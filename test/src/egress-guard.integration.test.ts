import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EgressBlocked,
  RequestFailed,
  guardedFetch,
  isBlockedIp,
  makeGuardedFetch,
} from "@brain/box";

/**
 * SSRF egress guard. The security property: an outbound URL
 * whose host an attacker can influence must never reach an internal address, and
 * a rebind between check and connect must not slip through. Each block case here
 * asserts BOTH that guardedFetch throws EgressBlocked AND that a local listener
 * standing in for the internal address received ZERO connections — i.e. no
 * socket was ever opened.
 */
describe("egress guard — SSRF fail-closed (G1)", () => {
  // A loopback TCP listener that counts every inbound connection. It stands in
  // for "the internal address": if the guard opened a socket, this ticks up.
  let listener: TcpServer;
  let listenerPort = 0;
  let connections = 0;

  beforeAll(async () => {
    listener = createTcpServer((sock) => {
      connections += 1;
      sock.destroy();
    });
    await new Promise<void>((res) => listener.listen(0, "127.0.0.1", res));
    listenerPort = (listener.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((res) => listener.close(() => res()));
  });

  it("isBlockedIp classifies internal ranges (v4, v6, IPv4-mapped, IMDS)", () => {
    for (const a of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // IMDS v4
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254", // IMDS v6
      "::ffff:169.254.169.254", // IPv4-mapped IMDS
      "::ffff:7f00:1", // IPv4-mapped loopback (hex form)
      "::", // IPv6 unspecified — [::] connects to ::1 loopback (the v6 twin of 0.0.0.0)
    ]) {
      expect(isBlockedIp(a), `${a} must be blocked`).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(a), `${a} must be allowed`).toBe(false);
    }
    // Not a recognizable literal → fail closed (blocked).
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });

  it("blocks a loopback URL with ZERO sockets opened", async () => {
    connections = 0;
    await expect(guardedFetch(`http://127.0.0.1:${listenerPort}/`)).rejects.toBeInstanceOf(
      EgressBlocked,
    );
    expect(connections).toBe(0);
  });

  it("blocks a DECIMAL-encoded loopback (2130706433) with ZERO sockets", async () => {
    connections = 0;
    await expect(guardedFetch(`http://2130706433:${listenerPort}/`)).rejects.toBeInstanceOf(
      EgressBlocked,
    );
    expect(connections).toBe(0);
  });

  it("blocks a HEX-encoded loopback (0x7f000001) with ZERO sockets", async () => {
    connections = 0;
    await expect(guardedFetch(`http://0x7f000001:${listenerPort}/`)).rejects.toBeInstanceOf(
      EgressBlocked,
    );
    expect(connections).toBe(0);
  });

  it("blocks a DNS rebind whose resolution is the metadata IP, ZERO sockets", async () => {
    connections = 0;
    // The URL host points at our loopback listener, but the (injected) resolver
    // returns the metadata address — the rebind. The guard must reject on the
    // RESOLVED address before any socket opens, so the listener stays at 0.
    const gf = makeGuardedFetch({
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    await expect(gf(`http://127.0.0.1:${listenerPort}/latest/meta-data/`)).rejects.toBeInstanceOf(
      EgressBlocked,
    );
    expect(connections).toBe(0);
  });

  it("blocks an IPv4-mapped metadata address (::ffff:169.254.169.254)", async () => {
    connections = 0;
    const gf = makeGuardedFetch({
      resolve: async () => [{ address: "::ffff:169.254.169.254", family: 6 }],
    });
    await expect(gf(`http://127.0.0.1:${listenerPort}/`)).rejects.toBeInstanceOf(EgressBlocked);
    expect(connections).toBe(0);
  });

  it("blocks an internal target named as a discovery token_endpoint", async () => {
    connections = 0;
    // A discovery doc that named http://10.0.0.9/token would be fetched via the
    // SAME guard — resolving to an internal address ⇒ blocked, no socket.
    const gf = makeGuardedFetch({
      resolve: async () => [{ address: "10.0.0.9", family: 4 }],
    });
    await expect(
      gf(`http://127.0.0.1:${listenerPort}/.well-known/oauth-authorization-server`),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(connections).toBe(0);
  });

  it("blocks a literal internal URL (metadata host verbatim)", async () => {
    await expect(
      guardedFetch("http://169.254.169.254/latest/meta-data/iam/"),
    ).rejects.toBeInstanceOf(EgressBlocked);
  });

  // ---- transport-path behaviors, exercised with a loopback-permitting guard --
  // (the egress POLICY is tested above; here we test redirect refusal + caps +
  // the happy path against a real local server the guard is allowed to reach.)
  describe("with a loopback-permitting guard (policy tested above)", () => {
    let http: HttpServer;
    let base = "";
    const permissive = makeGuardedFetch({ isBlocked: () => false });

    beforeAll(async () => {
      http = createHttpServer((req, res) => {
        if (req.url === "/ok") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ hello: "world" }));
        } else if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
          res.end();
        } else if (req.url === "/big") {
          res.writeHead(200);
          res.end("x".repeat(50_000));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((r) => http.close(() => r()));
    });

    it("returns status + text on the happy path", async () => {
      const res = await permissive(`${base}/ok`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ hello: "world" });
    });

    it("connects to a HOSTNAME URL via the pinned lookup (regression: node's {all:true} contract)", async () => {
      // A real hostname (not an IP literal) is the ONLY thing that exercises
      // node's `lookup` — and node calls it with `{all:true}`, so the pin must
      // return the ARRAY form or node reads addresses[0].address = undefined →
      // ERR_INVALID_IP_ADDRESS. Every custom-connector call in
      // production hits this path; every 127.0.0.1 test skipped it. Point a fake
      // hostname at the local server via an injected resolver.
      const port = (http.address() as { port: number }).port;
      const gf = makeGuardedFetch({
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        isBlocked: () => false,
      });
      const res = await gf(`http://pinned.test:${port}/ok`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ hello: "world" });
    });

    it("REFUSES a 302 to metadata (redirect:error), never follows", async () => {
      await expect(permissive(`${base}/redirect`)).rejects.toBeInstanceOf(EgressBlocked);
    });

    it("enforces the byte cap", async () => {
      await expect(permissive(`${base}/big`, { maxBytes: 1000 })).rejects.toBeInstanceOf(
        RequestFailed,
      );
    });
  });
});
