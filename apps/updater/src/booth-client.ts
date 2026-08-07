import { stripTrailingSlashes } from "@brain/shared";
import { verifiedControl, type VerifiedControl } from "./verify.js";
import type { ReleaseEntry } from "./versions.js";

/**
 * The updater's booth transport (delivery = pull). Two calls, both
 * brain-token authenticated, both fail-soft (a booth blip must skip a tick,
 * never crash the loop — the caller catches):
 *   POST /v1/heartbeat → { kill, desired_version } (+ a signed control blob;
 *                        the kill-switch client verifies it for the BOX, and
 *                        the updater verifies it for the operator restart op —
 *                        the one field that drives a side effect here)
 *   GET  /v1/releases  → the append-only publish-ordered release list.
 */

export interface HeartbeatReport {
  readonly currentVersion: string;
  readonly healthy: boolean;
  /** host root-disk usage percent (0–100); omitted when unreadable. */
  readonly diskPctUsed?: number;
  /** the box is stalled VERIFYING an update (transient defer), not latched —
   *  visible in the console so an outage is diagnosable, not silent. */
  readonly updateStalled?: boolean;
  readonly updateStalledVersion?: string;
  /** consecutive polls spent deferring that version — the booth pages on a
   *  stall that stops looking like a blip. */
  readonly updateStalledPolls?: number;
}

/** What runTick needs from a release feed — the booth or GitHub Releases. */
export interface ReleaseFeed {
  heartbeat(report: HeartbeatReport): Promise<BoothHeartbeat>;
  listReleases(): Promise<ReleaseEntry[]>;
}

export interface BoothHeartbeat {
  readonly kill: "live" | "off";
  readonly desiredVersion: string | null;
  /**
   * Operator restart op — from the VERIFIED signed control only, or
   * null when there is none to trust (key unconfigured, envelope absent /
   * tampered / stale, booth predates the op). Null ≠ generation 0: the caller
   * must never adopt a mark it didn't verify.
   */
  readonly control: VerifiedControl | null;
}

export class BoothClient implements ReleaseFeed {
  constructor(
    private readonly boothUrl: string,
    private readonly brainToken: string,
    /** booth Ed25519 public key (PEM); absent → restart ops are ignored. */
    private readonly boothPublicKeyPem?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${stripTrailingSlashes(this.boothUrl)}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.brainToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`booth ${path} → ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async heartbeat(report: HeartbeatReport): Promise<BoothHeartbeat> {
    // Ride the box's configured domain up on every heartbeat so the booth
    // registry shows the real domain rather than whatever hostname it enrolled
    // with (e.g. a bare IP). Empty/unset → omitted, booth keeps the old value.
    const domain = process.env.BRAIN_DOMAIN?.trim();
    const body = (await this.call("/v1/heartbeat", {
      method: "POST",
      body: JSON.stringify(domain ? { ...report, domain } : report),
    })) as { kill?: unknown; desired_version?: unknown };
    return {
      kill: body.kill === "off" ? "off" : "live",
      desiredVersion: typeof body.desired_version === "string" ? body.desired_version : null,
      control: verifiedControl(this.boothPublicKeyPem, body),
    };
  }

  async listReleases(): Promise<ReleaseEntry[]> {
    const body = (await this.call("/v1/releases", { method: "GET" })) as {
      releases?: readonly {
        version?: unknown;
        image_digest?: unknown;
        channel?: unknown;
        yanked?: unknown;
      }[];
    };
    const rows = body.releases ?? [];
    const out: ReleaseEntry[] = [];
    for (const r of rows) {
      if (typeof r.version !== "string" || typeof r.image_digest !== "string") {
        throw new Error("booth /v1/releases returned a malformed entry");
      }
      out.push({
        version: r.version,
        imageDigest: r.image_digest,
        channel: typeof r.channel === "string" ? r.channel : "stable",
        yanked: r.yanked === true,
      });
    }
    return out;
  }
}
