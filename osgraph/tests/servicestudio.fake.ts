/**
 * Test double for the servicestudio MCP streamable-HTTP endpoint (no network).
 * Shared by tests/servicestudio.*.test.ts; not a test file itself.
 */
import type { FetchLike } from "../src/servicestudio/types.js";

export interface RecordedCall {
  id: number;
  name: string;
  sessionToken: string | undefined;
  input: Record<string, unknown>;
  startedAt: number;
  /** Set by the fake when the handler's promise settles. */
  finishedAt?: number;
}

export interface FakeReply {
  /** HTTP status; default 200. */
  status?: number;
  /** Full raw body override (takes precedence over the fields below). */
  rawBody?: string;
  /** JSON-RPC error object. */
  rpcError?: { code: number; message: string; data?: unknown };
  /** Tool result text (content[0].text). */
  text?: string;
  /** result.isError flag. */
  isError?: boolean;
  /** Frame the body as SSE (default true) or plain JSON. */
  sse?: boolean;
  /** Throw this instead of answering (transport failure). */
  throwError?: Error;
  /** Never resolve until the test calls the returned release function (for timeout tests). */
  hang?: boolean;
}

export type Handler = (call: RecordedCall, attempt: number) => FakeReply | Promise<FakeReply>;

export function sseBody(rpc: unknown): string {
  return `event: message\ndata: ${JSON.stringify(rpc)}\n\n`;
}

export function rpcResult(id: number, text: string, isError = false): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
  };
}

export function rpcError(id: number, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export class FakeServiceStudio {
  readonly calls: RecordedCall[] = [];
  /** Max number of requests that were in flight at the same time (serialization check). */
  maxInFlight = 0;
  /** Requests in flight right now — readable so pool-width and drain tests can assert on it. */
  inFlight = 0;
  private readonly attempts = new Map<string, number>();
  private clock = 0;

  constructor(private readonly handler: Handler) {}

  toolCalls(name: string): RecordedCall[] {
    return this.calls.filter((c) => c.name === name);
  }

  readonly fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: { name: string; arguments: { sessionToken?: string; input: Record<string, unknown> } };
    };
    const call: RecordedCall = {
      id: body.id,
      name: body.params.name,
      sessionToken: body.params.arguments.sessionToken,
      input: body.params.arguments.input,
      startedAt: ++this.clock
    };
    this.calls.push(call);
    const attempt = (this.attempts.get(call.name) ?? 0) + 1;
    this.attempts.set(call.name, attempt);

    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const reply = await this.handler(call, attempt);
      if (reply.hang) {
        await new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (reply.throwError) throw reply.throwError;
      const status = reply.status ?? 200;
      let raw: string;
      if (reply.rawBody !== undefined) {
        raw = reply.rawBody;
      } else {
        const rpc = reply.rpcError
          ? rpcError(call.id, reply.rpcError.code, reply.rpcError.message, reply.rpcError.data)
          : rpcResult(call.id, reply.text ?? "", reply.isError ?? false);
        raw = reply.sse === false ? JSON.stringify(rpc) : sseBody(rpc);
      }
      return { status, text: async () => raw };
    } finally {
      this.inFlight--;
      call.finishedAt = ++this.clock;
    }
  };
}

export const APPS_TEXT = JSON.stringify({
  apps: [
    {
      key: "k1",
      name: "demoportal",
      kind: "eSpace",
      version: "1.0",
      description: "",
      isOpen: true,
      isReference: false,
      moduleType: "Reactive"
    }
  ]
});

/** Handler fragment: answers `listApps` with one app when the token matches, auth error otherwise. */
export function listAppsReply(call: RecordedCall, validToken: string): FakeReply | undefined {
  if (call.name !== "listApps") return undefined;
  if (call.sessionToken === validToken) return { text: APPS_TEXT };
  return { rpcError: { code: -32000, message: "Invalid session token" } };
}
