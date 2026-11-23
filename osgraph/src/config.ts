import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTokenFile } from "./doctor/token.js";
import { parseSkipKinds, PRUNABLE_KINDS, type PrunableKind } from "./rebuild/readKinds.js";
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
  /**
   * servicestudio MCP endpoint, trimmed (OSG-004: no default). Command-scoped (#7): `undefined` when
   * unset, and **not yet validated** unless `loadConfig` was asked to `requireServiceStudio`. Offline
   * commands never look at it; anything that talks to Studio goes through `requireServiceStudioUrl`,
   * which raises the same `CONFIG_MISSING` / `CONFIG_INVALID` errors process start used to.
   */
  serviceStudioUrl: string | undefined;
  /**
   * Hook-saved session token file, read-only (ADR-0004). `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` when it
   * names an existing file; otherwise the nearest `token.txt` at or above the working directory (the
   * same `resolveTokenFile` rule `osgraph doctor` and osopener use). Undefined only when neither is
   * found = interactive token mode.
   */
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
  /**
   * Kinds a rebuild does not read (#69; `OSGRAPH_SKIP_KINDS`, e.g. `Structure,ClientAction`). Default
   * none: the default is meant to come from a measured read-cost profile (`osgraph kinds`), and that
   * measurement is a live-Studio step. Only `PRUNABLE_KINDS` are accepted; `Screen` and `Block` feed
   * the extractor's flow index and cannot be switched off without changing other kinds' edges.
   */
  skipKinds: PrunableKind[];
  /** Live progress site. Raised automatically by `rebuild`/`reextract` unless disabled. */
  site: SiteConfig;
}

/**
 * The live progress site served in-process during a rebuild.
 *
 * It exists because a rebuild is long (hours on a large scope) and its only other output is
 * stderr, which most MCP clients swallow — so without this a rebuild is indistinguishable from
 * a hang. The site is raised before any work starts, so there is never a window in which work
 * is happening unobserved.
 */
export interface SiteConfig {
  /** `false` disables the site entirely (`OSGRAPH_PROGRESS_SITE=off`). Headless/CI escape hatch. */
  enabled: boolean;
  /**
   * Bind address. Defaults to `127.0.0.1` (this PC only; security default from #83, kept over the
   * 2026-11-22 phone default when run control merged on 2026-11-24). `OSGRAPH_PROGRESS_HOST=0.0.0.0`
   * opens it to a phone or another PC and then requires `OSGRAPH_PROGRESS_VIEWER_PASSWORD` (16+
   * characters, HTTP Basic) to view. Acting from another device additionally needs the run password
   * set when `osgraph run` starts; discovery and scope writes stay loopback-only.
   */
  host: string;
  /** When host binds LAN, require an explicit shared secret (used only behind trusted TLS/VPN). */
  viewerPassword?: string;
  /** First port tried; a busy port is stepped past (see `SITE_PORT_SCAN`). */
  port: number;
  /**
   * osopener's `dist` directory — the discovery job imports its `openModule`/`closeModule`
   * directly. Defaults to the `../osopener/dist` sibling, which is this repository's own layout.
   * This is the one place osgraph's documented hard dependency on osopener is literal code.
   */
  osopenerDist: string;
}

export const ENV_SERVICESTUDIO_URL = "OSGRAPH_SERVICESTUDIO_URL";
export const ENV_SERVICESTUDIO_TOKEN_FILE = "OSGRAPH_SERVICESTUDIO_TOKEN_FILE";
export const ENV_GRAPH_DIR = "OSGRAPH_GRAPH_DIR";
export const ENV_SCOPES_DIR = "OSGRAPH_SCOPES_DIR";
export const ENV_GRAPHIFY_BIN = "OSGRAPH_GRAPHIFY_BIN";
export const ENV_MAX_CONCURRENCY = "OSGRAPH_MAX_CONCURRENCY";
export const ENV_SKIP_KINDS = "OSGRAPH_SKIP_KINDS";
export const ENV_PROGRESS_SITE = "OSGRAPH_PROGRESS_SITE";
export const ENV_PROGRESS_HOST = "OSGRAPH_PROGRESS_HOST";
export const ENV_PROGRESS_VIEWER_PASSWORD = "OSGRAPH_PROGRESS_VIEWER_PASSWORD";
export const ENV_PROGRESS_PORT = "OSGRAPH_PROGRESS_PORT";
export const ENV_OSOPENER_DIST = "OSGRAPH_OSOPENER_DIST";

/** Loopback by default; a phone needs an explicit LAN bind plus a viewer password — see `SiteConfig.host`. */
export const DEFAULT_SITE_HOST = "127.0.0.1";
export const DEFAULT_SITE_PORT = 7473;
/** Consecutive ports tried when the first is taken, so two scopes can be watched at once. */
export const SITE_PORT_SCAN = 20;

/** Values of `OSGRAPH_PROGRESS_SITE` that turn the site off. Anything else leaves it on. */
const SITE_OFF = new Set(["off", "0", "false", "no", "none"]);

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

/**
 * Parses `OSGRAPH_PROGRESS_PORT`. Unset/unparseable -> the default; out of range -> the default,
 * because a port a kernel will refuse is a typo, not an intention. Like the concurrency knob this
 * never fails the process: the site is an observability aid, and refusing to start osgraph over a
 * bad port would lose the rebuild as well as the view of it.
 */
export function parseSitePort(value: string | undefined): number {
  const raw = nonEmpty(value);
  if (raw === undefined) return DEFAULT_SITE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) return DEFAULT_SITE_PORT;
  return n;
}

export interface LoadConfigOptions {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  existsSync?: (path: string) => boolean;
  /**
   * The osgraph package root, used to find the `../osopener/dist` sibling and `dashboard/`.
   * Defaults to the directory above this module's own (`dist/` at runtime, `src/` under vitest).
   */
  packageRoot?: string;
  /**
   * #7: validate the servicestudio endpoint now and throw if it is missing or not http(s). For a
   * command that does nothing but drive Studio, so it fails at start with the configuration exit
   * code. Default `false`: offline commands (and the MCP server, whose live tool checks on
   * dispatch) start with no endpoint configured.
   */
  requireServiceStudio?: boolean;
}

/**
 * #7: the one place the servicestudio endpoint is validated. Returns the trimmed URL, or throws
 * `OsgraphConfigError` — `CONFIG_MISSING` when unset/blank, `CONFIG_INVALID` when not an http(s)
 * URL — with the messages osgraph has always used. Call it immediately before a live operation is
 * dispatched, so the user sees this message instead of a downstream connection error.
 */
export function requireServiceStudioUrl(config: Pick<OsgraphConfig, "serviceStudioUrl">): string {
  const serviceStudioUrl = nonEmpty(config.serviceStudioUrl);
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
  return serviceStudioUrl;
}

/** `<packageRoot>` for the compiled `dist/config.js` — i.e. the directory holding package.json. */
function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Pure (given `env` + options): builds the runtime configuration from environment variables.
 *
 * Command-scoped (#7): a missing or malformed `OSGRAPH_SERVICESTUDIO_URL` is NOT an error here by
 * default — offline commands never need it. Pass `requireServiceStudio: true` for a command that
 * only drives Studio; otherwise the live path calls `requireServiceStudioUrl` when it is dispatched.
 */
export function loadConfig(env: Env, options: LoadConfigOptions = {}): OsgraphConfig {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.existsSync ?? existsSync;
  const packageRoot = options.packageRoot ?? defaultPackageRoot();

  const rawUrl = nonEmpty(env[ENV_SERVICESTUDIO_URL]);
  const serviceStudioUrl =
    options.requireServiceStudio === true ? requireServiceStudioUrl({ serviceStudioUrl: rawUrl }) : rawUrl;

  const graphDir = nonEmpty(env[ENV_GRAPH_DIR]) ?? join(cwd, ".osgraph");

  // Unlike the width knob, a bad kind list IS an error: silently ignoring a typo would run the full,
  // slow rebuild the operator meant to avoid, and ignoring `Screen` would hide why it cannot be pruned.
  const skip = parseSkipKinds(env[ENV_SKIP_KINDS]);
  if (skip.rejected.length > 0) {
    throw new OsgraphConfigError(
      "CONFIG_INVALID",
      `${ENV_SKIP_KINDS} names kind(s) that cannot be switched off: ${skip.rejected.join(", ")}. ` +
        `Allowed: ${PRUNABLE_KINDS.join(", ")}.`
    );
  }

  const scopesDir =
    nonEmpty(env[ENV_SCOPES_DIR]) ??
    (exists(join(cwd, "osgraph")) ? join(cwd, "osgraph", "scopes") : join(cwd, "scopes"));

  return {
    serviceStudioUrl,
    // One discovery rule for config and doctor: explicit existing file > nearest token.txt above cwd >
    // the explicit (missing) path, which then fails TOKEN_EXPIRED > none (interactive).
    tokenFile: resolveTokenFile(env, { cwd, exists }).path,
    graphDir,
    scopesDir,
    graphifyBin: nonEmpty(env[ENV_GRAPHIFY_BIN]) ?? "graphify",
    fetchConcurrency: parseFetchConcurrency(env[ENV_MAX_CONCURRENCY]),
    skipKinds: skip.kinds,
    site: {
      enabled: !SITE_OFF.has((nonEmpty(env[ENV_PROGRESS_SITE]) ?? "on").toLowerCase()),
      host: nonEmpty(env[ENV_PROGRESS_HOST]) ?? DEFAULT_SITE_HOST,
      ...(nonEmpty(env[ENV_PROGRESS_VIEWER_PASSWORD]) ? { viewerPassword: nonEmpty(env[ENV_PROGRESS_VIEWER_PASSWORD]) } : {}),
      port: parseSitePort(env[ENV_PROGRESS_PORT]),
      osopenerDist: nonEmpty(env[ENV_OSOPENER_DIST]) ?? join(packageRoot, "..", "osopener", "dist")
    }
  };
}
