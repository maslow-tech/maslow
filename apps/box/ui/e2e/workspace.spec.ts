import { expect, test, type Page } from "@playwright/test";

import { ownerToken, shot, signInAs, tokenFor } from "./support";

/**
 * THE DESKTOP ACCEPTANCE SUITE — the flows that can only be proven in a real
 * browser, against a real box, with a real websocket.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Everything else that claims to test these flows is Node. `test/src/
 * workspace.e2e.test.ts` and `graph-e2e.test.ts` both say so in their own
 * headers — "What is deliberately NOT here: pixels" — and drive client modules
 * against a booted box through a fetch shim. That is a good level for a lot of
 * things and a useless one for these four:
 *
 *  1. **Multiplayer.** Two sessions converging over a websocket cannot be
 *     observed from one process driving one module. The suites that DID test
 *     collab built their own server stack, so they went green while the shipped
 *     box had no room authorizer wired at all and refused every join. Only two
 *     real browser contexts against the real entrypoint can tell those apart.
 *  2. **The graph.** Pixi refuses to start under the box's CSP; jsdom stubs the
 *     engine out and `vite dev` sends no CSP, so nothing but a real browser
 *     loading the real build from the real box could ever see it.
 *  3. **Frame timing.** A CPU proxy in Node is not frames.
 *  4. **Pointer drag.** A board card moves under a sequence of pointer events
 *     with real hit testing and a real scroll container.
 *
 * One assertion style is deliberately avoided here and should stay avoided: an
 * assertion over SOURCE TEXT. `workspace.e2e.test.ts` asserts a regex against
 * `Shell.tsx`'s source (`/const canWrite = user\.role !== "viewer"/`), which
 * passes whether or not the app does anything with it. Everything below asserts
 * what a person sees.
 */

/* --------------------------------------------------------------- helpers -- */

/**
 * Create a note through the API and open it.
 *
 * Deliberately NOT driven through the create dialog: what is under test below
 * is the ROOM, and a fixture that depends on ⌘N, a palette, a type picker and a
 * submit button fails for six reasons that have nothing to do with
 * multiplayer — which is exactly how the first version of this file spent its
 * 90s timeout. The API call is the same endpoint the dialog posts to.
 */
async function createNote(
  page: Page,
  title: string,
  body = "seed line",
  visibility?: "org",
): Promise<string> {
  const res = await page.request.post("/api/v1/objects", {
    data: { title, body, ...(visibility ? { visibility } : {}) },
    headers: { "x-csrf-token": await csrfToken(page) },
  });
  if (!res.ok()) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/o/${id}`);
  await expect(page.getByLabel("Title")).toBeVisible();
  return id;
}

/** The double-submit CSRF cookie the dashboard sets at login. */
async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "brain_csrf");
  if (!csrf) throw new Error("no brain_csrf cookie — did sign-in run?");
  return csrf.value;
}

const editorBody = (page: Page) => page.locator(".editor-root .ProseMirror");

/* ------------------------------------------------------------ multiplayer -- */

test.describe("two people in one document", () => {
  /**
   * THE ONE THAT MATTERS. Two browser contexts, two different accounts, one
   * object — type in both and watch the text converge.
   *
   * The failure this replaces was silent and total: no websocket was ever
   * opened by the SPA (no view called `connectRoom`), the server had no
   * `authorizeRoom` and would have refused the join anyway, and the two
   * sessions simply diverged. Nothing went red, because nothing looked.
   *
   * Convergence is asserted on BOTH sides, not one: a test that only checks
   * that B sees A's text passes on a one-way relay, which is not what a CRDT
   * is for.
   */
  test("edits converge in both directions, and presence shows the other person", async ({
    browser,
  }, info) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // The websocket is the subject; record that one was actually opened rather
    // than inferring it from the text converging by some other route.
    const socketsA: string[] = [];
    pageA.on("websocket", (ws) => socketsA.push(ws.url()));

    try {
      await signInAs(pageA, ownerToken());
      const member = tokenFor("member");
      await signInAs(pageB, member.token);

      // Published explicitly: wave-2 default-private would keep B out of the
      // room entirely — a two-person fixture must be an org object.
      const id = await createNote(pageA, `Collab scratch ${Date.now()}`, "seed line", "org");
      await pageB.goto(`/o/${id}`);
      await expect(editorBody(pageB)).toBeVisible();

      // A collab socket, to this box, on the collab path.
      await expect
        .poll(() => socketsA.filter((u) => u.includes("/dash/collab")).length, {
          message: "the SPA must open a collab websocket",
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // A types. B must see it.
      await editorBody(pageA).click();
      await pageA.keyboard.press("End");
      await pageA.keyboard.type(" ALPHA-FROM-A");
      await expect(editorBody(pageB)).toContainText("ALPHA-FROM-A", { timeout: 20_000 });

      // B types. A must see it — and A must still have its own text, which is
      // the half a last-write-wins sync would get wrong.
      await editorBody(pageB).click();
      await pageB.keyboard.press("End");
      await pageB.keyboard.type(" BETA-FROM-B");
      await expect(editorBody(pageA)).toContainText("BETA-FROM-B", { timeout: 20_000 });
      await expect(editorBody(pageA)).toContainText("ALPHA-FROM-A");
      await expect(editorBody(pageB)).toContainText("ALPHA-FROM-A");

      await shot(pageA, info, "collab-context-a");
      await shot(pageB, info, "collab-context-b");

      // PRESENCE. The rail renders `null` whenever the roster is empty (a
      // dropped socket is not a loading state), so the group EXISTING at all is
      // the assertion — and it must hold on both screens, because the relay
      // builds one view per recipient.
      for (const page of [pageA, pageB]) {
        await expect(page.getByRole("group", { name: "Who is here" })).toBeVisible({
          timeout: 20_000,
        });
      }
      // Two people, counted by the relay from its own intersected view.
      await expect(pageA.locator('[data-slot="presence-summary"]')).toContainText(/2 people/i, {
        timeout: 20_000,
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  /**
   * The room's text becomes a real version through the SAME CAS write path
   * every other mutation uses — so it is attributed, audited and reloadable.
   * A CRDT that never lands in Postgres is a shared scratchpad, not an editor.
   */
  test("what was typed in the room is persisted and survives a reload", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signInAs(page, ownerToken());
      const id = await createNote(page, `Collab persistence ${Date.now()}`);
      const marker = `PERSISTED-${Date.now()}`;

      await editorBody(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(` ${marker}`);

      // The flush is idle-driven (FLUSH_IDLE_MS); give it its window rather
      // than racing it, then prove it from the SERVER's copy, not the DOM.
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`/api/v1/objects/${id}`);
            if (!res.ok()) return "";
            const body = (await res.json()) as { body?: string | null };
            return body.body ?? "";
          },
          // 60s, not 30: the flush is idle-driven and the whole box (node +
          // Postgres + two browser contexts) shares a starved CI runner — one
          // observed 30s+ miss on ubuntu-latest, never locally. The invariant
          // (the text MUST land in objects.body) is unchanged.
          { message: "the room's text must reach objects.body", timeout: 60_000 },
        )
        .toContain(marker);

      await page.reload();
      await expect(editorBody(page)).toContainText(marker);

      /**
       * …AND IT LEFT THE SAME TRAIL EVERY OTHER WRITE LEAVES.
       *
       * A prior review flagged, unconfirmed, that after an autosave which
       * demonstrably survived a reload `/history` held only version "1" whose
       * snapshot did not contain the typed text — reported as a possible defect
       * ("the body is being updated with no version behind it").
       *
       * IT IS NOT A DEFECT, and this asserts the real invariant so nobody has
       * to re-derive that. `before_image` is a BEFORE-image log: the row at
       * version N is the state the object held BEFORE the write that produced
       * N+1. So one write after creation correctly yields exactly one row, and
       * that row correctly holds the PRE-edit body. The typed text lives in
       * `objects` (asserted above, from the server) — looking for it in a
       * before-image is looking in the wrong place.
       *
       * What actually proves the flush is a first-class write is the audit
       * event: an `update` attributed to a real actor, carrying the live
       * editor's reason. That is what is checked.
       */
      const history = await page.request.get(`/api/v1/objects/${id}/history`);
      expect(history.ok()).toBe(true);
      const { versions, events } = (await history.json()) as {
        versions: { version: string | number }[];
        events: { kind: string; actor: string | null; payload: Record<string, unknown> | null }[];
      };
      // A version was cut (the before-image of the pre-flush body).
      expect(versions.length, "the flush must cut a version").toBeGreaterThan(0);
      // …and it is attributed and audited, exactly like a dashboard PATCH.
      const flushEvents = events.filter(
        (e) => e.kind === "update" && String(e.payload?.["reason"] ?? "").includes("live editor"),
      );
      expect(flushEvents.length, "the flush must leave an attributed update event").toBeGreaterThan(
        0,
      );
      expect(
        flushEvents.every((e) => e.actor),
        "no flush event may be unattributed",
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

/* --------------------------------------------- opening is not editing -- */

/**
 * The regression that made this suite worth extending. Opening an object wrote
 * a version, a history row and an audit event IN THE READER'S NAME, and edited
 * their prose — a backslash appeared in the text. Nobody typed.
 *
 * It needed a real browser against a real box: the two writers involved are
 * TipTap's own mount transactions (which do not fire in jsdom, so a unit test
 * of the guard passes with the guard removed) and the server's flush over a
 * live websocket (which no local dev session even reached — vite proxied
 * `/api` but not `/dash/collab`). Every Node-level suite was green while every
 * production open wrote a version.
 *
 * Asserted through the API rather than the header's `· v2`, because the version
 * is the thing under test and a rendered string is a proxy for it.
 */
test.describe("opening a document is not editing it", () => {
  test("an untouched object keeps its version and its exact text", async ({ page }) => {
    await signInAs(page, ownerToken());

    // A lone `~` is left literal by both parsers here and escaped by both
    // serializers, so the body's stored spelling is NOT its canonical one —
    // which is what made "did this change?" answer yes for an idle document.
    // Ordinary prose; no exotic markup required.
    const body = "B&P for an IDIQ volume set is ~$120k.";
    // Created but NOT opened, and the baseline is read before any browser
    // session touches it. `createNote` navigates, and the spurious write landed
    // fast enough to beat a baseline read taken after that — which made the
    // version comparison two post-write reads of the same number. The bug was
    // still caught (by the body), but by luck rather than by design.
    const res = await page.request.post("/api/v1/objects", {
      data: { title: `untouched ${Date.now()}`, body },
      headers: { "x-csrf-token": await csrfToken(page) },
    });
    if (!res.ok()) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };

    const read = async (): Promise<{ version: number; body: string }> => {
      const r = await page.request.get(`/api/v1/objects/${id}`);
      if (!r.ok()) throw new Error(`read failed: ${r.status()}`);
      const o = (await r.json()) as { version: number; body: string };
      return { version: o.version, body: o.body };
    };
    const before = await read();

    await page.goto(`/o/${id}`);
    // The body must be ON SCREEN before the clock starts: that proves the
    // editor mounted, which is where the spurious emission came from. Waiting
    // blind could pass by measuring nothing at all.
    await expect(editorBody(page)).toContainText("~$120k");
    // Past FLUSH_IDLE_MS (3s, apps/box/src/collab/flush.ts) plus room-sync and
    // save-queue debounce slack. Nothing is typed in this window.
    await page.waitForTimeout(8_000);

    // Version AND text: the version proves no write happened, the text proves
    // no write happened AND that nothing rewrote the user's prose if one did.
    expect(await read()).toEqual(before);
  });
});

/* ------------------------------------------------------------- side peek -- */

test.describe("the side peek is a real editor", () => {
  test("opens over a database view and edits persist", async ({ page }) => {
    await signInAs(page, ownerToken());
    await page.goto("/t/opportunity");

    // The TITLE LINK INSIDE THE FIRST TABLE ROW. Not `page.getByRole("link")`:
    // the sidebar is full of links and the first one on the page is a nav item,
    // which navigates instead of peeking and makes this test assert nothing.
    // Not the `<tr>` either — TableLayout puts the click handler on the link.
    const firstRow = page.locator("main tbody tr").first().getByRole("link").first();
    await expect(firstRow).toBeVisible();

    // A peek is `?peek=<id>` over the current route — the table must survive it.
    const beforePath = new URL(page.url()).pathname;
    await firstRow.click();
    const peek = page.getByRole("dialog", { name: "Object peek" });
    await expect(peek).toBeVisible();
    // The caller is still underneath: this is a peek, not a navigation.
    expect(new URL(page.url()).pathname).toBe(beforePath);
    expect(new URL(page.url()).searchParams.get("peek")).toBeTruthy();

    const marker = `PEEK-${Date.now()}`;
    const body = peek.locator(".editor-root .ProseMirror").first();
    await expect(body).toBeVisible();
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${marker}`);

    // Escape closes AND flushes — the panel must never eat the last sentence.
    await page.keyboard.press("Escape");
    await expect(peek).toBeHidden();

    await firstRow.click();
    await expect(
      page
        .getByRole("dialog", { name: "Object peek" })
        .locator(".editor-root .ProseMirror")
        .first(),
    ).toContainText(marker, { timeout: 20_000 });
  });
});

/* ----------------------------------------------------------------- board -- */

test.describe("the board", () => {
  /**
   * A card moved between columns is ONE patch, and the property it represents
   * really changes. Driven with pointer events because the board deliberately
   * has no drag-and-drop dependency (BoardLayout: "Pointer events + a fixed
   * drag layer").
   */
  test("dragging a card to another column changes the property", async ({ page }, info) => {
    await signInAs(page, ownerToken());
    await page.goto("/t/opportunity");
    await page.getByRole("button", { name: "Board" }).click();

    const columns = page.locator("[data-column-key]");
    await expect(columns.first()).toBeVisible();
    const columnCount = await columns.count();
    test.skip(columnCount < 2, "the seeded board needs two columns to move a card between");

    const card = columns.first().locator("[data-card-id]").first();
    await expect(card).toBeVisible();
    const cardId = await card.getAttribute("data-card-id");
    const target = columns.nth(1);

    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Past the drag threshold in several steps — one jump can be read as a
    // click that never became a drag.
    for (let i = 1; i <= 10; i += 1) {
      const t = i / 10;
      await page.mouse.move(
        from.x + from.width / 2 + (to.x + to.width / 2 - from.x - from.width / 2) * t,
        from.y + from.height / 2 + (to.y + 60 - from.y - from.height / 2) * t,
      );
    }
    await page.mouse.up();

    await expect(target.locator(`[data-card-id="${cardId}"]`)).toBeVisible({ timeout: 15_000 });
    await shot(page, info, "board-after-drag");

    // And it is a WRITE, not a local reorder: reload and it is still there.
    await page.reload();
    await page.getByRole("button", { name: "Board" }).click();
    await expect(
      page.locator("[data-column-key]").nth(1).locator(`[data-card-id="${cardId}"]`),
    ).toBeVisible({ timeout: 15_000 });
  });
});

/* ----------------------------------------------------------------- graph -- */

test.describe("the graph renders on a box", () => {
  /**
   * THE CSP REGRESSION. The box serves `script-src 'self'`; Pixi v8 generates
   * shader-sync functions with `new Function` and refused to start, so the
   * graph did not render on a box AT ALL — on any device, desktop included —
   * while working perfectly under `vite dev`, which sends no CSP.
   *
   * The banner is asserted ABSENT by its own words, because "a canvas exists"
   * is not enough: the degraded fallback also renders a container.
   */
  test("a WebGL canvas starts — no unsafe-eval banner", async ({ page }, info) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await signInAs(page, ownerToken());
    await page.goto("/graph");

    const surface = page.getByRole("application", { name: /graph/i });
    await expect(surface).toBeVisible();
    await expect(page.getByText(/could not start on this device/i)).toHaveCount(0);
    await expect(page.getByText(/unsafe-eval/i)).toHaveCount(0);

    const canvas = surface.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // A canvas with no drawing buffer is a canvas that failed quietly.
    const size = await canvas.evaluate((el) => ({
      w: (el as HTMLCanvasElement).width,
      h: (el as HTMLCanvasElement).height,
    }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);

    await shot(page, info, "graph-desktop");
    expect(
      consoleErrors.filter((t) => /unsafe-eval|CSP|Content Security Policy/i.test(t)),
      "no CSP violation on the graph page",
    ).toEqual([]);
  });

  /**
   * THE PERFORMANCE BUDGET, MEASURED IN FRAMES.
   *
   * The design spec commits to "5,000 nodes / 15,000 edges — sustained ≥ 55fps
   * median (no frame > 33ms at the 95th percentile) during a continuous 10s
   * pan+zoom". What existed instead was `perf.bench.test.ts`, a pure-Node CPU
   * proxy that says in its own words "passing the CPU gates does not prove
   * 55fps", with the real frame assertion behind `GRAPH_BENCH_GPU=1` and not
   * run in CI.
   *
   * This measures actual `requestAnimationFrame` deltas in a real compositor
   * while the camera moves. It is SKIPPED unless the box was seeded at scale
   * (`BRAIN_DEV_GRAPH_SCALE=5000`), because a number taken at 44 nodes is not
   * evidence about a 5,000-node promise and must not be allowed to look like
   * one — a skip is honest, a green tick at 44 nodes is not.
   */
  test("holds the frame budget during a 10s pan+zoom at the committed scale", async ({
    page,
  }, info) => {
    test.skip(
      !process.env.BRAIN_DEV_GRAPH_SCALE,
      "run the dev box with BRAIN_DEV_GRAPH_SCALE=5000 to measure the committed budget",
    );
    test.setTimeout(180_000);

    await signInAs(page, ownerToken());
    await page.goto("/graph");
    const surface = page.getByRole("application", { name: /graph/i });
    const canvas = surface.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });

    // Layout settles first: the budget is about steady-state pan/zoom, not the
    // first four seconds of force simulation (which the spec bounds separately).
    await page.waitForTimeout(6_000);

    const box = (await surface.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    /**
     * The sampler and the interaction MUST overlap. Frame times measured on an
     * idle canvas are a measurement of nothing — the renderer stops its ticker
     * when the camera is still, so an idle sample would report a beautiful
     * number and mean the opposite of the budget. So the rAF sampler is
     * STARTED (not awaited) and the pan/zoom is driven underneath it.
     */
    const sampling = page.evaluate(async () => {
      const deltas: number[] = [];
      let last = performance.now();
      const stop = performance.now() + 10_000;
      await new Promise<void>((resolve) => {
        const tick = (now: number): void => {
          deltas.push(now - last);
          last = now;
          if (now >= stop) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return deltas;
    });

    const driving = (async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      let i = 0;
      while (Date.now() < deadline) {
        // A continuous pan, with a wheel zoom folded in every lap, so the
        // 10 seconds cover both halves of "pan+zoom" rather than one of them.
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let step = 0; step < 20; step += 1) {
          await page.mouse.move(
            cx + Math.sin((i + step) / 4) * 200,
            cy + Math.cos((i + step) / 4) * 140,
          );
        }
        await page.mouse.up();
        await page.mouse.wheel(0, i % 2 === 0 ? -240 : 240);
        i += 20;
      }
    })();

    const [frames] = await Promise.all([sampling, driving]);

    const sorted = [...frames].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    await info.attach("frame-timing", {
      body: JSON.stringify({ samples: sorted.length, medianMs: median, p95Ms: p95 }, null, 2),
      contentType: "application/json",
    });

    // ≥55fps median is ≤18.2ms per frame; the 95th percentile bound is 33ms.
    expect(median, "median frame time (≥55fps)").toBeLessThanOrEqual(18.2);
    expect(p95, "95th percentile frame time").toBeLessThanOrEqual(33);
  });
});
