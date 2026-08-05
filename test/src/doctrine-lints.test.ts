import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// repo root = two dirs up from test/src/ — so virtual filePaths below resolve
// against the same globs eslint.config.js declares.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Prove the two doctrine `no-restricted-syntax` rules in
 * eslint.config.js actually FIRE on a crafted violation (anti-dead-lint — a
 * selector typo that silently matches nothing would make the lint a false
 * sense of coverage), and that test files are correctly ignored.
 */
const eslint = new ESLint({ cwd: repoRoot });

async function messages(code: string, relPath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  return (res?.messages ?? []).map((m) => m.message);
}

describe("doctrine lints fire on real violations", () => {
  it("Rule 1: a connector tool without requires.connector is flagged", async () => {
    const msgs = await messages(
      "const x = tool({ handler: async (d) => d.google.call() });\n",
      "packages/mcp-tools/src/__probe.ts",
    );
    expect(msgs.some((m) => /requires\.connector/.test(m))).toBe(true);
  });

  it("Rule 2: a hand-rolled page shell string in a product surface is flagged", async () => {
    const msgs = await messages(
      'export const p = "<!doctype html><html><head></head></html>";\n',
      "apps/box/src/__probe.ts",
    );
    expect(msgs.some((m) => /uiPage/.test(m))).toBe(true);
  });

  it("ignores test files (the ships-red false-positive class)", async () => {
    const msgs = await messages(
      'const s = "<html>Service Unavailable</html>";\n',
      "apps/box/src/connectors/__probe.test.ts",
    );
    expect(msgs.some((m) => /uiPage/.test(m))).toBe(false);
  });
});
