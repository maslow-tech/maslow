import type { BoothHeartbeat, HeartbeatReport, ReleaseFeed } from "./booth-client.js";
import { parseSemver, type Semver } from "./versions.js";
import type { ReleaseEntry } from "./versions.js";

/**
 * The standalone release feed: GitHub Releases instead of a fleet control
 * plane. Same duck-type as BoothClient (heartbeat + listReleases), so runTick
 * cannot tell them apart — but where the booth TELLS a box its desired
 * version, this client computes it locally as the newest non-yanked release on
 * its channel (the "channel head"). kill is always "live" and control is
 * always null: a standalone box has no operator plane, so there is nothing to
 * verify and nothing to obey.
 *
 * A release is eligible only if it carries a `release.json` asset
 * ({version, image_digest, channel}), uploaded by release.yml. Releases
 * without one (drafts, pre-OSS tags, manual uploads) are skipped — never
 * guessed at. Yanking = deleting the GitHub Release: the entry disappears
 * from the feed and the anti-rollback floor keeps boxes from sliding back.
 *
 * Rate limits: the unauthenticated GitHub API allows 60 requests/hour/IP.
 * One list call + at most ASSET_FETCH_LIMIT asset fetches per tick keeps a
 * 15-minute poll comfortably inside that; older releases than the newest few
 * are below any live box's floor anyway.
 */

const ASSET_FETCH_LIMIT = 8;
const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

interface GithubReleaseRow {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly assets?: readonly { name?: unknown; browser_download_url?: unknown }[];
}

export class GithubReleasesClient implements ReleaseFeed {
  /** last successful list — heartbeat derives the channel head from it. */
  private lastList: ReleaseEntry[] | null = null;

  constructor(
    /** "owner/repo", e.g. "maslow-tech/maslow". */
    private readonly repo: string,
    private readonly channel = "stable",
    private readonly timeoutMs = 10_000,
    private readonly apiBase = "https://api.github.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(url: string, accept: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept, "user-agent": "maslow-updater" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`github ${url} → ${res.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async listReleases(): Promise<ReleaseEntry[]> {
    const res = await this.get(
      `${this.apiBase}/repos/${this.repo}/releases?per_page=30`,
      "application/vnd.github+json",
    );
    const rows = (await res.json()) as GithubReleaseRow[];
    if (!Array.isArray(rows)) throw new Error("github releases list is not an array");

    // Newest-first by the tag's own semver (never API order), then fetch
    // release.json for at most the newest few eligible rows.
    const tagged: { tag: string; sv: Semver; url: string }[] = [];
    for (const row of rows) {
      if (row.draft === true) continue;
      if (typeof row.tag_name !== "string") continue;
      const sv = parseSemver(row.tag_name);
      if (sv === null) continue;
      const asset = (row.assets ?? []).find((a) => a.name === "release.json");
      if (asset === undefined || typeof asset.browser_download_url !== "string") continue;
      tagged.push({ tag: row.tag_name, sv, url: asset.browser_download_url });
    }
    tagged.sort((a, b) => compareSemverDesc(a.sv, b.sv));

    const out: ReleaseEntry[] = [];
    for (const t of tagged.slice(0, ASSET_FETCH_LIMIT)) {
      const body = (await (await this.get(t.url, "application/json")).json()) as {
        version?: unknown;
        image_digest?: unknown;
        channel?: unknown;
      };
      if (body.version !== t.tag) {
        throw new Error(`release.json for ${t.tag} names a different version`);
      }
      if (typeof body.image_digest !== "string" || !DIGEST_SHAPE.test(body.image_digest)) {
        throw new Error(`release.json for ${t.tag} has a malformed image digest`);
      }
      out.push({
        version: t.tag,
        imageDigest: body.image_digest,
        channel: typeof body.channel === "string" ? body.channel : "stable",
        yanked: false,
      });
    }
    this.lastList = out;
    return out;
  }

  async heartbeat(_report: HeartbeatReport): Promise<BoothHeartbeat> {
    // runTick always lists before it heartbeats, so lastList is this tick's
    // fresh view; if the list failed, hold (desired null) rather than guess.
    const head = (this.lastList ?? []).filter((r) => !r.yanked && r.channel === this.channel).at(0);
    return { kill: "live", desiredVersion: head?.version ?? null, control: null };
  }
}

/** Descending semver: newest first. Prerelease ranks below its final (semver §11). */
function compareSemverDesc(a: Semver, b: Semver): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  if (a[2] !== b[2]) return b[2] - a[2];
  return b[3] - a[3];
}
