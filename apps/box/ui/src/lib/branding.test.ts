import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding, applyInstallIcon, DEFAULT_INSTALL_ICON } from "./branding";

/**
 * The installed (home-screen) icon and app title follow the org's branding, and
 * fall back to our own pixel mark whenever the branded bytes can't be trusted —
 * a broken apple-touch-icon makes iOS install a screenshot of the page, so
 * "keep ours" is the only clean failure mode.
 */
describe("branding → PWA install chrome", () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<link rel="icon" href="/favicon.ico" />' +
      `<link rel="apple-touch-icon" sizes="180x180" href="${DEFAULT_INSTALL_ICON}" />` +
      '<meta name="apple-mobile-web-app-title" content="Brain" />';
  });

  const appleHref = () =>
    document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.getAttribute("href");
  const appTitle = () =>
    document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.content;

  it("keeps our icon when the org has uploaded no branding", async () => {
    await applyInstallIcon(false, vi.fn());
    expect(appleHref()).toBe(DEFAULT_INSTALL_ICON);
  });

  it("uses the org favicon once it proves it decodes as an image", async () => {
    const probe = vi.fn(async () => true);
    await applyInstallIcon(true, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(appleHref()).toMatch(/^\/favicon\.ico\?v=\d+$/);
  });

  it("falls back to our icon when the branded bytes don't decode", async () => {
    await applyInstallIcon(true, async () => false);
    expect(appleHref()).toBe(DEFAULT_INSTALL_ICON);
  });

  it("reverts to our icon when branding is cleared", async () => {
    await applyInstallIcon(true, async () => true);
    expect(appleHref()).not.toBe(DEFAULT_INSTALL_ICON);
    await applyInstallIcon(false, async () => true);
    expect(appleHref()).toBe(DEFAULT_INSTALL_ICON);
  });

  it("does nothing (and never throws) when the page has no apple-touch-icon link", async () => {
    document.head.innerHTML = "";
    await expect(applyInstallIcon(true, async () => true)).resolves.toBeUndefined();
  });

  it("labels the home-screen icon with the org name, short form", () => {
    applyBranding({ name: "Maslow", hasFavicon: false });
    // The tab gets the long form; the home screen gets the bare name (iOS
    // truncates past ~12 chars, so " · brain" would eat the useful part).
    expect(document.title).toBe("Maslow · brain");
    expect(appTitle()).toBe("Maslow");
  });

  it("falls back to 'Brain' as the home-screen label when unbranded", () => {
    applyBranding({ name: null, hasFavicon: false });
    expect(appTitle()).toBe("Brain");
  });
});
