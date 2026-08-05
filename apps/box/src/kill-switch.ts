import type { MiddlewareHandler } from "hono";
import { logEvt } from "./log.js";
import { recordBoxError } from "./errors.js";
import {
  bootDecision,
  handleValidateOutcome,
  initialKillState,
  type Decision,
  type KillClientConfig,
  type KillClientState,
  type ValidateOutcome,
} from "./kill-switch-client.js";

/**
 * The box-side kill-switch GATE. Wraps the pure
 * kill-switch-client state machine with the request-path integration: it polls
 * the booth `/v1/validate` (cached ~5s), keeps the persisted state, and exposes
 * a Hono middleware that gates EVERY externally-reachable surface (/mcp, /api,
 * the dashboard) — not just /mcp — returning 503 when the box is `off` or has
 * fallen out of the fail-open grace window. `/healthz` stays open for the
 * container/probe. Boots fail-closed if the last-verified lease is stale.
 */
export interface KillSwitchOptions {
  readonly config: KillClientConfig;
  /** fetch a fresh signed lease from the booth (transport is the caller's). */
  readonly validate: () => Promise<ValidateOutcome>;
  readonly refreshMs?: number;
  readonly now?: () => number;
  readonly initialState?: KillClientState;
  readonly persist?: (state: KillClientState) => void;
}

export class KillSwitchGate {
  private state: KillClientState;
  private decision: Decision;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly opts: KillSwitchOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.refreshMs = opts.refreshMs ?? 5000;
    this.state = opts.initialState ?? initialKillState();
    // boot-time gate: decide from persisted state BEFORE any network call.
    const boot = bootDecision(this.state, opts.config, this.now());
    this.state = boot.state;
    this.decision = boot.decision;
    opts.persist?.(this.state);
  }

  async refresh(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastCheck < this.refreshMs) return;
    this.lastCheck = now;
    let outcome: ValidateOutcome;
    try {
      outcome = await this.opts.validate();
    } catch {
      outcome = { ok: false, reason: "unreachable" };
    }
    // a failing check was previously INVISIBLE while the box sat in grace
    // heading for a blackout — one warn per refresh interval names it.
    if (!outcome.ok) {
      logEvt("killswitch_check_failed", { reason: outcome.reason }, "warn");
      if (outcome.reason === "unreachable") recordBoxError({ code: "booth_unreachable", count: 1 });
    }
    const ev = handleValidateOutcome(this.state, outcome, this.opts.config, this.now());
    this.state = ev.state;
    this.decision = ev.decision;
    this.opts.persist?.(this.state);
  }

  async allowed(): Promise<boolean> {
    await this.refresh();
    return this.decision === "allow";
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      // Internal probes stay open: /healthz (liveness) and /canary (write-path)
      // must reflect the box's health, not the kill-switch state — else the
      // updater would misread an intentionally-off box as a broken deploy. Both
      // are blocked at caddy, so they are reachable only on the compose network.
      if (c.req.path === "/healthz" || c.req.path === "/canary") return next();
      if (!(await this.allowed())) {
        return c.json(
          { error: "service unavailable: the box is off or unreachable from the control plane" },
          503,
        );
      }
      return next();
    };
  }
}
