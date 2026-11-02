import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OsgraphErrorCode } from "./types.js";

/** Thrown by `loadConfig` when the environment cannot yield a usable configuration. */
export class OsgraphConfigError extends Error {
  readonly code: OsgraphErrorCode;
  constructor(code: OsgraphErrorCode, message: string) {
    super(message);
    this.name = "OsgraphConfigError";
    this.code = code;
  }
}

export interface OsgraphConfig {
  /** servicestudio MCP endpoint (OSG-004: required, no default). */
  serviceStudioUrl: string;
  /** Hook-saved session token file, read-only (ADR-0004). Undefined = interactive token mode. */
  tokenFile: string | undefined;
  /** Where snapshots live: `<graphDir>/<scope>/graph.json`. */
  graphDir: string;
  /** Where scope files live: `<scopesDir>/<scope>.json` (ADR-0005). */
  scopesDir: string;
  /** Graphify executable used by `queryPath` (ADR-0003: pinned, never `install`/`hook install`). */
  graphifyBin: string;
  /**
   * Reads allowed in flight at once (OSG-016; ADR-0013). Plumbed to BOTH the client's
   * `maxConcurrent` gate and the rebuild walker's element fan-out, because the two have to agree:
   * the gate alone is a cap, not a fan-out, and the fan-out alone would queue behind the gate.
   *
   * Default 4 — the servicestudio MCP's measured admission limit on build 11.55.94.65328
   * (`docs/discovery/2026-10-31-mcp-read-concurrency.md` section 3.2); a 5th caller only waits a
   * whole wave. `OSGRAPH_MAX_CONCURRENCY` overrides it, clamped to [1, 8]; **1 restores exactly the
   * pre-OSG-016 serial behaviour**, which is the escape hatch if a different Studio build regresses.
   */
  fetchConcurrency: number;
}

export const ENV_SERVICESTUDIO_URL = "OSGRAPH_SERVICESTUDIO_URL";
export const ENV_SERVICESTUDIO_TOKEN_FILE = "OSGRAPH_SERVICESTUDIO_TOKEN_FILE";
export const ENV_GRAPH_DIR = "OSGRAPH_GRAPH_DIR";
export const ENV_SCOPES_DIR = "OSGRAPH_SCOPES_DIR";
export const ENV_GRAPHIFY_BIN = "OSGRAPH_GRAPHIFY_BIN";
export const ENV_MAX_CONCURRENCY = "OSGRAPH_MAX_CONCURRENCY";

/** Default read width (ADR-0013): the server's measured admission limit. */
export const DEFAULT_FETCH_CONCURRENCY = 4;
/** Clamp for `OSGRAPH_MAX_CONCURRENCY`. 1 = serial; above 8 only queues server-side (section 3.2). */
export const MIN_FETCH_CONCURRENCY = 1;
export const MAX_FETCH_CONCURRENCY = 8;

/**
 * Parses `OSGRAPH_MAX_CONCURRENCY`. Unset, empty or unparseable -> the default; otherwise truncated
 * towards zero and clamped into [1, 8]. Deliberately NOT a config error: a bad width is a knob, and
 * failing a whole osgraph process over it would be worse than ignoring it.
 */
export function parseFetchConcurrency(value: string | undefined): number {
  const raw = nonEmpty(value);
  if (raw === undefined) return DEFAULT_FETCH_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FETCH_CONCURRENCY;
  return Math.min(MAX_FETCH_CONCURRENCY, Math.max(MIN_FETCH_CONCURRENCY, Math.trunc(n)));
}

export interface LoadConfigOptions {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  existsSync?: (path: string) => boolean;
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Pure (given `env` + options): builds the runtime configuration from environment variables.
 * Throws `OsgraphConfigError("CONFIG_MISSING")` when `OSGRAPH_SERVICESTUDIO_URL` is unset or empty.
 */
export function loadConfig(env: Env, options: LoadConfigOptions = {}): OsgraphConfig {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.existsSync ?? existsSync;

  const serviceStudioUrl = nonEmpty(env[ENV_SERVICESTUDIO_URL]);
  if (serviceStudioUrl === undefined) {
    throw new OsgraphConfigError(
      "CONFIG_MISSING",
      `${ENV_SERVICESTUDIO_URL} is not set. osgraph has no default servicestudio endpoint; ` +
        `set it to the servicestudio MCP URL (e.g. http://127.0.0.1:41820/mcp).`
    );
  }

  try {
    const parsed = new URL(serviceStudioUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    throw new OsgraphConfigError(
      "CONFIG_INVALID",
      `${ENV_SERVICESTUDIO_URL} is not a valid http(s) URL: '${serviceStudioUrl}'.`
    );
  }

  const graphDir = nonEmpty(env[ENV_GRAPH_DIR]) ?? join(cwd, ".osgraph");

  const scopesDir =
    nonEmpty(env[ENV_SCOPES_DIR]) ??
    (exists(join(cwd, "osgraph")) ? join(cwd, "osgraph", "scopes") : join(cwd, "scopes"));

  return {
    serviceStudioUrl,
    tokenFile: nonEmpty(env[ENV_SERVICESTUDIO_TOKEN_FILE]),
    graphDir,
    scopesDir,
    graphifyBin: nonEmpty(env[ENV_GRAPHIFY_BIN]) ?? "graphify",
    fetchConcurrency: parseFetchConcurrency(env[ENV_MAX_CONCURRENCY])
  };
}
