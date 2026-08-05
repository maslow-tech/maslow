import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { useCollabTitle, type UseCollabRoom } from "./useCollab";
import { COLLAB_TITLE_FIELD, type CollabState } from "./collab";

/**
 * `useCollabTitle` is the fix for the title being dropped (and shown "locked by
 * the editor") the instant a collab room connects: the title is a room-owned
 * field but, unlike the body, had no CRDT binding, so every keystroke went to
 * CAS and the box refused it with 409 `open_in_editor`. These tests pin the
 * three halves of the fix — the writer routes into the Y.Doc ONLY once the room
 * has synced (`everSynced`), stays on CAS before the first sync (so the empty
 * pre-sync buffer can never raise a spurious conflict), and the reflect side
 * only seeds from a LIVE doc so that same empty buffer cannot wipe the loaded
 * title.
 */

function fakeRoom(
  doc: Y.Doc,
  status: CollabState["status"],
  // A live room has synced by definition; connecting/offline default to
  // never-synced, and a caller passes `true` for an already-synced room that
  // later dropped (everSynced latches true across drops).
  everSynced = status === "live",
): UseCollabRoom {
  return {
    state: { doc, status, everSynced } as unknown as CollabState,
    binding: { doc, provider: null, user: { name: "", color: "" } },
    keepMine: () => undefined,
    takeTheirs: () => undefined,
    reconnectNow: () => undefined,
    flushPersist: () => undefined,
  };
}

describe("useCollabTitle", () => {
  it("routes a title edit into the room's CRDT and returns true once synced", () => {
    const doc = new Y.Doc();
    const reflect = vi.fn();
    const { result } = renderHook(() => useCollabTitle(fakeRoom(doc, "live"), reflect));

    let handled = false;
    act(() => {
      handled = result.current("Acme renewal");
    });

    expect(handled).toBe(true);
    expect(doc.getText(COLLAB_TITLE_FIELD).toString()).toBe("Acme renewal");
  });

  it("routes to CAS (returns false) BEFORE the first sync, so the pre-sync buffer stays empty", () => {
    // While the room is still connecting it has never synced: the Y.Doc is an
    // empty buffer, not the object's stored content. Writing the title into it
    // would make reconcile see base=EMPTY / server=<real> and raise a spurious
    // conflict whose "keep mine" wipes the real body — so the title stays on CAS
    // (exactly the gate the body uses via `roomOwnsBody`).
    const doc = new Y.Doc();
    const reflect = vi.fn();
    const { result } = renderHook(() => useCollabTitle(fakeRoom(doc, "connecting"), reflect));

    let handled = true;
    act(() => {
      handled = result.current("Acme renewal");
    });

    expect(handled).toBe(false);
    expect(doc.getText(COLLAB_TITLE_FIELD).toString()).toBe("");
  });

  it("still routes into the CRDT while OFFLINE once the room has already synced", () => {
    // `everSynced` latches true across drops: a synced room that lost its socket
    // still owns the title (its Y.Doc is the offline buffer reconcile re-applies).
    const doc = new Y.Doc();
    const reflect = vi.fn();
    const { result } = renderHook(() => useCollabTitle(fakeRoom(doc, "offline", true), reflect));

    let handled = false;
    act(() => {
      handled = result.current("Offline edit");
    });

    expect(handled).toBe(true);
    expect(doc.getText(COLLAB_TITLE_FIELD).toString()).toBe("Offline edit");
  });

  it("returns false with no room, so the host keeps its CAS path", () => {
    const reflect = vi.fn();
    const { result } = renderHook(() => useCollabTitle(null, reflect));
    expect(result.current("anything")).toBe(false);
  });

  it("returns false when the room is DENIED, so the host falls back to CAS", () => {
    // A denied room owns nothing — `deny()` hands body/title back to CAS. Writing
    // into its dead Y.Doc would sync nowhere, so the title must route to CAS —
    // even for a room that HAD synced before it was denied (everSynced=true).
    const doc = new Y.Doc();
    const reflect = vi.fn();
    const { result } = renderHook(() => useCollabTitle(fakeRoom(doc, "denied", true), reflect));

    let handled = true;
    act(() => {
      handled = result.current("typed after denial");
    });

    expect(handled).toBe(false);
    // Nothing was written into the dead doc.
    expect(doc.getText(COLLAB_TITLE_FIELD).toString()).toBe("");
  });

  it("reflects a peer's title edit into the host once the room is LIVE", () => {
    const doc = new Y.Doc();
    doc.getText(COLLAB_TITLE_FIELD).insert(0, "Server title");
    const reflect = vi.fn();
    renderHook(() => useCollabTitle(fakeRoom(doc, "live"), reflect));

    // Seeded from the just-synced doc on mount.
    expect(reflect).toHaveBeenLastCalledWith("Server title");

    // A remote (peer/agent) splice flows through to the host.
    act(() => {
      doc.getText(COLLAB_TITLE_FIELD).insert(6, "!!");
    });
    expect(reflect).toHaveBeenLastCalledWith("Server!! title");
  });

  it("does NOT reflect from the empty pre-sync buffer (that would wipe the title)", () => {
    // Before the first sync the doc is an empty buffer whose title is "";
    // seeding from it would clobber the loaded title. The effect is gated on
    // `live`, so a "connecting" room reflects nothing.
    const doc = new Y.Doc();
    const reflect = vi.fn();
    renderHook(() => useCollabTitle(fakeRoom(doc, "connecting"), reflect));
    expect(reflect).not.toHaveBeenCalled();
  });
});
