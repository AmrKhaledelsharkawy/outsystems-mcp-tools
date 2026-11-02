/**
 * Minimal servicestudio MCP client: one tool (`listApps`), streamable-HTTP JSON-RPC, SSE response.
 *
 * - Token is read from the configured file on every call, never cached across calls, never logged (ADR-0004).
 *   `tokenFile` may be a lookup function, so a file created after start-up (the session-guard hook writes
 *   `token.txt` mid-session) is picked up without a restart.
 * - `createSessionToken` is never called (OSG-014 §4); an invalid/missing token → `TOKEN_EXPIRED`.
 * - Calls are serialized through a promise queue (ADR-0007).
 */
import { readFile } from "node:fs/promises";
import type { OsopenerError, OsopenerErrorCode } from "./types.js";

export class ServiceStudioError extends Error {
  readonly code: OsopenerErrorCode;
  readonly details?: unknown;
  constructor(code: OsopenerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ServiceStudioError";
    this.code = code;
    this.details = details;
  }
  toError(): OsopenerError {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export interface ServiceStudioClient {
  /** Names of modules Service Studio reports as open (`isOpen: true`). */
  listOpenModules(): Promise<string[]>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where to read the token from, evaluated per call. `detail` describes the lookup in paths only — it goes
 * into TOKEN_EXPIRED messages so a wrong or missing token names the file it looked for.
 */
export type TokenFileLookup = () => { path: string | undefined; detail?: string };

export interface HttpClientOptions {
  url: string;
  /** A fixed path, nothing, or a lookup re-evaluated on every call. */
  tokenFile: string | undefined | TokenFileLookup;
  fetch?: FetchLike;
  /** Per-call timeout; servicestudio answers listApps in well under a second. */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

interface ListAppsPayload {
  apps?: Array<{ name?: string; isOpen?: boolean }>;
}

/** Parses an SSE body (`data: {...}` lines) or a plain JSON body into the last JSON-RPC message. */
export function parseJsonRpcBody(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
  let last: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) last = line.slice(5).trim();
  }
  if (last === undefined) throw new Error("servicestudio response contained no JSON-RPC message");
  return JSON.parse(last) as JsonRpcResponse;
}

/** Extracts open-module names from a `listApps` tool result text. */
export function parseListApps(text: string): string[] {
  const payload = JSON.parse(text) as ListAppsPayload;
  const names: string[] = [];
  for (const app of payload.apps ?? []) {
    if (app.isOpen === true && typeof app.name === "string") names.push(app.name);
  }
  return names;
}

/** Replaces every occurrence of the token in `text` so it can never leak through an error. */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}

const TOKEN_EXPIRED_MESSAGE = "session token invalid; a human must approve a new one in Service Studio";

export class HttpServiceStudioClient implements ServiceStudioClient {
  private readonly url: string;
  private readonly tokenFile: string | undefined | TokenFileLookup;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(options: HttpClientOptions) {
    this.url = options.url;
    this.tokenFile = options.tokenFile;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** ADR-0007: at most one in-flight request per process. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Resolves the token file for this call: a lookup is re-run every time, a fixed path is used as given. */
  private locateTokenFile(): { path: string | undefined; detail?: string } {
    return typeof this.tokenFile === "function" ? this.tokenFile() : { path: this.tokenFile };
  }

  private async readToken(): Promise<string> {
    const { path, detail } = this.locateTokenFile();
    const where = detail ?? (path === undefined ? "no token file configured" : `token file ${path}`);
    if (path === undefined || path.length === 0) {
      throw new ServiceStudioError("TOKEN_EXPIRED", `${TOKEN_EXPIRED_MESSAGE} (${where})`);
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new ServiceStudioError("TOKEN_EXPIRED", `${TOKEN_EXPIRED_MESSAGE} (unreadable: ${where})`);
    }
    const token = raw.trim();
    if (token.length === 0) {
      throw new ServiceStudioError("TOKEN_EXPIRED", `${TOKEN_EXPIRED_MESSAGE} (empty: ${where})`);
    }
    return token;
  }

  async listOpenModules(): Promise<string[]> {
    return this.enqueue(async () => {
      const token = await this.readToken();
      const text = await this.callTool("listApps", {}, token);
      try {
        return parseListApps(text);
      } catch (err) {
        throw new ServiceStudioError(
          "SERVICESTUDIO_UNREACHABLE",
          `listApps returned an unparseable payload: ${redact(String(err), token)}`
        );
      }
    });
  }

  private async callTool(name: string, input: Record<string, unknown>, token: string): Promise<string> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: { sessionToken: token, input } }
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body,
        signal: controller.signal
      });
    } catch (err) {
      throw new ServiceStudioError(
        "SERVICESTUDIO_UNREACHABLE",
        `servicestudio MCP at ${this.url} unreachable: ${redact(err instanceof Error ? err.message : String(err), token)}`
      );
    } finally {
      clearTimeout(timer);
    }
    const raw = redact(await response.text(), token);
    if (response.status === 401 || response.status === 403) {
      throw new ServiceStudioError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE);
    }
    let msg: JsonRpcResponse;
    try {
      msg = parseJsonRpcBody(raw);
    } catch (err) {
      throw new ServiceStudioError(
        "SERVICESTUDIO_UNREACHABLE",
        `servicestudio returned HTTP ${response.status} with a non JSON-RPC body: ${String(err)}`
      );
    }
    if (msg.error) {
      if (msg.error.code === -32002 || /session token/i.test(msg.error.message)) {
        throw new ServiceStudioError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE);
      }
      throw new ServiceStudioError(
        "SERVICESTUDIO_UNREACHABLE",
        `servicestudio ${name} failed [${msg.error.code}]: ${msg.error.message}`
      );
    }
    const first = msg.result?.content?.[0];
    if (!first || typeof first.text !== "string") {
      throw new ServiceStudioError("SERVICESTUDIO_UNREACHABLE", `servicestudio ${name} returned no text content`);
    }
    if (msg.result?.isError) {
      if (/session token/i.test(first.text)) throw new ServiceStudioError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE);
      throw new ServiceStudioError("SERVICESTUDIO_UNREACHABLE", `servicestudio ${name} reported an error: ${first.text}`);
    }
    return first.text;
  }
}
