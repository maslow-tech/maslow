import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The installability contract. Every claim here is something a phone silently
 * ignores rather than errors on when it regresses — an install that quietly
 * degrades to a Safari bookmark is the exact failure this pins.
 *
 * Assets are read off disk (not rendered), because these are BUILD inputs:
 * index.html is the vite template and public/ is copied verbatim into the
 * bundle the box serves.
 */
const UI_ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(UI_ROOT, "index.html"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(UI_ROOT, "public", "manifest.webmanifest"), "utf8"),
) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

/** Read a PNG's IHDR — width/height are the two big-endian u32s at byte 16. */
function pngSize(relPath: string): { width: number; height: number; magic: string } {
  const buf = readFileSync(join(UI_ROOT, "public", relPath));
  return {
    magic: buf.subarray(1, 4).toString("ascii"),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe("index.html PWA head", () => {
  it("opts into the safe-area viewport (required by black-translucent)", () => {
    expect(html).toMatch(/<meta\s+name="viewport"[^>]*viewport-fit=cover/s);
  });

  it("links the manifest", () => {
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
  });

  it("carries the iOS standalone meta (iOS ignores the manifest)", () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="[^"]+"/);
  });

  it("ships an apple-touch-icon pointing at a real 180px PNG", () => {
    const m = /<link rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("/icons/apple-touch-icon.png");
    expect(pngSize("icons/apple-touch-icon.png")).toEqual({
      magic: "PNG",
      width: 180,
      height: 180,
    });
  });

  it("declares one theme-color per skin, matching --ground in index.css", () => {
    const colors = [...html.matchAll(/<meta name="theme-color"[^>]*>/g)].map((m) => m[0]);
    expect(colors).toHaveLength(2);
    expect(
      colors.some((c) => c.includes("prefers-color-scheme: light") && c.includes("#ffffff")),
    ).toBe(true);
    expect(
      colors.some((c) => c.includes("prefers-color-scheme: dark") && c.includes("#060608")),
    ).toBe(true);
  });

  it("adds no external asset host (the SPA CSP forbids one)", () => {
    expect(html).not.toMatch(/(href|src)="https?:\/\//);
  });
});

describe("manifest.webmanifest", () => {
  it("installs as a standalone, portrait app scoped to the whole origin", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.orientation).toBe("portrait-primary");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  it("names itself from the shipped default brand", () => {
    expect(manifest.name).toBe("Company brain");
    expect(manifest.short_name.length).toBeGreaterThan(0);
  });

  it("colors match the skins (dark ground, as the icon art does)", () => {
    expect(manifest.background_color).toBe("#060608");
    expect(manifest.theme_color).toBe("#060608");
  });

  it("declares 180/192/512 icons that exist on disk at those sizes", () => {
    const bySize = new Map(manifest.icons.map((i) => [i.sizes, i]));
    for (const size of [180, 192, 512]) {
      const icon = bySize.get(`${size}x${size}`);
      expect(icon, `manifest is missing a ${size}px icon`).toBeDefined();
      expect(icon!.type).toBe("image/png");
      expect(icon!.src.startsWith("/icons/")).toBe(true);
      expect(pngSize(icon!.src.replace(/^\//, ""))).toEqual({
        magic: "PNG",
        width: size,
        height: size,
      });
    }
  });

  it("marks the launcher icons maskable so Android doesn't clip the mark", () => {
    for (const size of ["192x192", "512x512"]) {
      const icon = manifest.icons.find((i) => i.sizes === size)!;
      expect(icon.purpose).toContain("maskable");
    }
  });
});
