// SPIKE VERDICT: SAB bridge WORKS over async custom IFileSystem (2026-07-16)
// — with one mandatory caveat: the custom fs's ops run inside the sandbox's
// defense-in-depth AsyncLocalStorage context, where just-bash blocks
// globalThis.setTimeout/setInterval/setImmediate/process.env at call time
// (on by default: `defenseInDepth ?? true`). Any fs op that schedules timers
// (pg-pool does, at connect/release) throws SecurityViolationError unless the
// op's async work is wrapped in `DefenseInDepthBox.runTrustedAsync(...)` —
// the wrapper just-bash itself documents for "trusted host-extension
// [code] that need[s] direct Node.js globals" (types.d.ts, Command.trusted).
// Task 3 therefore mounts PgFs DIRECTLY (no InMemoryFs copy-in/copy-out
// fallback needed) and MUST wrap every FsStore round-trip in runTrustedAsync.
/**
 * The pre-build spike for the brain filesystem.
 *
 * Question: do the python/js WASM sandboxes — which do file I/O through a
 * SharedArrayBuffer sync bridge (the worker blocks on Atomics.wait while the
 * host services the FS call) — work against a CUSTOM async IFileSystem whose
 * every operation is genuinely asynchronous (real macrotask latency), the way
 * the Postgres-backed PgFs will be? The design scout only proved the bridge
 * against just-bash's own InMemoryFs, whose ops resolve on the microtask
 * queue.
 *
 * ProbeFs simulates Postgres latency/asynchrony without a DB: it wraps
 * InMemoryFs, forces every op through a real setTimeout(1) macrotask, and
 * logs every call so we can prove the sandboxes' I/O actually traversed the
 * custom filesystem (not some internal snapshot). Two flavors:
 *
 * - trusted: the delay runs under DefenseInDepthBox.runTrustedAsync — the
 *   shape PgFs must use. All four bridge paths pass (python + js, both as
 *   the whole fs and mounted at /data under MountableFs).
 * - naive: bare globalThis.setTimeout — pinned to FAIL with the
 *   defense-in-depth security violation, so a just-bash upgrade that changes
 *   this contract (either direction) is caught here.
 */
import { describe, expect, it } from "vitest";
import { Bash, DefenseInDepthBox, InMemoryFs, MountableFs, type IFileSystem } from "just-bash";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/**
 * Every IFileSystem method is async, waits a real macrotask, and records the
 * call before delegating to a private InMemoryFs. resolvePath/getAllPaths are
 * sync in the interface, so they delegate directly.
 */
class ProbeFs implements IFileSystem {
  readonly calls: string[] = [];
  private readonly inner = new InMemoryFs();

  constructor(private readonly mode: "trusted" | "naive") {}

  private async probe(op: string, path: string): Promise<void> {
    this.calls.push(`${op} ${path}`);
    if (this.mode === "trusted") {
      await DefenseInDepthBox.runTrustedAsync(tick);
    } else {
      await tick();
    }
  }

  async readFile(...a: Parameters<IFileSystem["readFile"]>) {
    await this.probe("readFile", a[0]);
    return this.inner.readFile(...a);
  }
  async readFileBytes(...a: Parameters<InMemoryFs["readFileBytes"]>) {
    await this.probe("readFileBytes", a[0]);
    return this.inner.readFileBytes(...a);
  }
  async readFileBuffer(...a: Parameters<IFileSystem["readFileBuffer"]>) {
    await this.probe("readFileBuffer", a[0]);
    return this.inner.readFileBuffer(...a);
  }
  async writeFile(...a: Parameters<IFileSystem["writeFile"]>) {
    await this.probe("writeFile", a[0]);
    return this.inner.writeFile(...a);
  }
  async appendFile(...a: Parameters<IFileSystem["appendFile"]>) {
    await this.probe("appendFile", a[0]);
    return this.inner.appendFile(...a);
  }
  async exists(...a: Parameters<IFileSystem["exists"]>) {
    await this.probe("exists", a[0]);
    return this.inner.exists(...a);
  }
  async stat(...a: Parameters<IFileSystem["stat"]>) {
    await this.probe("stat", a[0]);
    return this.inner.stat(...a);
  }
  async mkdir(...a: Parameters<IFileSystem["mkdir"]>) {
    await this.probe("mkdir", a[0]);
    return this.inner.mkdir(...a);
  }
  async readdir(...a: Parameters<IFileSystem["readdir"]>) {
    await this.probe("readdir", a[0]);
    return this.inner.readdir(...a);
  }
  async readdirWithFileTypes(...a: Parameters<InMemoryFs["readdirWithFileTypes"]>) {
    await this.probe("readdirWithFileTypes", a[0]);
    return this.inner.readdirWithFileTypes(...a);
  }
  async rm(...a: Parameters<IFileSystem["rm"]>) {
    await this.probe("rm", a[0]);
    return this.inner.rm(...a);
  }
  async cp(...a: Parameters<IFileSystem["cp"]>) {
    await this.probe("cp", a[0]);
    return this.inner.cp(...a);
  }
  async mv(...a: Parameters<IFileSystem["mv"]>) {
    await this.probe("mv", a[0]);
    return this.inner.mv(...a);
  }
  resolvePath(...a: Parameters<IFileSystem["resolvePath"]>) {
    return this.inner.resolvePath(...a);
  }
  getAllPaths() {
    return this.inner.getAllPaths();
  }
  async chmod(...a: Parameters<IFileSystem["chmod"]>) {
    await this.probe("chmod", a[0]);
    return this.inner.chmod(...a);
  }
  async symlink(...a: Parameters<IFileSystem["symlink"]>) {
    await this.probe("symlink", a[1]);
    return this.inner.symlink(...a);
  }
  async link(...a: Parameters<IFileSystem["link"]>) {
    await this.probe("link", a[1]);
    return this.inner.link(...a);
  }
  async readlink(...a: Parameters<IFileSystem["readlink"]>) {
    await this.probe("readlink", a[0]);
    return this.inner.readlink(...a);
  }
  async lstat(...a: Parameters<IFileSystem["lstat"]>) {
    await this.probe("lstat", a[0]);
    return this.inner.lstat(...a);
  }
  async realpath(...a: Parameters<IFileSystem["realpath"]>) {
    await this.probe("realpath", a[0]);
    return this.inner.realpath(...a);
  }
  async utimes(...a: Parameters<IFileSystem["utimes"]>) {
    await this.probe("utimes", a[0]);
    return this.inner.utimes(...a);
  }
}

const PY_UPPER = `python3 -c "open('/data/out.txt','w').write(open('/data/in.txt').read().upper())"`;
const JS_UPPER = `js-exec -c 'const fs = require("fs"); fs.writeFileSync("/data/out.txt", fs.readFileSync("/data/in.txt", "utf8").toUpperCase())'`;

/** ProbeFs as the WHOLE filesystem. Bash's default cwd is /home/user and the
 * python worker chdir's into it through its /host mount, so it must exist. */
async function directProbe(mode: "trusted" | "naive") {
  const probe = new ProbeFs(mode);
  await probe.mkdir("/home/user", { recursive: true });
  await probe.mkdir("/data", { recursive: true });
  await probe.writeFile("/data/in.txt", "hello");
  probe.calls.length = 0; // only sandbox-driven traffic from here on
  return {
    fs: probe as IFileSystem,
    probe,
    readBack: () => probe.readFile("/data/out.txt"),
  };
}

/** ProbeFs mounted at /data under MountableFs — the Task 3 production shape
 * (PgFs mounted at /shared and /home/<slug> over a base fs). */
async function mountedProbe(mode: "trusted" | "naive") {
  const probe = new ProbeFs(mode);
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount("/data", probe);
  await fs.mkdir("/home/user", { recursive: true });
  await fs.writeFile("/data/in.txt", "hello");
  probe.calls.length = 0;
  return { fs: fs as IFileSystem, probe, readBack: () => fs.readFile("/data/out.txt") };
}

describe("spike: WASM SAB bridge over an async custom IFileSystem", () => {
  it("python3 reads and writes through the async probe fs", { timeout: 120_000 }, async () => {
    const { fs, probe, readBack } = await directProbe("trusted");
    const bash = new Bash({ fs, python: true });

    const r = await bash.exec(PY_UPPER);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(await readBack()).toBe("HELLO");
    // The I/O must have traversed the custom fs, not an internal snapshot.
    expect(probe.calls.some((c) => c.includes("/data/in.txt"))).toBe(true);
    expect(probe.calls.some((c) => c.includes("/data/out.txt"))).toBe(true);
  });

  it("js-exec reads and writes through the async probe fs", { timeout: 120_000 }, async () => {
    const { fs, probe, readBack } = await directProbe("trusted");
    const bash = new Bash({ fs, javascript: true });

    const r = await bash.exec(JS_UPPER);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(await readBack()).toBe("HELLO");
    expect(probe.calls.some((c) => c.includes("in.txt"))).toBe(true);
    expect(probe.calls.some((c) => c.includes("out.txt"))).toBe(true);
  });

  it(
    "python3 + js-exec through MountableFs with the probe mounted at /data",
    { timeout: 240_000 },
    async () => {
      for (const script of [PY_UPPER, JS_UPPER]) {
        const { fs, probe, readBack } = await mountedProbe("trusted");
        const bash = new Bash({ fs, python: true, javascript: true });

        const r = await bash.exec(script);
        expect(r.stderr).toBe("");
        expect(r.exitCode).toBe(0);
        expect(await readBack()).toBe("HELLO");
        // MountableFs routed the sandbox's I/O into the probe (mount-relative paths).
        expect(probe.calls.some((c) => c.includes("out.txt"))).toBe(true);
      }
    },
  );

  it(
    "pins the caveat: fs ops using bare globalThis timers trip defense-in-depth",
    { timeout: 120_000 },
    async () => {
      // just-bash monkey-patches globalThis.setTimeout during exec (defense-in-
      // depth, ON by default) and the custom fs runs inside that untrusted
      // context. PgFs must wrap its Postgres round-trips in runTrustedAsync —
      // if a just-bash upgrade changes this contract, this pin catches it.
      const { fs } = await directProbe("naive");
      const bash = new Bash({ fs, javascript: true });

      const r = await bash.exec(JS_UPPER);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("setTimeout is blocked during script execution");
    },
  );
});
