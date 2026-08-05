import type { Migration } from "./types.js";

/**
 * Remote-MCP fleet kill-switch mirror (control-plane half). One column add:
 *
 *   remote_mcp_server.booth_kill  the box-local mirror of a BOOTH kill directive
 *     (per-box or fleet-wide). The box's signed-directive poller reconciles it
 *     to the control plane; the tools/list visibility gate + the call proxy read
 *     it (effective usable = `status = 'enabled' AND NOT booth_kill`). It is
 *     DELIBERATELY separate from the owner's local `status` toggle so a fleet
 *     kill never clobbers — and a fleet clear never re-enables — an owner's
 *     manual disable. Defaults false; a killed row persists across restarts (the
 *     column IS the fail-closed state), and the poller only ever un-kills on a
 *     validly-signed, fresh directive.
 *
 * Migration doctrine (runs on LIVE boxes): append-only, guarded, NEVER throws on
 * box state. ADD COLUMN IF NOT EXISTS is a no-op on a re-run and on a box that
 * somehow already has it. No RLS, no data rewrite, no live credential row
 * touched — a pure column add reached only through the owner-gated store.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

-- G6.1 (control-plane half): the fleet kill-switch mirror. NOT NULL DEFAULT
-- false so every existing row is immediately "not killed" and the gates read a
-- concrete boolean; brain_app already has SELECT/UPDATE on the table (0036).
ALTER TABLE remote_mcp_server ADD COLUMN IF NOT EXISTS booth_kill boolean NOT NULL DEFAULT false;
`;

export const migration0039: Migration = {
  version: "0039",
  name: "remote-mcp-fleet-kill",
  sql: SQL,
};
