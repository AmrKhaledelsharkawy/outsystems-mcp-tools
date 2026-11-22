/**
 * servicestudio MCP client (S2). Streamable HTTP, stateless: every call is one POST carrying
 * `tools/call` with `{ sessionToken, input }`; no `initialize` handshake is needed (live, 2026-10-29).
 *
 * Rules implemented here:
 *  - Bounded concurrency: at most `maxConcurrent` (default 4) requests in flight per process, the
 *    server's measured admission limit. This supersedes ADR-0007's one-in-flight queue — see
 *    `docs/discovery/2026-10-31-mcp-read-concurrency.md`. `drain()` is the barrier callers must
 *    await before closing a module.
 *  - A missing temp OML (both message forms, see `isTransientOmlError`) is transient and retried
 *    once after a fixed back-off; other `-32000` errors are NOT retried by the client.
 *  - ADR-0004 / OSG-004: tokens come from a `TokenProvider`; on an auth-class failure the client asks
 *    the provider to recover ONCE and retries that one call, then throws `TOKEN_EXPIRED`.
 *  - Secrecy: every error message / detail leaving this module passes through `redact()`.
 *  - Transport failures (ECONNREFUSED, timeout, non-2xx) -> `OsgraphToolError("SERVICESTUDIO_UNREACHABLE")`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { CallAdmission, CallAttempt, CallTrace, CallTraceSink } from "./trace.js";
import { parseSseBody, unwrapCodeText, unwrapJsonArray, unwrapJsonObject } from "./unwrap.js";
import {
  OsgraphToolError,
  ServiceStudioCallError,
  type ActionObjectType,
  type FetchLike,
  type JsonRpcResponse,
  type ServiceStudioApp,
  type ServiceStudioClientOptions,
  type ServiceStudioElementName,
  type TokenProvider
} from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const TRANSIENT_RETRY_DELAY_MS = 250;
/**
 * Requests allowed in flight at once. The servicestudio MCP on 11.55.94.65328 admits exactly 4:
 * widths 1-4 all complete in ~11.5 s, a 5th caller waits a whole ~11 s wave, so a larger value only
 * queues server-side and inflates per-call latency (a timeout risk, not a speed-up).
 * Measured sweep: `docs/discovery/2026-10-31-mcp-read-concurrency.md` section 3.2.
 */
export const DEFAULT_MAX_CONCURRENT = 4;
export const TOKEN_EXPIRED_MESSAGE =
  "session token invalid; a human must approve a new one in Service Studio";
export const REDACTED = "[redacted]";

/**
 * Transient temp-OML signature (JSON-RPC -32000). Two message forms, both meaning "the module's
 * exported temp OML is not there":
 *
 *  - `OML not found: …-in.oml` — the form ADR-0007 recorded.
 *  - `Could not find file '…\ServiceStudio.MCPServer\<guid>-in.oml'.` — what build 11.55.94.65328
 *    **actually** returns. Captured live 2026-10-31; see
 *    `docs/discovery/2026-10-31-mcp-read-concurrency.md` section 8.2. Matching only the first form
 *    meant `isTransient` was false for the single error it exists for, so the retry never fired and
 *    ADR-0011 aborted the whole rebuild on a one-call blip.
 *
 * Both are anchored on a `-in.oml` path so an unrelated missing file is not retried. `No module is
 * currently open` is deliberately NOT transient: the module really is gone and retrying cannot help.
 */
const TEMP_OML_MISSING = [/OML not found/i, /could not find file[^\n]*-in\.oml/i];

export function isTransientOmlError(rpcCode: number | undefined, message: string): boolean {
  if (rpcCode !== undefined && rpcCode !== -32000) return false;
  return TEMP_OML_MISSING.some((re) => re.test(message));
}

/**
 * Auth-class failure matcher (ADR-0004). The live signature is not confirmed yet; this is the single
 * place the live verifier adjusts. Matches HTTP 401/403 or a message naming the session token.
 */
export function isAuthFailure(args: { httpStatus?: number; message?: string }): boolean {
  if (args.httpStatus === 401 || args.httpStatus === 403) return true;
  const msg = args.message ?? "";
  return /session ?token|unauthori[sz]ed|invalid token|not authori[sz]ed|token (is )?(invalid|expired|missing|required)/i.test(
    msg
  );
}

/** Replaces every known token in `text` with `[redacted]`. Empty tokens are ignored. */
export function redactTokens(text: string, tokens: Iterable<string>): string {
  let out = text;
  for (const t of tokens) {
    if (t.length === 0) continue;
    out = out.split(t).join(REDACTED);
  }
  return out;
}

/** Internal: an auth-class failure before recovery is attempted. Never leaves `callTool`. */
class AuthFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFailure";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Case-insensitive module key of a tool input, or undefined when the call is not module-addressed. */
function moduleKey(input: Record<string, unknown>): string | undefined {
  const name = input.eSpaceName;
  return typeof name === "string" && name.length > 0 ? name.toLowerCase() : undefined;
}

export class ServiceStudioClient {
  readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly transientRetryDelayMs: number;
  private tokenProvider: TokenProvider | undefined;
  /** Tokens seen through `callToolRaw` (provider-less calls), for redaction. */
  private readonly rawTokens = new Set<string>();
  private readonly maxConcurrent: number;
  /** Requests in flight right now (holding a permit). */
  private active = 0;
  /** FIFO of callers waiting for a permit. */
  private readonly waiters: Array<() => void> = [];
  /** FIFO of `drain()` callers waiting for the client to go idle. */
  private readonly idleWaiters: Array<() => void> = [];
  /** Logical operations not yet settled, per module (`moduleKey`); see `drainModule`. */
  private readonly moduleOps = new Map<string, number>();
  /** `drainModule()` callers waiting for their module's count to reach zero. */
  private readonly moduleWaiters = new Map<string, Array<() => void>>();
  private nextId = 1;
  /** `--trace`: receives one `CallTrace` per settled `callTool`. Undefined = tracing off. */
  private traceSink: CallTraceSink | undefined;
  /** The trace of the call whose async context is running (admissions and attempts land on it). */
  private readonly traceCtx = new AsyncLocalStorage<CallTrace>();
  private nextTraceId = 1;
  private permitObserver: ((status: { limit: number; active: number; queued: number }) => void) | undefined;

  constructor(options: ServiceStudioClientOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transientRetryDelayMs = options.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
    this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.tokenProvider = options.tokenProvider;
  }

  /** Wires the token provider (needed because `createTokenProvider` itself takes the client). */
  setTokenProvider(provider: TokenProvider): void {
    this.tokenProvider = provider;
  }

  getTokenProvider(): TokenProvider | undefined {
    return this.tokenProvider;
  }

  /** Replaces every token this client has ever seen with `[redacted]`. */
  redact(text: string): string {
    const tokens = new Set<string>(this.rawTokens);
    if (this.tokenProvider) for (const t of this.tokenProvider.knownTokens()) tokens.add(t);
    return redactTokens(text, tokens);
  }

  // ---------------------------------------------------------------------------------------------
  // Generic calls

  /**
   * Calls any servicestudio tool with the provider's token (acquiring one if none is held).
   * Returns the raw `content[0].text`. Auth failure -> provider.recover() once -> retry once ->
   * `OsgraphToolError("TOKEN_EXPIRED")`.
   */
  async callTool(name: string, input: Record<string, unknown> = {}): Promise<string> {
    const sink = this.traceSink;
    if (sink === undefined) return this.callToolCounted(name, input);
    const trace: CallTrace = {
      id: this.nextTraceId++,
      tool: name,
      module: typeof input.eSpaceName === "string" ? input.eSpaceName : null,
      startedAtUtc: new Date().toISOString(),
      queuedMs: performance.now(),
      admissions: [],
      attempts: [],
      settledMs: 0,
      ok: false
    };
    try {
      const text = await this.traceCtx.run(trace, () => this.callToolCounted(name, input));
      trace.ok = true;
      return text;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      trace.errorCode = typeof code === "string" ? code : err instanceof Error ? err.name : "UNKNOWN";
      throw err;
    } finally {
      trace.settledMs = performance.now();
      try {
        sink(trace);
      } catch {
        /* tracing must never fail a read */
      }
    }
  }

  /**
   * Attaches (or, with `undefined`, detaches) a per-call trace sink (`osgraph run --trace`). Off by
   * default; when off, the call path is unchanged apart from one field check.
   */
  setCallTrace(sink: CallTraceSink | undefined): void {
    this.traceSink = sink;
  }

  /** Instantaneous read-only snapshot of the existing global permit gate. */
  getPermitStatus(): { limit: number; active: number; queued: number } {
    return { limit: this.maxConcurrent, active: this.active, queued: this.waiters.length };
  }

  setPermitObserver(listener: ((status: { limit: number; active: number; queued: number }) => void) | undefined): void {
    this.permitObserver = listener;
    this.notifyPermitObserver();
  }

  private notifyPermitObserver(): void {
    // Monitoring must NEVER break admission or release, even if a dashboard observer throws.
    try { this.permitObserver?.(this.getPermitStatus()); } catch { /* noncritical observer */ }
  }

  /** The number of read permits (the server's admission width). */
  get concurrency(): number {
    return this.maxConcurrent;
  }

  private async callToolCounted(name: string, input: Record<string, unknown>): Promise<string> {
    // The module count is taken here, before the FIFO and before any token acquire/recover, and released
    // only when this outermost promise settles (plan v3 section 4). `listApps` has no `eSpaceName`, so it
    // stays untracked by module and is covered by the global `drain()` only.
    const key = moduleKey(input);
    if (key === undefined) return this.callToolUntracked(name, input);
    this.opStart(key);
    try {
      return await this.callToolUntracked(name, input);
    } finally {
      this.opEnd(key);
    }
  }

  private async callToolUntracked(name: string, input: Record<string, unknown>): Promise<string> {
    const provider = this.tokenProvider;
    if (!provider) {
      throw new OsgraphToolError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE, {
        reason: "no token provider configured"
      });
    }
    let token = provider.current() ?? (await provider.acquire());
    try {
      return await this.callToolRawInternal(token, name, input);
    } catch (err) {
      if (!(err instanceof AuthFailure)) throw err;
      token = await provider.recover();
      try {
        return await this.callToolRawInternal(token, name, input);
      } catch (err2) {
        if (err2 instanceof AuthFailure) {
          throw new OsgraphToolError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE, {
            toolName: name,
            cause: this.redact(err2.message)
          });
        }
        throw err2;
      }
    }
  }

  /**
   * Calls a tool with an explicit token (or none, for `createSessionToken`), through the concurrency gate and with the
   * ADR-0007 transient retry, but WITHOUT token recovery. Used by the token provider.
   * An auth-class failure surfaces as `OsgraphToolError("TOKEN_EXPIRED")`.
   */
  async callToolRaw(
    token: string | undefined,
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<string> {
    try {
      // The token provider's own calls happen inside some traced call's token step; keep them out of
      // that call's trace (they are not its read).
      return await this.traceCtx.exit(() => this.callToolRawInternal(token, name, input));
    } catch (err) {
      if (err instanceof AuthFailure) {
        throw new OsgraphToolError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE, {
          toolName: name,
          cause: this.redact(err.message)
        });
      }
      throw err;
    }
  }

  /** Like `callToolRaw` but lets the internal `AuthFailure` signal through (for `callTool`'s recovery). */
  private callToolRawInternal(
    token: string | undefined,
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    if (token !== undefined && token.length > 0) this.rawTokens.add(token);
    const run = () => this.withTransientRetry(name, () => this.tracedPost(token, name, input));
    return this.enqueue(run);
  }

  /** `post`, recorded as one attempt on the current call's trace when tracing is on. */
  private async tracedPost(token: string | undefined, name: string, input: Record<string, unknown>): Promise<string> {
    const trace = this.traceCtx.getStore();
    if (trace === undefined) return this.post(token, name, input);
    const attempt: CallAttempt = { startMs: performance.now(), endMs: 0, ok: false };
    trace.attempts.push(attempt);
    try {
      const text = await this.post(token, name, input);
      attempt.ok = true;
      return text;
    } finally {
      attempt.endMs = performance.now();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Typed helpers (all read-only; every one takes the module name so no module needs to be in front)

  async listApps(): Promise<ServiceStudioApp[]> {
    const text = await this.callTool("listApps", {});
    return this.parseApps(text, "listApps");
  }

  /** `listApps` with an explicit token: the token provider's validation call (ADR-0004). */
  async listAppsWithToken(token: string): Promise<ServiceStudioApp[]> {
    const text = await this.callToolRaw(token, "listApps", {});
    return this.parseApps(text, "listApps");
  }

  private parseApps(text: string, toolName: string): ServiceStudioApp[] {
    try {
      const obj = unwrapJsonObject<{ apps?: unknown }>(text);
      if (!Array.isArray(obj.apps)) throw new Error("`apps` is not an array");
      return obj.apps as ServiceStudioApp[];
    } catch (err) {
      throw new ServiceStudioCallError({
        toolName,
        message: this.redact(`${toolName}: unparseable response (${errorMessage(err)})`),
        serverText: this.redact(text)
      });
    }
  }

  getDataModel(eSpaceName: string): Promise<string> {
    return this.codeText("getDataModel", { eSpaceName, includeJson: "Never" });
  }

  getStructures(eSpaceName: string): Promise<string> {
    return this.codeText("getStructures", { eSpaceName, includeJson: "Never" });
  }

  getScreenNames(eSpaceName: string): Promise<ServiceStudioElementName[]> {
    return this.names("getScreenNames", { eSpaceName });
  }

  getWebBlockNames(eSpaceName: string): Promise<ServiceStudioElementName[]> {
    return this.names("getWebBlockNames", { eSpaceName });
  }

  getActionNames(eSpaceName: string, objectType: ActionObjectType): Promise<ServiceStudioElementName[]> {
    return this.names("getActionNames", { eSpaceName, objectType });
  }

  getScreen(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getScreen", { eSpaceName, objectName, includeJson: "Never" });
  }

  getWebBlock(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getWebBlock", { eSpaceName, objectName, includeJson: "Never" });
  }

  getClientAction(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getClientAction", { eSpaceName, objectName, includeJson: "Never" });
  }

  getServerAction(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getServerAction", { eSpaceName, objectName, includeJson: "Never" });
  }

  /**
   * A Service module's published `SL_*` action. Same text shape as a server action, which is why
   * `kinds.ts` already normalises `ServiceAction` -> `ServerAction` and the capture stores both
   * under `raw/<module>/ServerAction/`: the node id an SL action gets here is byte-identical to the
   * id its External/Placeholder stub already carries, so reading it *resolves* the stub rather than
   * adding a duplicate (ADR-0006 id identity, `graph/build.ts` "real nodes win over externals").
   */
  getServiceAction(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getServiceAction", { eSpaceName, objectName, includeJson: "Never" });
  }

  // Traditional Web variants (same inputs as the Reactive ones).

  getScreenNamesTraditional(eSpaceName: string): Promise<ServiceStudioElementName[]> {
    return this.names("getScreenNamesTraditional", { eSpaceName });
  }

  getWebBlockNamesTraditional(eSpaceName: string): Promise<ServiceStudioElementName[]> {
    return this.names("getWebBlockNamesTraditional", { eSpaceName });
  }

  getScreenTraditional(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getScreenTraditional", { eSpaceName, objectName, includeJson: "Never" });
  }

  getWebBlockTraditional(eSpaceName: string, objectName: string): Promise<string> {
    return this.codeText("getWebBlockTraditional", { eSpaceName, objectName, includeJson: "Never" });
  }

  /** Any code-text tool -> unwrapped Model-API code (fences and `{"result":...}` envelopes removed). */
  async codeText(name: string, input: Record<string, unknown>): Promise<string> {
    const text = await this.callTool(name, input);
    try {
      return unwrapCodeText(text);
    } catch (err) {
      throw new ServiceStudioCallError({
        toolName: name,
        message: this.redact(`${name}: unparseable response (${errorMessage(err)})`),
        serverText: this.redact(text)
      });
    }
  }

  /** Any names tool -> parsed array. */
  async names(name: string, input: Record<string, unknown>): Promise<ServiceStudioElementName[]> {
    const text = await this.callTool(name, input);
    try {
      return unwrapJsonArray<ServiceStudioElementName>(text);
    } catch (err) {
      throw new ServiceStudioCallError({
        toolName: name,
        message: this.redact(`${name}: unparseable response (${errorMessage(err)})`),
        serverText: this.redact(text)
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  /**
   * Bounded-concurrency gate: at most `maxConcurrent` requests in flight, FIFO for waiters.
   *
   * Supersedes ADR-0007's one-in-flight promise chain. Live measurement on 11.55.94.65328
   * (`docs/discovery/2026-10-31-mcp-read-concurrency.md`) found no read-vs-read race in ~250
   * concurrent calls and a hard server admission limit of 4: widths 1-4 all finish in ~11.5 s, a
   * 5th caller waits a whole wave. One gate per client **process** — not per module; a second open
   * module buys no extra capacity (section 6.2).
   */
  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const trace = this.traceCtx.getStore();
    await this.acquire();
    const admission: CallAdmission | undefined =
      trace !== undefined ? { admittedMs: performance.now(), releasedMs: 0 } : undefined;
    if (admission !== undefined) trace?.admissions.push(admission);
    try {
      return await fn();
    } finally {
      if (admission !== undefined) admission.releasedMs = performance.now();
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // `while`, not `if`: a woken waiter re-checks, so a permit can never be handed out twice.
    while (this.active >= this.maxConcurrent) {
      const waiting = new Promise<void>((resolve) => this.waiters.push(resolve));
      this.notifyPermitObserver();
      await waiting;
    }
    this.active++;
    this.notifyPermitObserver();
  }

  /** Always called from a `finally`, so a rejected call cannot leak its permit. */
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    this.notifyPermitObserver();
    if (next) {
      next();
      return;
    }
    if (this.active === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /**
   * Resolves once nothing is in flight or queued. Never rejects — a failed request still releases
   * its permit and still counts as settled.
   *
   * **Await this before driving osopener's `closeModule`.** Closing a module while reads for it are
   * still queued is the one combination that reproduced ADR-0007's temp-OML error: a read that has
   * already exported survives the tab closing under it, but one still waiting its turn finds no
   * `<guid>-in.oml` and fails. Concurrency does not cause that — it widens the window, so the
   * barrier matters more here than it did under the serial queue
   * (`docs/discovery/2026-10-31-mcp-read-concurrency.md` sections 8.2-8.4).
   */
  async drain(): Promise<void> {
    while (this.active > 0 || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  /**
   * Resolves once every logical operation addressed to `module` (case-insensitive `eSpaceName`) has
   * settled: queued, in flight, in its transient temp-OML back-off, or in token recovery. Unlike
   * `drain()` it ignores other modules' work, so a pipeline can close A's tab while B is still reading.
   * Never rejects. A module with no operations resolves immediately.
   *
   * Counts are taken in `callTool` (before the FIFO) and released when that outermost promise settles;
   * the typed helpers' parsing after `callTool` is synchronous, so nothing is left to await. Operations
   * started AFTER this call are not waited for (same contract as `drain()`).
   */
  async drainModule(module: string): Promise<void> {
    const key = module.toLowerCase();
    while ((this.moduleOps.get(key) ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const list = this.moduleWaiters.get(key);
        if (list) list.push(resolve);
        else this.moduleWaiters.set(key, [resolve]);
      });
    }
  }

  private opStart(key: string): void {
    this.moduleOps.set(key, (this.moduleOps.get(key) ?? 0) + 1);
  }

  private opEnd(key: string): void {
    const n = (this.moduleOps.get(key) ?? 1) - 1;
    if (n > 0) {
      this.moduleOps.set(key, n);
      return;
    }
    this.moduleOps.delete(key);
    const waiters = this.moduleWaiters.get(key);
    this.moduleWaiters.delete(key);
    if (waiters) for (const resolve of waiters) resolve();
  }

  private async withTransientRetry<T>(name: string, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ServiceStudioCallError && err.transient) {
        await sleep(this.transientRetryDelayMs);
        try {
          return await attempt();
        } catch (err2) {
          if (err2 instanceof ServiceStudioCallError && err2.transient) {
            throw new ServiceStudioCallError({
              toolName: name,
              message: `${err2.message} (retried once after ${this.transientRetryDelayMs} ms, ADR-0007)`,
              rpcCode: err2.rpcCode,
              transient: true,
              serverText: err2.serverText
            });
          }
          throw err2;
        }
      }
      throw err;
    }
  }

  /** One HTTP round-trip. Classifies the outcome; never retries. */
  private async post(
    token: string | undefined,
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const id = this.nextId++;
    const args: Record<string, unknown> = { input };
    if (token !== undefined) args.sessionToken = token;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body,
        signal: controller.signal
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new OsgraphToolError(
        "SERVICESTUDIO_UNREACHABLE",
        this.redact(
          aborted
            ? `servicestudio MCP at ${this.url} did not answer '${name}' within ${this.timeoutMs} ms`
            : `servicestudio MCP at ${this.url} is unreachable: ${errorMessage(err)}`
        ),
        { toolName: name, url: this.url, timedOut: aborted }
      );
    } finally {
      clearTimeout(timer);
    }

    if (isAuthFailure({ httpStatus: status })) {
      throw new AuthFailure(this.redact(`HTTP ${status} from servicestudio MCP for '${name}'`));
    }
    if (status < 200 || status >= 300) {
      throw new OsgraphToolError(
        "SERVICESTUDIO_UNREACHABLE",
        this.redact(`servicestudio MCP at ${this.url} answered HTTP ${status} for '${name}'`),
        { toolName: name, url: this.url, httpStatus: status, body: this.redact(text).slice(0, 500) }
      );
    }

    let rpc: JsonRpcResponse;
    try {
      rpc = parseSseBody(text);
    } catch (err) {
      throw new ServiceStudioCallError({
        toolName: name,
        message: this.redact(`${name}: cannot parse servicestudio response (${errorMessage(err)})`),
        serverText: this.redact(text).slice(0, 2000)
      });
    }

    if (rpc.error) {
      const rpcCode = typeof rpc.error.code === "number" ? rpc.error.code : undefined;
      const msg = `${rpc.error.message ?? "unknown JSON-RPC error"}${
        typeof rpc.error.data === "string" ? `: ${rpc.error.data}` : ""
      }`;
      const redacted = this.redact(msg);
      if (isAuthFailure({ message: msg })) throw new AuthFailure(`${name}: ${redacted}`);
      throw new ServiceStudioCallError({
        toolName: name,
        message: `${name}: [${rpcCode ?? "?"}] ${redacted}`,
        rpcCode,
        transient: isTransientOmlError(rpcCode, msg),
        serverText: redacted
      });
    }

    const content = rpc.result?.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    const resultText = typeof first?.text === "string" ? first.text : undefined;

    if (rpc.result?.isError) {
      const msg = resultText ?? "tool returned isError without text";
      const redacted = this.redact(msg);
      if (isAuthFailure({ message: msg })) throw new AuthFailure(`${name}: ${redacted}`);
      throw new ServiceStudioCallError({
        toolName: name,
        message: `${name}: tool error: ${redacted}`,
        transient: isTransientOmlError(undefined, msg),
        serverText: redacted
      });
    }

    if (resultText === undefined) {
      throw new ServiceStudioCallError({
        toolName: name,
        message: `${name}: response has no text content`,
        serverText: this.redact(JSON.stringify(rpc)).slice(0, 2000)
      });
    }
    return resultText;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
