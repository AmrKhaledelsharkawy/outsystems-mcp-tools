/**
 * `osgraph doctor` (#63): the LOCAL doctor. One read-only pass that explains why a rebuild or `run`
 * cannot work on this machine, before it fails halfway.
 *
 * Read-only by construction:
 *  - the only Service Studio call is `listApps`; `createSessionToken` is never called (approving a
 *    session is a human act - osgraph only READS the token file);
 *  - no module is opened or closed (the osopener adapter is only loaded, never driven);
 *  - nothing is written (the graph directory is probed with `access`, not by creating a file).
 *
 * The token is never printed: it is not placed in any check, and the client redacts it from every
 * transport error it surfaces.
 *
 * osgraph is not standalone: the doctor checks the two things it depends on - the human-approved
 * session token (token manager) and osopener - alongside Service Studio itself. #9 (source /
 * DEV-environment preflight) will extend this command rather than replace it: add a check to
 * `DoctorCheckId` and one function to `runDoctor`.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OsgraphConfigError, requireServiceStudioUrl, type OsgraphConfig } from "../config.js";
import { readMeta, resolveScopeArtifactPaths } from "../graph/io.js";
import { describeLoadFailure, loadOsopenerAdapter, type OsopenerLoadResult } from "../osopener/adapter.js";
import { readScope } from "../scopes/index.js";
import { ServiceStudioClient } from "../servicestudio/client.js";
import { OsgraphToolError, ServiceStudioCallError, type FetchLike, type ServiceStudioApp } from "../servicestudio/types.js";
import { resolveTokenFile, type TokenFileResolution } from "./token.js";

export type DoctorCheckId = "token" | "endpoint" | "osopener" | "scope" | "graphDir";
/** `warn` never fails the run; `skip` means the check could not run because an earlier one failed. */
export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorStatus;
  /** One line a human can act on. Never contains a token. */
  summary: string;
  /** Machine-readable facts (paths, codes, names). Never contains a token. */
  details?: Record<string, unknown>;
}

export interface ModuleResolution {
  module: string;
  /** `exact` = case-exact listing name and open; `not-open` = case-exact but listed as not open. */
  status: "exact" | "not-open" | "near-miss" | "missing";
  suggestion?: string;
  reason?: "case" | "typo";
}

export interface DoctorReport {
  /** False when any check failed. The CLI exits non-zero on `!ok`. */
  ok: boolean;
  checkedAt: string;
  scope: string | null;
  checks: DoctorCheck[];
  modules?: ModuleResolution[];
}

export interface DoctorOptions {
  config: OsgraphConfig;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Scope whose module names and snapshot are checked. Without it those checks are skipped. */
  scope?: string;
  /** Overrides `config.graphDir`. */
  graphDir?: string;
  /** Per-request timeout for the one Studio call. Default 15 s. */
  timeoutMs?: number;
  // Seams for tests (defaults are the real thing).
  fetchImpl?: FetchLike;
  readTokenFile?: (path: string) => Promise<string>;
  exists?: (path: string) => boolean;
  loadOpener?: (dist: string) => Promise<OsopenerLoadResult>;
  /** Throws when `path` is not writable. */
  canWrite?: (path: string) => void;
  now?: () => Date;
}

export const SCOPE_NOT_OPEN_EXPLANATION =
  "Service Studio answers 'No module is currently open in Service Studio' when the NAME it was given is " +
  "not an open module - a closed, misspelled or wrongly-cased name - even while other modules are open. " +
  "It does not mean Studio is empty or unreachable.";

export const TOKEN_HUMAN_MESSAGE =
  "a human must approve a new Service Studio session through the token manager; osgraph never creates a session token";

/** Case-insensitive Levenshtein distance, two-row. */
function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** Resolves one scope module against the listing. Exported for tests. */
export function resolveModuleName(module: string, apps: readonly Pick<ServiceStudioApp, "name" | "isOpen">[]): ModuleResolution {
  const exact = apps.find((a) => a.name === module);
  if (exact !== undefined) return { module, status: exact.isOpen === false ? "not-open" : "exact" };
  const folded = apps.find((a) => a.name.toLowerCase() === module.toLowerCase());
  if (folded !== undefined) return { module, status: "near-miss", suggestion: folded.name, reason: "case" };
  let best: { name: string; distance: number } | undefined;
  for (const a of apps) {
    const distance = editDistance(module, a.name);
    if (best === undefined || distance < best.distance) best = { name: a.name, distance };
  }
  const limit = Math.max(1, Math.min(3, Math.floor(module.length / 4)));
  if (best !== undefined && best.distance <= limit) {
    return { module, status: "near-miss", suggestion: best.name, reason: "typo" };
  }
  return { module, status: "missing" };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Listing {
  apps?: ServiceStudioApp[];
  reachable: boolean;
  tokenRejected: boolean;
  /** Present when the endpoint could not be used (config / transport / unexpected reply). */
  endpoint: DoctorCheck;
}

/** The single Studio round-trip. With no token it is a reachability probe only. */
async function callListApps(
  config: OsgraphConfig,
  token: string | undefined,
  fetchImpl: FetchLike | undefined,
  timeoutMs: number
): Promise<Listing> {
  let url: string;
  try {
    url = requireServiceStudioUrl(config);
  } catch (err) {
    const code = err instanceof OsgraphConfigError ? err.code : "CONFIG_INVALID";
    return {
      reachable: false,
      tokenRejected: false,
      endpoint: {
        id: "endpoint",
        status: "fail",
        summary: `Studio MCP endpoint is not configured: ${errMessage(err)}`,
        details: { code }
      }
    };
  }
  const client = new ServiceStudioClient({ url, fetchImpl, timeoutMs, transientRetryDelayMs: 0, maxConcurrent: 1 });
  return typedListing(client, url, token);
}

async function typedListing(client: ServiceStudioClient, url: string, token: string | undefined): Promise<Listing> {
  try {
    if (token === undefined) {
      await client.callToolRaw(undefined, "listApps", {});
      // A tokenless call that succeeds is unexpected but it proves reachability.
      return { reachable: true, tokenRejected: false, endpoint: reachable(url) };
    }
    const apps = await client.listAppsWithToken(token);
    return { apps, reachable: true, tokenRejected: false, endpoint: reachable(url) };
  } catch (err) {
    if (err instanceof OsgraphToolError && err.code === "TOKEN_EXPIRED") {
      // Studio answered and refused the token: the endpoint is fine, the token is not.
      return { reachable: true, tokenRejected: true, endpoint: reachable(url) };
    }
    if (err instanceof OsgraphToolError && err.code === "SERVICESTUDIO_UNREACHABLE") {
      return {
        reachable: false,
        tokenRejected: false,
        endpoint: {
          id: "endpoint",
          status: "fail",
          summary: `Studio MCP endpoint unreachable: ${err.message}. Is Service Studio running with its MCP server enabled?`,
          details: { url, code: err.code, ...(typeof err.details === "object" && err.details !== null ? { ...(err.details as object) } : {}) }
        }
      };
    }
    // The server answered, but not in a way that proves or disproves the token.
    const code = err instanceof ServiceStudioCallError ? "SERVICESTUDIO_CALL_FAILED" : "UNEXPECTED";
    return {
      reachable: true,
      tokenRejected: false,
      endpoint: {
        id: "endpoint",
        status: "warn",
        summary: `Studio MCP endpoint answered, but listApps failed: ${errMessage(err)}`,
        details: { url, code }
      }
    };
  }
}

function reachable(url: string): DoctorCheck {
  return { id: "endpoint", status: "pass", summary: `Studio MCP endpoint answered at ${url}`, details: { url } };
}

function describeSource(r: TokenFileResolution): string {
  switch (r.source) {
    case "env":
      return "from OSGRAPH_SERVICESTUDIO_TOKEN_FILE";
    case "search":
      return `found by searching up from ${r.searchedFrom}`;
    default:
      return "";
  }
}

async function checkOsopener(opts: DoctorOptions): Promise<DoctorCheck> {
  const dist = opts.config.site.osopenerDist;
  const loader = opts.loadOpener ?? ((d: string) => loadOsopenerAdapter(d, { env: opts.env }));
  let loaded: OsopenerLoadResult;
  try {
    loaded = await loader(dist);
  } catch (err) {
    return { id: "osopener", status: "fail", summary: `osopener could not be loaded: ${errMessage(err)}`, details: { dist } };
  }
  if (!loaded.ok) {
    const f = loaded.failure;
    return {
      id: "osopener",
      status: "fail",
      // Verbatim: the adapter's own one-line description, not a paraphrase.
      summary: describeLoadFailure(f),
      details: { dist: f.dist, cause: f.cause, ...(f.code !== undefined ? { code: f.code } : {}), ...(f.detail !== undefined ? { detail: f.detail } : {}) }
    };
  }
  return { id: "osopener", status: "pass", summary: `osopener loaded from ${dist}`, details: { dist } };
}

function nearestExisting(path: string, exists: (p: string) => boolean): string | undefined {
  let current = resolve(path);
  for (;;) {
    if (exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function defaultCanWrite(path: string): void {
  accessSync(path, constants.W_OK);
}

function checkGraphDir(opts: DoctorOptions, graphDir: string, now: Date): DoctorCheck {
  const exists = opts.exists ?? existsSync;
  const canWrite = opts.canWrite ?? defaultCanWrite;
  const details: Record<string, unknown> = { graphDir };
  let target = graphDir;
  let willCreate = false;
  if (!exists(graphDir)) {
    const ancestor = nearestExisting(graphDir, exists);
    if (ancestor === undefined) {
      return { id: "graphDir", status: "fail", summary: `graph directory ${graphDir} cannot be created: no existing parent`, details };
    }
    target = ancestor;
    willCreate = true;
  }
  try {
    canWrite(target);
  } catch (err) {
    return {
      id: "graphDir",
      status: "fail",
      summary: `graph directory ${willCreate ? `parent ${target}` : graphDir} is not writable: ${errMessage(err)}`,
      details
    };
  }

  let snapshotNote = "no scope given, snapshot not checked";
  if (opts.scope !== undefined) {
    try {
      const paths = resolveScopeArtifactPaths(graphDir, opts.scope);
      details.snapshot = paths.graph;
      if (!exists(paths.graph)) {
        snapshotNote = `no snapshot for scope '${opts.scope}' yet (the first rebuild or run creates it)`;
        details.snapshotPresent = false;
      } else {
        details.snapshotPresent = true;
        let stamp: Date | undefined;
        try {
          const meta = readMeta(paths.graph);
          const raw = meta?.stagedTo ?? meta?.rebuiltAt;
          if (raw !== undefined) {
            const parsed = new Date(raw);
            if (!Number.isNaN(parsed.getTime())) stamp = parsed;
          }
        } catch {
          /* unreadable meta: fall back to the file's mtime */
        }
        stamp ??= statSync(paths.graph).mtime;
        const ageMs = Math.max(0, now.getTime() - stamp.getTime());
        details.snapshotAt = stamp.toISOString();
        details.snapshotAgeMs = ageMs;
        snapshotNote = `snapshot for scope '${opts.scope}' present, age ${formatDoctorAge(ageMs)}`;
      }
    } catch (err) {
      return { id: "graphDir", status: "fail", summary: `cannot resolve the snapshot for scope '${opts.scope}': ${errMessage(err)}`, details };
    }
  }
  return {
    id: "graphDir",
    status: "pass",
    summary: `graph directory ${willCreate ? "will be created and is" : "is"} writable; ${snapshotNote}`,
    details
  };
}

/** `3d 4h`, `5h 12m`, `7m`, `42s` - same shape as `run`'s age text. */
export function formatDoctorAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const now = (opts.now ?? (() => new Date()))();
  const exists = opts.exists ?? existsSync;
  const readTokenFile = opts.readTokenFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const graphDir = opts.graphDir ?? opts.config.graphDir;
  const checks: DoctorCheck[] = [];

  // --- token file: found + non-empty (validation happens with the one listApps call) ---------------
  const resolution = resolveTokenFile(opts.env, { cwd: opts.cwd, exists });
  let token: string | undefined;
  let tokenFailure: DoctorCheck | undefined;
  if (resolution.path === undefined || resolution.source === "env-missing") {
    tokenFailure = {
      id: "token",
      status: "fail",
      summary:
        resolution.path === undefined
          ? `no token.txt found at or above ${resolution.searchedFrom}; ${TOKEN_HUMAN_MESSAGE}`
          : `token file ${resolution.path} (OSGRAPH_SERVICESTUDIO_TOKEN_FILE) does not exist and no token.txt was found at or above ${resolution.searchedFrom}; ${TOKEN_HUMAN_MESSAGE}`,
      details: { source: resolution.source, searchedFrom: resolution.searchedFrom, probed: resolution.probed }
    };
  } else {
    try {
      const raw = (await readTokenFile(resolution.path)).trim();
      if (raw.length === 0) {
        tokenFailure = {
          id: "token",
          status: "fail",
          summary: `token file ${resolution.path} is empty; ${TOKEN_HUMAN_MESSAGE}`,
          details: { path: resolution.path, source: resolution.source }
        };
      } else {
        token = raw;
      }
    } catch (err) {
      tokenFailure = {
        id: "token",
        status: "fail",
        summary: `token file ${resolution.path} is not readable: ${errMessage(err)}`,
        details: { path: resolution.path, source: resolution.source }
      };
    }
  }

  // --- the one Studio call -------------------------------------------------------------------------
  const listing = await callListApps(opts.config, token, opts.fetchImpl, timeoutMs);

  let tokenCheck: DoctorCheck;
  if (tokenFailure !== undefined) {
    tokenCheck = tokenFailure;
  } else if (listing.tokenRejected) {
    tokenCheck = {
      id: "token",
      status: "fail",
      summary: `Studio rejected the token in ${resolution.path} (expired or from an old session); ${TOKEN_HUMAN_MESSAGE}`,
      details: { path: resolution.path, source: resolution.source }
    };
  } else if (listing.apps !== undefined) {
    tokenCheck = {
      id: "token",
      status: "pass",
      summary: `token file ${resolution.path} ${describeSource(resolution)} - listApps accepted it`,
      details: { path: resolution.path, source: resolution.source }
    };
  } else {
    tokenCheck = {
      id: "token",
      status: "skip",
      summary: `token file ${resolution.path} is present but could not be validated: the Studio endpoint check failed`,
      details: { path: resolution.path, source: resolution.source }
    };
  }
  checks.push(tokenCheck, listing.endpoint);

  // --- osopener ---------------------------------------------------------------------------------
  checks.push(await checkOsopener(opts));

  // --- scope module names -----------------------------------------------------------------------
  let modules: ModuleResolution[] | undefined;
  if (opts.scope === undefined) {
    checks.push({ id: "scope", status: "skip", summary: "no --scope given: scope module names not checked" });
  } else {
    let scopeModules: string[] | undefined;
    try {
      scopeModules = readScope(opts.config.scopesDir, opts.scope).modules;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      checks.push({
        id: "scope",
        status: "fail",
        summary: `scope '${opts.scope}' cannot be read: ${errMessage(err)}`,
        details: { ...(typeof code === "string" ? { code } : {}) }
      });
    }
    if (scopeModules !== undefined) {
      if (listing.apps === undefined) {
        checks.push({
          id: "scope",
          status: "skip",
          summary: `${scopeModules.length} module(s) in scope '${opts.scope}' not resolved: no module listing (see the token and endpoint checks)`,
          details: { modules: scopeModules.length }
        });
      } else {
        modules = scopeModules.map((m) => resolveModuleName(m, listing.apps ?? []));
        const missing = modules.filter((m) => m.status === "missing");
        const near = modules.filter((m) => m.status === "near-miss");
        const closed = modules.filter((m) => m.status === "not-open");
        const failed = missing.length + near.length > 0;
        const parts: string[] = [];
        for (const m of near) {
          parts.push(`'${m.module}' is not a listed name; did you mean '${m.suggestion}' (${m.reason === "case" ? "different case" : "possible typo"})?`);
        }
        for (const m of missing) {
          parts.push(`'${m.module}' is not in Studio's module listing (not open, or misspelled)`);
        }
        for (const m of closed) {
          parts.push(`'${m.module}' is listed but not open (osgraph run opens it through osopener; rebuild needs it already open)`);
        }
        checks.push({
          id: "scope",
          status: failed ? "fail" : closed.length > 0 ? "warn" : "pass",
          summary: failed
            ? `${missing.length + near.length} of ${modules.length} module(s) in scope '${opts.scope}' do not resolve case-exactly. ${parts.join(" ")} ${SCOPE_NOT_OPEN_EXPLANATION}`
            : closed.length > 0
              ? `all ${modules.length} module(s) in scope '${opts.scope}' resolve case-exactly. ${parts.join(" ")}`
              : `all ${modules.length} module(s) in scope '${opts.scope}' resolve case-exactly to open modules`,
          details: { scope: opts.scope, modules: modules.length, nearMisses: near.length, unresolved: missing.length, notOpen: closed.length }
        });
      }
    }
  }

  // --- graph dir ---------------------------------------------------------------------------------
  checks.push(checkGraphDir(opts, graphDir, now));

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checkedAt: now.toISOString(),
    scope: opts.scope ?? null,
    checks,
    ...(modules !== undefined ? { modules } : {})
  };
}

/** Human-readable text for the CLI. */
export function renderDoctorReport(report: DoctorReport): string {
  const tag: Record<DoctorStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };
  const lines = [`osgraph doctor${report.scope !== null ? ` (scope '${report.scope}')` : ""}`];
  for (const c of report.checks) lines.push(`  ${tag[c.status]}  ${c.id}: ${c.summary}`);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  lines.push(report.ok ? "all checks passed" : `${failed} check(s) failed`);
  return `${lines.join("\n")}\n`;
}
