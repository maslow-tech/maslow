import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryFs, defineCommand, type CustomCommand, type IFileSystem } from "just-bash";

/**
 * The sandbox's offline package toolkit.
 *
 * just-bash's python is CPython 3.13 compiled to WASM with the stdlib only —
 * C extensions (numpy, pandas, lxml, pillow) can never load. What CAN work,
 * and what network-gapped agent sandboxes ship by default, is pure-Python
 * wheels made importable offline. Ours live in `vendor/python-site/`
 * (installed by `uv pip install --target`, dist-info stripped):
 *
 *   openpyxl + et_xmlfile   read/write .xlsx
 *   pypdf                   read/split/merge/extract PDFs
 *   beautifulsoup4/soupsieve HTML parsing (html.parser backend; no lxml)
 *   tabulate                pretty text tables
 *   python-dateutil + six   date parsing/arithmetic
 *   markdown                markdown → HTML
 *
 * HOW IMPORTS REACH THEM (each step proven by spike in this repo):
 * - The worker mounts the whole just-bash virtual FS into the WASM world at
 *   `/host` (emscripten HOSTFS), so the vendored tree mounted at /opt/python
 *   is natively readable at /host/opt/python.
 * - Python-level patches (builtins.open, os.*) redirect plain absolute paths,
 *   but the FROZEN import machinery uses raw C-level I/O — so sys.path must
 *   name the /host-prefixed path. PYTHONPATH is hard-set by the worker and
 *   sitecustomize can't be reached, so we inject a preamble instead:
 * - A custom `python3` command (custom commands shadow built-ins) rewrites
 *   -c/-m/script invocations to prepend the sys.path preamble, then delegates
 *   to the untouched built-in `python` (delegating back to `python3` would
 *   recurse into the shadow — proven, OOM). `python` stays raw on purpose:
 *   it is the escape hatch and the recursion breaker.
 */

const TOOLKIT_MOUNT = "/opt/python";
const HOST_SITE = `/host${TOOLKIT_MOUNT}`;

const PREAMBLE = `import sys
if ${JSON.stringify(HOST_SITE)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(HOST_SITE)})
`;

/** One human line for the tool description + doctrine. */
export const PYTHON_TOOLKIT_NOTE =
  "python3 ships an offline toolkit: openpyxl (xlsx), pypdf, beautifulsoup4, " +
  "tabulate, python-dateutil, markdown (pure-Python only — no numpy/pandas)";

// ---------------------------------------------------------------- toolkit fs

function vendorDir(): string {
  // dist/sandbox-packages.js → ../vendor/python-site (same for src via tsx)
  return join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "python-site");
}

function walk(dir: string, prefix: string, out: Map<string, string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, `${prefix}/${name}`, out);
    // latin1 keeps binary data files (e.g. dateutil's zoneinfo tarball)
    // byte-exact through just-bash's ByteString file layer.
    else out.set(`${prefix}/${name}`, readFileSync(p).toString("latin1"));
  }
}

let toolkitPromise: Promise<IFileSystem> | undefined;

/**
 * The shared, read-only toolkit filesystem, built once per process and
 * mounted at /opt/python in every exec. Reads are concurrent-safe (nothing
 * mutates it); writes teach instead of landing.
 */
export function toolkitFs(): Promise<IFileSystem> {
  toolkitPromise ??= (async () => {
    const files = new Map<string, string>();
    // Mounted filesystems receive MOUNT-RELATIVE paths — seed at "/".
    walk(vendorDir(), "", files);
    const inner = new InMemoryFs();
    for (const [path, content] of files) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir !== "") await inner.mkdir(dir, { recursive: true });
      await inner.writeFile(path, content);
    }
    return readOnly(inner);
  })().catch((e) => {
    // Don't cache a rejection — a transient build failure would otherwise
    // break the toolkit mount for every future exec in this process. Reset so
    // the next call rebuilds.
    toolkitPromise = undefined;
    throw e;
  });
  return toolkitPromise;
}

function erofs(p: string): Error {
  const err = new Error(
    `EROFS: '${p}' is in the read-only package toolkit — write under /shared, /home/<you> or /tmp`,
  ) as Error & { code: string };
  err.code = "EROFS";
  return err;
}

function readOnly(inner: IFileSystem): IFileSystem {
  return {
    readFile: (p, o?) => inner.readFile(p, o),
    ...(inner.readFileBytes ? { readFileBytes: inner.readFileBytes.bind(inner) } : {}),
    readFileBuffer: (p) => inner.readFileBuffer(p),
    exists: (p) => inner.exists(p),
    stat: (p) => inner.stat(p),
    lstat: (p) => inner.lstat(p),
    readdir: (p) => inner.readdir(p),
    ...(inner.readdirWithFileTypes
      ? { readdirWithFileTypes: inner.readdirWithFileTypes.bind(inner) }
      : {}),
    readlink: (p) => inner.readlink(p),
    realpath: (p) => inner.realpath(p),
    resolvePath: (b, p) => inner.resolvePath(b, p),
    getAllPaths: () => inner.getAllPaths(),
    chmod: async () => undefined,
    utimes: async () => undefined,
    writeFile: async (p) => {
      throw erofs(p);
    },
    appendFile: async (p) => {
      throw erofs(p);
    },
    mkdir: async (p) => {
      throw erofs(p);
    },
    rm: async (p) => {
      throw erofs(p);
    },
    cp: async (_s, d) => {
      throw erofs(d);
    },
    mv: async (s) => {
      throw erofs(s);
    },
    symlink: async (_t, l) => {
      throw erofs(l);
    },
    link: async (_e, n) => {
      throw erofs(n);
    },
  };
}

// ---------------------------------------------------------- python3 wrapper

/**
 * Rewrite a python3 argv so the toolkit is on sys.path, delegating to the
 * built-in `python`. Unparseable/interactive forms pass through unchanged —
 * they still run, just without the vendored packages.
 */
/**
 * `from __future__` must be the first statement in a module, so the sys.path
 * preamble can't simply lead. Hoist any leading future-imports (after blank
 * lines and comments) above the preamble.
 */
function withPreamble(code: string): string {
  const lines = code.split("\n");
  const future: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (/^from\s+__future__\s+import\b/.test(t)) {
      future.push(lines[i]!);
      continue;
    }
    break;
  }
  if (future.length === 0) return `${PREAMBLE}${code}`;
  return `${future.join("\n")}\n${PREAMBLE}${lines.slice(i).join("\n")}`;
}

// python3 flags that consume the NEXT argv token — so it isn't mistaken for a
// script path. (-c/-m are handled explicitly above.)
const ARG_FLAGS = new Set(["-W", "-X"]);

export function rewritePythonArgs(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c") {
      const code = args[i + 1];
      if (code === undefined) break;
      return [...args.slice(0, i), "-c", withPreamble(code), ...args.slice(i + 2)];
    }
    if (ARG_FLAGS.has(a)) {
      i++; // skip this flag's argument
      continue;
    }
    if (a === "-m") {
      const mod = args[i + 1];
      if (mod === undefined) break;
      const rest = args.slice(i + 2);
      const code =
        `import runpy\n${PREAMBLE}` +
        `sys.argv = [${[mod, ...rest].map((r) => JSON.stringify(r)).join(", ")}]\n` +
        `runpy.run_module(${JSON.stringify(mod)}, run_name="__main__", alter_sys=True)\n`;
      return [...args.slice(0, i), "-c", code];
    }
    // first non-flag arg = a script path. `-` (explicit stdin) is NOT a script:
    // it falls through to the stdin-program path (readsStdinProgram + the stdin
    // preamble in pythonToolkitCommand), same as bare `python3` with a heredoc.
    // runpy opens the script with RAW C-level I/O, which only sees the WASM
    // world — hand it the /host-prefixed absolute path (argv keeps the
    // user-visible one).
    if (!a.startsWith("-")) {
      const rest = args.slice(i + 1);
      const code =
        `${PREAMBLE}import os as _os, runpy\n` +
        `_s = ${JSON.stringify(a)}\n` +
        `_abs = _s if _s.startswith("/") else _os.getcwd().rstrip("/") + "/" + _s\n` +
        `_host = _abs if _abs.startswith(("/host/", "/lib/")) else "/host" + _abs\n` +
        `sys.argv = [${[a, ...rest].map((r) => JSON.stringify(r)).join(", ")}]\n` +
        `runpy.run_path(_host, run_name="__main__")\n`;
      return [...args.slice(0, i), "-c", code];
    }
  }
  return [...args];
}

/**
 * True when python will read its PROGRAM from stdin — a bare `python3` (heredoc)
 * or an explicit `python3 -`. In that case there is no script/-c/-m argv to
 * carry the sys.path preamble, so pythonToolkitCommand must inject it into the
 * stdin stream instead (without this, `python3 <<'PY' import openpyxl' fails —
 * the most natural way to write multi-line python bypassed the toolkit). A
 * `-c`/`-m`/script invocation returns false: there stdin is data, not code, and
 * the preamble is already in the rewritten argv.
 */
export function readsStdinProgram(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "-m") return false; // program comes from the arg
    if (a === "-") return true; // explicit "read program from stdin"
    if (ARG_FLAGS.has(a)) {
      i++; // this flag consumes the next token — skip it
      continue;
    }
    if (!a.startsWith("-")) return false; // a script file — stdin is data
    // any other lone flag (-u, -B, -O, -q, …) doesn't take a script — keep scanning
  }
  return true; // no -c/-m/script seen → python reads its program from stdin
}

/** The `python3` shadow that puts the toolkit on sys.path. */
export function pythonToolkitCommand(): CustomCommand {
  return defineCommand("python3", async (args, ctx) => {
    if (!ctx.exec) {
      return { stdout: "", stderr: "python3: sandbox exec unavailable\n", exitCode: 127 };
    }
    // When the program arrives on stdin (heredoc / `python3 -`) there's no argv
    // to rewrite, so hoist the sys.path preamble into the stdin code itself
    // (withPreamble keeps any leading `from __future__` first). ASCII preamble +
    // latin1 stdin concatenate byte-for-byte, so stdinKind stays "bytes".
    const stdinStr = ctx.stdin !== undefined ? String(ctx.stdin) : "";
    const injectStdin = stdinStr !== "" && readsStdinProgram([...args]);
    const stdin = injectStdin ? withPreamble(stdinStr) : stdinStr;
    // Delegate to the untouched `python` builtin (same-name delegation would
    // recurse into this shadow). argv goes via options.args — appended verbatim
    // with NO shell parsing, so code containing quotes/$/backticks is safe.
    // cwd/stdin forwarded so `cd` and pipes behave exactly like the builtin;
    // ctx.stdin is a ByteString (latin1 chars = bytes) — stdinKind says so.
    return ctx.exec("python", {
      cwd: ctx.cwd,
      args: rewritePythonArgs([...args]),
      ...(stdin !== "" ? { stdin: stdin as unknown as string, stdinKind: "bytes" as const } : {}),
    });
  });
}
