import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INSTALL_SH = fileURLToPath(new URL("../../deploy/install.sh", import.meta.url));

function runBash(script: string, env: Record<string, string>): string {
  return execFileSync("bash", ["-c", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("installer idempotency (re-run doesn't brick)", () => {
  it("generates secrets ONCE — a re-run keeps the existing value", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
       a=$(generate_secret_once db_password)
       b=$(generate_secret_once db_password)
       echo "$a|$b"`,
      { BRAIN_HOME: home },
    );
    const [a, b] = out.trim().split("|");
    expect(a).toBe(b); // second call returns the SAME secret
    expect((a ?? "").length).toBeGreaterThan(20);
  });

  it("detects install vs repair (repair never re-initializes PGDATA)", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const pgdata = join(home, "pgdata");

    const fresh = runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; detect_mode`, {
      BRAIN_HOME: home,
      BRAIN_PGDATA: pgdata,
    });
    expect(fresh.trim()).toBe("install");

    mkdirSync(pgdata, { recursive: true });
    writeFileSync(join(pgdata, "PG_VERSION"), "17");
    const existing = runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; detect_mode`, {
      BRAIN_HOME: home,
      BRAIN_PGDATA: pgdata,
    });
    expect(existing.trim()).toBe("repair");
  });
});

describe("GHCR login (private pull + in-updater cosign)", () => {
  it("skips with a warning (never dies) when no token is set", () => {
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
       ghcr_login 2>&1 && echo SKIP_OK`,
      {},
    );
    expect(out).toContain("no BRAIN_GHCR_TOKEN");
    expect(out).toContain("SKIP_OK"); // returned 0, did not die
  });

  it("dies when a token is set but no username is given", () => {
    expect(() =>
      runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; ghcr_login`, {
        BRAIN_GHCR_TOKEN: "ghp_fake",
      }),
    ).toThrow(/BRAIN_GHCR_USER/);
  });

  it("logs in and leaves config.json where the updater mount expects it", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const cfgDir = join(home, "docker");
    // Stub `docker`: a bash function shadows the PATH binary. It mimics
    // `docker login --password-stdin` by writing config.json into DOCKER_CONFIG.
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      docker() {
        if [ "$1" = "login" ]; then
          cat >/dev/null   # drain the piped token
          mkdir -p "$DOCKER_CONFIG"
          printf '{"auths":{"ghcr.io":{"auth":"x"}}}' > "$DOCKER_CONFIG/config.json"
          return 0
        fi
        return 0
      }
      ghcr_login 2>&1 && echo LOGIN_OK
      [ -s "${cfgDir}/config.json" ] && echo CONFIG_PRESENT`;
    const out = runBash(script, {
      BRAIN_GHCR_TOKEN: "ghp_fake",
      BRAIN_GHCR_USER: "brain-bot",
      BRAIN_DOCKER_CONFIG_DIR: cfgDir,
    });
    expect(out).toContain("login ok");
    expect(out).toContain("LOGIN_OK");
    expect(out).toContain("CONFIG_PRESENT");
  });

  it("accepts the token via BRAIN_GHCR_TOKEN_FILE", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const tokFile = join(home, "ghcr.tok");
    const cfgDir = join(home, "docker");
    writeFileSync(tokFile, "ghp_fromfile");
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      docker() { cat >/dev/null; mkdir -p "$DOCKER_CONFIG"; echo '{}' > "$DOCKER_CONFIG/config.json"; return 0; }
      ghcr_login 2>&1 && echo OK`;
    const out = runBash(script, {
      BRAIN_GHCR_TOKEN_FILE: tokFile,
      BRAIN_GHCR_USER: "brain-bot",
      BRAIN_DOCKER_CONFIG_DIR: cfgDir,
    });
    expect(out).toContain("OK");
    expect(out).toContain("login ok");
  });
});

describe("installer bundle + .env rendering", () => {
  it("resolves the bundle URL from BRAIN_VERSION, and BRAIN_BUNDLE_URL wins", () => {
    const byVersion = runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; bundle_url`, {
      BRAIN_VERSION: "v0.1.0",
    }).trim();
    expect(byVersion).toBe(
      "https://github.com/maslow-tech/maslow/releases/download/v0.1.0/brain-deploy-v0.1.0.tar.gz",
    );

    const explicit = runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; bundle_url`, {
      BRAIN_VERSION: "v0.1.0",
      BRAIN_BUNDLE_URL: "https://cdn.example.com/b.tgz",
    }).trim();
    expect(explicit).toBe("https://cdn.example.com/b.tgz");
  });

  it("fetch_bundle skips (never dies) when compose is already present", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const deploy = join(home, "deploy");
    mkdirSync(deploy, { recursive: true });
    writeFileSync(join(deploy, "docker-compose.yml"), "name: brain\n");
    // No BRAIN_VERSION/URL set — would die if it tried to fetch. It must skip.
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; fetch_bundle && echo SKIPPED_OK`,
      { BRAIN_HOME: home, BRAIN_DEPLOY_DIR: deploy },
    );
    expect(out).toContain("SKIPPED_OK");
  });

  it("render_env writes a complete 0600 .env with stable secrets across re-runs", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const deploy = join(home, "deploy");
    const env = {
      BRAIN_HOME: home,
      BRAIN_SECRETS_DIR: join(home, "secrets"),
      BRAIN_DEPLOY_DIR: deploy,
      BRAIN_ENV_FILE: join(deploy, ".env"),
      BRAIN_BOOTH_URL: "https://booth.example.com",
      BRAIN_TOKEN: "brain_tok_frombundle",
    };
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      render_env brain.customer.example >/dev/null
      first_app=$(grep BRAIN_APP_DATABASE_URL "${env.BRAIN_ENV_FILE}")
      render_env brain.customer.example >/dev/null
      second_app=$(grep BRAIN_APP_DATABASE_URL "${env.BRAIN_ENV_FILE}")
      echo "PERMS=$(stat -c '%a' "${env.BRAIN_ENV_FILE}" 2>/dev/null || stat -f '%A' "${env.BRAIN_ENV_FILE}" 2>/dev/null)"
      [ "$first_app" = "$second_app" ] && echo STABLE || echo CHANGED
      cat "${env.BRAIN_ENV_FILE}"`;
    const out = runBash(script, env);

    // every var the compose stack + migrate service require must be present
    for (const key of [
      "BRAIN_DOMAIN=brain.customer.example",
      "POSTGRES_SUPERUSER_PASSWORD=",
      "BRAIN_APP_DATABASE_URL=postgres://brain_app:",
      "BRAIN_OWNER_DATABASE_URL=postgres://brain_owner:",
      "BRAIN_SUPERUSER_DATABASE_URL=postgres://postgres:",
      "BRAIN_APP_PASSWORD=",
      "BRAIN_OWNER_PASSWORD=",
      "BRAIN_EXTERNAL_PASSWORD=",
      "BRAIN_BOOTH_URL=https://booth.example.com",
      "BRAIN_TOKEN=brain_tok_frombundle",
      "BRAIN_PUBLIC_URL=https://brain.customer.example",
      "BRAIN_OAUTH_SIGNING_KEY_B64=",
      "BRAIN_HOST_DEPLOY_DIR=",
    ]) {
      expect(out).toContain(key);
    }
    expect(out).toContain("STABLE"); // secrets are generate-once
    expect(out).toContain("PERMS=600"); // .env is not world/group readable
  });
});

describe("compose-plugin heal + atomic enrollment", () => {
  it("shq + enrollment.env round-trips all six fields, INCLUDING an apostrophe value", () => {
    const secrets = mkdtempSync(join(tmpdir(), "brain-enroll-"));
    // A GHCR token / owner name with an embedded ' must survive the write→source
    // round-trip — the previously-untested path (O'Brien).
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      write_enrollment_env "tok-123" "box-42" "canary" "keyB64==" "ghcr-user" "ghp_a'b'c"
      unset BRAIN_TOKEN BRAIN_BOX_ID BRAIN_CHANNEL BRAIN_GHCR_TOKEN BRAIN_GHCR_USER BRAIN_BOOTH_PUBLIC_KEY_B64
      load_enrollment >/dev/null 2>&1
      echo "T=$BRAIN_TOKEN|B=$BRAIN_BOX_ID|C=$BRAIN_CHANNEL|K=$BRAIN_BOOTH_PUBLIC_KEY_B64|U=$BRAIN_GHCR_USER|G=$BRAIN_GHCR_TOKEN|CACHED=$BRAIN_ENROLL_CREDS_CACHED"`;
    const out = runBash(script, { BRAIN_SECRETS_DIR: secrets }).trim();
    expect(out).toBe("T=tok-123|B=box-42|C=canary|K=keyB64==|U=ghcr-user|G=ghp_a'b'c|CACHED=1");
  });

  it("enrollment.env perms are 0600 (creds never world/group readable)", () => {
    const secrets = mkdtempSync(join(tmpdir(), "brain-enroll-"));
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
       write_enrollment_env "t" "b" "stable" "k" "u" "g"
       stat -c '%a' "${secrets}/enrollment.env" 2>/dev/null || stat -f '%A' "${secrets}/enrollment.env"`,
      { BRAIN_SECRETS_DIR: secrets },
    ).trim();
    expect(out).toBe("600");
  });

  it("ghcr_login on a box with EXISTING ghcr.io auth WARNS + keeps creds when the cached token is rejected (never bricks)", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const cfgDir = join(home, "docker");
    mkdirSync(cfgDir, { recursive: true });
    // A working config already exists; the login FAILS (rotated shared PAT).
    writeFileSync(join(cfgDir, "config.json"), '{"auths":{"ghcr.io":{"auth":"old"}}}');
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      docker() { if [ "$1" = login ]; then cat >/dev/null; return 1; fi; return 0; }
      ghcr_login 2>&1 && echo RETURNED_ZERO`;
    const out = runBash(script, {
      BRAIN_GHCR_TOKEN: "ghp_rotated",
      BRAIN_GHCR_USER: "brain-bot",
      BRAIN_DOCKER_CONFIG_DIR: cfgDir,
    });
    expect(out).toContain("may have rotated");
    expect(out).toContain("RETURNED_ZERO"); // returned 0 — did NOT die
  });

  it("ghcr_login on a FRESH box (no cached auth) DIES when the token is rejected", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-install-"));
    const cfgDir = join(home, "docker"); // no config.json → fresh
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      docker() { if [ "$1" = login ]; then cat >/dev/null; return 1; fi; return 0; }
      ghcr_login`;
    expect(() =>
      runBash(script, {
        BRAIN_GHCR_TOKEN: "ghp_bad",
        BRAIN_GHCR_USER: "brain-bot",
        BRAIN_DOCKER_CONFIG_DIR: cfgDir,
      }),
    ).toThrow(/docker login ghcr.io failed/);
  });

  it("ensure_compose_plugin DIES on a sha256 mismatch (never installs an unverified binary)", () => {
    // Stub curl to write WRONG bytes to the -o target; uname → x86_64.
    const script = `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
      uname() { echo x86_64; }
      curl() { out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; shift; done; printf 'WRONG BYTES' > "$out"; return 0; }
      ensure_compose_plugin`;
    expect(() => runBash(script, {})).toThrow(/sha256 mismatch/);
  });

  it("ensure_docker heals compose ONLY when 'docker compose version' fails", () => {
    // compose present → ensure_compose_plugin must NOT run.
    const present = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
       docker() { return 0; }              # 'docker compose version' succeeds
       systemctl() { return 0; }
       ensure_compose_plugin() { echo HEAL_RAN; }
       ensure_docker 2>&1; echo DONE`,
      {},
    );
    expect(present).toContain("DONE");
    expect(present).not.toContain("HEAL_RAN");

    // compose missing → ensure_compose_plugin runs.
    const missing = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"
       docker() { case "$1" in info) return 0;; compose) return 1;; *) return 0;; esac; }
       systemctl() { return 0; }
       ensure_compose_plugin() { echo HEAL_RAN; }
       ensure_docker 2>&1; echo DONE`,
      {},
    );
    expect(missing).toContain("HEAL_RAN");
  });
});

describe("fail-closed bundle integrity", () => {
  // Build a tiny valid deploy tarball (deploy/ wrapping a compose file) so the
  // pass/allow paths can actually extract.
  function makeBundle(): { tgz: string; sha: string; deployDir: string } {
    const work = mkdtempSync(join(tmpdir(), "brain-bundle-"));
    const src = join(work, "deploy");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "docker-compose.yml"), "name: brain\n");
    const tgz = join(work, "brain-deploy.tar.gz");
    execFileSync("tar", ["-czf", tgz, "-C", work, "deploy"]);
    const sha = execFileSync("bash", ["-c", `sha256sum "${tgz}" | cut -d' ' -f1`], {
      encoding: "utf8",
    }).trim();
    return { tgz, sha, deployDir: join(work, "out") };
  }

  it("DIES on a local bundle with NO sha (the supply-chain hole is closed)", () => {
    const { tgz, deployDir } = makeBundle();
    expect(() =>
      runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; fetch_bundle`, {
        BRAIN_BUNDLE_LOCAL: tgz,
        BRAIN_DEPLOY_DIR: deployDir,
      }),
    ).toThrow(/refusing an unverified bundle/);
  });

  it("SUCCEEDS with the correct sha", () => {
    const { tgz, sha, deployDir } = makeBundle();
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; fetch_bundle 2>&1 && echo FETCH_OK`,
      { BRAIN_BUNDLE_LOCAL: tgz, BRAIN_BUNDLE_SHA256: sha, BRAIN_DEPLOY_DIR: deployDir },
    );
    expect(out).toContain("sha256 verified");
    expect(out).toContain("FETCH_OK");
  });

  it("DIES on a WRONG sha", () => {
    const { tgz, deployDir } = makeBundle();
    expect(() =>
      runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; fetch_bundle`, {
        BRAIN_BUNDLE_LOCAL: tgz,
        BRAIN_BUNDLE_SHA256: "0".repeat(64),
        BRAIN_DEPLOY_DIR: deployDir,
      }),
    ).toThrow(/checksum mismatch/);
  });

  it("BRAIN_ALLOW_UNVERIFIED_BUNDLE=1 warns and proceeds (the ONLY dev escape)", () => {
    const { tgz, deployDir } = makeBundle();
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; fetch_bundle 2>&1 && echo FETCH_OK`,
      { BRAIN_BUNDLE_LOCAL: tgz, BRAIN_ALLOW_UNVERIFIED_BUNDLE: "1", BRAIN_DEPLOY_DIR: deployDir },
    );
    expect(out).toContain("UNVERIFIED bundle");
    expect(out).toContain("FETCH_OK");
  });
});

describe("validate_prereqs (fail fast before enroll burns the code)", () => {
  it("install mode DIES without owner name/email", () => {
    expect(() =>
      runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; validate_prereqs install`, {
        BRAIN_VERSION: "v0.1.0",
      }),
    ).toThrow(/BRAIN_BOOTSTRAP_OWNER_NAME and BRAIN_BOOTSTRAP_OWNER_EMAIL/);
  });

  it("install mode DIES with owner set but NO bundle source", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-prereq-"));
    expect(() =>
      runBash(`BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; validate_prereqs install`, {
        BRAIN_BOOTSTRAP_OWNER_NAME: "O",
        BRAIN_BOOTSTRAP_OWNER_EMAIL: "o@x.co",
        BRAIN_DEPLOY_DIR: join(home, "deploy"), // empty → no compose present
      }),
    ).toThrow(/no deploy bundle source/);
  });

  it("install mode PASSES for each valid bundle source", () => {
    const base = {
      BRAIN_BOOTSTRAP_OWNER_NAME: "O",
      BRAIN_BOOTSTRAP_OWNER_EMAIL: "o@x.co",
    };
    const sources: Record<string, string>[] = [
      { BRAIN_VERSION: "v0.1.0" },
      { BRAIN_BUNDLE_URL: "https://x/y.tgz" },
      { BRAIN_SKIP_FETCH: "1" },
    ];
    for (const src of sources) {
      const out = runBash(
        `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; validate_prereqs install && echo PREREQ_OK`,
        { ...base, ...src },
      );
      expect(out).toContain("PREREQ_OK");
    }
  });

  it("repair mode is a strict no-op (never dies, even with nothing set)", () => {
    const out = runBash(
      `BRAIN_INSTALL_LIB=1 source "${INSTALL_SH}"; validate_prereqs repair && echo REPAIR_NOOP`,
      {},
    );
    expect(out).toContain("REPAIR_NOOP");
  });
});
