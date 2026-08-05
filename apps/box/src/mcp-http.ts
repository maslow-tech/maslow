import type { Context, Hono } from "hono";
import { logEvt } from "./log.js";
import { recordBoxError } from "./errors.js";
import { toBoxErrorReport } from "@brain/mcp-tools";
import type { Pool } from "pg";
import { isBrainError } from "@brain/shared";
import {
  authenticate,
  AuthError,
  callTool,
  isCustomFetchName,
  renderToolResult,
  toolDescriptors,
  toolNames,
  INITIALIZE_INSTRUCTIONS,
  type JwtVerifyOptions,
  type ToolDeps,
} from "@brain/mcp-tools";
import { recordCall } from "./activity.js";
import { APP_VERSION } from "./dashboard.js";

/**
 * The MCP surface at `/mcp` — Streamable HTTP JSON-RPC.
 * One validator on every request (never forwards the token to Postgres);
 * initialize / tools/list / tools/call. Teaching errors are returned as MCP
 * tool errors (isError), not raw RPC faults, so the agent can learn + retry.
 */

const PROTOCOL_VERSION = "2024-11-05";

/** The closed set of real tool names — the only strings telemetry may carry. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set(toolNames());

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

interface McpMountOptions {
  readonly deps: ToolDeps;
  readonly pool: Pool;
  readonly jwt?: JwtVerifyOptions;
  /**
   * The box's CANONICAL public origin (e.g. https://brain.example.com), set only
   * when the OAuth authorization server is mounted. The 401 advertises the
   * protected-resource metadata pointer from THIS value — never the request Host
   * — so a `Host: evil.com` request can't steer discovery off-box, and the
   * pointer is omitted entirely when OAuth is off.
   */
  readonly publicUrl?: string;
  /**
   * Provider slugs USABLE BY THIS CALLER, checked live per tools/list (CLAUDE.md
   * connector-visibility doctrine): org-keyed providers once an owner configures
   * them; per-member OAuth providers additionally need the caller's own
   * connected account. Absent → connector-gated tools stay hidden (fail closed).
   */
  readonly connectors?: (caller: { readonly actorId: string }) => Promise<ReadonlySet<string>>;
  /**
   * tools/list descriptors for custom connectors (owner-defined, DB-backed)
   * USABLE by this caller — the box filters by the same usable set computed
   * for `connectors`, so visibility semantics are identical to catalog
   * org-keyed providers. Input schema is the fixed custom-fetch shape and is
   * attached here. Call dispatch is NOT here: a `<slug>_fetch` call flows
   * through callTool's synthesized def (validation + call-audit intact).
   */
  readonly customTools?: (usable: ReadonlySet<string>) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly annotations: Record<string, boolean>;
      /** Advertised input schema; defaults to the custom-fetch shape when the
       *  descriptor omits it. */
      readonly inputSchema?: Record<string, unknown>;
    }>
  >;
}

/** The one input schema every custom-connector tool advertises. */
const CUSTOM_FETCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "API path (or full URL where the connector supports it). Omit entirely to get the connector's usage instructions.",
    },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
    params: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "string", description: "JSON request body (non-GET methods)" },
  },
  additionalProperties: false,
} as const;

export function mountMcp(app: Hono, opts: McpMountOptions): void {
  app.post("/mcp", async (c: Context) => {
    let ctx;
    try {
      ctx = await authenticate(
        opts.pool,
        c.req.header("authorization"),
        opts.jwt ? { jwt: opts.jwt } : undefined,
      );
    } catch (e) {
      const base = e instanceof AuthError ? e.wwwAuthenticate : 'Bearer realm="brain"';
      if (opts.publicUrl) {
        // Point clients at the discovery doc so claude.ai/Desktop starts the
        // OAuth flow (RFC 9728 / MCP auth). Uses the pinned canonical origin.
        const resourceMeta = `${opts.publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
        c.header("WWW-Authenticate", `${base}, resource_metadata="${resourceMeta}"`);
      } else {
        c.header("WWW-Authenticate", base);
      }
      // A MISSING header is protocol-normal (every claude.ai OAuth connect
      // starts with an unauthenticated POST to harvest WWW-Authenticate) —
      // info-level, never the fleet channel, or routine onboarding would
      // read as an auth attack. A PRESENTED-but-bad token is the real signal.
      // ponytail: unthrottled — add a per-minute counter if a scanner ever
      // floods this (rotation caps bound the damage meanwhile).
      if (c.req.header("authorization")) {
        logEvt("auth_rejected", { surface: "mcp", reason: "bad_token" }, "warn");
        recordBoxError({ code: "auth_rejected", count: 1 });
      } else {
        logEvt("auth_rejected", { surface: "mcp", reason: "no_token" });
      }
      return c.json(rpcError(null, -32001, "unauthorized"), 401);
    }

    let body: RpcRequest;
    try {
      body = (await c.req.json()) as RpcRequest;
    } catch {
      return c.json(rpcError(null, -32700, "parse error"), 400);
    }
    const { id, method, params } = body;

    try {
      switch (method) {
        case "initialize":
          return c.json(
            result(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "brain", version: APP_VERSION },
              instructions: INITIALIZE_INSTRUCTIONS,
            }),
          );
        case "notifications/initialized":
          return c.body(null, 202);
        case "ping":
          return c.json(result(id, {}));
        case "tools/list": {
          // Advertise only the tools this caller can actually use — an owner
          // sees people-admin tools, a member sees content+schema, a viewer
          // sees the read surface, and connector-gated tools appear only when
          // the provider is usable by THIS caller (see opts.connectors).
          // Call-time enforcement is unchanged.
          const connectors = opts.connectors
            ? await opts.connectors({ actorId: ctx.actorId })
            : new Set<string>();
          const custom = opts.customTools ? await opts.customTools(connectors) : [];
          return c.json(
            result(id, {
              tools: [
                ...toolDescriptors({ role: ctx.role, scopes: ctx.scopes, connectors }),
                ...custom.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema ?? CUSTOM_FETCH_JSON_SCHEMA,
                  annotations: t.annotations,
                })),
              ],
            }),
          );
        }
        case "tools/call": {
          const name = String(params?.name ?? "");
          const args = params?.arguments ?? {};
          // Telemetry label: a KNOWN tool name verbatim, anything else the
          // fixed marker — params.name is caller-controlled, and both the
          // stdout line and the activity rollup are documented content-free.
          // Custom-connector names pass the strict slug grammar, so they are
          // as safe to log verbatim as registry names.
          const label = KNOWN_TOOLS.has(name) || isCustomFetchName(name) ? name : "(invalid)";
          const t0 = Date.now();
          // Per-call flow bag: tool internals drop metadata facts (search
          // modes, hit counts, exit codes) that ride the mcp_call line.
          const flow: Record<string, unknown> = {};
          const callCtx = { ...ctx, flow };
          // One structured timing line per call to stdout (docker logs): tool
          // NAME + attribution ids + outcome + duration + flow metadata —
          // never arguments or content.
          const logCallLine = (ok: boolean, ms: number, code?: string): void => {
            recordCall(label, !ok, ms);
            console.log(
              JSON.stringify({
                evt: "mcp_call",
                tool: label,
                ok,
                ms,
                actor: ctx.actorId,
                ...(Object.keys(flow).length ? { flow } : {}),
                ...(code ? { code } : {}),
              }),
            );
          };
          try {
            const out = await callTool(opts.deps, callCtx, name, args);
            logCallLine(true, Date.now() - t0);
            // The presentation layer: known read-tool shapes render as compact
            // line-oriented text; everything else (and errors below — their
            // JSON envelope is load-bearing) stays JSON.
            const text = renderToolResult(name, args, out) ?? JSON.stringify(out);
            return c.json(result(id, { content: [{ type: "text", text }] }));
          } catch (toolErr) {
            const payload = isBrainError(toolErr)
              ? toolErr.toJSON()
              : { code: "internal", message: "tool failed" };
            // Fleet channel: real failures only — BrainError teaching
            // refusals (validation, connector-not-enabled) would drown the
            // console in noise that isn't "going wrong".
            if (!isBrainError(toolErr)) recordBoxError(toBoxErrorReport(toolErr));
            // ponytail: message-match for the one refusal that IS fleet-worthy
            // (disk pressure); a typed flag on BrainError if a second appears.
            else if ((toolErr as Error).message.includes("write-shed"))
              recordBoxError({ code: "write_shed_disk", count: 1 });
            logCallLine(false, Date.now() - t0, (payload as { code?: string }).code ?? "internal");
            return c.json(
              result(id, {
                isError: true,
                content: [{ type: "text", text: JSON.stringify(payload) }],
              }),
            );
          }
        }
        default:
          return c.json(rpcError(id, -32601, "method not found"));
      }
    } catch (e) {
      return c.json(rpcError(id, -32603, (e as Error).message ?? "internal error"));
    }
  });
}
