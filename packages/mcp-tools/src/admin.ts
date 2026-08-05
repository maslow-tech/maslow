import type { Pool, PoolClient } from "pg";
import { AuthError, generateToken, validateActorById } from "./auth.js";
import { mapWriteError, type Scope } from "./write-path.js";

/** The three standard permission tiers (migration 0015); scopes are derived. */
export type Permission = "owner" | "member" | "viewer";

export interface AdminOptions {
  /**
   * Fired AFTER a revoke commits, with the revoked account id — mirrors
   * `WriterOptions.onAccessChange`. The box wires this to the collab eviction
   * hub so an MCP `revoke_user` closes the revoked member's already-open
   * editor sockets in the same breath as the write, exactly as the dashboard
   * revoke route does. Without it those sockets keep streaming every
   * keystroke the team types until the ≤60s reauth floor catches them — the
   * exact window the offboarding design refuses to accept. Notification only:
   * never awaited, never able to fail the revoke.
   */
  readonly onAccountRevoked?: (accountId: string) => void;
}

/**
 * Local account administration. Thin wrappers over the
 * SECURITY DEFINER account fns, always run with app.actor_id set so the DB can
 * enforce owner-only. Every account is created with a name + email + tier
 * (owner/member/viewer). Minted tokens are returned ONCE (only their hash is
 * ever stored).
 */
export class Admin {
  constructor(
    private readonly pool: Pool,
    private readonly opts: AdminOptions = {},
  ) {}

  private async asActor<T>(actorId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw mapWriteError(e);
    } finally {
      c.release();
    }
  }

  /**
   * Create an account at one of the three tiers. Name + email + permission are
   * all required (the DB enforces it too). Only an owner may call this, and
   * only an owner may create another owner.
   */
  async createUser(
    actorId: string,
    input: { name: string; email: string; permission: Permission },
  ): Promise<{ id: string; token: string }> {
    const { token, hash } = generateToken(
      input.permission === "owner" ? "brain_owner" : "brain_user",
    );
    const id = await this.asActor(actorId, async (c) => {
      const r = await c.query<{ id: string }>("SELECT brain_create_user($1, $2, $3, $4) AS id", [
        input.name,
        input.email,
        input.permission,
        hash,
      ]);
      const newId = r.rows[0]!.id;
      await this.createPersonalPage(c, newId, input.name);
      await this.createFsHome(c, newId, input.name);
      return newId;
    });
    return { id, token };
  }

  /**
   * Every account gets one private home page (mirrors the 0012 seed for
   * pre-existing members). Acting as the new account itself so RLS WITH CHECK
   * accepts the private row and the create event carries the right actor.
   */
  private async createPersonalPage(c: PoolClient, accountId: string, name: string): Promise<void> {
    await c.query("SELECT set_config('app.actor_id', $1, true)", [accountId]);
    await c.query(
      `INSERT INTO objects (title, body, visibility, created_by)
       VALUES ($1, $2, 'private', $3)`,
      [
        `${name} — personal`,
        `Private page for ${name}. Objects with visibility 'private' — including this ` +
          `one — are visible only to their creator (and any accounts in shared_with). ` +
          `Keep personal context here; keep org knowledge org-visible.`,
        accountId,
      ],
    );
  }

  /**
   * Give the new account its filesystem home: an fs_homes slug + the
   * /home/<slug> dir row (migration 0037 — mirrors its backfill for accounts
   * created after it ran). Same slugify rules as the migration: lower,
   * non-[a-z0-9] runs become '-', trimmed; collisions get -2,-3…;
   * empty/reserved/pathological names fall back to 'user-<first 8 of uuid>'.
   * Guarded on table existence so account creation keeps working on a brain
   * migrated only part-way (e.g. the migrate-with-data seed). Runs with
   * app.actor_id already set to the new account (createPersonalPage), so the
   * trigger-pinned owner_id satisfies the fs_visibility WITH CHECK.
   */
  private async createFsHome(c: PoolClient, accountId: string, name: string): Promise<void> {
    const t = await c.query<{ ok: string | null }>(
      "SELECT to_regclass('public.fs_homes')::text AS ok",
    );
    if (!t.rows[0]?.ok) return;
    const reserved = new Set(["user", "shared", "home", "tmp", "bin", "usr", "etc", "root"]);
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/g, "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(base) || reserved.has(base)) {
      base = `user-${accountId.slice(0, 8)}`;
    }
    let slug = base;
    for (let n = 2; ; n++) {
      const clash = await c.query("SELECT 1 FROM fs_homes WHERE slug = $1", [slug]);
      if (clash.rowCount === 0) break;
      const suffix = `-${n}`;
      slug = base.slice(0, 63 - suffix.length) + suffix;
    }
    await c.query("INSERT INTO fs_homes (actor_id, slug) VALUES ($1, $2)", [accountId, slug]);
    await c.query(
      `INSERT INTO fs_entries (path, parent, name, kind, created_by, updated_by)
       VALUES ($1, '/home', $2, 'dir', $3, $3) ON CONFLICT (path) DO NOTHING`,
      [`/home/${slug}`, slug, accountId],
    );
  }

  async revokeAccount(actorId: string, id: string): Promise<void> {
    await this.asActor(actorId, (c) => c.query("SELECT brain_revoke_account($1)", [id]));
    // After commit only: an eviction for a revoke that rolled back would drop
    // a legitimate member's live sockets for nothing.
    try {
      this.opts.onAccountRevoked?.(id);
    } catch (err) {
      console.warn("admin: onAccountRevoked hook failed —", String(err));
    }
  }

  /**
   * The caller's LIVE role + scopes, read straight from accounts (the authority).
   * An OAuth JWT (claude.ai / Desktop) carries the role+scopes minted at connect
   * time for up to ACCESS_TTL (~1h), so a demoted or scope-reduced member would
   * otherwise keep their old powers until the token refreshes. Call-time authz
   * must re-read this. Returns null when the account is missing / revoked /
   * inactive / expired (fail closed) — never for those cases does it throw; a
   * genuine DB error still propagates (a real failure, not a silent downgrade).
   */
  async liveAuthz(accountId: string): Promise<{ role: string; scopes: Scope[] } | null> {
    try {
      const live = await validateActorById(this.pool, accountId);
      return { role: live.role, scopes: [...live.scopes] };
    } catch (e) {
      if (e instanceof AuthError) return null;
      throw e;
    }
  }

  async rotateToken(actorId: string, id: string): Promise<{ token: string }> {
    const { token, hash } = generateToken();
    await this.asActor(actorId, (c) => c.query("SELECT brain_rotate_token($1, $2)", [id, hash]));
    return { token };
  }

  /**
   * One-time first-owner bootstrap. Self-guards on a zero-owner box.
   * Requires a real name + email — there is no nameless default owner.
   */
  async bootstrapOwner(input: {
    name: string;
    email: string;
  }): Promise<{ id: string; token: string }> {
    const { token, hash } = generateToken("brain_owner");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query<{ id: string }>("SELECT brain_bootstrap_owner($1, $2, $3) AS id", [
        input.name,
        input.email,
        hash,
      ]);
      // brain_bootstrap_owner left app.actor_id = the new owner for this txn.
      await this.createPersonalPage(c, r.rows[0]!.id, input.name);
      // On a fresh box the migrations (incl. 0037's home backfill) ran before
      // any owner existed — the first owner needs a home like everyone else.
      await this.createFsHome(c, r.rows[0]!.id, input.name);
      await c.query("COMMIT");
      return { id: r.rows[0]!.id, token };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw mapWriteError(e);
    } finally {
      c.release();
    }
  }
}
