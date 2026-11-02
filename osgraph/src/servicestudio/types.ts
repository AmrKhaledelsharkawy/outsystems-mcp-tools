/**
 * Types for the servicestudio MCP client (S2) and the session-token provider (S10).
 * Vocabulary: GLOSSARY.md (rebuild, element, module); decisions: OSG-004, OSG-011, OSG-015, ADR-0004, ADR-0007.
 */
import type { OsgraphErrorCode } from "../types.js";

/**
 * Session-level failure that makes the whole rebuild impossible (OSG-004 all-or-nothing):
 * `SERVICESTUDIO_UNREACHABLE` (transport), `TOKEN_EXPIRED` (ADR-0004), ...
 * `message` and `details` are redacted: they never contain the session token.
 */
export class OsgraphToolError extends Error {
  readonly code: OsgraphErrorCode;
  readonly details?: unknown;
  constructor(code: OsgraphErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "OsgraphToolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Element-level failure of ONE servicestudio tool call while the session itself is fine
 * (OSG-011 skip-and-continue class): a JSON-RPC error, a tool result with `isError`, or an
 * unparseable response. The client already retried once when `transient` (ADR-0007 "OML not found").
 * Callers apply their own OSG-011 one-retry-then-drop rule. Never an auth or transport failure.
 */
export class ServiceStudioCallError extends Error {
  readonly toolName: string;
  /** JSON-RPC error code when the server returned one (e.g. -32000). */
  readonly rpcCode: number | undefined;
  /** True when the failure matched ADR-0007's transient signature ("OML not found"). */
  readonly transient: boolean;
  /** Redacted raw server text (JSON-RPC error data or tool `isError` text). */
  readonly serverText: string | undefined;
  constructor(args: {
    toolName: string;
    message: string;
    rpcCode?: number;
    transient?: boolean;
    serverText?: string;
  }) {
    super(args.message);
    this.name = "ServiceStudioCallError";
    this.toolName = args.toolName;
    this.rpcCode = args.rpcCode;
    this.transient = args.transient ?? false;
    this.serverText = args.serverText;
  }
}

/** One entry of `listApps` -> `{ apps: [...] }`. */
export interface ServiceStudioApp {
  key: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  isOpen: boolean;
  isReference: boolean;
  moduleType: string;
}

/** One entry of the names tools (`getScreenNames`, `getWebBlockNames`, `getActionNames`, ...). */
export interface ServiceStudioElementName {
  Name: string;
  Description?: string;
  /** Screens/blocks only (ADR-0008 flow-qualified ids). */
  UIFlow?: string;
  IsReferenced?: boolean;
  [extra: string]: unknown;
}

/**
 * `objectType` of `getActionNames`.
 *
 * `"service"` was missing until 2026-11-01, and its absence was the whole of the SL blind spot: a
 * Service module publishes `SL_*` **service actions**, which `getActionNames(objectType:"server")`
 * does not list. Measured on the `ua-full` capture: 38 of 38 `_SL` modules yielded
 * `{Entity: 1, Structure: 1}` and no actions, while 46 edges pointed *into* SL and 0 left it — the
 * layer was a terminal wall in the graph. osgraph already reported the gap honestly as
 * `placeholderCount` (ADR-0009: an in-scope element it did not read); nobody read the signal.
 */
export type ActionObjectType = "client" | "server" | "service";

/**
 * Supplies the session token to the client (ADR-0004 / OSG-004).
 * The token is held in memory only; `acquire()` is the only method that hands it to
 * callers outside the client.
 */
export interface TokenProvider {
  readonly mode: "file" | "interactive";
  /**
   * Start of a rebuild: obtain + validate a token and cache it in memory.
   * File mode: read the file, validate with `listApps`, never call `createSessionToken`;
   * invalid/missing/empty -> `OsgraphToolError("TOKEN_EXPIRED")`.
   * Interactive mode: one fresh `createSessionToken`.
   */
  acquire(): Promise<string>;
  /** In-memory token, or undefined before `acquire()` / after `clear()`. Used by the client only. */
  current(): string | undefined;
  /**
   * Mid-run auth failure: file mode re-reads the file once; interactive mode re-acquires once.
   * Returns the (possibly new) token, or throws `OsgraphToolError("TOKEN_EXPIRED")`.
   */
  recover(): Promise<string>;
  /** Every token this provider has held in this process; used for redaction only. */
  knownTokens(): ReadonlySet<string>;
  /** Drop the in-memory token (end of rebuild). Redaction memory is kept. */
  clear(): void;
}

/** Minimal `fetch` shape the client needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ServiceStudioClientOptions {
  /** servicestudio MCP streamable-HTTP endpoint (`OSGRAPH_SERVICESTUDIO_URL`). */
  url: string;
  fetchImpl?: FetchLike;
  tokenProvider?: TokenProvider;
  /** Per-request timeout; default 120 000 ms. */
  timeoutMs?: number;
  /** Back-off before the single transient retry (ADR-0007); default 250 ms. Tests pass 0. */
  transientRetryDelayMs?: number;
  /**
   * Requests in flight at once; default 4 (`DEFAULT_MAX_CONCURRENT`), the server's measured
   * admission limit. Clamped to >= 1; pass 1 for the old strictly-serial behaviour.
   */
  maxConcurrent?: number;
}

/** JSON-RPC 2.0 envelope the servicestudio MCP answers with. */
export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: { code?: number; message?: string; data?: unknown };
}
