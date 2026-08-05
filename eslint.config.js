import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "exports/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.claude/**",
      "docs/**",
      "**/*.config.js",
      "**/*.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // loose node scripts (build tooling) — node globals, no TS project
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // TypeScript's own compiler resolves globals (node/dom) and catches
      // undefined references — eslint's no-undef only produces false positives
      // on typed code (process/fetch/console in the dev harness). Off, per the
      // typescript-eslint recommendation.
      "no-undef": "off",
    },
  },
  {
    // Doctrine lint (CLAUDE.md connector-visibility): a connector-backed MCP
    // tool must declare requires.connector. esquery is an allowlist (no type
    // awareness) so the durable invariant lives in the doctrine guard test;
    // this is fast dev/CI feedback for the current connector deps.
    files: ["packages/mcp-tools/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'CallExpression[callee.name="tool"]:has(MemberExpression[object.name="d"][property.name=/^(google|microsoft)$/]):not(:has(Property[key.name="requires"] Property[key.name="connector"]))',
          message:
            "Connector-backed MCP tool must declare requires.connector (CLAUDE.md connector-visibility doctrine). New connector dep? update this regex AND the ToolDeps doctrine guard test.",
        },
      ],
    },
  },
  {
    // Doctrine lint (CLAUDE.md UI): product pages render through uiPage()
    // (packages/shared ui-theme), never a hand-rolled page shell. Detects the
    // concrete tell — a doctype/html/head in a string or template — while never
    // touching legitimate JSX shells (layout.tsx <html>, the editorial landing),
    // which are JSX elements, not string/template literals.
    files: ["apps/box/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/<!doctype html|<html[ >]|<head[ >]/i]",
          message:
            "Product pages must render through uiPage() (packages/shared ui-theme), not a hand-rolled page shell.",
        },
        {
          selector: "TemplateElement[value.raw=/<!doctype html|<html[ >]|<head[ >]/i]",
          message:
            "Product pages must render through uiPage() (packages/shared ui-theme), not a hand-rolled page shell.",
        },
      ],
    },
  },
);
