/**
 * SERVICE WORKER REGISTRATION — the page half of `src/sw.js`.
 *
 * Two facts shape everything here:
 *
 *  1. **The box self-updates.** An operator ships a release, the updater pulls
 *     it, and the origin starts serving a different app — without asking any
 *     open tab. `lib/api.ts` already handles the SERVER side of that skew: every
 *     response carries `X-Brain-App-Version`, and a change from the version we
 *     booted with forces exactly one reload (guarded by the `brain-skew-reload`
 *     sessionStorage key so it can never loop).
 *
 *  2. **A service worker can outlive the box's version.** That is the whole
 *     hazard: if the worker served a cached index.html, the api.ts skew reload
 *     would land right back on the OLD bundle, see the same skew, and be
 *     silently wrong (the sessionStorage guard means it would not even retry).
 *     `sw.js` is therefore network-first for navigations — this module never has
 *     to fight it, and the two mechanisms compose:
 *
 *        api.ts sees a new SERVER version   → one reload → new index.html
 *                                             (network-first) → new bundle.
 *        this module sees a new WORKER build → a banner, never a reload.
 *
 * WE NEVER RELOAD ON OUR OWN. `controllerchange` firing (which it does, because
 * sw.js calls skipWaiting + clients.claim) famously reloads the page under a
 * user who is mid-sentence in the editor. The affordance is a quiet pill; the
 * human decides when.
 *
 * HOW "NEW VERSION" IS DECIDED: not by worker lifecycle states, which are racy
 * and fire for reasons that are not a new app (a re-register, a claim, a
 * navigation). We compare BUILD IDS. The app bundle is compiled with
 * `__APP_BUILD_ID__` and sw.js is emitted with the same string by the same vite
 * build, so "the worker's id differs from mine" means precisely "the code
 * running in this tab is not the code this origin now serves" — and after a
 * reload the two match again, which is why the banner cannot loop.
 */
import { useSyncExternalStore } from "react";

/** Build stamp compiled into the bundle by vite.config.ts (`define`). */
declare const __APP_BUILD_ID__: string;

type SwStatus =
  /** No `navigator.serviceWorker` (old browser, or a non-secure origin). */
  | "unsupported"
  /** Deliberately not registered: dev server, demo bundle, sub-path base. */
  | "disabled"
  | "registering"
  /** Registered and current — the tab is running what the origin serves. */
  | "ready"
  /** The active worker reports a different build than this tab is running. */
  | "update-ready"
  | "failed";

interface AppStatus {
  sw: SwStatus;
  /** `navigator.onLine` is a lower bound (true can still mean captive portal),
   *  but false is reliable — and false is the case the UI must speak to. */
  offline: boolean;
}

/* ------------------------------------------------------------------ store -- */

let state: AppStatus = { sw: "registering", offline: false };
const listeners = new Set<(s: AppStatus) => void>();

function setState(next: Partial<AppStatus>): void {
  const merged = { ...state, ...next };
  if (merged.sw === state.sw && merged.offline === state.offline) return;
  state = merged;
  for (const fn of [...listeners]) fn(state);
}

export function getAppStatus(): AppStatus {
  return state;
}

export function subscribeAppStatus(fn: (s: AppStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React binding for the two things the chrome needs to say out loud. */
export function useAppStatus(): AppStatus {
  return useSyncExternalStore(
    (fn) => subscribeAppStatus(fn),
    getAppStatus,
    () => state,
  );
}

/** The controller the app chrome talks to (set once, at startup). */
let live: SwController | null = null;

export function getServiceWorkerController(): SwController | null {
  return live;
}

/** Test seam only — resets the module store between cases. */
export function __resetAppStatus(): void {
  state = { sw: "registering", offline: false };
  listeners.clear();
  live = null;
}

/* ---------------------------------------------------------- duck-typing -- */
/* The real ServiceWorkerContainer is not constructible and jsdom does not ship
 * one, so the controller takes the narrowest shape it actually uses. Same
 * discipline as lib/collab.ts: re-state the contract, name the real type. */

export interface SwLike {
  postMessage(message: unknown): void;
}

export interface SwRegistrationLike {
  update(): Promise<unknown>;
}

export interface SwContainerLike {
  controller: SwLike | null;
  register(scriptUrl: string, options?: { scope?: string }): Promise<SwRegistrationLike>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface SwHost {
  container: SwContainerLike | null;
  /** This tab's build stamp. */
  buildId: string;
  /** Where sw.js lives, and the scope it claims (base-aware). */
  scriptUrl: string;
  scope: string;
  /** Injected so a test can drive them; defaults read the real environment. */
  isOnline?: () => boolean;
  onWindowEvent?: (type: "online" | "offline" | "visibilitychange", fn: () => void) => void;
  isVisible?: () => boolean;
  session?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  /** Minimum gap between `registration.update()` polls. */
  pollIntervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

/** Set by api.ts before its one fail-safe reload; read here on the way back up. */
const SKEW_KEY = "brain-skew-reload";
/** Our own guard, mirroring api.ts: at most one banner-driven reload per build. */
const SW_RELOAD_KEY = "brain-sw-reload";
const DEFAULT_POLL_MS = 15 * 60 * 1000;

export interface SwController {
  /** Ask the active worker which build it is. */
  probe(): void;
  /** `registration.update()`, rate-limited. */
  poll(): Promise<void>;
  /** The banner's button: one reload, recorded so it cannot repeat. */
  applyUpdate(): void;
}

/**
 * Wire the state machine. Returns a controller even when registration is
 * impossible — nothing in here may throw outward, because a service worker is a
 * nicety and must never be the reason the dashboard fails to start.
 */
export async function startServiceWorker(host: SwHost): Promise<SwController> {
  const session = host.session ?? safeSession();
  const reload = host.reload ?? (() => globalThis.location?.reload());
  const isOnline = host.isOnline ?? (() => globalThis.navigator?.onLine !== false);
  const onWindowEvent =
    host.onWindowEvent ??
    ((type, fn) => {
      if (type === "visibilitychange") globalThis.document?.addEventListener(type, fn);
      else globalThis.addEventListener?.(type, fn);
    });
  const isVisible = host.isVisible ?? (() => globalThis.document?.visibilityState !== "hidden");

  setState({ offline: !isOnline() });
  onWindowEvent("online", () => setState({ offline: false }));
  onWindowEvent("offline", () => setState({ offline: true }));

  let registration: SwRegistrationLike | null = null;
  let lastPoll = 0;
  const pollMs = host.pollIntervalMs ?? DEFAULT_POLL_MS;

  const probe = (): void => {
    try {
      host.container?.controller?.postMessage({ type: "BUILD_ID" });
    } catch {
      // A worker that refuses to talk simply leaves us on "ready".
    }
  };

  const poll = async (): Promise<void> => {
    if (!registration) return;
    const now = Date.now();
    if (now - lastPoll < pollMs) return;
    lastPoll = now;
    try {
      await registration.update();
    } catch {
      // Offline, or the box is mid-restart. The next poll tries again.
    }
  };

  const applyUpdate = (): void => {
    // Record the build we are reloading FOR, exactly as api.ts records the
    // version it reloaded for. If we come back and the worker STILL reports
    // that same foreign build (a half-served deploy, or a worker the box no
    // longer has a matching bundle for), the banner may reappear but the tab is
    // never bounced a second time for it — that is the loop this key forbids.
    const target = String(pendingBuildId ?? "");
    try {
      if (session.getItem(SW_RELOAD_KEY) === target) return;
      session.setItem(SW_RELOAD_KEY, target);
    } catch {
      // Private-mode storage refusal must not eat the reload.
    }
    reload();
  };

  let pendingBuildId: string | null = null;
  const controller: SwController = { probe, poll, applyUpdate };
  live = controller;

  if (!host.container) {
    setState({ sw: "unsupported" });
    return controller;
  }

  // The worker's answer, whether solicited (probe) or broadcast on activate.
  host.container.addEventListener("message", (event: unknown) => {
    const data = (event as { data?: { type?: string; buildId?: string } }).data;
    if (!data || data.type !== "BUILD_ID" || typeof data.buildId !== "string") return;
    if (data.buildId === host.buildId) {
      pendingBuildId = null;
      // Converged: clear the one-reload-per-build guard so the NEXT release can
      // spend its own reload.
      try {
        session.setItem(SW_RELOAD_KEY, "");
      } catch {
        // Nothing to clear if storage is refusing us anyway.
      }
      setState({ sw: "ready" });
      return;
    }
    pendingBuildId = data.buildId;
    setState({ sw: "update-ready" });
  });

  // Claiming fires this; ask the new boss who it is rather than assuming.
  host.container.addEventListener("controllerchange", () => probe());

  setState({ sw: "registering" });
  try {
    registration = await host.container.register(host.scriptUrl, { scope: host.scope });
    setState({ sw: state.sw === "update-ready" ? "update-ready" : "ready" });
  } catch {
    setState({ sw: "failed" });
    return controller;
  }

  // A page that arrived via api.ts's version-skew reload is, by definition, the
  // new bundle talking to a box that just changed underneath it. Refresh the
  // worker NOW rather than at the next 15-minute poll, so the two halves of the
  // app converge on the same build immediately.
  let skewed = false;
  try {
    skewed = session.getItem(SKEW_KEY) !== null;
  } catch {
    skewed = false;
  }
  if (skewed) {
    lastPoll = 0;
    void poll();
  }

  probe();

  // Cheap update checks: on return-to-foreground (the moment a phone user is
  // most likely to be looking at stale code) and on a slow timer.
  onWindowEvent("visibilitychange", () => {
    if (isVisible()) void poll();
  });
  const every = host.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  every(() => void poll(), pollMs);

  return controller;
}

function safeSession(): Pick<Storage, "getItem" | "setItem"> {
  try {
    const s = globalThis.sessionStorage;
    if (s) return s;
  } catch {
    // Blocked storage (Safari private mode, third-party context).
  }
  return { getItem: () => null, setItem: () => undefined };
}

/**
 * The real entry point, called once from main.tsx.
 *
 * Registration is skipped anywhere a worker would be a liability rather than a
 * feature: the dev server (no /sw.js is emitted), the hosted-demo bundle
 * (served from a sub-path on someone else's origin, where a scope-root worker
 * has no business existing), and any non-root base for the same reason.
 */
export function startServiceWorkerFromEnv(): Promise<SwController> {
  const base = import.meta.env.BASE_URL || "/";
  if (!import.meta.env.PROD || base !== "/") {
    setState({ sw: "disabled", offline: globalThis.navigator?.onLine === false });
    return Promise.resolve({ probe: () => {}, poll: async () => {}, applyUpdate: () => {} });
  }
  const container = (globalThis.navigator as Navigator | undefined)?.serviceWorker as
    (SwContainerLike | undefined) | undefined;
  return startServiceWorker({
    container: container ?? null,
    buildId: typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "dev",
    scriptUrl: `${base}sw.js`,
    scope: base,
  });
}
