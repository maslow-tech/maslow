/**
 * Per-customer white-label branding, stored owner-side in box_kv (migration
 * 0023) so it survives restarts + self-updates and needs no new table.
 *
 * Two keys:
 *   brand_name    — the customer's display name (sidebar, login, tab title).
 *   brand_favicon — a data: URL (image/png|svg+xml|x-icon|jpeg) for the tab
 *                   icon shown across the dashboard, /mcp, /oauth — every route
 *                   on the box's origin, since one /favicon.ico covers them all.
 *
 * Reads go through the brain_owner client (box_kv grants nothing to brain_app),
 * the same client the boot path already uses for the session secret. Nothing
 * here is brain content — it's box-local chrome.
 */
import type { Client, Pool } from "pg";

/** What the public branding endpoint hands the UI. Secrets: none — the favicon
 *  bytes ride their own /favicon.ico route, not this JSON. */
interface BrandingPublic {
  /** null when unset — the UI falls back to its built-in default label. */
  readonly name: string | null;
  readonly hasFavicon: boolean;
}

interface FaviconBytes {
  readonly mime: string;
  readonly bytes: Buffer;
}

const NAME_KEY = "brand_name";
const FAVICON_KEY = "brand_favicon";

const MAX_NAME_LEN = 200;
/** ~192 KB of image once base64 is decoded — a favicon/logo, not a hero. */
const MAX_FAVICON_DATAURL_LEN = 256 * 1024;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jpeg",
]);

async function kvGet(owner: Client | Pool, key: string): Promise<string | null> {
  try {
    const r = await owner.query<{ value: string }>("SELECT value FROM box_kv WHERE key = $1", [
      key,
    ]);
    return r.rows[0]?.value ?? null;
  } catch {
    // Pre-0023 box mid-migrate: table not there yet. Treat as unset, never throw
    // — branding is chrome; a missing table must not 500 the whole dashboard.
    return null;
  }
}

async function kvSet(owner: Client | Pool, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await owner.query("DELETE FROM box_kv WHERE key = $1", [key]);
    return;
  }
  await owner.query(
    `INSERT INTO box_kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** The public view — safe to serve unauthenticated (it's what the login screen
 *  needs before anyone is signed in). */
export async function getBrandingPublic(owner: Client | Pool): Promise<BrandingPublic> {
  // Sequential (not Promise.all) so an anonymous login-screen request holds at
  // most ONE checkout of the small ownerKv pool.
  const name = await kvGet(owner, NAME_KEY);
  const favicon = await kvGet(owner, FAVICON_KEY);
  return { name: name && name.trim() ? name : null, hasFavicon: !!favicon };
}

/** Decode the stored data: URL into servable bytes, or null if unset/corrupt. */
export async function getFavicon(owner: Client | Pool): Promise<FaviconBytes | null> {
  const dataUrl = await kvGet(owner, FAVICON_KEY);
  if (!dataUrl) return null;
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1]!;
  if (!ALLOWED_MIME.has(mime)) return null;
  try {
    return { mime, bytes: Buffer.from(m[2]!, "base64") };
  } catch {
    return null;
  }
}

export interface BrandingUpdate {
  /** undefined = leave as-is; "" or null = clear back to default. */
  readonly name?: string | null;
  /** undefined = leave as-is; null = clear; a data: URL = set. */
  readonly faviconDataUrl?: string | null;
}

/** Validate + persist an owner's branding change. Throws a plain Error with a
 *  human message on bad input (callers map it to a 400). */
export async function setBranding(owner: Client | Pool, update: BrandingUpdate): Promise<void> {
  if (update.name !== undefined) {
    const name = (update.name ?? "").trim();
    if (name.length > MAX_NAME_LEN) {
      throw new Error(`name must be ${MAX_NAME_LEN} characters or fewer`);
    }
    await kvSet(owner, NAME_KEY, name === "" ? null : name);
  }
  if (update.faviconDataUrl !== undefined) {
    const url = update.faviconDataUrl;
    if (url === null || url === "") {
      await kvSet(owner, FAVICON_KEY, null);
    } else {
      if (url.length > MAX_FAVICON_DATAURL_LEN) {
        throw new Error("image is too large (max ~192 KB)");
      }
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (!m || !ALLOWED_MIME.has(m[1]!)) {
        throw new Error("image must be a base64 data URL (png, svg, ico, or jpeg)");
      }
      await kvSet(owner, FAVICON_KEY, url);
    }
  }
}
