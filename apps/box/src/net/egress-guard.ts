// The single outbound HTTP primitive for anything an agent can steer — the
// generic custom-connector executor routes through here (the SSRF
// centerpiece).
//
// The one job: an outbound URL whose host an attacker may influence must never
// reach an internal address, and must never be re-resolvable after the check.
// The guard therefore, on EVERY call (request time, never definition time):
//   1. resolves the host to concrete addresses (DNS or a literal IP),
//   2. CIDR-tests EVERY resolved address against a numeric blocklist — IP-ness
//      is decided only by resolving + CIDR math, never by a hostname string or
//      regex, so decimal / octal / hex / IPv4-mapped encodings are covered
//      uniformly (the WHATWG URL parser normalizes them into url.hostname first,
//      then dns.lookup returns the literal), G1.2/G1.3,
//   3. PINS the connection to the first validated address via the socket
//      `lookup` hook so the TCP target is the checked IP and DNS is never
//      consulted a second time — a rebind between check and connect cannot
//      reach an internal host (DNS-rebinding / TOCTOU closed), G1.1,
//   4. REFUSES redirects (any 3xx is an error — a redirect could carry the
//      credential off-host or bounce to metadata), G1.5, and
//   5. never reflects the upstream URL / Location / body into an error string —
//      every failure message is static, G1.5.
//
// Byte + time caps (G6.2) bound a hostile or wedged upstream. The blocklist is
// numeric ranges only; nothing here trusts a hostname's spelling.

import { request as httpsRequest } from "node:https";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { promisify } from "node:util";

/**
 * A node `lookup` that pins the socket to a PRE-VALIDATED address so DNS is
 * never consulted again (TOCTOU/rebinding closed). Node invokes `lookup` two
 * ways: the scalar contract `cb(err, address, family)`, OR — when the connect
 * path passes `{ all: true }` (which the real Agent does for a HOSTNAME URL) —
 * the ARRAY contract `cb(err, [{address, family}])`. Returning the scalar form
 * to an `{all:true}` caller makes node read `addresses[0].address` = undefined
 * → `ERR_INVALID_IP_ADDRESS`. An IP-LITERAL URL skips `lookup` entirely, which
 * is exactly why 127.0.0.1-only tests never caught this — every real hostname
 * broke. Honor BOTH contracts.
 */
const pinnedLookup =
  (pinned: { address: string; family: number }): LookupFunction =>
  (_hostname, options, cb) => {
    if (options && (options as { all?: boolean }).all) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      cb(null, pinned.address, pinned.family);
    }
  };

const dnsLookupAll = promisify(dnsLookupCb) as (
  host: string,
  opts: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

/** Thrown when a destination resolves to a blocked address or a hop tries to
 *  redirect. The message is STATIC — never the host, the Location, or the body
 *  (no reflection channel back to the caller). */
export class EgressBlocked extends Error {
  constructor(public readonly kind: string) {
    super("egress blocked: destination or redirect is not permitted");
    this.name = "EgressBlocked";
  }
}

/** Thrown on timeout / oversize / transport failure. Static message, mirroring
 *  custom.ts's no-passthrough rule (a network/DNS message could embed the URL). */
export class RequestFailed extends Error {
  constructor() {
    super("request failed (timeout, network error, or refused redirect)");
    this.name = "RequestFailed";
  }
}

export interface GuardedInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export type GuardedFetch = (url: string, init?: GuardedInit) => Promise<GuardedResponse>;

// ---- numeric blocklist (G1.2/G1.3) ----------------------------------------
// Parsed once into {base, prefix}. v4 as 32-bit ints, v6 as 128-bit BigInts.
// NO hostname strings appear anywhere in the decision.
const BLOCKED_V4 = [
  "127.0.0.0/8", // loopback
  "10.0.0.0/8", // private
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "169.254.0.0/16", // link-local — INCLUDES the IMDS 169.254.169.254 (G1.3)
  "100.64.0.0/10", // CGNAT
  "0.0.0.0/8", // "this host" / unspecified
];
const BLOCKED_V6 = [
  "::/128", // unspecified — [::] routes to ::1 loopback on connect (the v6 twin of 0.0.0.0)
  "::1/128", // loopback
  "fc00::/7", // unique-local
  "fe80::/10", // link-local
  "::ffff:0:0/96", // ALL IPv4-mapped (catches ::ffff:169.254.169.254 uniformly)
  "fd00:ec2::/64", // the AWS IMDS IPv6 range (fd00:ec2::254), G1.3
];

function v4ToInt(addr: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

/** Expand any textual IPv6 (incl. `::` and embedded-IPv4 forms) to a 128-bit
 *  BigInt, or null if it isn't a well-formed v6 literal. */
function v6ToBigInt(input: string): bigint | null {
  let a = input;
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  // Embedded IPv4 tail (`::ffff:1.2.3.4`) → rewrite as two hextets.
  const lastColon = a.lastIndexOf(":");
  const tail = a.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    a = `${a.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

const V4_RANGES = BLOCKED_V4.map((c) => {
  const [base, bits] = c.split("/") as [string, string];
  const prefix = Number(bits);
  const baseInt = v4ToInt(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (baseInt & mask) >>> 0, mask };
});

const V6_RANGES = BLOCKED_V6.map((c) => {
  const [base, bits] = c.split("/") as [string, string];
  const prefix = BigInt(bits);
  const baseBig = v6ToBigInt(base)!;
  const full = (1n << 128n) - 1n;
  const mask = prefix === 0n ? 0n : (full << (128n - prefix)) & full;
  return { base: baseBig & mask, mask };
});

/**
 * True if `addr` (a concrete resolved address) falls in any blocked CIDR.
 * Encoding-agnostic: callers pass what DNS / the URL parser produced, and both
 * v4 (dotted) and v6 (incl. IPv4-mapped) are tested with CIDR math. A string
 * that is neither a valid v4 nor v6 literal is treated as BLOCKED (fail closed).
 */
export function isBlockedIp(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "");
  if (isIPv4(a)) {
    const n = v4ToInt(a);
    if (n === null) return true;
    return V4_RANGES.some((r) => (n & r.mask) >>> 0 === r.base);
  }
  if (isIPv6(a)) {
    const n = v6ToBigInt(a);
    if (n === null) return true;
    return V6_RANGES.some((r) => (n & r.mask) === r.base);
  }
  return true; // not a recognizable literal → refuse
}

// ---- the guarded fetch ----------------------------------------------------

/** Test seam ONLY: production wires the exported `guardedFetch` (real DNS +
 *  real blocklist). Tests inject a resolver (to simulate rebinding) or a
 *  permissive blocklist (to exercise the transport path against a local
 *  server). There is no per-CALL bypass — the hot path signature is
 *  `(url, init)` with no policy hooks, so an agent-reachable call can never
 *  weaken the guard. */
interface GuardDeps {
  readonly resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  readonly isBlocked?: (address: string, family: number) => boolean;
}

async function defaultResolve(host: string): Promise<Array<{ address: string; family: number }>> {
  const r = await dnsLookupAll(host, { all: true, verbatim: true });
  return r.map((x) => ({ address: x.address, family: x.family }));
}

/**
 * The security-critical FRONT HALF: parse the URL, refuse non-http(s) and
 * embedded userinfo, resolve the host, CIDR-test EVERY resolved address, and
 * return the URL + the single pinned address. Throws `EgressBlocked` BEFORE
 * any socket opens.
 */
async function validateAndPin(
  url: string,
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>,
  isBlocked: (address: string, family: number) => boolean,
): Promise<{ u: URL; pinned: { address: string; family: number } }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EgressBlocked("invalid-url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new EgressBlocked("scheme-not-permitted");
  }
  if (u.username || u.password) {
    throw new EgressBlocked("embedded-credentials"); // no userinfo — an off-host redirect would carry it
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");

  // resolve, then CIDR-test EVERY answer BEFORE any socket opens.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new EgressBlocked("dns-failed");
  }
  if (addrs.length === 0) throw new EgressBlocked("no-address");
  for (const a of addrs) {
    if (isBlocked(a.address, a.family)) throw new EgressBlocked("internal-address");
  }
  return { u, pinned: addrs[0]! };
}

export function makeGuardedFetch(deps: GuardDeps = {}): GuardedFetch {
  const resolve = deps.resolve ?? defaultResolve;
  const isBlocked = deps.isBlocked ?? ((address: string) => isBlockedIp(address));

  return async function guardedFetch(
    url: string,
    init: GuardedInit = {},
  ): Promise<GuardedResponse> {
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;

    // 1+2: resolve → CIDR-test every answer → pin ONE (shared with the stream).
    const { u, pinned } = await validateAndPin(url, resolve, isBlocked);

    // 3+4+5: connect with the socket PINNED to the validated address (DNS is
    // never consulted again), refuse redirects, cap bytes/time, static errors.
    return await new Promise<GuardedResponse>((resolveP, rejectP) => {
      const mod = u.protocol === "https:" ? httpsRequest : httpRequest;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      let req: ClientRequest;
      try {
        req = mod(
          u,
          {
            method: init.method ?? "GET",
            ...(init.headers ? { headers: init.headers } : {}),
            // Pin the socket to the ALREADY-VALIDATED address — this closes the
            // TOCTOU window: the hostname still rides in SNI/Host, but the TCP
            // target is the IP we checked, and the resolver is never called.
            lookup: pinnedLookup(pinned),
            signal: AbortSignal.timeout(timeoutMs),
          },
          (res: IncomingMessage) => {
            const status = res.statusCode ?? 0;
            // redirect:"error" — hardcoded, every hop (G1.5). Never follow.
            if (
              status === 301 ||
              status === 302 ||
              status === 303 ||
              status === 307 ||
              status === 308
            ) {
              res.destroy();
              req.destroy();
              done(() => rejectP(new EgressBlocked("redirect")));
              return;
            }
            const cl = Number(res.headers["content-length"] ?? 0);
            if (cl && cl > maxBytes) {
              res.destroy();
              req.destroy();
              done(() => rejectP(new RequestFailed()));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (c: Buffer) => {
              total += c.length;
              if (total > maxBytes) {
                res.destroy();
                req.destroy();
                done(() => rejectP(new RequestFailed()));
                return;
              }
              chunks.push(c);
            });
            res.on("end", () => {
              const headers = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === "string") headers.set(k, v);
                else if (Array.isArray(v)) headers.set(k, v.join(", "));
              }
              done(() =>
                resolveP({ status, headers, text: Buffer.concat(chunks).toString("utf8") }),
              );
            });
            res.on("error", () => done(() => rejectP(new RequestFailed())));
          },
        );
      } catch {
        done(() => rejectP(new RequestFailed()));
        return;
      }
      req.on("error", () => done(() => rejectP(new RequestFailed())));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  };
}

/** The production guard: real DNS + the real numeric blocklist, no bypass. */
export const guardedFetch: GuardedFetch = makeGuardedFetch();
