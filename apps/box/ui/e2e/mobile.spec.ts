import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * PHASE 7 ACCEPTANCE — **the dashboard on a phone**, driven by a real browser
 * on a real iPhone profile (see playwright.config.ts: WebKit, 393x852, touch,
 * mobile user agent).
 *
 * Every other test of this SPA is jsdom. jsdom has no layout, so it cannot see
 * a row that overflows the viewport by 12px; it has no compositor, so it cannot
 * see a tap target that is 32px tall; it has no service worker, so it cannot
 * see a registration that fails because the worker was served as text/html. All
 * three are shipping bugs a customer meets on their first phone visit, and all
 * three were, before this file, only asserted about.
 *
 * So: prove it. Each case names the gesture a person performs, performs it, and
 * asserts what changed — with a screenshot attached to the report as evidence
 * rather than as decoration.
 *
 * WHAT LIVES ELSEWHERE. The service worker's hardest promise — that it can
 * never answer a navigation from cache after the box updates underneath it — is
 * proven exhaustively in `test/src/pwa.integration.test.ts`, which can boot a
 * SECOND box over the same worker and watch it converge. A browser cannot make
 * the origin change builds mid-session, so what this file proves is the half a
 * browser can: the worker really registers, really controls the page, and a
 * controlled navigation still reaches the network.
 *
 * PRECONDITIONS. The box must be serving a real vite BUILD (the config's
 * webServer does exactly that) — `vite dev` emits no sw.js and no manifest, so
 * a PWA assertion there would be about a different application. Sign-in uses
 * the dev box's seeded owner token; point BRAIN_E2E_TOKEN at another one to
 * drive a different brain.
 */

/* --------------------------------------------------------------- fixtures -- */

const TOKENS_PATH = fileURLToPath(new URL("../../dev/dev-tokens.json", import.meta.url));

function ownerToken(): string {
  const fromEnv = process.env.BRAIN_E2E_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as {
      permission: string;
      token: string;
    }[];
    const owner = tokens.find((t) => t.permission === "owner") ?? tokens[0];
    if (owner?.token) return owner.token;
  } catch {
    // fall through to the explicit failure below
  }
  throw new Error(
    `no access token: set BRAIN_E2E_TOKEN, or start the dev box (pnpm --filter @brain/box dev:box) so ${TOKENS_PATH} exists`,
  );
}

/** Sign in and land on the shell. Session is a cookie, so this runs per test. */
async function signIn(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  const field = page.locator("#tok");
  const nav = page.getByRole("navigation", { name: "Primary" });
  // The SPA mounts AFTER goto resolves. A bare isVisible() answers instantly,
  // so on a slow runner it runs before React has rendered the login form,
  // skips the fill, and then waits forever for a shell that never signs in.
  // Wait for whichever surface actually mounts before deciding.
  await expect(field.or(nav).first()).toBeVisible();
  if (await field.isVisible()) {
    await field.fill(ownerToken());
    await page.getByRole("button", { name: /sign in/i }).click();
  }
  // The phone chrome is the proof we are in: the bottom bar only exists below
  // the mobile breakpoint, so waiting for it also asserts the shell went mobile.
  await expect(nav).toBeVisible();
}

/** Attach a screenshot as evidence for the assertion just made. */
async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

/**
 * A one-finger drag, synthesized as PointerEvents with `pointerType: "touch"`.
 *
 * Playwright's touchscreen API is tap-only on WebKit, and the graph canvas
 * listens for pointerdown/pointermove/pointerup and routes anything whose
 * pointerType is "touch" into its own gesture recognizer (lib/graph/mobile.ts).
 * Dispatching those events IS the recognizer's real input path — what is
 * simulated here is the finger, not the code under test.
 */
async function touchDrag(
  target: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await target.evaluate(
    (el, args) => {
      const fire = (type: string, x: number, y: number, id = 1): void => {
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            isPrimary: id === 1,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire("pointerdown", args.from.x, args.from.y);
      for (let i = 1; i <= args.steps; i++) {
        const t = i / args.steps;
        fire(
          "pointermove",
          args.from.x + (args.to.x - args.from.x) * t,
          args.from.y + (args.to.y - args.from.y) * t,
        );
      }
      fire("pointerup", args.to.x, args.to.y);
    },
    { from, to, steps },
  );
}

/** Two fingers moving apart (or together) about a fixed midpoint. */
async function pinch(
  target: Locator,
  center: { x: number; y: number },
  fromGap: number,
  toGap: number,
): Promise<void> {
  await target.evaluate(
    (el, args) => {
      const fire = (type: string, id: number, x: number, y: number): void => {
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            isPrimary: id === 1,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      const at = (gap: number): [number, number] => [
        args.center.x - gap / 2,
        args.center.x + gap / 2,
      ];
      const [l0, r0] = at(args.fromGap);
      fire("pointerdown", 1, l0, args.center.y);
      fire("pointerdown", 2, r0, args.center.y);
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const gap = args.fromGap + (args.toGap - args.fromGap) * (i / steps);
        const [l, r] = at(gap);
        fire("pointermove", 1, l, args.center.y);
        fire("pointermove", 2, r, args.center.y);
      }
      const [l1, r1] = at(args.toGap);
      fire("pointerup", 1, l1, args.center.y);
      fire("pointerup", 2, r1, args.center.y);
    },
    { center, fromGap, toGap },
  );
}

/**
 * Wait until a canvas surface stops changing, then return its pixels.
 *
 * A force layout animates on arrival, so comparing before/after only means
 * something once "before" is genuinely still. Two rules here are both bug
 * fixes, not caution — this helper was FLAKY (roughly 1 run in 3) and the flake
 * looked exactly like a broken gesture:
 *
 *  1. **A settle needs `STABLE_FRAMES` consecutive identical frames, not one
 *     matching pair.** A force simulation passes through slow moments; two
 *     frames 500ms apart can match while the layout is still moving, and the
 *     helper would then return a "settled" image that kept changing afterwards.
 *     The subsequent comparison is then between two arbitrary points on an
 *     animation, which is a coin flip.
 *  2. **A blank canvas is not a settled canvas.** The first sample can be taken
 *     before Pixi has painted anything at all; two identical EMPTY frames
 *     satisfy any "it stopped changing" test instantly. `minWaitMs` gives the
 *     renderer its start, and the spec's own budget puts initial layout at
 *     ≤4s — so waiting is correct behaviour, not padding.
 *
 * The failing runs were the fast ones (~4s vs ~15s), which is the tell: the
 * helper returned early and the test compared two frames of the same animation.
 */
const STABLE_FRAMES = 3;

async function settledPixels(
  page: Page,
  target: Locator,
  timeoutMs = 30_000,
  minWaitMs = 1_000,
): Promise<Buffer> {
  await page.waitForTimeout(minWaitMs);
  const deadline = Date.now() + timeoutMs;
  let previous = await target.screenshot();
  let stable = 1;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const next = await target.screenshot();
    if (next.equals(previous)) {
      stable += 1;
      if (stable >= STABLE_FRAMES) return next;
    } else {
      stable = 1;
    }
    previous = next;
  }
  throw new Error("the graph never settled — cannot tell a gesture from an animation");
}

/** Every route the phone chrome can reach, plus the two parameterised ones. */
const STATIC_ROUTES = [
  "/",
  "/search",
  "/timeline",
  "/graph",
  "/members",
  "/connectors",
  "/files",
  "/private",
  "/notes",
  "/trash",
] as const;

/* ------------------------------------------------------------- the drawer -- */

test.describe("the app shell on a phone", () => {
  test("the hamburger opens the navigation drawer, and navigating dismisses it", async ({
    page,
  }, info) => {
    await signIn(page);

    const drawer = page.getByRole("dialog", { name: "Navigation" });
    // Closed, it is off-canvas and inert — present in the tree (that is what
    // makes it animate) but not reachable by a finger or a screen reader.
    await expect(drawer).toHaveAttribute("data-open", "false");

    await page.getByRole("button", { name: "Open navigation" }).tap();
    await expect(drawer).toHaveAttribute("data-open", "true");
    await expect(drawer).toBeVisible();
    // It owns the screen while it is up: focus moved inside it.
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // …and it never covers the whole screen — the caller stays visible behind
    // the scrim, which is what makes it a drawer rather than a page.
    const box = await drawer.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBeLessThan(viewport.width * 0.92);
    await shot(page, info, "drawer-open");

    // Navigating IS the dismiss — a drawer left up over the page you just asked
    // for is the classic phone-nav bug.
    await drawer
      .getByRole("link", { name: /timeline/i })
      .first()
      .tap();
    await expect(page).toHaveURL(/\/timeline$/);
    await expect(drawer).toHaveAttribute("data-open", "false");

    // Escape closes it too, and hands focus back to the button that opened it.
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await expect(drawer).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveAttribute("data-open", "false");
  });

  test("an edge swipe opens the drawer and a swipe back closes it", async ({ page }) => {
    await signIn(page);
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    const body = page.locator("body");
    const viewport = page.viewportSize()!;

    // The Shell listens on WINDOW for touchstart/move/end (see Shell.tsx) and
    // reads exactly one thing off each: `e.touches[0].clientX/clientY`. WebKit
    // refuses to construct a `Touch` or a `TouchEvent` from script ("Illegal
    // constructor"), so the event is shaped by hand around that contract — the
    // handler under test cannot tell the difference, and a synthetic finger is
    // the only finger a headless browser has.
    const swipe = async (fromX: number, toX: number): Promise<void> => {
      await body.evaluate(
        (_el, args) => {
          const fire = (type: string, x: number): void => {
            const point = { clientX: x, clientY: args.y, identifier: 1 };
            const event = new Event(type, { bubbles: true, cancelable: false });
            const points = type === "touchend" ? [] : [point];
            Object.defineProperties(event, {
              touches: { value: points },
              targetTouches: { value: points },
              changedTouches: { value: [point] },
            });
            window.dispatchEvent(event);
          };
          fire("touchstart", args.fromX);
          for (let i = 1; i <= 8; i++) {
            fire("touchmove", args.fromX + ((args.toX - args.fromX) * i) / 8);
          }
          fire("touchend", args.toX);
        },
        { fromX, toX, y: Math.round(viewport.height / 2) },
      );
    };

    await swipe(4, 220);
    await expect(drawer).toHaveAttribute("data-open", "true");
    await swipe(220, 4);
    await expect(drawer).toHaveAttribute("data-open", "false");
  });
});

/* ------------------------------------------------------- create and write -- */

test.describe("writing from a phone", () => {
  test("the bottom bar creates an object and lands in its editor", async ({ page }, info) => {
    await signIn(page);
    const title = await createNote(page);

    // Quick-create's whole point: the next keystroke goes into the new object.
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
    await expect(page.getByText(title).first()).toBeVisible();
    await shot(page, info, "created-object");
  });

  test("typing runs under the keyboard, with the formatting bar docked above it", async ({
    page,
  }, info) => {
    await signIn(page);
    // A FRESH object, not a seeded one: these cases type into the body, and
    // typing into shared demo content makes every later run start from
    // whatever the last run left behind.
    await createNote(page);

    const editor = page.locator(".editor-root .ProseMirror");
    await expect(editor).toBeVisible();
    await editor.tap();

    // The docked bar is touch's replacement for every hover affordance (bubble
    // menu, drag handle), and it only exists while the editor has focus.
    const toolbar = page.getByRole("toolbar", { name: "Formatting" });
    await expect(toolbar).toBeVisible();

    const sentence = `typed on a phone ${Date.now()}`;
    await page.keyboard.type(sentence);
    await expect(editor).toContainText(sentence);

    // The keyboard overlay's whole contract: the bar sits ABOVE the keyboard
    // (never under it, never over the caret). The layout viewport does not
    // shrink for a keyboard, so this is measured against the VISUAL viewport —
    // which is exactly the number `--editor-kb-inset` is built from.
    const bar = (await toolbar.boundingBox())!;
    const visual = await page.evaluate(() => ({
      height: window.visualViewport?.height ?? window.innerHeight,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
    }));
    expect(bar.y + bar.height).toBeLessThanOrEqual(visual.offsetTop + visual.height + 1);
    // …and the caret is not hidden behind the bar.
    const caretBottom = await editor.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return 0;
      return sel.getRangeAt(0).getBoundingClientRect().bottom;
    });
    expect(caretBottom).toBeLessThanOrEqual(bar.y + 1);
    await shot(page, info, "editor-docked-toolbar");
  });

  /**
   * THE WEBKIT REGRESSION TEST. This was red on purpose until 2026-07-22.
   *
   * `keepFocus` cancels **pointerdown** for every control in the editor's touch
   * chrome, to stop the tap from blurring the editor and taking the keyboard
   * (and the selection) with it. On Chrome that is the whole story. On WebKit —
   * iOS Safari, i.e. the only engine on the device this chrome exists for —
   * cancelling pointerdown ALSO cancels the compatibility click, so `onClick`
   * never ran and the entire touch editing chrome was inert: it drew, and
   * nothing happened when a finger used it.
   *
   * `chromeButtonProps` (BlockEditor.tsx) now runs the command on `pointerup`
   * for a non-mouse pointer and suppresses the click that may follow. This test
   * is what keeps that true: if the chrome ever goes back to waiting for a
   * click, an iPhone loses every formatting control and this goes red.
   */
  test("the docked bar's controls do something when a finger taps them", async ({ page }) => {
    await signIn(page);
    await createNote(page);

    const editor = page.locator(".editor-root .ProseMirror");
    await editor.tap();
    const toolbar = page.getByRole("toolbar", { name: "Formatting" });
    await expect(toolbar).toBeVisible();

    // Bold from the docked bar must apply to what gets typed next — the bar is
    // real editing, not decoration.
    await toolbar.getByRole("button", { name: "Bold" }).tap();
    await page.keyboard.type("bolded");
    // By text, not by tag: a body may already contain bold runs, and
    // `locator("strong")` would happily match one of those instead.
    await expect(editor.locator("strong", { hasText: "bolded" })).toHaveCount(1);

    // The touch-only "+" sheet is the replacement for a drag handle that
    // cannot survive iOS's long-press. Same tap, same silence.
    await toolbar.getByRole("button", { name: "Block actions" }).tap();
    await expect(page.getByRole("menu", { name: "Block actions" })).toBeVisible();
  });

  test("the slash menu inserts a block", async ({ page }, info) => {
    await signIn(page);
    await createNote(page);

    const editor = page.locator(".editor-root .ProseMirror");
    await editor.tap();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/todo");

    const menu = page.getByRole("listbox", { name: "Insert block" });
    await expect(menu).toBeVisible();
    await shot(page, info, "slash-menu");
    // It must be reachable on a 393px screen — a menu drawn off the right edge
    // is a menu nobody can use.
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    // Keyboard-driven insertion works: Enter runs the highlighted command.
    await page.keyboard.press("Enter");
    // The query text is consumed, and a real block replaced it.
    await expect(editor).not.toContainText("/todo");
    await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1, { timeout: 10_000 });
  });

  /** The same WebKit fix as above, reached through the slash menu instead of
   *  the bar — and the case that mattered most: a phone user has no keyboard
   *  Enter to fall back on once the software keyboard has dismissed the menu,
   *  so TAP is the only way in. */
  test("tapping a slash-menu option inserts that block", async ({ page }) => {
    await signIn(page);
    await createNote(page);

    const editor = page.locator(".editor-root .ProseMirror");
    await editor.tap();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/todo");

    const menu = page.getByRole("listbox", { name: "Insert block" });
    await expect(menu).toBeVisible();
    await menu.getByRole("option").first().tap();
    await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1, { timeout: 10_000 });
  });
});

/* --------------------------------------------------------- database views -- */

test.describe("database layouts on a phone", () => {
  test("the four layouts switch, and the board pages one column at a time", async ({
    page,
  }, info) => {
    await signIn(page);
    await page.goto("/t/opportunity");

    // Icon-only on a phone (four labelled buttons do not fit across 393px), so
    // the name survives as the accessible name and nothing is lost.
    const table = page.getByRole("button", { name: "Table" });
    await expect(table).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Board" }).tap();
    await expect(page.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const pager = page.getByRole("navigation", { name: "Board columns" });
    await expect(pager).toBeVisible();
    await shot(page, info, "board-mobile");

    // One column at a time, exactly the scroller's width — a snap page that is
    // a few pixels off drifts further with every swipe. Located by its own
    // testid: the structural `nav ~ div` sibling walk broke the moment the
    // scroller gained a positioning wrapper, and scrollBy on the wrapper is a
    // silent no-op.
    const scroller = page.getByTestId("board-scroller");
    const width = await scroller.evaluate((el) => el.clientWidth);
    const columns = await scroller.locator("section").count();
    expect(columns).toBeGreaterThan(1);
    for (const section of await scroller.locator("section").all()) {
      expect((await section.boundingBox())!.width).toBeCloseTo(width, 0);
    }

    const label = () => pager.locator("span").first().innerText();
    const first = await label();

    // The swipe. Playwright's WebKit touchscreen is tap-only, and scroll-snap
    // is resolved by the compositor rather than by a DOM listener, so the
    // gesture is issued as the scroll it produces; what is asserted is the
    // thing the swipe is FOR — that the scroller snaps to a whole column and
    // the pager follows.
    await scroller.evaluate((el) => el.scrollBy({ left: el.clientWidth, behavior: "smooth" }));
    await expect.poll(label, { timeout: 10_000 }).not.toBe(first);
    // The pager updates from the scroll listener the moment the new column
    // crosses the midpoint, so it fires WHILE the smooth scroll is still
    // running — poll for the resting position rather than reading a frame of
    // the animation. What is asserted is that it comes to rest on a whole
    // column: a snap that lands mid-column drifts further with every swipe.
    await expect
      .poll(
        async () => {
          const left = await scroller.evaluate((el) => el.scrollLeft);
          const offset = left % width;
          return Math.min(offset, width - offset) < 1;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // And the non-swipe path a screen reader (or a shaky hand) needs.
    await pager.getByRole("button", { name: "Previous column" }).tap();
    await expect.poll(label, { timeout: 10_000 }).toBe(first);

    for (const name of ["Gallery", "Calendar"] as const) {
      const button = page.getByRole("button", { name });
      if (await button.isDisabled()) continue;
      await button.tap();
      await expect(page.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
      await shot(page, info, `layout-${name.toLowerCase()}`);
      // Switching layout must never make the page wider than the phone.
      expect(await horizontalOverflow(page)).toEqual([]);
    }
  });

  test("tapping a row opens the side-peek as a full-screen sheet", async ({ page }, info) => {
    await signIn(page);
    await page.goto("/t/opportunity");

    await page.locator("table a[href^='/o/']").first().tap();
    const peek = page.getByTestId("side-peek");
    await expect(peek).toBeVisible();
    const panel = peek.getByRole("dialog", { name: "Object peek" });
    // On a phone the peek IS the screen — a 40%-width side panel on 393px
    // would be a column of hyphenated words.
    await expect(panel).toHaveAttribute("data-mobile", "true");
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeCloseTo(viewport.width, 0);
    await shot(page, info, "side-peek-mobile");

    await panel.getByRole("button", { name: "Close peek" }).tap();
    await expect(peek).toBeHidden();
  });
});

/* ------------------------------------------------------------- the graph -- */

test.describe("the graph on a phone", () => {
  /**
   * THE CSP REGRESSION TEST. This was red on purpose until 2026-07-22, and it
   * was the biggest thing this suite found: **the graph did not render on a box
   * at all**, on any device, desktop included.
   *
   * The box serves the SPA with `script-src 'self'` (box.ts) and always will.
   * Pixi v8 generates its shader/uniform/UBO sync functions with `new Function`,
   * so under that CSP it refused to start and GraphView fell back to its
   * degraded banner. No WebGL canvas was ever mounted, which is why the gesture
   * assertions below could not even find one.
   *
   * Nothing else in the tree can see this: `vite dev` sends no CSP, and the
   * jsdom graph suites stub the engine out entirely. It takes the real build,
   * served by the real box, in a real browser — which is what this file is. The
   * renderer now installs `pixi.js/unsafe-eval` before `Application.init()`; if
   * that import is ever dropped, this test goes red instead of the fleet.
   */
  test("drag pans the camera and pinch zooms it — the page never moves", async ({ page }, info) => {
    // This whole test is "did the GESTURE move the camera", decided by whether
    // the canvas pixels changed — so it needs a canvas that is otherwise still.
    // The idle breath (GraphView) deliberately keeps a settled map drifting
    // forever, which makes `settledPixels` unsatisfiable: no two frames are
    // ever byte-identical again. Reduced motion is the switch that turns the
    // breath off, and asking for it here is honest rather than a test-only
    // backdoor — it is the same thing a viewer who sets it gets.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await page.goto("/graph");

    const surface = page.getByRole("application", { name: /graph of the brain/i });
    await expect(surface).toBeVisible();
    // The touch copy is the tell that the view knows it is on a phone.
    await expect(surface).toHaveAttribute("aria-label", /pinch to zoom/i);

    // The gesture recognizer's listeners are on the WebGL canvas the renderer
    // appends (renderer.ts), not on this wrapper — and a DOM event dispatched
    // at a parent never reaches a child. Aim at the canvas itself.
    const canvas = surface.locator("canvas").first();
    await expect(canvas).toBeVisible();

    const still = await settledPixels(page, surface);
    await shot(page, info, "graph-settled");
    const box = (await surface.boundingBox())!;
    const mid = { x: box.width / 2, y: box.height / 2 };

    await touchDrag(canvas, { x: mid.x + 90, y: mid.y + 60 }, { x: mid.x - 90, y: mid.y - 60 });
    const panned = await settledPixels(page, surface);
    expect(panned.equals(still), "a one-finger drag must move the camera").toBe(false);
    await shot(page, info, "graph-panned");

    await pinch(canvas, mid, 80, 260);
    const zoomed = await settledPixels(page, surface);
    expect(zoomed.equals(panned), "a pinch must zoom the camera").toBe(false);
    await shot(page, info, "graph-zoomed");

    // The gestures belong to the CAMERA. If they reached the page, a fling
    // would scroll the dashboard out from under the graph (and on iOS a pinch
    // would zoom the whole document, which no amount of CSS gets back).
    const moved = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      pageScale: window.visualViewport?.scale ?? 1,
    }));
    expect(moved).toEqual({ scrollY: 0, scrollX: 0, pageScale: 1 });
  });
});

/* ------------------------------------------------ layout + touch targets -- */

test.describe("every route at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no route scrolls sideways", async ({ page }, info) => {
    await signIn(page);
    const routes = [...STATIC_ROUTES, "/t/opportunity", await firstObjectPath(page)];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const offenders = await horizontalOverflow(page);
      if (offenders.length > 0) await shot(page, info, `overflow-${route.replace(/\W+/g, "_")}`);
      expect(offenders, `${route} overflows 390px`).toEqual([]);
    }
  });

  test("everything a finger aims at is at least 44px", async ({ page }, info) => {
    await signIn(page);

    for (const route of ["/", "/search", "/graph", "/t/opportunity"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      // Open the drawer too: it is half the phone's controls, and a control
      // that is only reachable behind a hamburger still has to be tappable.
      await page.getByRole("button", { name: "Open navigation" }).tap();
      await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveAttribute(
        "data-open",
        "true",
      );

      const small = await page.evaluate(() => {
        // The phone chrome (drawer + bottom bar) plus every explicit opt-in.
        // Not every button on every page: a control inside a desktop-shaped
        // data table is not what a thumb aims at, and 44px there would push
        // rows apart until nothing fits.
        const nodes = document.querySelectorAll<HTMLElement>(
          ".touch-chrome a, .touch-chrome button, .touch-chrome [data-slot='button'], .touch-target",
        );
        const bad: { label: string; w: number; h: number }[] = [];
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // not rendered
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          // 43.5 rather than 44: sub-pixel layout rounds a 44px box to 43.99.
          if (r.height < 43.5 || r.width < 43.5) {
            bad.push({
              label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "?",
              w: Math.round(r.width),
              h: Math.round(r.height),
            });
          }
        }
        return bad;
      });
      if (small.length > 0) await shot(page, info, `tap-targets-${route.replace(/\W+/g, "_")}`);
      expect(small, `${route} has sub-44px tap targets`).toEqual([]);

      await page.keyboard.press("Escape");
    }
  });
});

/* ------------------------------------------------------------ the PWA half */

test.describe("installability", () => {
  test("the manifest, its icons and the iOS meta tags are all really served", async ({
    page,
    request,
  }) => {
    await signIn(page);

    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    // Served as anything else, Chrome declines to offer an install at all.
    expect(res.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = JSON.parse(await res.text()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      const got = await request.get(icon.src);
      expect(got.status(), `${icon.src} must resolve`).toBe(200);
      expect(got.headers()["content-type"]).toContain("image/png");
    }

    // The browser's own view of the manifest link, and the tags iOS reads
    // INSTEAD of the manifest (add-to-home-screen ignores it entirely there).
    expect(await page.locator("link[rel=manifest]").getAttribute("href")).toBe(
      "/manifest.webmanifest",
    );
    expect(
      await page.locator("meta[name='apple-mobile-web-app-capable']").getAttribute("content"),
    ).toBe("yes");
    expect(
      await page
        .locator("meta[name='apple-mobile-web-app-status-bar-style']")
        .getAttribute("content"),
    ).toBe("black-translucent");
    expect(
      await page.locator("meta[name='apple-mobile-web-app-title']").getAttribute("content"),
    ).toBeTruthy();
    const touchIcon = await page.locator("link[rel='apple-touch-icon']").getAttribute("href");
    expect((await request.get(touchIcon!)).status()).toBe(200);
    // `black-translucent` paints under the notch, which is only correct with
    // viewport-fit=cover — the pair is what makes safe-area insets meaningful.
    expect(await page.locator("meta[name=viewport]").getAttribute("content")).toContain(
      "viewport-fit=cover",
    );
    // One theme-color per skin, so the OS chrome follows --ground.
    await expect(page.locator("meta[name='theme-color']")).toHaveCount(2);
  });

  test("the service worker registers, controls the page, and still hits the network", async ({
    page,
    request,
  }) => {
    await signIn(page);

    // Served as HTML (the SPA catch-all swallowing it) registration fails
    // silently-ish; served with a long cache the box could never replace it.
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toMatch(/javascript/);
    expect(sw.headers()["cache-control"]).toContain("no-cache");
    expect(await sw.text()).not.toContain("__APP_BUILD_ID__");

    // Registration is real, not merely attempted.
    const active = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { scope: reg.scope, state: reg.active?.state ?? null };
    });
    expect(active.state).toBe("activated");
    expect(new URL(active.scope).pathname).toBe("/");

    // sw.js calls skipWaiting + clients.claim, so the very first load is
    // controlled — a worker that only takes over on the SECOND visit is a
    // worker most phone users never meet.
    await expect
      .poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 15_000,
      })
      .toBe(true);

    // And a controlled navigation still reaches the box. This is the browser
    // half of the promise `test/src/pwa.integration.test.ts` proves in full: if
    // navigations were answered from cache, a self-updating box could never
    // reach a device that already has the app open.
    const shellRequests: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "document") shellRequests.push(r.url());
    });
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    expect(shellRequests.length, "a controlled navigation must hit the network").toBeGreaterThan(0);

    // The worker cached the shell (offline works) — and cached NOTHING from the
    // brain. A cached /api response would be one member's rows answered to
    // another, which no amount of RLS can undo once it is on the device.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const c = await caches.open(name);
        for (const req of await c.keys()) urls.push(new URL(req.url).pathname);
      }
      return { names, urls };
    });
    expect(cached.names.some((n) => n.startsWith("brain-shell-"))).toBe(true);
    expect(cached.urls.filter((u) => u.startsWith("/api"))).toEqual([]);
    expect(cached.urls.filter((u) => u.startsWith("/dash"))).toEqual([]);
  });
});

/* ---------------------------------------------------------------- helpers -- */

/**
 * Elements that stick out past the viewport's right edge. Reported as a list of
 * culprits rather than a bare boolean — "something overflows" is a bug report
 * nobody can act on. `documentElement.scrollWidth` alone is not enough: a fixed
 * element wider than the screen does not always grow it.
 */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > width + 1) bad.push(":root scrollWidth");
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      // A deliberate horizontal scroller (the board's snap track, the shadcn
      // table container) is allowed to be wider than the screen INSIDE its own
      // clip — and so is everything it CONTAINS, which is the whole point of
      // putting it there. What is not allowed is for any of it to push the
      // page, and the :root scrollWidth check above is what catches that.
      let clipped = false;
      for (let a: HTMLElement | null = el; a; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > width + 1) {
        const id = el.id ? `#${el.id}` : "";
        const cls =
          el.className && typeof el.className === "string"
            ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")}`
            : "";
        bad.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)}`);
      }
    }
    // Report the outermost offenders only; a wide row makes every cell "wide".
    return bad.slice(0, 8);
  });
}

/**
 * Make a note through the phone's own bottom bar and land in its editor. The
 * writing cases need somewhere to type that is theirs — typing into the seeded
 * demo content makes the next run start from the last run's leftovers.
 */
async function createNote(page: Page): Promise<string> {
  const title = `phone e2e ${Date.now()}`;
  await page.getByRole("navigation", { name: "Primary" }).getByText("New", { exact: true }).tap();
  await page.getByPlaceholder(/what do you want to make/i).fill("note");
  await page.getByRole("option").first().click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  return title;
}

/** The path of some object in the seeded brain — the editor and the peek need
 *  a real one, and hard-coding an id would tie this suite to one seed. */
async function firstObjectPath(page: Page): Promise<string> {
  await page.goto("/t/opportunity");
  const href = await page.locator("a[href^='/o/']").first().getAttribute("href");
  if (!href) throw new Error("no objects in the seeded brain — cannot drive the editor");
  return href;
}
