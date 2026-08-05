/**
 * A tiny LCS diff used by the rich edit-history view. Works on arrays of
 * tokens (words for titles, lines for bodies) so the same routine renders both
 * an inline word diff and a line-by-line body diff.
 */

export type DiffKind = "same" | "add" | "del";
export interface DiffOp {
  kind: DiffKind;
  value: string;
}

/** Longest-common-subsequence diff of two token arrays. */
export function diffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", value: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", value: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", value: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", value: a[i++]! });
  while (j < m) out.push({ kind: "add", value: b[j++]! });
  return out;
}

/** Split into words + the whitespace between them, so a rejoin is faithful. */
export function wordTokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** Split into lines (newline stripped). */
export function lineTokens(s: string): string[] {
  return s.length === 0 ? [] : s.split("\n");
}

/** True when the two strings are byte-identical after trimming trailing ws. */
export function unchanged(a: string | null, b: string | null): boolean {
  return (a ?? "") === (b ?? "");
}
