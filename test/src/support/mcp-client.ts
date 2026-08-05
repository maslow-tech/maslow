/* eslint-disable @typescript-eslint/no-explicit-any -- pragmatic dynamic JSON-RPC shapes in a test client */
/**
 * A minimal scripted MCP client (Streamable HTTP JSON-RPC) for the e2e suite.
 * `request` is any fetch-shaped function — in tests we pass the box Hono app's
 * `app.request`, so the call goes through the real routing + auth + dispatch
 * stack without binding a socket.
 */
type RequestFn = (path: string, init: RequestInit) => Promise<Response>;

export interface McpToolError extends Error {
  brain?: { code?: string; message?: string; unblock?: string };
}

export class McpClient {
  private idCounter = 0;
  constructor(
    private readonly request: RequestFn,
    private token: string,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    const res = await this.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.idCounter, method, params }),
    });
    if (res.status === 401) {
      const err = new Error("unauthorized") as McpToolError;
      err.brain = { code: "refused" };
      throw err;
    }
    const json = (await res.json()) as { result?: any; error?: { code: number; message: string } };
    if (json.error) throw new Error(`rpc error ${json.error.code}: ${json.error.message}`);
    return json.result;
  }

  initialize(): Promise<any> {
    return this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "brain-test-client", version: "0" },
    });
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const r = await this.rpc("tools/list");
    return r.tools;
  }

  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text: string | undefined = r.content?.[0]?.text;
    // Errors are always a JSON BrainError envelope; successes are JSON only
    // for tools the presentation layer doesn't render — rendered tools
    // (get/search/recent/list) return line-oriented text, handed back raw.
    const looksJson = !!text && /^[[{]/.test(text.trimStart());
    const parsed = looksJson ? JSON.parse(text) : null;
    if (r.isError) {
      const err = new Error(parsed?.message ?? "tool error") as McpToolError;
      err.brain = parsed;
      throw err;
    }
    return (parsed ?? text ?? null) as T;
  }
}
