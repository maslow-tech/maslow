/**
 * Shared fixtures for the real-browser suites.
 *
 * Extracted from `mobile.spec.ts` when the desktop suite arrived, so the two
 * cannot drift on how a session is established — a second copy of `signIn` is
 * how one suite ends up silently testing a logged-out shell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo } from "@playwright/test";

const TOKENS_PATH = fileURLToPath(new URL("../../dev/dev-tokens.json", import.meta.url));

interface DevToken {
  permission: string;
  name: string;
  token: string;
  accountId: string;
}

function devTokens(): DevToken[] {
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as DevToken[];
  } catch {
    throw new Error(
      `no dev tokens: start the dev box (pnpm --filter @brain/box dev:box) so ${TOKENS_PATH} exists`,
    );
  }
}

export function tokenFor(permission: string): DevToken {
  const found = devTokens().find((t) => t.permission === permission);
  if (!found) throw new Error(`dev box has no ${permission} token`);
  return found;
}

export function ownerToken(): string {
  const fromEnv = process.env.BRAIN_E2E_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return tokenFor("owner").token;
}

/**
 * Sign in with an explicit token and land on the shell.
 *
 * Session is a cookie, so this runs per browser CONTEXT — which is exactly what
 * makes a two-person multiplayer test possible: two contexts, two tokens, two
 * genuinely separate sessions against one box.
 */
export async function signInAs(page: Page, token: string, path = "/"): Promise<void> {
  await page.goto(path);
  const field = page.locator("#tok");
  const shell = page.getByRole("navigation", { name: "Databases" }).or(page.locator("main"));
  // The SPA mounts AFTER goto resolves. A bare isVisible() answers instantly,
  // so on a slow runner it runs before React has rendered the login form,
  // skips the fill, and then waits forever for a shell that never signs in.
  // Wait for whichever surface actually mounts before deciding.
  await expect(field.or(shell).first()).toBeVisible();
  if (await field.isVisible()) {
    await field.fill(token);
    await page.getByRole("button", { name: /sign in/i }).click();
  }
  await expect(shell.first()).toBeVisible();
}

export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
