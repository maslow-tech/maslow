/**
 * Base-URL normalisation shared by every caller that concatenates a path onto a
 * configured (or header-derived) origin.
 */

/**
 * Drop the trailing `/` run from a base URL — the exact behaviour of
 * `replace(/\/+$/, "")`, written as a loop because an anchored `+` backtracks
 * polynomially on a long slash run (CodeQL js/polynomial-redos) and some of
 * these inputs arrive in a request header.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f /* "/" */) end--;
  return end === url.length ? url : url.slice(0, end);
}
