import type { Migration } from "./types.js";

/**
 * 0058 — object governance + delayed owner removal (tag governance wave 5).
 *
 * `objects.governed_by`: WHO may change an object's audience (share/transfer).
 * Backfilled to created_by; kept NULLABLE with COALESCE(created_by) in every
 * check so a row this migration never saw (pre-0058 app mid-update, adopted
 * box) degrades to the old creator rule instead of throwing (doctrine rule 1).
 * Orphan stewardship lives in the WRITE PATH, not here: when a governor's
 * account is no longer active, a live OWNER may govern the rows they can SEE —
 * private-only orphans stay dead rows, which is the privacy promise working.
 *
 * `owner_removals`: the delayed (72h) owner-demotion ledger. Any owner may
 * initiate demoting another (or themselves); any owner — including the target —
 * may cancel inside the window; the LAST active owner can never be removed
 * (checked at initiate AND again at execution). Role is not tags: demotion
 * strips capability, never visibility. SSH/root stays the documented
 * break-glass. The sweep fn is boot-path (no actor), granted to brain_owner
 * ONLY — same rationale as brain_teammate_token: an ungated SECURITY DEFINER
 * that demotes owners must be unreachable from the request-serving role.
 *
 * Numbering: 0057 is this stack's tag-governance migration; 0058 claimed
 * 2026-07-29 after checking every open PR (#274's 0057-drop-remote-mcp was
 * flagged to renumber — it claimed second).
 */
const SQL = `
SET LOCAL lock_timeout = '5s';
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);

-- ---------------------------------------------------------------- governed_by
ALTER TABLE objects ADD COLUMN IF NOT EXISTS governed_by uuid;
-- brain_app updates it through share(transfer_to); brain_system backfills.
GRANT UPDATE (governed_by) ON objects TO brain_app;
GRANT UPDATE (governed_by) ON objects TO brain_system;

-- Backfill = created_by. Cross-actor bulk UPDATE: brain_system (FORCE RLS
-- binds brain_owner), triggers quiesced so the timeline isn't flooded and the
-- deferred-trigger 0018 failure mode can't latch a box with rows.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE objects DISABLE TRIGGER brain_objects_audit;
ALTER TABLE objects DISABLE TRIGGER brain_objects_biconditional;
SET LOCAL ROLE brain_system;
UPDATE objects SET governed_by = created_by WHERE governed_by IS NULL;
RESET ROLE;
ALTER TABLE objects ENABLE TRIGGER brain_objects_audit;
ALTER TABLE objects ENABLE TRIGGER brain_objects_biconditional;

-- ---------------------------------------------------------------- owner_removals
CREATE TABLE IF NOT EXISTS owner_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES accounts(id),
  initiated_by uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by uuid,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE owner_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_removals FORCE ROW LEVEL SECURITY;
-- Pending removals are deliberately org-READABLE (every member may know an
-- owner change is in flight — the notify fan-out says so anyway); mutations
-- go ONLY through the SECURITY DEFINER fns below.
DROP POLICY IF EXISTS owner_removals_read ON owner_removals;
CREATE POLICY owner_removals_read ON owner_removals FOR SELECT USING (true);
GRANT SELECT ON owner_removals TO brain_app;
GRANT SELECT, INSERT, UPDATE ON owner_removals TO brain_system;
-- BYPASSRLS skips policies, not GRANTs (0040 lesson): the sweep's demotion
-- UPDATE runs as brain_system and needs the exact columns it touches.
GRANT UPDATE (role, scopes) ON accounts TO brain_system;

-- ---------------------------------------------------------------- fns
CREATE OR REPLACE FUNCTION brain_owner_removal_initiate(p_target uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_actor uuid; v_id uuid;
BEGIN
  v_actor := brain_assert_owner();
  IF NOT EXISTS (SELECT 1 FROM accounts
                  WHERE id = p_target AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'target is not an active owner';
  END IF;
  IF (SELECT count(*) FROM accounts WHERE role = 'owner' AND status = 'active') < 2 THEN
    RAISE EXCEPTION 'the last owner cannot be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM owner_removals
              WHERE target_id = p_target AND cancelled_at IS NULL AND executed_at IS NULL) THEN
    RAISE EXCEPTION 'a removal for this owner is already pending';
  END IF;
  INSERT INTO owner_removals (target_id, initiated_by, effective_at)
    VALUES (p_target, v_actor, now() + interval '72 hours')
    RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;
ALTER FUNCTION brain_owner_removal_initiate(uuid) OWNER TO brain_system;

CREATE OR REPLACE FUNCTION brain_owner_removal_cancel(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_actor uuid;
BEGIN
  v_actor := brain_assert_owner();  -- any owner may veto, the target included
  UPDATE owner_removals SET cancelled_at = now(), cancelled_by = v_actor
    WHERE id = p_id AND cancelled_at IS NULL AND executed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'no pending removal with that id'; END IF;
END $fn$;
ALTER FUNCTION brain_owner_removal_cancel(uuid) OWNER TO brain_system;

CREATE OR REPLACE FUNCTION brain_owner_removal_sweep() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_row owner_removals%ROWTYPE; v_n int := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM owner_removals
     WHERE effective_at <= now() AND cancelled_at IS NULL AND executed_at IS NULL
     FOR UPDATE
  LOOP
    -- Re-check at execution: the world may have changed inside the window.
    IF (SELECT count(*) FROM accounts WHERE role = 'owner' AND status = 'active') < 2
       OR NOT EXISTS (SELECT 1 FROM accounts
                       WHERE id = v_row.target_id AND role = 'owner' AND status = 'active') THEN
      UPDATE owner_removals SET cancelled_at = now() WHERE id = v_row.id;
      CONTINUE;
    END IF;
    -- Demotion strips capability, never visibility (role is not tags).
    UPDATE accounts SET role = 'member', scopes = ARRAY['read','write']::text[]
      WHERE id = v_row.target_id;
    UPDATE owner_removals SET executed_at = now() WHERE id = v_row.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $fn$;
ALTER FUNCTION brain_owner_removal_sweep() OWNER TO brain_system;

REVOKE EXECUTE ON FUNCTION brain_owner_removal_initiate(uuid),
  brain_owner_removal_cancel(uuid), brain_owner_removal_sweep() FROM PUBLIC;
-- initiate/cancel self-gate on brain_assert_owner (they read app.actor_id), so
-- the request-serving role may call them from owner-gated dashboard routes.
GRANT EXECUTE ON FUNCTION brain_owner_removal_initiate(uuid),
  brain_owner_removal_cancel(uuid) TO brain_app;
-- The sweep has NO in-function auth (boot path, no actor): brain_owner ONLY.
GRANT EXECUTE ON FUNCTION brain_owner_removal_sweep() TO brain_owner;
`;

export const migration0058: Migration = {
  version: "0058",
  name: "governance",
  sql: SQL,
};
