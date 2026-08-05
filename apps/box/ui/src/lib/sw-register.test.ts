/**
 * The registration state machine, and specifically the parts that keep a
 * self-updating box from getting stuck: build-id comparison decides "new
 * version", nothing here ever reloads on its own, and a reload that does not
 * converge is spent exactly once.
 *
 * The real ServiceWorkerContainer is not constructible and jsdom does not ship
 * one, so these drive the duck-typed `SwContainerLike` the module declares.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAppStatus,
  getAppStatus,
  getServiceWorkerController,
  startServiceWorker,
  subscribeAppStatus,
  type SwContainerLike,
  type SwHost,
} from "./sw-register";

/** A container we can post messages "from the worker" into. */
function fakeContainer(opts: { controller?: boolean; failRegister?: boolean } = {}) {
  const posted: unknown[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const update = vi.fn(async () => undefined);
  const container: SwContainerLike & {
    posted: unknown[];
    update: typeof update;
    emit: (type: string, event: unknown) => void;
    fromWorker: (buildId: string) => void;
  } = {
    controller: opts.controller === false ? null : { postMessage: (m) => posted.push(m) },
    register: opts.failRegister
      ? vi.fn(async () => {
          throw new Error("nope");
        })
      : vi.fn(async () => ({ update })),
    addEventListener: (type, fn) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    posted,
    update,
    emit: (type, event) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    fromWorker: (buildId) => {
      for (const fn of listeners.get("message") ?? []) fn({ data: { type: "BUILD_ID", buildId } });
    },
  };
  return container;
}

function memSession(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function host(over: Partial<SwHost> = {}): SwHost {
  return {
    container: fakeContainer(),
    buildId: "build-1",
    scriptUrl: "/sw.js",
    scope: "/",
    isOnline: () => true,
    isVisible: () => true,
    onWindowEvent: () => undefined,
    session: memSession(),
    reload: vi.fn(),
    pollIntervalMs: 1000,
    setInterval: () => 0,
    ...over,
  };
}

beforeEach(() => {
  __resetAppStatus();
});

describe("registration", () => {
  it("registers the worker at the scope root and reports ready", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container }));

    expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(getAppStatus().sw).toBe("ready");
  });

  it("reports unsupported (and never throws) with no container", async () => {
    const ctl = await startServiceWorker(host({ container: null }));
    expect(getAppStatus().sw).toBe("unsupported");
    expect(() => ctl.probe()).not.toThrow();
  });

  it("reports failed when registration rejects", async () => {
    await startServiceWorker(host({ container: fakeContainer({ failRegister: true }) }));
    expect(getAppStatus().sw).toBe("failed");
  });

  it("asks the active worker which build it is", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container }));
    expect(container.posted).toContainEqual({ type: "BUILD_ID" });
  });

  it("re-asks on controllerchange rather than assuming skipWaiting means stale", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container }));
    container.posted.length = 0;
    container.emit("controllerchange", {});
    expect(container.posted).toContainEqual({ type: "BUILD_ID" });
  });
});

describe("update detection", () => {
  it("stays ready when the worker reports OUR build", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container, buildId: "build-1" }));
    container.fromWorker("build-1");
    expect(getAppStatus().sw).toBe("ready");
  });

  it("flips to update-ready when the worker reports a different build", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container, buildId: "build-1" }));
    container.fromWorker("build-2");
    expect(getAppStatus().sw).toBe("update-ready");
  });

  it("ignores messages that are not a build-id announcement", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container }));
    container.emit("message", { data: { type: "SOMETHING_ELSE", buildId: "build-9" } });
    container.emit("message", { data: null });
    expect(getAppStatus().sw).toBe("ready");
  });

  it("NEVER reloads on its own — a new build only offers", async () => {
    const reload = vi.fn();
    const container = fakeContainer();
    await startServiceWorker(host({ container, reload }));
    container.fromWorker("build-2");
    container.emit("controllerchange", {});
    expect(reload).not.toHaveBeenCalled();
  });

  it("notifies subscribers on every transition", async () => {
    const seen: string[] = [];
    subscribeAppStatus((s) => seen.push(s.sw));
    const container = fakeContainer();
    await startServiceWorker(host({ container }));
    container.fromWorker("build-2");
    expect(seen).toContain("ready");
    expect(seen.at(-1)).toBe("update-ready");
  });
});

describe("applyUpdate — one reload per build, never a loop", () => {
  it("reloads when the human asks", async () => {
    const reload = vi.fn();
    const container = fakeContainer();
    const ctl = await startServiceWorker(host({ container, reload }));
    container.fromWorker("build-2");
    ctl.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("refuses a SECOND reload for the same unconverged build", async () => {
    const reload = vi.fn();
    const container = fakeContainer();
    const session = memSession();
    const ctl = await startServiceWorker(host({ container, reload, session }));
    container.fromWorker("build-2");
    ctl.applyUpdate();
    // The reload happened, the worker still reports build-2 (a deploy that did
    // not converge). The banner may come back; the tab must not bounce again.
    container.fromWorker("build-2");
    ctl.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("frees the guard once the worker and the page agree, so the NEXT release can reload", async () => {
    const reload = vi.fn();
    const container = fakeContainer();
    const session = memSession();
    const ctl = await startServiceWorker(host({ container, reload, session, buildId: "build-1" }));
    container.fromWorker("build-2");
    ctl.applyUpdate();
    container.fromWorker("build-1"); // converged
    expect(getAppStatus().sw).toBe("ready");
    container.fromWorker("build-3"); // a later release
    ctl.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("interop with api.ts's version-skew reload", () => {
  it("refreshes the worker immediately when this load came from a skew reload", async () => {
    const container = fakeContainer();
    const session = memSession({ "brain-skew-reload": "v0.4.81" });
    await startServiceWorker(host({ container, session }));
    await Promise.resolve();
    expect(container.update).toHaveBeenCalled();
  });

  it("does not poll on a normal load", async () => {
    const container = fakeContainer();
    await startServiceWorker(host({ container, session: memSession() }));
    await Promise.resolve();
    expect(container.update).not.toHaveBeenCalled();
  });

  it("survives storage that refuses to answer", async () => {
    const container = fakeContainer();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const reload = vi.fn();
    const ctl = await startServiceWorker(host({ container, session: throwing, reload }));
    container.fromWorker("build-2");
    ctl.applyUpdate();
    expect(getAppStatus().sw).toBe("update-ready");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("offline", () => {
  it("starts offline when the browser is offline", async () => {
    await startServiceWorker(host({ isOnline: () => false }));
    expect(getAppStatus().offline).toBe(true);
  });

  it("tracks online/offline events", async () => {
    const handlers = new Map<string, () => void>();
    await startServiceWorker(
      host({
        isOnline: () => true,
        onWindowEvent: (type, fn) => void handlers.set(type, fn),
      }),
    );
    expect(getAppStatus().offline).toBe(false);
    handlers.get("offline")!();
    expect(getAppStatus().offline).toBe(true);
    handlers.get("online")!();
    expect(getAppStatus().offline).toBe(false);
  });

  it("checks for an update when the tab comes back to the foreground", async () => {
    const container = fakeContainer();
    const handlers = new Map<string, () => void>();
    await startServiceWorker(
      host({
        container,
        onWindowEvent: (type, fn) => void handlers.set(type, fn),
        isVisible: () => true,
        pollIntervalMs: 0,
      }),
    );
    container.update.mockClear();
    handlers.get("visibilitychange")!();
    await Promise.resolve();
    expect(container.update).toHaveBeenCalled();
  });
});

describe("controller handle", () => {
  it("is exposed for the chrome once started, and cleared on reset", async () => {
    await startServiceWorker(host());
    expect(getServiceWorkerController()).not.toBeNull();
    __resetAppStatus();
    expect(getServiceWorkerController()).toBeNull();
  });
});
