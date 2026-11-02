import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OsopenerErrorCode } from "./types.js";

export class OsopenerConfigError extends Error {
  readonly code: OsopenerErrorCode;
  constructor(code: OsopenerErrorCode, message: string) {
    super(message);
    this.name = "OsopenerConfigError";
    this.code = code;
  }
}

/** How `tokenFile` was decided — reported so a wrong token is diagnosable without printing it. */
export type TokenFileSource =
  | "env" // OSGRAPH_SERVICESTUDIO_TOKEN_FILE, and the file is there
  | "search" // found by walking up from the working directory
  | "env-missing" // env var set but no such file, and the search found nothing either
  | "none"; // neither configured nor found

export interface TokenFileResolution {
  /** Absolute path, or undefined when nothing was configured and nothing was found. */
  path: string | undefined;
  source: TokenFileSource;
  /** Directory the upward search started from (the user's working directory). */
  searchedFrom: string;
  /** Candidate paths that were probed, nearest first. Never contains a token, only paths. */
  probed: string[];
}

export interface OsopenerConfig {
  /** servicestudio MCP endpoint (same env name as osgraph, OSG-014 §4). */
  serviceStudioUrl: string;
  /**
   * Hook-saved session token file, read-only (ADR-0004). Undefined → every listApps call fails TOKEN_EXPIRED.
   * Resolved from the env var when that file exists, otherwise discovered by walking up from the working
   * directory, so one user-scope registration serves every workspace.
   */
  tokenFile: string | undefined;
  /** Where `tokenFile` came from, and what was probed to get there. */
  token: TokenFileResolution;
  /** Optional explicit ServiceStudio.exe path (skips discovery). */
  studioExe: string | undefined;
  /** Package root; `tracks/` and `screenshots/` live under it. */
  dataDir: string;
  /** Path of `scripts/studio-ui.ps1`. */
  helperScript: string;
  /** PowerShell executable (Windows PowerShell 5.1 by default). */
  powershellExe: string;
}

export const ENV_SERVICESTUDIO_URL = "OSGRAPH_SERVICESTUDIO_URL";
export const ENV_SERVICESTUDIO_TOKEN_FILE = "OSGRAPH_SERVICESTUDIO_TOKEN_FILE";
export const ENV_TOKEN_SEARCH_DIR = "OSOPENER_TOKEN_SEARCH_DIR";
export const ENV_TOKEN_SEARCH = "OSOPENER_TOKEN_SEARCH";
export const ENV_TOKEN_FILE_NAME = "OSOPENER_TOKEN_FILE_NAME";
export const ENV_STUDIO_EXE = "OSOPENER_STUDIO_EXE";
export const ENV_DATA_DIR = "OSOPENER_DATA_DIR";
export const ENV_POWERSHELL = "OSOPENER_POWERSHELL";

/** Default name of the hook-saved token file, searched for in the working directory and its parents. */
export const DEFAULT_TOKEN_FILE_NAME = "token.txt";

/** Values of `OSOPENER_TOKEN_SEARCH` that turn discovery off, leaving the env path as the only source. */
const SEARCH_OFF = new Set(["off", "0", "false", "no", "none"]);

type Env = Record<string, string | undefined>;

export interface ResolveOptions {
  /** The directory the user is working in. Defaults to `process.cwd()` — for a stdio MCP server that is the workspace. */
  cwd?: string;
  /** Existence probe; injectable for tests. */
  exists?: (path: string) => boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/** `<package>/` — resolved from `dist/config.js` (or `src/config.ts` under vitest). */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Every directory from `startDir` up to the filesystem root, nearest first.
 * Terminates on the root even when `startDir` is already it.
 */
export function ancestorDirs(startDir: string): string[] {
  const start = resolve(startDir);
  const root = parse(start).root;
  const dirs: string[] = [];
  let current = start;
  for (;;) {
    dirs.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/**
 * Finds the nearest `token.txt` at or above `startDir`. Returns the path and every candidate probed,
 * so a miss can say where it looked.
 */
export function findTokenFile(
  startDir: string,
  options: { fileName?: string; exists?: (path: string) => boolean } = {}
): { path: string | undefined; probed: string[] } {
  const fileName = options.fileName ?? DEFAULT_TOKEN_FILE_NAME;
  const exists = options.exists ?? existsSync;
  const probed: string[] = [];
  for (const dir of ancestorDirs(startDir)) {
    const candidate = join(dir, fileName);
    probed.push(candidate);
    if (exists(candidate)) return { path: candidate, probed };
  }
  return { path: undefined, probed };
}

/**
 * Decides which token file to read, and re-decidable at any time: the session-guard hook may create
 * `token.txt` after the server has started, so callers resolve per token read rather than once at boot.
 *
 * Order: an env-configured file that exists wins (explicit beats inferred); otherwise the nearest
 * `token.txt` at or above the working directory; otherwise the env path is reported as missing so the
 * error can name it.
 */
export function resolveTokenFile(env: Env, options: ResolveOptions = {}): TokenFileResolution {
  const exists = options.exists ?? existsSync;
  const searchStart = nonEmpty(env[ENV_TOKEN_SEARCH_DIR]) ?? options.cwd ?? process.cwd();
  const searchedFrom = resolve(searchStart);
  const fileName = nonEmpty(env[ENV_TOKEN_FILE_NAME]) ?? DEFAULT_TOKEN_FILE_NAME;

  const searchEnabled = !SEARCH_OFF.has((nonEmpty(env[ENV_TOKEN_SEARCH]) ?? "on").toLowerCase());

  const configured = nonEmpty(env[ENV_SERVICESTUDIO_TOKEN_FILE]);
  const configuredPath = configured === undefined ? undefined : isAbsolute(configured) ? configured : resolve(searchedFrom, configured);
  if (configuredPath !== undefined && exists(configuredPath)) {
    return { path: configuredPath, source: "env", searchedFrom, probed: [configuredPath] };
  }

  const found = searchEnabled ? findTokenFile(searchedFrom, { fileName, exists }) : { path: undefined, probed: [] };
  const probed = configuredPath === undefined ? found.probed : [configuredPath, ...found.probed];
  if (found.path !== undefined) {
    return { path: found.path, source: "search", searchedFrom, probed };
  }
  if (configuredPath !== undefined) {
    return { path: configuredPath, source: "env-missing", searchedFrom, probed };
  }
  return { path: undefined, source: "none", searchedFrom, probed };
}

/** One line for stderr describing where the token came from. Contains paths only, never a token. */
export function describeTokenResolution(token: TokenFileResolution): string {
  switch (token.source) {
    case "env":
      return `token file: ${token.path} (from ${ENV_SERVICESTUDIO_TOKEN_FILE})`;
    case "search":
      return `token file: ${token.path} (found by searching up from ${token.searchedFrom})`;
    case "env-missing":
      return `token file: ${token.path} from ${ENV_SERVICESTUDIO_TOKEN_FILE} does not exist, and no ${DEFAULT_TOKEN_FILE_NAME} found at or above ${token.searchedFrom}`;
    case "none":
      return `token file: none — no ${ENV_SERVICESTUDIO_TOKEN_FILE} set and no ${DEFAULT_TOKEN_FILE_NAME} at or above ${token.searchedFrom}`;
  }
}

/**
 * Pure (given `env`): builds the runtime config. Throws `CONFIG_MISSING` when the servicestudio URL is unset.
 * The token file is not required at startup so `focusStudio` keeps working without one; listApps-based tools
 * return `TOKEN_EXPIRED` instead.
 */
export function loadConfig(
  env: Env,
  options: { packageRoot?: string } & ResolveOptions = {}
): OsopenerConfig {
  const root = options.packageRoot ?? packageRoot();
  const serviceStudioUrl = nonEmpty(env[ENV_SERVICESTUDIO_URL]);
  if (serviceStudioUrl === undefined) {
    throw new OsopenerConfigError(
      "CONFIG_MISSING",
      `${ENV_SERVICESTUDIO_URL} is not set. osopener has no default servicestudio endpoint; ` +
        `set it to the servicestudio MCP URL (e.g. http://127.0.0.1:41820/mcp).`
    );
  }
  const dataDir = nonEmpty(env[ENV_DATA_DIR]) ?? root;
  const token = resolveTokenFile(env, options);
  return {
    serviceStudioUrl,
    tokenFile: token.path,
    token,
    studioExe: nonEmpty(env[ENV_STUDIO_EXE]),
    dataDir,
    helperScript: join(root, "scripts", "studio-ui.ps1"),
    powershellExe: nonEmpty(env[ENV_POWERSHELL]) ?? "powershell.exe"
  };
}
