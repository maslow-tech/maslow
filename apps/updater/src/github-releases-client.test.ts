import { describe, expect, it } from "vitest";
import { GithubReleasesClient } from "./github-releases-client.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

type Row = {
  tag_name?: unknown;
  draft?: boolean;
  assets?: { name: string; browser_download_url: string }[];
};

/** A fake GitHub: one list response + per-URL release.json bodies. */
function fakeGithub(rows: Row[], assets: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/releases?") ? rows : assets[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function row(tag: string, url: string, extra: Partial<Row> = {}): Row {
  return {
    tag_name: tag,
    draft: false,
    assets: [{ name: "release.json", browser_download_url: url }],
    ...extra,
  };
}

describe("GithubReleasesClient", () => {
  it("builds entries from release.json assets, newest-first by semver", async () => {
    const { fetchImpl } = fakeGithub(
      // API order is deliberately scrambled — semver order must win.
      [row("v0.1.0", "https://dl/v0.1.0"), row("v0.2.0", "https://dl/v0.2.0")],
      {
        "https://dl/v0.1.0": { version: "v0.1.0", image_digest: DIGEST_A, channel: "stable" },
        "https://dl/v0.2.0": { version: "v0.2.0", image_digest: DIGEST_B, channel: "stable" },
      },
    );
    const client = new GithubReleasesClient("o/r", "stable", 1000, "https://api", fetchImpl);
    const list = await client.listReleases();
    expect(list.map((r) => r.version)).toEqual(["v0.2.0", "v0.1.0"]);
    expect(list[0].imageDigest).toBe(DIGEST_B);
    const hb = await client.heartbeat({ currentVersion: "v0.1.0", healthy: true });
    expect(hb).toEqual({ kill: "live", desiredVersion: "v0.2.0", control: null });
  });

  it("skips drafts, non-semver tags, and releases without a release.json asset", async () => {
    const { fetchImpl } = fakeGithub(
      [
        row("v0.3.0", "https://dl/v0.3.0", { draft: true }),
        row("models-1", "https://dl/models-1"),
        { tag_name: "v0.4.0", draft: false, assets: [] },
        row("v0.1.0", "https://dl/v0.1.0"),
      ],
      { "https://dl/v0.1.0": { version: "v0.1.0", image_digest: DIGEST_A, channel: "stable" } },
    );
    const client = new GithubReleasesClient("o/r", "stable", 1000, "https://api", fetchImpl);
    const list = await client.listReleases();
    expect(list.map((r) => r.version)).toEqual(["v0.1.0"]);
  });

  it("refuses a malformed digest and a version mismatch", async () => {
    const bad = fakeGithub([row("v0.1.0", "https://dl/v0.1.0")], {
      "https://dl/v0.1.0": { version: "v0.1.0", image_digest: "sha256:short", channel: "stable" },
    });
    const c1 = new GithubReleasesClient("o/r", "stable", 1000, "https://api", bad.fetchImpl);
    await expect(c1.listReleases()).rejects.toThrow(/malformed image digest/);

    const swapped = fakeGithub([row("v0.1.0", "https://dl/v0.1.0")], {
      "https://dl/v0.1.0": { version: "v0.9.9", image_digest: DIGEST_A, channel: "stable" },
    });
    const c2 = new GithubReleasesClient("o/r", "stable", 1000, "https://api", swapped.fetchImpl);
    await expect(c2.listReleases()).rejects.toThrow(/different version/);
  });

  it("heartbeat holds (desired null) before any successful list and off-channel", async () => {
    const { fetchImpl } = fakeGithub([row("v0.1.0", "https://dl/v0.1.0")], {
      "https://dl/v0.1.0": { version: "v0.1.0", image_digest: DIGEST_A, channel: "canary" },
    });
    const client = new GithubReleasesClient("o/r", "stable", 1000, "https://api", fetchImpl);
    // No list yet → hold.
    expect(
      (await client.heartbeat({ currentVersion: "v0.1.0", healthy: true })).desiredVersion,
    ).toBeNull();
    await client.listReleases();
    // Only a canary release exists; a stable-channel box holds.
    expect(
      (await client.heartbeat({ currentVersion: "v0.1.0", healthy: true })).desiredVersion,
    ).toBeNull();
  });
});
