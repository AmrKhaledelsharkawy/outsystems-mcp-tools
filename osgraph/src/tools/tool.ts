import { z, type ZodRawShape, type ZodType } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import type { OsgraphConfig } from "../config.js";
import { readGraphCompleteness, readSnapshot, type Snapshot } from "../graph/index.js";
import { loadLayerRules, type LayerRules } from "../layers/rules.js";
import { ScopeStore } from "../scopes/store.js";
import type { ServiceStudioClient } from "../servicestudio/client.js";
import { createServiceStudioClient } from "../servicestudio/token.js";
import { OsgraphToolError, type TokenProvider } from "../servicestudio/types.js";
import type { ServiceStudioReader, ServiceStudioSession } from "../rebuild/reader.js";
import { runGraphifyPath, type GraphifyPathResult, type RunGraphifyPathOptions } from "../graphify/path.js";
import {
  NO_SNAPSHOT_COMPLETENESS,
  UNKNOWN_COMPLETENESS,
  type GraphCompleteness,
  type OsgraphError,
  type ToolResponse
} from "../types.js";

/**
 * ADR-0007/F1: rebuilds are serialized process-wide, and the gate answers the loser immediately
 * instead of queueing it. Justification: a live scope rebuild is minutes to hours of servicestudio
 * reads (no internal timeout), so a queued second call would hold its MCP `tools/call` open for that
 * whole time with no way to report progress or be cancelled — and rebuild is caller-triggered
 * (ADR-0002), so the caller is the right place to decide whether to wait. The structured
 * `REBUILD_IN_PROGRESS` keeps OSG-011's envelope (the loser still gets `graphCompleteness` for the
 * snapshot its next query will read).
 *
 * Since OSG-016 this gate is about **budget-sharing, not a race**. Concurrent reads are safe — the
 * discovery doc found no read-vs-read failure in ~250 concurrent calls (ADR-0013) — but the server
 * admits exactly 4 at once and that pool is per *process*, not per module or per rebuild. Two
 * concurrent rebuilds would therefore split one budget of 4 and each run at roughly half speed,
 * while making every progress figure meaningless. Do not relax it on the grounds that the race is
 * gone; the reason changed, the decision did not.
 */
export interface RebuildGate {
  /** True when the gate was free and is now held; the caller MUST `release()` in a `finally`. */
  tryAcquire(): boolean;
  release(): void;
  readonly busy: boolean;
}

export function createRebuildGate(): RebuildGate {
  let held = false;
  return {
    tryAcquire: () => (held ? false : ((held = true), true)),
    release: () => {
      held = false;
    },
    get busy() {
      return held;
    }
  };
}

/** Context handed to every tool handler by the server. Every accessor is injectable for tests. */
export interface ToolContext {
  config: OsgraphConfig;
  env: Record<string, string | undefined>;
  now: () => Date;
  /** Lazily loads + caches `layer-rules.json` (the package copy unless overridden). */
  loadRules: () => LayerRules;
  /** `<graphDir>/<scope>/graph.json` (ADR-0005). */
  snapshotPath: (scope: string) => string;
  scopeStore: ScopeStore;
  /** Diagnostic line sink; the server binds it to stderr. NEVER stdout (MCP transport). */
  log: (line: string) => void;
  /**
   * The servicestudio session for one rebuild. The default builds the client + token provider ONCE
   * per context and hands every call the same instances (ADR-0007/F1, ADR-0013): the bounded-
   * concurrency gate is instance state on the client, so a per-call client would give each tool call
   * its own pool of 4 and overshoot the server's admission limit — which does not corrupt reads, but
   * does inflate every call's latency into timeout territory. The server creates exactly one context,
   * so "per context" is "per process", which is the unit the server's pool is measured in.
   */
  createSession: () => ServiceStudioSession;
  /** Runs `graphify path` (real spawn by default). */
  runGraphifyPath: (options: RunGraphifyPathOptions) => Promise<GraphifyPathResult>;
  /** Process-wide `rebuild` serialization (ADR-0007/F1, ADR-0013: budget-sharing, not a race). */
  rebuildGate: RebuildGate;
  /**
   * ADR-0004 secrecy: replaces every session token this process has held with `[redacted]`.
   * Identity until a servicestudio client exists (no token can have leaked before then).
   */
  redactSecrets: (text: string) => string;
}

export interface ToolContextOverrides extends Partial<Omit<ToolContext, "config">> {
  /** Layer rules file to load instead of the package copy. */
  layerRulesPath?: string;
}

/** What a shared session is built from: the reader every call goes through, and its token provider. */
export interface SharedSessionParts {
  reader: ServiceStudioReader;
  tokenProvider: Pick<TokenProvider, "acquire" | "clear">;
}

/**
 * F1: hands out sessions that all share ONE reader and ONE token provider, built lazily on first use
 * and then memoised, so the client's bounded-concurrency gate (ADR-0013) and its `drain()` barrier
 * are genuinely process-wide instead of per tool call.
 *
 * `release()` is reference-counted so it is safe on a shared provider: the in-memory token is
 * cleared only when the last session using it has finished, never from under another one that is
 * still reading. A session counts as a holder from the moment it asks for the token, so a failed
 * `acquire()` still balances its own `release()` (`rebuildScope` releases in a `finally`).
 */
export function createSharedSessionFactory(build: () => SharedSessionParts): () => ServiceStudioSession {
  let shared: SharedSessionParts | undefined;
  let holders = 0;
  return () => {
    shared ??= build();
    const { reader, tokenProvider } = shared;
    return {
      reader,
      acquire: async () => {
        holders++;
        return tokenProvider.acquire();
      },
      release: () => {
        if (holders > 0) holders--;
        if (holders === 0) tokenProvider.clear();
      }
    };
  };
}

export function createToolContext(config: OsgraphConfig, overrides: ToolContextOverrides = {}): ToolContext {
  let rules: LayerRules | undefined;

  let client: ServiceStudioClient | undefined;
  const sharedSession = createSharedSessionFactory(() => {
    const built = createServiceStudioClient(config);
    client = built.client;
    return { reader: built.client, tokenProvider: built.tokenProvider };
  });

  const ctx: ToolContext = {
    config,
    env: overrides.env ?? process.env,
    now: overrides.now ?? (() => new Date()),
    loadRules:
      overrides.loadRules ??
      (() => {
        if (rules === undefined) rules = loadLayerRules(overrides.layerRulesPath);
        return rules;
      }),
    snapshotPath: overrides.snapshotPath ?? ((scope: string) => join(config.graphDir, scope, "graph.json")),
    scopeStore: overrides.scopeStore ?? new ScopeStore(config.scopesDir),
    log: overrides.log ?? ((line: string) => process.stderr.write(`${line}\n`)),
    createSession: overrides.createSession ?? sharedSession,
    runGraphifyPath: overrides.runGraphifyPath ?? runGraphifyPath,
    rebuildGate: overrides.rebuildGate ?? createRebuildGate(),
    redactSecrets: overrides.redactSecrets ?? ((text: string) => client?.redact(text) ?? text)
  };
  return ctx;
}

/** One osgraph MCP tool. */
export interface OsgraphTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResponse>;
}

/** Serialises a `ToolResponse` into MCP content; `isError` is set when the response carries an error. */
export function toCallToolResult(response: ToolResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    ...(response.error ? { isError: true } : {})
  };
}

export function okResponse<T>(result: T, graphCompleteness: GraphCompleteness): ToolResponse<T> {
  return { result, graphCompleteness };
}

export function errorResponse(
  error: OsgraphError,
  graphCompleteness: GraphCompleteness = NO_SNAPSHOT_COMPLETENESS
): ToolResponse<never> {
  return { error, graphCompleteness };
}

/** Placeholder handler shared by every S1 stub. */
export function notImplemented(toolName: string): ToolResponse<never> {
  return errorResponse({
    code: "NOT_IMPLEMENTED",
    message: `osgraph tool '${toolName}' is not implemented yet.`
  });
}

/**
 * OSG-011: completeness of the addressed scope's snapshot — `{0,null}` when no scope is addressed or
 * none exists, `completenessUnknown: true` when a snapshot exists but could not be read (F7).
 */
export function completenessFor(ctx: ToolContext, scope: string | undefined): GraphCompleteness {
  if (scope === undefined) return NO_SNAPSHOT_COMPLETENESS;
  try {
    return readGraphCompleteness(ctx.snapshotPath(scope));
  } catch {
    return UNKNOWN_COMPLETENESS;
  }
}

/**
 * The scope a response's `graphCompleteness` is measured against, taken defensively from raw tool
 * arguments: anything that is not a non-empty string addresses no scope (F2 — `scope` may itself be
 * the field the strict schema rejected, and the rejection still has to answer in the normal
 * envelope rather than crash).
 */
export function scopeArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * F2 (goal.md decision log, 2026-10-30): registering a strict zod schema with the SDK makes it
 * reject bad arguments BEFORE the handler runs, so the caller gets a bare MCP `-32602` with no
 * `graphCompleteness` — the one response shape OSG-011's "every osgraph tool response" rule has to
 * cover, since a caller typo is the commonest way to reach a tool. Each tool therefore registers the
 * permissive shape this builds — same field names, same `.describe()` text, so tool discovery still
 * documents the surface — and calls `parseInput` with the strict schema inside its handler.
 */
export function permissiveShape(strict: z.ZodObject<ZodRawShape>): ZodRawShape {
  const out: Record<string, ZodType> = {};
  for (const [key, field] of Object.entries(strict.shape)) {
    const description = (field as ZodType).description;
    const permissive = z.unknown().optional();
    out[key] = description === undefined ? permissive : permissive.describe(description);
  }
  return out as ZodRawShape;
}

/**
 * The strict check, inside the handler. A rejection becomes `INPUT_INVALID` whose message names the
 * offending field(s) and whose `details.issues` carries the structured zod issues, so `runTool`
 * answers it in the normal envelope with `graphCompleteness`.
 */
export function parseInput<T>(strict: z.ZodType<T>, args: Record<string, unknown>, toolName: string): T {
  const parsed = strict.safeParse(args);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.map((p) => String(p)).join("."),
    code: i.code,
    message: i.message
  }));
  const fields = [...new Set(issues.map((i) => (i.path.length > 0 ? i.path : "(root)")))];
  throw new OsgraphToolError(
    "INPUT_INVALID",
    `${toolName}: invalid input for ${fields.length === 1 ? "field" : "fields"} ${fields.map((f) => `'${f}'`).join(", ")}: ` +
      issues.map((i) => `${i.path.length > 0 ? i.path : "(root)"}: ${i.message}`).join("; "),
    { tool: toolName, fields, issues }
  );
}

/**
 * Runs a handler body and maps exceptions to error responses that still carry `graphCompleteness`
 * (OSG-011 — also on error responses, when a snapshot exists). `OsgraphToolError` keeps its code,
 * message and details verbatim (the client already redacted them); anything else becomes
 * `INTERNAL_ERROR` with its message passed through `ctx.redactSecrets` — it is the one error path
 * that can carry an arbitrary exception message, so it is the one that needs ADR-0004's secrecy
 * guarantee applied here rather than assumed (S6 audit F12).
 */
export async function runTool<T>(
  ctx: ToolContext,
  scope: string | undefined,
  body: () => Promise<{ result: T; graphCompleteness?: GraphCompleteness }>
): Promise<ToolResponse<T>> {
  try {
    const out = await body();
    return okResponse(out.result, out.graphCompleteness ?? completenessFor(ctx, scope));
  } catch (err) {
    const completeness = completenessFor(ctx, scope);
    if (err instanceof OsgraphToolError) {
      const error: OsgraphError = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      return errorResponse(error, completeness);
    }
    return errorResponse(
      { code: "INTERNAL_ERROR", message: ctx.redactSecrets(err instanceof Error ? err.message : String(err)) },
      completeness
    );
  }
}

/** Reads a scope's snapshot; `SCOPE_NOT_FOUND` when neither snapshot nor scope file exists, else `SNAPSHOT_MISSING`. */
export function loadSnapshot(ctx: ToolContext, scope: string): { snapshot: Snapshot; path: string } {
  const path = ctx.snapshotPath(scope);
  let snapshot: Snapshot;
  try {
    snapshot = readSnapshot(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (!ctx.scopeStore.exists(scope)) ctx.scopeStore.read(scope); // throws SCOPE_NOT_FOUND
      throw new OsgraphToolError(
        "SNAPSHOT_MISSING",
        `scope '${scope}' has no snapshot yet (expected ${path}); run rebuild({ scope: "${scope}" }) first`,
        { scope, path }
      );
    }
    throw new OsgraphToolError("SNAPSHOT_MISSING", `snapshot for scope '${scope}' at ${path} is unreadable: ${(err as Error).message}`, {
      scope,
      path
    });
  }
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.links)) {
    throw new OsgraphToolError("SNAPSHOT_MISSING", `snapshot for scope '${scope}' at ${path} is not a node-link graph`, { scope, path });
  }
  return { snapshot, path };
}
