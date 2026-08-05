#!/usr/bin/env node
/**
 * smoke-client-path.mjs — headless-Chromium driver:
 * login → save branding → read-back against the freshly-built box image. The
 * load-bearing assertion is that POST /api/v1/branding returns 200: the client
 * must attach x-csrf-token from the brain_csrf cookie, and the server's
 * double-submit check must pass — a Secure/SameSite cookie flag that breaks the
 * read, or a missing header, regresses to 403. Chromium treats http://localhost
 * as a secure context, so the Secure cookie is stored + read WITHOUT TLS,
 * exercising prod flags verbatim. Non-zero exit on any failed assertion.
 *
 *   node deploy/smoke-client-path.mjs <baseUrl> <ownerToken>
 */
import { chromium } from "playwright";

const [baseUrl, token] = process.argv.slice(2);
if (!baseUrl || !token) {
  console.error("usage: smoke-client-path.mjs <baseUrl> <ownerToken>");
  process.exit(2);
}

const unique = `Smoke Co ${Date.now()}`;

const fail = (msg) => {
  console.error(`smoke-client-path: FAIL — ${msg}`);
  process.exitCode = 1;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // Surface a CSRF-rejection body loudly if it ever appears.
  page.on("response", (res) => {
    if (res.url().includes("/api/v1/branding")) {
      console.log(`branding ${res.request().method()} → ${res.status()}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // Login — paste the token into the single password input, click "Sign in →".
  await page.locator('input[type="password"]').fill(token);
  await page.getByRole("button", { name: /sign in/i }).click();

  // App shell — the Home greeting appears once the session cookie is set.
  await page.getByText(/Good (morning|afternoon|evening)/).waitFor({ timeout: 30_000 });

  // Save branding and REQUIRE the POST to be 200 (a missing csrf header → 403).
  await page.goto(`${baseUrl}/branding`, { waitUntil: "domcontentloaded" });
  await page.locator("#brand-name").fill(unique);
  const [saveRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/v1/branding") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: /^Save$/ }).click(),
  ]);
  if (saveRes.status() !== 200)
    fail(`POST /api/v1/branding was ${saveRes.status()} (expected 200)`);

  const body = await page.content();
  if (/csrf check failed/i.test(body)) fail("a 'csrf check failed' surfaced on the page");

  // End-to-end read-back — the unique name must survive a reload.
  //
  // Wait for the VALUE, not just the element. `domcontentloaded` fires before the
  // SPA's GET /api/v1/branding resolves, and waitFor() only proves #brand-name
  // EXISTS — so reading inputValue() straight after it races the fetch and yields
  // "" on a slow runner. That false negative has failed real release builds
  // with `got ""` while branding was persisting fine.
  //
  // This still fails a genuine non-persist: the poll times out and we then report
  // what the API itself returned, which distinguishes "the fetch never populated
  // the input" from "the server really did not store it".
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#brand-name").waitFor({ timeout: 15_000 });
  try {
    await page.waitForFunction(
      (expected) =>
        /** @type {HTMLInputElement | null} */ (document.querySelector("#brand-name"))?.value ===
        expected,
      unique,
      { timeout: 15_000 },
    );
  } catch {
    const persisted = await page.locator("#brand-name").inputValue();
    const served = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/v1/branding", { credentials: "include" });
        return `${r.status} ${(await r.text()).slice(0, 200)}`;
      } catch (e) {
        return `fetch failed: ${String(e)}`;
      }
    });
    fail(
      `branding did not persist: input showed "${persisted}", expected "${unique}"; ` +
        `GET /api/v1/branding served: ${served}`,
    );
  }

  if (!process.exitCode)
    console.log("smoke-client-path: OK — login + CSRF-guarded write + read-back");
} finally {
  await browser.close();
}
