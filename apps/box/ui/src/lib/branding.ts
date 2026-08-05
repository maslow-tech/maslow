import type { Branding } from "./api";

/** The label shown when a customer hasn't set their own name. */
export const DEFAULT_BRAND = "Company brain";

/** Our own home-screen icon — the pixel mark, shipped in public/icons/. */
export const DEFAULT_INSTALL_ICON = "/icons/apple-touch-icon.png";

/** Apply branding to the document chrome: tab title + favicon + the
 *  home-screen (install) icon and app title. Idempotent — safe to call on every
 *  branding fetch/update. The favicon is always served from /favicon.ico
 *  (owner-set, box_kv); we bust the cache with a token so a freshly-uploaded
 *  icon shows without a hard refresh. */
export function applyBranding(b: Branding): void {
  document.title = b.name ? `${b.name} · brain` : "Company brain";
  applyInstallTitle(b.name);
  void applyInstallIcon(b.hasFavicon);

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!b.hasFavicon) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = `/favicon.ico?v=${Date.now()}`;
}

/** The name iOS writes under the home-screen icon. Short — the OS truncates
 *  past ~12 characters — so it's the org's own name, never "<name> · brain". */
function applyInstallTitle(name: string | null): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (meta) meta.content = name?.trim() || "Brain";
}

/** Does this URL decode as a raster image in this browser? */
function loadsAsImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image !== "function") return resolve(false);
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/**
 * Point the home-screen icon at the org's branding when there is one.
 *
 * iOS reads `link[rel=apple-touch-icon]` at add-to-home-screen time, so
 * swapping the href live is enough — the user is on the page when they install.
 * We only swap after PROVING the branded bytes decode as an image: the owner
 * may have uploaded an SVG or an .ico (both accepted for the tab favicon,
 * neither reliable for a home-screen icon), and a broken apple-touch-icon does
 * not fall back to the previous link — iOS silently installs a screenshot of
 * the page. On any doubt we keep our own pixel mark, which is the clean
 * fallback. Android/Chrome installs read the manifest icons instead; those stay
 * ours, since a manifest cannot be rewritten from the client under this CSP.
 */
export async function applyInstallIcon(
  hasFavicon: boolean,
  probe: (src: string) => Promise<boolean> = loadsAsImage,
): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!link) return;
  if (!hasFavicon) {
    link.setAttribute("href", DEFAULT_INSTALL_ICON);
    return;
  }
  const branded = `/favicon.ico?v=${Date.now()}`;
  link.setAttribute("href", (await probe(branded)) ? branded : DEFAULT_INSTALL_ICON);
}
