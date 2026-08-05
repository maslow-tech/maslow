/**
 * `pixi.js/unsafe-eval` is a SIDE-EFFECT-ONLY subpath: importing it swaps
 * Pixi's `new Function` code generators for interpreted equivalents so the
 * renderer starts under `script-src 'self'` (see `lib/graph/renderer.ts` for
 * why that CSP is not negotiable). Pixi ships the runtime but no types for the
 * subpath, and the module has no exports worth typing — it installs itself on
 * import.
 */
declare module "pixi.js/unsafe-eval";
