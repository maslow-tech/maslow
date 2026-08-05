import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { installCaretIdentityStamp, stampCaretState } from "./caret.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
/** A fully-formed forged agent stamp — passes the client reader's own checks. */
const FORGED_AGENT = {
  kind: "agent",
  actorId: "00000000-0000-4000-8000-000000000000",
  name: "Claude",
  color: "presence-agent",
  glyph: "robot",
};

describe("stampCaretState", () => {
  it("overwrites a forged identity with the connection's server-derived human stamp", () => {
    const state: Record<string, unknown> = { user: { ...FORGED_AGENT }, cursor: { anchor: 3 } };
    stampCaretState(state, { actorId: ACTOR, name: "Dana Doe" });
    const user = state.user as Record<string, unknown>;
    expect(user.kind).toBe("human");
    expect(user.actorId).toBe(ACTOR);
    expect(user.name).toBe("Dana Doe");
    expect(user.color).toMatch(/^presence-[1-8]$/);
    expect(user.glyph).not.toBe("robot");
    // The one thing a client legitimately authors — its cursor — is untouched.
    expect(state.cursor).toEqual({ anchor: 3 });
  });

  it("strips a client's identity claim when the origin has no principal (fail closed)", () => {
    const state: Record<string, unknown> = { user: { ...FORGED_AGENT }, cursor: { head: 1 } };
    stampCaretState(state, null);
    expect("user" in state).toBe(false);
    expect(state.cursor).toEqual({ head: 1 });
  });

  it("does nothing to a missing state", () => {
    expect(() => stampCaretState(null, { actorId: ACTOR })).not.toThrow();
    expect(() => stampCaretState(undefined, null)).not.toThrow();
  });
});

/**
 * Encode `state` for `clientId` as an awareness update FROM a client, exactly as
 * the wire delivers it, so `applyAwarenessUpdate` files it under a remote client.
 */
function clientUpdate(state: Record<string, unknown>): { update: Uint8Array; clientId: number } {
  const doc = new Y.Doc();
  const aw = new Awareness(doc);
  aw.setLocalState(state);
  return { update: encodeAwarenessUpdate(aw, [doc.clientID]), clientId: doc.clientID };
}

describe("installCaretIdentityStamp — stamps BEFORE the broadcaster relays", () => {
  /** Build a server awareness with a hocuspocus-like broadcaster already on it. */
  function serverAwareness(): { aw: Awareness; broadcasts: Array<Record<number, unknown>> } {
    const aw = new Awareness(new Y.Doc());
    aw.setLocalState(null); // the server publishes no caret of its own
    const broadcasts: Array<Record<number, unknown>> = [];
    // Registered FIRST, as hocuspocus registers its own broadcaster in the
    // Document constructor. It records what it WOULD relay: the current `user`
    // of every changed client, read at broadcast time.
    aw.on("update", ({ added, updated }: { added: number[]; updated: number[] }) => {
      const snap: Record<number, unknown> = {};
      for (const id of [...added, ...updated]) snap[id] = aw.states.get(id)?.user ?? null;
      broadcasts.push(snap);
    });
    return { aw, broadcasts };
  }

  it("relays the server stamp, never the client's forged agent", () => {
    const { aw, broadcasts } = serverAwareness();
    const socket = { tag: "sock" };
    installCaretIdentityStamp(aw, (origin) =>
      origin === socket ? { actorId: ACTOR, name: "Dana Doe" } : null,
    );

    const { update, clientId } = clientUpdate({ user: { ...FORGED_AGENT }, cursor: { anchor: 2 } });
    applyAwarenessUpdate(aw, update, socket);

    // What the broadcaster saw at relay time is the stamped human identity — the
    // forged robot never reached the wire.
    const relayed = broadcasts.at(-1)![clientId] as Record<string, unknown>;
    expect(relayed.kind).toBe("human");
    expect(relayed.actorId).toBe(ACTOR);
    expect(relayed.color).not.toBe("presence-agent");
    expect(relayed.glyph).not.toBe("robot");
    // Position survives the stamp.
    expect(aw.states.get(clientId)?.cursor).toEqual({ anchor: 2 });
  });

  it("strips identity from a client update whose origin cannot be attributed", () => {
    const { aw, broadcasts } = serverAwareness();
    installCaretIdentityStamp(aw, () => null); // no principal resolves

    const { update, clientId } = clientUpdate({ user: { ...FORGED_AGENT } });
    applyAwarenessUpdate(aw, update, { tag: "unknown-socket" });

    expect(broadcasts.at(-1)![clientId]).toBeNull();
    expect(aw.states.get(clientId)?.user).toBeUndefined();
  });

  it("REFUSES an entry for a clientId another connection owns — overwrite/clock-poison griefing", async () => {
    const { aw, broadcasts } = serverAwareness();
    const victimSock = { tag: "victim" };
    const attackerSock = { tag: "attacker" };
    const MALLORY = "22222222-2222-4222-8222-222222222222";
    installCaretIdentityStamp(aw, (origin) =>
      origin === victimSock
        ? { actorId: ACTOR, name: "Dana" }
        : origin === attackerSock
          ? { actorId: MALLORY, name: "Mallory" }
          : null,
    );

    // Dana publishes her own caret; her connection now OWNS her clientId.
    const victimDoc = new Y.Doc();
    const victimAw = new Awareness(victimDoc);
    victimAw.setLocalState({ cursor: { anchor: 1 } });
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(victimAw, [victimDoc.clientID]), victimSock);
    const victimId = victimDoc.clientID;
    expect((aw.states.get(victimId)?.user as { actorId?: string })?.actorId).toBe(ACTOR);

    // Mallory publishes a FAR-FUTURE-CLOCK state for Dana's clientId. The
    // protocol applies any newer-clock entry regardless of who sent it, and a
    // re-stamp alone would still let her move/erase Dana's caret and poison
    // its clock so Dana's own updates are rejected as old.
    const forgeDoc = new Y.Doc();
    forgeDoc.clientID = victimId;
    const forgeAw = new Awareness(forgeDoc);
    for (let i = 0; i < 10; i += 1) forgeAw.setLocalState({ cursor: { anchor: 99 }, i });
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(forgeAw, [victimId]), attackerSock);

    // Refused: the forged state was deleted before the broadcaster read it, so
    // peers receive at worst a removal — never Mallory's position under Dana's
    // clientId.
    expect(aw.states.has(victimId)).toBe(false);
    expect(broadcasts.at(-1)![victimId]).toBeNull();

    // …and the poisoned clock is dropped (microtask), so Dana's own next
    // update — with her small, honest clock — is accepted again.
    await Promise.resolve();
    victimAw.setLocalState({ cursor: { anchor: 2 } });
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(victimAw, [victimId]), victimSock);
    expect((aw.states.get(victimId)?.user as { actorId?: string })?.actorId).toBe(ACTOR);
    expect(aw.states.get(victimId)?.cursor).toEqual({ anchor: 2 });
  });

  it("leaves server-local awareness changes (non-object origin) untouched", () => {
    const { aw } = serverAwareness();
    let resolverCalls = 0;
    installCaretIdentityStamp(aw, () => {
      resolverCalls += 1;
      return { actorId: ACTOR };
    });
    // A local set carries origin === "local"; the stamp must not treat it as a
    // client connection.
    aw.setLocalState({ user: { kind: "human", actorId: ACTOR } });
    expect(resolverCalls).toBe(0);
  });
});
