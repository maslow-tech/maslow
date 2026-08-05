import { migration0001 } from "./0001-init.js";
import { migration0002 } from "./0002-executor.js";
import { migration0003 } from "./0003-invariants.js";
import { migration0004 } from "./0004-enum-check.js";
import { migration0005 } from "./0005-deletion-mirror.js";
import { migration0006 } from "./0006-ref-mirror.js";
import { migration0007 } from "./0007-think-merge.js";
import { migration0008 } from "./0008-accounts-admin.js";
import { migration0009 } from "./0009-operator-ops.js";
import { migration0010 } from "./0010-operator-account.js";
import { migration0011 } from "./0011-canary.js";
import { migration0012 } from "./0012-private-visibility.js";
import { migration0013 } from "./0013-prop-history.js";
import { migration0014 } from "./0014-embeddings.js";
import { migration0015 } from "./0015-owner-guards.js";
import { migration0016 } from "./0016-member-schema-admin.js";
import { migration0017 } from "./0017-drop-operator.js";
import { migration0018 } from "./0018-weighted-tsv.js";
import { migration0019 } from "./0019-call-audit.js";
import { migration0020 } from "./0020-drop-think.js";
import { migration0021 } from "./0021-source-refs.js";
import { migration0022 } from "./0022-type-icons.js";
import { migration0023 } from "./0023-box-kv.js";
import { migration0024 } from "./0024-connector-config.js";
import { migration0025 } from "./0025-connector-vault.js";
import { migration0026 } from "./0026-write-reason.js";
import { migration0027 } from "./0027-props-version-exact.js";
import { migration0028 } from "./0028-redact-connector-history.js";
import { migration0029 } from "./0029-chunk-embeddings.js";
import { migration0030 } from "./0030-on-behalf-of.js";
import { migration0031 } from "./0031-provision-teammate.js";
import { migration0032 } from "./0032-group-on-behalf-of.js";
import { migration0033 } from "./0033-custom-connectors.js";
import { migration0034 } from "./0034-connector-config-scope.js";
import { migration0036 } from "./0036-remote-mcp.js";
// The filesystem is 0037: 0035 is reserved (unified-integrations client_id) and
// 0036 is remote-MCP, so the filesystem takes the next free slot — strictly
// after everything on main, so it can never apply out of order on a live box.
import { migration0037 } from "./0037-filesystem.js";
// 0038 (remote-MCP OAuth: token-fingerprint + provenance columns, PR2b) — the
// spec calls it "0037", but that slot is the filesystem; append-only doctrine
// puts it in the next free slot, strictly after everything so it never applies
// out of order on a live box.
import { migration0038 } from "./0038-remote-mcp-oauth.js";
// 0039 (remote-MCP FLEET kill mirror, PR2c): the box-local `booth_kill` column
// the signed-directive poller reconciles to the booth's kill directives.
import { migration0039 } from "./0039-remote-mcp-fleet-kill.js";
// 0040-0042 (SDLC hardening) — renumbered after main's 0039 per append-only.
import { migration0040 } from "./0040-force-rls.js";
import { migration0041 } from "./0041-events-actor-budget-index.js";
import { migration0042 } from "./0042-reissue-owner-token.js";
// 0043 (filesystem version control + locks): the fs_versions snapshot log
// (RLS-scoped like fs_entries) + fs_entries lock columns.
import { migration0043 } from "./0043-fs-versions-locks.js";
// 0044 (widen remote_mcp_server.auth_kind CHECK to admit 'oauth'). 0043 is
// claimed by the filesystem versions/locks work (PR #195, opened first) — this
// takes the next free slot rather than bouncing that branch a second time.
import { migration0044 } from "./0044-remote-mcp-oauth-authkind.js";
// 0045 (fs version eviction, elevated): fs_versions is FORCE-RLS, so eviction
// running as the writing member measured and enforced the "global" byte budget
// over that member's own slice only. The reaper moves into a brain_system-owned
// SECURITY DEFINER function that sees the whole table and discloses nothing.
import { migration0045 } from "./0045-fs-evict-versions.js";
// 0046 (fs_versions on_behalf_of): 0043 hand-copied fs_entries' RLS policy onto
// fs_versions and dropped the narrowing conjunct, so a session acting
// on-behalf-of a member could still read the ACTING principal's own home files
// out of the version log (history/versionContent/listTrash) after the live read
// correctly ENOENT'd. The conjunct now lives in one shared, frozen string.
import { migration0046 } from "./0046-fs-versions-obo.js";
// 0047 (fs_versions unique (path, version_no)): 0043's index was NON-unique and
// the store allocated version_no with a racy max+1, so an `rm -r` (locking the
// directory) and a concurrent write (locking the file) both wrote version 1 for
// one path — and (path, version_no) is the key every reader uses. De-duplicates
// first (renumber the later row), then makes the pair unique.
import { migration0047 } from "./0047-fs-versions-unique.js";
// 0048 (fs_version_seq): version_no was allocated from the SURVIVING rows, so
// once eviction reclaimed a path's whole history the counter restarted at 1 and
// a remembered `restore <path> 3` silently bound to different bytes. The
// high-water mark now lives outside the evictable rows, written by the reaper.
import { migration0048 } from "./0048-fs-version-highwater.js";
// 0049: fs_version_seq shipped without RLS — its sibling tables are FORCE-RLS,
// so a private home PATH was enumerable by brain_owner with no DR escape.
import { migration0049 } from "./0049-fs-version-seq-rls.js";
// 0050 (remote-MCP OAuth scopes): the connect flow never sent a `scope`
// parameter, so an AS that requires one refused — Robinhood does it silently
// (bounces to its agentic hub, no error), leaving Connect a no-op. Store the
// AS's advertised scopes at registration so connect can send them.
import { migration0050 } from "./0050-remote-mcp-oauth-scopes.js";
// 0051: defense-in-depth guard on brain_fs_evict_versions (0045) —
// refuse a non-positive budget, floor keep at 1, so the BYPASSRLS eviction
// function can never be a global-wipe primitive.
import { migration0051 } from "./0051-fs-evict-args-guard.js";
// Workspace-UI migrations. These take the next free slots STRICTLY AFTER
// everything main has already shipped (main is through 0051 —
// 0051-fs-evict-args-guard), so they can never collide with an applied
// migration's checksum on a live box or fail migration-numbering on merge:
// 0052 = write_idempotency (phase 1), 0053 = collab_docs (phase 2), 0054 =
// saved_views (phase 4). Renumbered from the original 0043/0044/0045
// reservation, and again off 0051/0052/0053, which main has since claimed for
// unrelated fs-versions/OAuth/fs-evict migrations.
import { migration0052 } from "./0052-write-idempotency.js";
// 0053 (collab_docs, phase 2): the Yjs room blob + flush bookkeeping; FORCE
// RLS at birth with the OBJECT's visibility as both USING and WITH CHECK.
import { migration0053 } from "./0053-collab-docs.js";
// 0054 (saved_views, phase 4): per-member named view configs (kind 'database'
// now, 'graph' from birth so phase 6 needs no second migration); FORCE RLS at
// birth with the MEMBER predicate as both USING and WITH CHECK — a USING-only
// policy would let one member plant a pinned view in another member's sidebar.
import { migration0054 } from "./0054-saved-views.js";
import { migration0055 } from "./0055-drop-pending-ops.js";
// 0056 checked against every open PR/branch on 2026-07-29 — no other claimant.
import { migration0056 } from "./0056-set-type-audit.js";
// 0057 (tag governance): tags/account_tags, the audience DNF column + backfill
// from the legacy visibility/shared_with columns, the brain_can_see policy
// swap, owner-gated tag-admin fns, and the teammate account heal. Renumbered
// TWICE: claimed 0052 (main topped out at 0051 on 2026-07-23), then 0056
// after main took 0052-0055, then here after main's set-type-audit landed as
// 0056 the same day this branch's PR opened — main merged first, we yield.
import { migration0057 } from "./0057-tag-governance.js";
// 0058 (governance): objects.governed_by + the delayed owner-removal ledger.
import { migration0058 } from "./0058-governance.js";
import { migration0059 } from "./0059-contract-teammate-remote-mcp.js";
import { migration0060 } from "./0060-fs-larger-files.js";
import type { Migration } from "./types.js";

export { migrationChecksum } from "./types.js";
export type { Migration } from "./types.js";

/**
 * The ordered infra migration set. Append-only: new versions are added, never
 * edited in place (the ledger stores a checksum and the runner refuses a
 * changed already-applied migration).
 */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
  migration0028,
  migration0029,
  migration0030,
  migration0031,
  migration0032,
  migration0033,
  migration0034,
  // 0035 (client_id column) is reserved by the unified-integrations plan for a
  // later increment; 0036 is remote-MCP (PR2a); 0037 is the filesystem.
  migration0036,
  migration0037,
  migration0038,
  migration0039,
  migration0040,
  migration0041,
  migration0042,
  migration0043,
  migration0044,
  migration0045,
  migration0046,
  migration0047,
  migration0048,
  migration0049,
  migration0050,
  migration0051,
  // The workspace-UI migrations append strictly after everything main has
  // shipped (through 0051), so they never apply out of order on a live box.
  migration0052,
  migration0053,
  migration0054,
  // 0055 is the cleanup sweep's drop of the never-used pending_ops table.
  migration0055,
  migration0056,
  // 0057 is tag governance, renumbered off its 0052 and 0056 claims.
  migration0057,
  migration0058,
  // 0059 is the contraction the two feature removals deferred: the remote-MCP
  // tables (2026-07-29) and the teammate's is_service column + provisioning
  // functions (2026-07-30). Both were held back on purpose so a canary-failure
  // rollback would not land on an image that still read them; both have
  // converged. It sweeps the remote servers' connector_config /
  // connector_secrets credentials BEFORE dropping the table whose slugs are the
  // only way to identify them.
  migration0059,
  // 0060 widens the fs per-file CHECK to 100 MB. See its header for why the
  // cost is WAL rather than disk, and why the next raise needs chunked rows.
  migration0060,
];
