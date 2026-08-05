import { posix } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  defineCommand,
  latin1FromBytes,
  type CommandContext,
  type CustomCommand,
  type ExecResult,
} from "just-bash";
import { isBrainError } from "@brain/shared";
import { isVersionNo, type FsCtx, type FsStore } from "./fs-store.js";

/**
 * In-sandbox version-control commands.
 * They register alongside the python3 shadow in the bash runner and reach the
 * brain filesystem's version history through the SAME FsStore the PgFs mount
 * uses — so RLS on fs_versions/fs_entries scopes them exactly like every other
 * surface (a foreign home's history is simply empty, never an error).
 *
 *   history <path>              prior snapshots, newest first (vN … reason … when)
 *   diff <path> [<a> [<b>]]     unified diff: last snapshot vs working tree,
 *                               version a vs working tree, or version a vs b
 *   restore <path> [<version>]  roll a live file back, or resurrect a deleted one
 *   restore --list [<prefix>]   what is recoverable from the trash
 *
 * `diff` and `history` SHADOW just-bash builtins (custom commands win the name).
 * `history` builtin is a no-op stub (shell history is unimplemented), so nothing
 * is lost there. `diff` builtin is a real file-vs-file comparator, so this
 * shadow keeps its whole contract — same output format, same flag surface
 * (-u/-q/-s/-i/--help, clustered shorts, `--`, `-` for stdin), same exit codes
 * (0 same, 1 differ, 2 trouble) — and only takes over when the operands are
 * version-shaped (one path, or a path plus version numbers). Two file operands
 * still compare two files. There is no way to delegate back to a shadowed
 * builtin (same-name exec recurses), which is why the passthrough is
 * reimplemented here rather than forwarded — over the SAME jsdiff the builtin
 * used, so the bytes it prints are the bytes it printed before.
 *
 * Mutations go straight to the store, behind the PgFs mount's back, so every
 * command first `sync`s the mounts: buffered appends flush (they must not land
 * on top of a restore) and the per-exec stat/list memos drop (so a later
 * ls/cat/test sees the restored truth inside the same script).
 */

const DIFF_CONTEXT_LINES = 3;
/**
 * A unified body is refused above this per side. The whole diff runs
 * SYNCHRONOUSLY in the box's one Node process — runBash's AbortController
 * cannot interrupt it — so the only real defence is not starting. 1 MiB is
 * FS_VERSION_MAX_FILE_BYTES (a snapshot can never exceed it), which leaves
 * only a huge *live* file able to trip this, and it trips before allocating.
 */
const DIFF_MAX_BYTES = 1024 * 1024;
/**
 * jsdiff's own abort valve: past this it returns undefined instead of chasing
 * a worst-case O(N·D) edit script. Two totally-different 1 MiB files stop here
 * in ~2s using tens of MB, where the old hand-rolled full LCS matrix needed
 * gigabytes and never returned.
 */
const DIFF_TIMEOUT_MS = 2_000;

const DIFF_HELP = `diff - compare files line by line, or a file against its own history

Usage: diff [OPTION]... FILE1 FILE2
       diff [OPTION]... PATH            (last snapshot vs the working tree)
       diff [OPTION]... PATH VERSION    (that version vs the working tree)
       diff [OPTION]... PATH A B        (version A vs version B)

Options:
  -u, --unified     output unified diff format (default)
  -q, --brief       report only whether the inputs differ
  -s, --report-identical-files  report when the inputs are the same
  -i, --ignore-case  ignore case differences
      --help        display this help and exit

FILE1/FILE2 may be \`-\` for standard input. Version numbers come from
\`history PATH\`; \`restore PATH [VERSION]\` puts one back.
`;

type Res = ExecResult;

/** Resolve a possibly-relative operand against the shell cwd. */
function absPath(cwd: string, arg: string): string {
  return arg.startsWith("/") ? arg : posix.resolve(cwd, arg);
}

function fmtBytes(n: number): string {
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)}MB`;
  if (n >= 2 ** 10) return `${(n / 2 ** 10).toFixed(1)}KB`;
  return `${n}B`;
}

function out(stdout: string, exitCode = 0): Res {
  return { stdout, stderr: "", exitCode };
}

/** A teaching BrainError (ELOCKED, EROFS, ENOENT…) reads as a normal tool error. */
function fail(command: string, e: unknown, exitCode = 1): Res {
  const msg = isBrainError(e) ? e.message : ((e as Error)?.message ?? String(e));
  return { stdout: "", stderr: `${command}: ${msg}\n`, exitCode };
}

function usage(form: string): Res {
  return { stdout: "", stderr: `usage: ${form}\n`, exitCode: 2 };
}

/**
 * A positive int4 operand — how a version number is told from a filename.
 * Bounded by MAX_VERSION_NO because `version_no` is an int4: a bigger number
 * is not a version that happens to be missing, it is one no box could hold,
 * and passing it through printed a raw Postgres range error into the sandbox.
 */
function versionArg(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return isVersionNo(n) ? n : null;
}

/** A Buffer view over whatever the store/fs handed back — never a copy. */
function asBuf(b: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Can these bytes be diffed as TEXT — i.e. does `toString("utf8")` lose
 * nothing? Strict UTF-8 validation (no NUL, no overlong form, no surrogate,
 * nothing past U+10FFFF), which is exactly the round trip
 * `Buffer.from(b.toString("utf8"), "utf8").equals(b)` — but as a scan, so a
 * 100 MB file costs no allocation. This is load-bearing for CORRECTNESS, not
 * pretty output: `toString("utf8")` maps EVERY invalid byte to U+FFFD, so
 * `\xff\xfe` and `\xfe\xff` decode to the SAME string. Comparing the decoded
 * strings therefore reported genuinely different files as identical (exit 0,
 * `-s` even said so), and a script keying on diff's exit code was misled.
 * Bytes decide identity; text is only ever the rendering.
 */
function isDiffableText(b: Buffer): boolean {
  for (let i = 0; i < b.length;) {
    const c = b[i]!;
    if (c === 0x00) return false; // a NUL is diff(1)'s own "this is binary"
    if (c < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    let cp: number;
    if (c >= 0xc2 && c <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      min = 0x800;
      cp = c & 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = c & 0x07;
    } else {
      return false; // 0x80-0xc1 (stray continuation / overlong), 0xf5-0xff
    }
    if (i + need >= b.length) return false; // truncated sequence
    for (let k = 1; k <= need; k++) {
      const cc = b[i + k]!;
      if ((cc & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/**
 * -i folds ASCII case ONLY, like diff(1) in the C locale. Not
 * `String.toLowerCase()`: that applies full Unicode case mapping, which can
 * collapse two genuinely different strings (U+0130 vs "i" + U+0307) into one
 * — the same "different bytes called identical" mistake in a different dress.
 */
function foldAscii(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

interface DiffOpts {
  brief: boolean;
  identical: boolean;
  ignoreCase: boolean;
}

/**
 * diff(1)'s report over the SAME jsdiff engine the shadowed builtin used
 * (Myers, linear memory, an abort valve) — never a hand-rolled LCS matrix.
 *
 * Order matters:
 *   1. raw BYTE compare (cheap, exact) — so inputs differing only in a
 *      trailing newline DIFFER, and only a true byte match can be called
 *      identical. Decoding first would fuse distinct invalid-UTF-8 bytes
 *      into one U+FFFD string and report a real difference as no difference;
 *   2. bytes that differ can never be re-labelled identical downstream: if
 *      either side is not losslessly decodable text, say so GNU-style
 *      ("Binary files X and Y differ", exit 1) for -q/-u/default alike;
 *   3. -i folds case for the COMPARE only, after byte inequality is
 *      established: the printed patch always shows the original bytes;
 *   4. -q answers from the compare alone, paying nothing for a patch;
 *   5. only a real unified body checks the size guard and runs the diff.
 */
function renderDiff(aLabel: string, bLabel: string, a: Buffer, b: Buffer, opts: DiffOpts): Res {
  const identical = (): Res =>
    out(opts.identical ? `Files ${aLabel} and ${bLabel} are identical\n` : "");
  if (a.equals(b)) return identical();
  // From here the BYTES differ. Nothing below may claim identity on the
  // strength of a decoded string.
  if (!isDiffableText(a) || !isDiffableText(b)) {
    return out(`Binary files ${aLabel} and ${bLabel} differ\n`, 1);
  }
  // Decoding is deferred so -q on two huge files still allocates nothing.
  let aText: string | null = null;
  let bText: string | null = null;
  if (opts.ignoreCase) {
    aText = a.toString("utf8");
    bText = b.toString("utf8");
    if (foldAscii(aText) === foldAscii(bText)) return identical();
  }
  if (opts.brief) return out(`Files ${aLabel} and ${bLabel} differ\n`, 1);
  const big = a.length > DIFF_MAX_BYTES ? aLabel : b.length > DIFF_MAX_BYTES ? bLabel : null;
  if (big !== null) {
    return fail(
      "diff",
      new Error(
        `${big}: too large to diff (over ${fmtBytes(DIFF_MAX_BYTES)}) — they differ; use \`diff -q\` or compare a smaller slice`,
      ),
      2,
    );
  }
  const patch = createTwoFilesPatch(
    aLabel,
    bLabel,
    aText ?? a.toString("utf8"),
    bText ?? b.toString("utf8"),
    "",
    "",
    {
      context: DIFF_CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (patch === undefined) {
    return fail(
      "diff",
      new Error(`${aLabel} and ${bLabel} are too different to diff — they differ`),
      2,
    );
  }
  return out(patch, 1);
}

/** Byte-for-byte the shadowed builtin's flag errors (same wording, exit 1). */
function badFlag(arg: string): Res {
  return {
    stdout: "",
    stderr: arg.startsWith("--")
      ? `diff: unrecognized option '${arg}'\n`
      : `diff: invalid option -- '${arg.replace(/^-/, "")}'\n`,
    exitCode: 1,
  };
}

interface FsVcHooks {
  /**
   * Reconcile the PgFs mounts with a store write made outside them: flush
   * buffered appends, drop per-exec caches, and (when given) note the path as
   * durably written so the runner's `persisted:` trailer stays honest.
   */
  sync?: (mutated?: string) => Promise<void>;
}

/**
 * Build the version-control commands bound to one caller's store + RLS context.
 * Registered per exec in bash.ts's `customCommands` (like the python3 shadow),
 * so the closed-over ctx carries that caller's actor/scope.
 */
export function fsVersionCommands(
  store: FsStore,
  ctx: FsCtx,
  hooks: FsVcHooks = {},
): CustomCommand[] {
  const sync = async (mutated?: string): Promise<void> => {
    if (hooks.sync) await hooks.sync(mutated);
  };

  const history = defineCommand("history", async (args, cctx: CommandContext): Promise<Res> => {
    const target = args[0];
    if (target === undefined) return usage("history <path>");
    const p = absPath(cctx.cwd, target);
    try {
      await sync();
      // METADATA only — printing a size/date table must never drag every
      // snapshot's bytes (up to the per-path cap × 1 MiB) into the process.
      const rows = await store.versionList(ctx, p);
      if (rows.length === 0) {
        if (!(await store.exists(ctx, p))) {
          return fail("history", new Error(`${p}: No such file or directory`), 2);
        }
        // "No history yet" and "this file will NEVER be snapshotted" are
        // different answers, and printing the same six words for both is how an
        // agent overwrites bytes it believed were recoverable. Snapshots are
        // skipped silently on purpose (history may never fail a live write), so
        // this line is the only place that difference can surface.
        const why = await store.versionSkipReason(ctx, p);
        return out(
          why === null
            ? `no version history for ${p}\n`
            : `no version history for ${p} — ${why}, so overwrites are not snapshotted (an rm still keeps the bytes)\n`,
        );
      }
      // SHA256 is the only BYTE-level signal an agent has in here: the sandbox
      // ships no cmp/xxd/hexdump/sha256sum, so without it two snapshots can
      // only be told apart by re-reading and eyeballing them. It is stored per
      // snapshot already (versionList selects it without touching content), so
      // this column costs one more string per row and no extra bytes.
      // Abbreviated to 12 hex chars (48 bits) like git: unambiguous across the
      // handful of snapshots a path can keep, and readable in a table.
      const body = rows
        .map(
          (r) =>
            `v${r.version_no}\t${r.reason}\t${fmtBytes(r.size_bytes)}\t${r.sha256?.slice(0, 12) ?? "-"}\t${r.edited_by}\t${r.created_at.toISOString()}`,
        )
        .join("\n");
      return out(`VERSION\tREASON\tSIZE\tSHA256\tEDITED_BY\tWHEN\n${body}\n`);
    } catch (e) {
      return fail("history", e);
    }
  });

  const diff = defineCommand("diff", async (args, cctx: CommandContext): Promise<Res> => {
    // --help wins wherever it appears (the builtin checked it before parsing).
    if (args.includes("--help")) return out(DIFF_HELP);
    const opts: DiffOpts = { brief: false, identical: false, ignoreCase: false };
    const operands: string[] = [];
    let noMoreFlags = false;
    for (const arg of args) {
      // `-` alone is an operand (stdin), never a flag — same as the builtin.
      if (noMoreFlags || !arg.startsWith("-") || arg === "-") {
        operands.push(arg);
        continue;
      }
      if (arg === "--") {
        noMoreFlags = true;
        continue;
      }
      if (arg.startsWith("--")) {
        switch (arg.slice(2).split("=")[0]) {
          case "unified":
            break; // unified is the only format we emit
          case "brief":
            opts.brief = true;
            break;
          case "report-identical-files":
            opts.identical = true;
            break;
          case "ignore-case":
            opts.ignoreCase = true;
            break;
          default:
            return badFlag(arg);
        }
        continue;
      }
      // Short flags cluster (`-qi` is `-q -i`), exactly like just-bash's parser.
      for (const ch of arg.slice(1)) {
        switch (ch) {
          case "u":
            break;
          case "q":
            opts.brief = true;
            break;
          case "s":
            opts.identical = true;
            break;
          case "i":
            opts.ignoreCase = true;
            break;
          default:
            return badFlag(`-${ch}`);
        }
      }
    }
    if (operands.length === 0) return fail("diff", new Error("missing operand"), 2);
    // stdin has no version history, so `-` is only ever a file operand.
    if (operands[0] === "-" && operands.length < 2) {
      return fail("diff", new Error("missing operand"), 2);
    }

    const p = absPath(cctx.cwd, operands[0]!);
    const va = versionArg(operands[1]);
    const vb = versionArg(operands[2]);
    try {
      await sync();
      // ---- version mode: one path, optionally one or two version numbers ----
      if (
        operands[0] !== "-" &&
        (operands.length === 1 ||
          (operands.length === 2 && va) ||
          (operands.length === 3 && va && vb))
      ) {
        if (va && vb) {
          return renderDiff(
            `${p}@v${va}`,
            `${p}@v${vb}`,
            asBuf(await store.versionContent(ctx, p, va)),
            asBuf(await store.versionContent(ctx, p, vb)),
            opts,
          );
        }
        if (va) {
          return renderDiff(
            `${p}@v${va}`,
            p,
            asBuf(await store.versionContent(ctx, p, va)),
            asBuf((await store.read(ctx, p)).bytes),
            opts,
          );
        }
        const versions = await store.versionList(ctx, p);
        if (versions.length === 0) {
          if (!(await store.exists(ctx, p))) {
            return fail("diff", new Error(`${p}: No such file or directory`), 2);
          }
          return out(`no prior version to diff for ${p}\n`);
        }
        // "What changed last?" — so compare against the newest snapshot whose
        // bytes actually DIFFER from the working tree, not blindly the newest
        // row. A snapshot equal to the live file makes `diff <path>` print
        // nothing and exit 0 ("no changes") while a real edit sits one row
        // below it, unshown. Falls back to the newest when every snapshot
        // matches: then "identical" is the honest answer.
        const live = await store.read(ctx, p);
        const pick = versions.find((v) => v.sha256 !== live.meta.sha256) ?? versions[0]!;
        return renderDiff(
          `${p}@v${pick.version_no}`,
          p,
          asBuf(await store.versionContent(ctx, p, pick.version_no)),
          asBuf(live.bytes),
          opts,
        );
      }
      // ---- file-vs-file mode: the shadowed builtin's whole contract ----
      if (operands.length > 2) return fail("diff", new Error("extra operand"), 2);
      // Labels + errors name the operand as typed, like the builtin did.
      // RAW bytes on both sides — `readFile(…, "utf8")` would decode (and so
      // fuse) exactly the byte differences renderDiff has to be able to see.
      const read = async (operand: string): Promise<Buffer> => {
        if (operand === "-") return Buffer.from(latin1FromBytes(cctx.stdin), "latin1");
        try {
          return asBuf(await cctx.fs.readFileBuffer(absPath(cctx.cwd, operand)));
        } catch {
          throw new Error(`${operand}: No such file or directory`);
        }
      };
      const [f1, f2] = [operands[0]!, operands[1]!];
      return renderDiff(f1, f2, await read(f1), await read(f2), opts);
    } catch (e) {
      return fail("diff", e, 2);
    }
  });

  const RESTORE_USAGE = "restore <path> [<version>] | restore --list [<prefix>]";

  const restore = defineCommand("restore", async (args, cctx: CommandContext): Promise<Res> => {
    const target = args[0];
    // `rm` is a soft delete, so the trash needs a reader IN the sandbox —
    // otherwise an agent can only resurrect a path whose name it already knows.
    if (target === "--list" || target === "-l") {
      const prefix = args[1] === undefined ? "/" : absPath(cctx.cwd, args[1]);
      try {
        await sync();
        const rows = await store.listTrash(ctx, prefix);
        if (rows.length === 0) return out(`nothing deleted under ${prefix}\n`);
        const body = rows
          .map(
            (r) =>
              `${r.path}\t${fmtBytes(r.size_bytes)}\t${r.edited_by}\t${r.created_at.toISOString()}`,
          )
          .join("\n");
        return out(`PATH\tSIZE\tDELETED_BY\tWHEN\n${body}\n`);
      } catch (e) {
        return fail("restore", e);
      }
    }
    if (target === undefined) return usage(RESTORE_USAGE);
    const p = absPath(cctx.cwd, target);
    let versionNo: number | undefined;
    if (args[1] !== undefined) {
      const v = versionArg(args[1]);
      if (v === null) return usage(RESTORE_USAGE);
      versionNo = v;
    }
    try {
      await sync();
      const res = await store.restore(ctx, p, versionNo);
      await sync(p);
      // Say what was KEPT, not just what was put back: the bytes a roll-back
      // replaced are preserved as a new version, so this line is how an agent
      // tells a real undo (there is a vN to go back to) from a no-op.
      const kept =
        res.preserved === null
          ? ""
          : ` (previous content kept as v${res.preserved.version_no}, ${fmtBytes(res.preserved.size_bytes)})`;
      return out(`restored ${p} from v${res.restoredFrom}${kept}\n`);
    } catch (e) {
      return fail("restore", e);
    }
  });

  return [history, diff, restore];
}
