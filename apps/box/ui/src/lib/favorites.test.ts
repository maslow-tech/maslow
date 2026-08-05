import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_FAVORITES,
  MAX_RECENTS,
  addFavorite,
  chromeHref,
  clearAllChrome,
  clearRecents,
  favoritesKey,
  isFavorite,
  loadChrome,
  parseChromeKey,
  purgeForeignChrome,
  recentsKey,
  recordRecent,
  removeFavorite,
  resetChromeStore,
  toggleFavorite,
} from "./favorites";

/**
 * Two properties carry this file: the chrome a member sees is THEIRS (a
 * favorite is an object id and a recent is a title — content, when the object
 * is private), and the lists stay small and deduped however hard they are hit.
 *
 * The purge rule is the mandatory half of choosing localStorage over
 * `saved_views`, so it is tested from both directions: a foreign key is deleted
 * rather than ignored, and a read as account B never surfaces account A's rows
 * even before anything explicitly purges.
 */

const A = "acct-aaaa";
const B = "acct-bbbb";

// On the way IN: the shared setup wipes localStorage between tests, and the
// module store deliberately keeps the account it already loaded.
beforeEach(() => {
  resetChromeStore();
});

const obj = (key: string, label = key) => ({ kind: "object", key, label, type: "deal" }) as const;

describe("keys", () => {
  it("round-trips both lists", () => {
    expect(parseChromeKey(favoritesKey(A))).toEqual({ list: "favorites", accountId: A });
    expect(parseChromeKey(recentsKey(A))).toEqual({ list: "recents", accountId: A });
  });

  it("refuses anything that is not ours", () => {
    expect(parseChromeKey("brain.draft.acct.obj")).toBeNull();
    expect(parseChromeKey("brain.fav.")).toBeNull();
    expect(parseChromeKey("nonsense")).toBeNull();
  });

  it("routes an entry to its page", () => {
    expect(chromeHref({ kind: "object", key: "o1" })).toBe("/o/o1");
    expect(chromeHref({ kind: "type", key: "deal" })).toBe("/t/deal");
  });
});

describe("favorites", () => {
  it("stars, unstars and persists", () => {
    expect(toggleFavorite(A, obj("o1", "Acme"))).toBe(true);
    expect(isFavorite(A, "object", "o1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(favoritesKey(A)) ?? "[]")).toHaveLength(1);

    expect(toggleFavorite(A, obj("o1", "Acme"))).toBe(false);
    expect(isFavorite(A, "object", "o1")).toBe(false);
    expect(JSON.parse(localStorage.getItem(favoritesKey(A)) ?? "[]")).toHaveLength(0);
  });

  it("puts the newest star first and never doubles one", () => {
    addFavorite(A, obj("o1", "One"));
    addFavorite(A, obj("o2", "Two"));
    addFavorite(A, obj("o1", "One renamed"));
    const { favorites } = loadChrome(A, true);
    expect(favorites.map((f) => f.key)).toEqual(["o1", "o2"]);
    expect(favorites[0]?.label).toBe("One renamed");
  });

  it("keeps object and type favorites apart", () => {
    addFavorite(A, { kind: "object", key: "deal", label: "A deal", type: null });
    addFavorite(A, { kind: "type", key: "deal", label: "Deals", type: "deal" });
    expect(loadChrome(A, true).favorites).toHaveLength(2);
    removeFavorite(A, "type", "deal");
    expect(loadChrome(A, true).favorites.map((f) => f.kind)).toEqual(["object"]);
  });

  it("caps the shelf", () => {
    for (let i = 0; i < MAX_FAVORITES + 5; i += 1) addFavorite(A, obj(`o${i}`));
    expect(loadChrome(A, true).favorites).toHaveLength(MAX_FAVORITES);
  });
});

describe("recents", () => {
  it("dedupes, moves to the front and caps at ten", () => {
    for (let i = 0; i < MAX_RECENTS + 4; i += 1) {
      recordRecent(A, { kind: "object", key: `o${i}`, label: `Object ${i}`, type: null });
    }
    let { recents } = loadChrome(A, true);
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents[0]?.key).toBe(`o${MAX_RECENTS + 3}`);

    recordRecent(A, { kind: "object", key: "o5", label: "Object 5", type: null });
    recents = loadChrome(A, true).recents;
    expect(recents[0]?.key).toBe("o5");
    expect(recents.filter((r) => r.key === "o5")).toHaveLength(1);
  });

  it("refreshes a stale label rather than keeping the old title", () => {
    recordRecent(A, { kind: "object", key: "o1", label: "Old name", type: null });
    recordRecent(A, { kind: "object", key: "o1", label: "New name", type: null });
    const { recents } = loadChrome(A, true);
    expect(recents).toHaveLength(1);
    expect(recents[0]?.label).toBe("New name");
  });

  it("never records a row with no label", () => {
    recordRecent(A, { kind: "object", key: "o1", label: "   ", type: null });
    expect(loadChrome(A, true).recents).toHaveLength(0);
  });

  it("is cleared on sign-out while favorites survive", () => {
    addFavorite(A, obj("o1", "Acme"));
    recordRecent(A, { kind: "object", key: "o2", label: "Visited", type: null });
    clearRecents();
    const s = loadChrome(A, true);
    expect(s.recents).toHaveLength(0);
    expect(s.favorites).toHaveLength(1);
  });
});

describe("the purge rule", () => {
  it("deletes another account's lists rather than ignoring them", () => {
    addFavorite(A, obj("o1", "A's object"));
    recordRecent(A, { kind: "object", key: "o2", label: "A was here", type: null });
    resetChromeStore();

    expect(purgeForeignChrome(B)).toBe(2);
    expect(localStorage.getItem(favoritesKey(A))).toBeNull();
    expect(localStorage.getItem(recentsKey(A))).toBeNull();
  });

  it("never surfaces a foreign list through a plain read", () => {
    addFavorite(A, obj("o1", "A's object"));
    resetChromeStore();

    const s = loadChrome(B);
    expect(s.accountId).toBe(B);
    expect(s.favorites).toHaveLength(0);
    // and A's row is gone from storage, not merely unread
    expect(localStorage.getItem(favoritesKey(A))).toBeNull();
  });

  it("wipes everything when we cannot prove whose it is", () => {
    addFavorite(A, obj("o1"));
    resetChromeStore();
    purgeForeignChrome("");
    expect(localStorage.getItem(favoritesKey(A))).toBeNull();
  });

  it("drops the in-memory copy when the account changes under it", () => {
    addFavorite(A, obj("o1"));
    purgeForeignChrome(B);
    expect(loadChrome(B).favorites).toHaveLength(0);
  });
});

describe("hostile storage", () => {
  it("drops a corrupt list instead of throwing", () => {
    localStorage.setItem(favoritesKey(A), "{not json");
    expect(loadChrome(A).favorites).toEqual([]);
    expect(localStorage.getItem(favoritesKey(A))).toBeNull();
  });

  it("drops rows an older release shaped differently", () => {
    localStorage.setItem(
      favoritesKey(A),
      JSON.stringify([
        { kind: "object", key: "o1", label: "kept", type: "deal", at: 1 },
        { kind: "nope", key: "o2", label: "dropped" },
        { key: "o3", label: "dropped too" },
        "garbage",
      ]),
    );
    const { favorites } = loadChrome(A);
    expect(favorites.map((f) => f.key)).toEqual(["o1"]);
  });

  it("survives a storage that refuses to write", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => addFavorite(A, obj("o1"))).not.toThrow();
    // The session still has it, even though the disk does not.
    expect(isFavorite(A, "object", "o1")).toBe(true);
    spy.mockRestore();
  });

  it("clears both lists for every account when asked", () => {
    addFavorite(A, obj("o1"));
    resetChromeStore();
    addFavorite(B, obj("o2"));
    // B's write already purged A; clearAllChrome takes what is left.
    expect(clearAllChrome()).toBeGreaterThan(0);
    expect(localStorage.length).toBe(0);
  });
});
