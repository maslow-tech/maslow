#!/usr/bin/env node
/**
 * Generate the PWA icon set into apps/box/ui/public/icons/.
 *
 * Checked in (both the generator AND its output) on purpose: the icons ship
 * inside the box image and must resolve on the box's own origin under the
 * strict CSP — no CDN, no build-time network, no image toolchain in CI. Node's
 * zlib is the only dependency, so `node scripts/gen-icons.mjs` reproduces the
 * committed bytes on any machine.
 *
 * The mark is the pixel "M" from the wordmark (Geist Pixel, the brand display
 * face) drawn as flat blocks — a font would drag a webfont into the build for
 * one glyph. White on the dark-skin ground, #060608, which reads on both a
 * light and a dark home screen; the glyph sits inside the central 50% of the
 * canvas, well within the maskable safe zone (a circle of 80% diameter), so
 * Android's circle/squircle crop never clips it.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

/** dark-skin ground (--ground in index.css) + the wordmark's ink. */
const GROUND = [0x06, 0x06, 0x08];
const INK = [0xff, 0xff, 0xff];

/** The pixel "M", 7 columns x 7 rows. */
const GLYPH = ["X.....X", "XX...XX", "X.X.X.X", "X..X..X", "X.....X", "X.....X", "X.....X"];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGB rows as an 8-bit truecolour PNG. */
function encodePng(size, pixel) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = rowStart + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function icon(size) {
  // Glyph box = the central 50% of the canvas; each glyph pixel is 1/5 of that.
  const box = Math.round(size * 0.5);
  const cell = box / GLYPH[0].length;
  const originX = (size - box) / 2;
  const originY = (size - box) / 2;
  return encodePng(size, (x, y) => {
    const gx = Math.floor((x - originX) / cell);
    const gy = Math.floor((y - originY) / cell);
    const row = gy >= 0 && gy < GLYPH.length ? GLYPH[gy] : null;
    return row && gx >= 0 && gx < row.length && row[gx] === "X" ? INK : GROUND;
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), icon(size));
}
// iOS reads this one at add-to-home-screen time; same art, its own stable name.
writeFileSync(join(OUT_DIR, "apple-touch-icon.png"), icon(180));
process.stdout.write(`wrote 4 icons to ${OUT_DIR}\n`);
