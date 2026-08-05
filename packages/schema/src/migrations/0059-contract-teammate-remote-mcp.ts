import type { Migration } from "./types.js";

/**
 * Contraction: drop the DB remains of two removed features (2026-08-02).
 *
 * Both features were removed in code but left their schema behind on purpose —
 * expand/contract, so a canary failure could roll back onto the previous image
 * without the rollback landing on tables the old code still reads. Both have
 * long since converged fleet-wide, so this is the contract half.
 *
 *   1. REMOTE MCP (removed 2026-07-29, PR #274). Tables remote_mcp_server,
 *      remote_mcp_tools_cache, remote_mcp_member_ack — from 0036/0038/0039/
 *      0044/0050. index.ts has carried the TODO for this since the removal.
 *   2. THE TEAMMATE / HARNESS (removed 2026-07-30, PR #298). The 0031/0057
 *      provisioning functions, `accounts.is_service`, and any service-account
 *      rows still sitting on a box.
 *
 * ---------------------------------------------------------------- credentials
 * THE ORDER MATTERS, and getting it wrong is unrecoverable. A remote server's
 * bearer token never lived in remote_mcp_server — it lived in connector_config
 * (and, for the OAuth variant, connector_secrets / connector_oauth_state),
 * keyed by the SAME slug. Those rows carry an opaque encrypted blob and a
 * provider string; the only thing on the box that says which provider strings
 * were remote servers is remote_mcp_server.slug. Drop the table first and the
 * credential rows become permanently unidentifiable — encrypted secrets we can
 * never attribute, never clean up, and never explain to a user. So the
 * sweep reads the slugs and deletes the credentials BEFORE the drop, exactly as
 * index.ts's note demanded.
 *
 * ---------------------------------------------------------------- doctrine
 * Migrations run on LIVE boxes we have never seen (see CLAUDE.md). Every step
 * here is guarded and NEVER throws on surprising state:
 *
 *   - all drops are IF EXISTS, so a re-run and a box that already contracted
 *     are both no-ops;
 *   - the credential sweep is skipped with a NOTICE when remote_mcp_server is
 *     already gone (to_regclass check), because a box mid-rollout may have been
 *     contracted by a later release and rolled back;
 *   - service-account ROWS ARE NEVER DELETED. They are revoked in place, with
 *     their tag grants and personal tag purged. This is a deliberate retreat
 *     from an earlier draft that deleted them when no FK pointed at the row:
 *     on any real box that branch cannot fire, because 0037 gives EVERY account
 *     an fs home and fs_entries.created_by is NOT NULL — so the delete path was
 *     untestable dead code guarding a DELETE against a user's data. What
 *     deletion would have bought is nothing: a revoked account with no token
 *     cannot authenticate, which is the whole objective. What it risks is
 *     real — a service account can be the author of objects, the actor of audit
 *     events, and the owner of file rows, and an audit trail that cannot say
 *     who wrote something is worse than one naming a retired account.
 *
 * `accounts` is not RLS-bound, but `tags` and `account_tags` ARE (0057, FORCE,
 * SELECT-only policies) — so the step that purges a retired account's grants
 * runs under `SET LOCAL ROLE brain_system`. Without it the DELETEs match zero
 * rows and report success, which is the worst possible outcome: the migration
 * passes while a revoked account keeps holding the org tag. This was not
 * theoretical — the first version of this migration did exactly that, and only
 * the with-data test caught it.
 *
 * ---------------------------------------------------------------- functions
 * Postgres does NOT track column references inside plpgsql bodies, so dropping
 * accounts.is_service would leave brain_tag_grant compiling fine and failing at
 * RUNTIME the first time an owner granted a custom tag — on a box, silently,
 * long after this migration passed. It is replaced here, in the SAME migration
 * that drops the column, which is the only way the two can never disagree.
 * Its is_service branch existed solely to keep service accounts out of custom
 * tags; with no service accounts and no column, the branch is unreachable.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

-- 1 ------------------------------------------------------- remote MCP credentials
DO $$
DECLARE v_slugs text[]; v_n int;
BEGIN
  IF to_regclass('remote_mcp_server') IS NULL THEN
    RAISE NOTICE 'remote_mcp_server is already gone — skipping the credential sweep';
  ELSE
    -- Dynamic ONLY so this compiles on a box where the table is already gone;
    -- via format()/%I to satisfy the repo's quoting lint, which does not care
    -- that the identifier here is a constant (and is right not to trust that).
    EXECUTE format('SELECT array_agg(slug) FROM %I', 'remote_mcp_server') INTO v_slugs;
    IF v_slugs IS NULL OR cardinality(v_slugs) = 0 THEN
      RAISE NOTICE 'no remote MCP servers registered — no credentials to sweep';
    ELSE
      DELETE FROM connector_config WHERE provider = ANY(v_slugs);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE NOTICE 'swept % connector_config row(s) for % remote slug(s)', v_n, cardinality(v_slugs);
      IF to_regclass('connector_secrets') IS NOT NULL THEN
        DELETE FROM connector_secrets WHERE provider = ANY(v_slugs);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RAISE NOTICE 'swept % connector_secrets row(s)', v_n;
      END IF;
      IF to_regclass('connector_oauth_state') IS NOT NULL THEN
        DELETE FROM connector_oauth_state WHERE provider = ANY(v_slugs);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RAISE NOTICE 'swept % connector_oauth_state row(s)', v_n;
      END IF;
    END IF;
  END IF;
END $$;

-- 2 ------------------------------------------------------------ remote MCP tables
-- Child-first so no drop depends on CASCADE to do the right thing.
DROP TABLE IF EXISTS remote_mcp_member_ack;
DROP TABLE IF EXISTS remote_mcp_tools_cache;
DROP TABLE IF EXISTS remote_mcp_server;

-- 3 --------------------------------------------------------- service accounts
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'is_service') THEN
    RAISE NOTICE 'accounts.is_service already dropped — no service accounts to retire';
    RETURN;
  END IF;
  -- tags and account_tags are FORCE ROW LEVEL SECURITY (0057) and their only
  -- policies are FOR SELECT. Under FORCE, brain_owner — the role the migration
  -- runner connects as — is RLS-bound like anyone else, and a bare brain_owner
  -- connection holds no tags at all. So a plain DELETE below would match
  -- NOTHING and report success: grants survive, the migration passes, and the
  -- box quietly keeps a retired account holding the org tag. Hence the
  -- brain_system switch inside the loop. Caught by the with-data test, which is
  -- the only place it COULD be caught — an empty CI database has no rows for
  -- the silence to hide behind.
  -- Dynamic for the same reason: the column is dropped at the end of this very
  -- migration, so a static reference would not compile on a re-run.
  FOR r IN EXECUTE format('SELECT id, email FROM accounts WHERE %I', 'is_service') LOOP
    -- Drop what the account HOLDS. Tag grants and a personal tag are
    -- capability, not content: a retired account must hold neither.
    -- account_tags cascades from both sides, so removing the personal tag
    -- takes its membership with it.
    --
    -- The role switch wraps ONLY these two statements. brain_system is the
    -- BYPASSRLS escape, not a superuser: it holds no grants on accounts, so
    -- widening this to cover the UPDATE below fails with "permission denied
    -- for table accounts". Narrow is both safer and the only thing that works.
    SET LOCAL ROLE brain_system;
    DELETE FROM account_tags WHERE account_id = r.id;
    DELETE FROM tags WHERE kind = 'personal' AND account_id = r.id;
    RESET ROLE;

    -- Then revoke the account itself: status + a cleared token_hash, which is
    -- what actually stops it authenticating. accounts is not RLS-bound, and
    -- brain_owner is the role that may write it.
    UPDATE accounts
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
     WHERE id = r.id;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'retired % service account(s): tags purged, token cleared, status revoked', v_n;
END $$;

-- 4 ------------------------------------------------------- teammate functions
DROP FUNCTION IF EXISTS brain_provision_teammate(text, text, text);
DROP FUNCTION IF EXISTS brain_teammate_token(text);

-- 5 ---------------------------------------- brain_tag_grant without is_service
-- Replaced in the SAME migration that drops the column it reads. See the header.
CREATE OR REPLACE FUNCTION brain_tag_grant(p_slug text, p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_actor uuid; v_tag tags%ROWTYPE;
BEGIN
  v_actor := brain_assert_owner();
  SELECT * INTO v_tag FROM tags WHERE slug = p_slug;
  IF v_tag.id IS NULL THEN RAISE EXCEPTION 'no such tag'; END IF;
  IF v_tag.kind = 'personal' THEN RAISE EXCEPTION 'personal tags are not assignable'; END IF;
  INSERT INTO account_tags (tag_id, account_id, granted_by) VALUES (v_tag.id, p_account, v_actor)
    ON CONFLICT DO NOTHING;
END $fn$;
ALTER FUNCTION brain_tag_grant(text, uuid) OWNER TO brain_system;
REVOKE EXECUTE ON FUNCTION brain_tag_grant(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_tag_grant(text, uuid) TO brain_app;

-- 6 ------------------------------------------------------ accounts.is_service
ALTER TABLE accounts DROP COLUMN IF EXISTS is_service;
`;

export const migration0059: Migration = {
  version: "0059",
  name: "contract-teammate-remote-mcp",
  sql: SQL,
  allowDestructive: [
    {
      rule: "drop-table",
      match: "remote_mcp_member_ack",
      reason:
        "the remote-MCP feature was removed in code on 2026-07-29 (PR #274) and the fleet has long since converged past the rollback window this table was kept open for; nothing reads or writes it",
    },
    {
      rule: "drop-table",
      match: "remote_mcp_tools_cache",
      reason:
        "cache of a removed feature's tools/list snapshots — derived data with no reader since 2026-07-29, and regenerable by definition if the feature ever returns",
    },
    {
      rule: "drop-table",
      match: "remote_mcp_server",
      reason:
        "the last reader (tools/list) went with PR #274 on 2026-07-29; its slugs are used HERE, before the drop, to sweep the connector_config/connector_secrets credentials they keyed, so nothing is orphaned",
    },
    {
      rule: "drop-column",
      match: "is_service",
      reason:
        "the teammate feature was removed on 2026-07-30 (PR #298); this migration revokes every service-account row and purges its tags BEFORE dropping the flag that identified them, and replaces brain_tag_grant — the one live function whose body read the column — in the same migration, so no box is left with a function that compiles and fails at runtime",
    },
  ],
  reason:
    "contract the schema left behind by the remote-MCP (2026-07-29) and teammate (2026-07-30) removals, sweeping the remote servers' encrypted credentials before their slugs become unrecoverable",
};
