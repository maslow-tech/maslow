#!/usr/bin/env node
/**
 * Minify every FIRST-PARTY js artifact inside a `pnpm deploy`ed prod tree
 * (deploy/Dockerfile*, anti-reverse-engineering C1): the app's own dist plus
 * the @brain/* workspace packages' dist inside node_modules. Per-file and in
 * place — module structure, imports, and resolution are untouched, so runtime
 * behavior is identical; comments and readable identifiers are gone, and no
 * sourcemaps ship. Third-party node_modules are public code and stay as-is.
 *
 * Usage: node scripts/minify-dist.mjs /prod/box
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";

const root = process.argv[2];
if (!root) {
  console.error("usage: minify-dist.mjs <deployed-tree>");
  process.exit(1);
}

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsFiles(p);
    else if (name.endsWith(".js")) yield p;
  }
}

const targets = [join(root, "dist")];
const scoped = join(root, "node_modules", "@brain");
try {
  for (const pkg of readdirSync(scoped)) targets.push(join(scoped, pkg, "dist"));
} catch {
  // no workspace deps in this tree (e.g. the updater) — fine
}

let files = 0;
let before = 0;
let after = 0;
for (const dir of targets) {
  let entries;
  try {
    entries = [...jsFiles(dir)];
  } catch {
    continue; // target absent
  }
  for (const file of entries) {
    const src = readFileSync(file, "utf8");
    const out = transformSync(src, { minify: true, legalComments: "none" }).code;
    writeFileSync(file, out);
    files += 1;
    before += src.length;
    after += out.length;
  }
}
console.log(
  `minified ${files} files: ${(before / 1024).toFixed(0)}KiB -> ${(after / 1024).toFixed(0)}KiB`,
);
if (files === 0) {
  console.error("minify-dist: nothing minified — wrong path?");
  process.exit(1);
}
