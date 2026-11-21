/**
 * Token-file discovery - the ONE rule shared by `loadConfig` (which picks file vs interactive token
 * mode for every command that talks to Studio) and `osgraph doctor` (#63), so the two always agree.
 *
 * This deliberately mirrors the rule osopener uses (`osopener/src/config.ts`: `resolveTokenFile`),
 * so the doctor looks at the same `token.txt` osopener would read: an explicitly configured file
 * that exists wins; otherwise the nearest `token.txt` at or above the working directory. osgraph
 * cannot import osopener's source (separate package, loaded only as a built `dist`), so the rule is
 * restated here and the two must be kept in step. Only paths are ever produced - never a token.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const ENV_TOKEN_FILE = "OSGRAPH_SERVICESTUDIO_TOKEN_FILE";
export const ENV_TOKEN_SEARCH_DIR = "OSOPENER_TOKEN_SEARCH_DIR";
export const ENV_TOKEN_SEARCH = "OSOPENER_TOKEN_SEARCH";
export const ENV_TOKEN_FILE_NAME = "OSOPENER_TOKEN_FILE_NAME";
export const DEFAULT_TOKEN_FILE_NAME = "token.txt";

const SEARCH_OFF = new Set(["off", "0", "false", "no", "none"]);

export type TokenFileSource = "env" | "search" | "env-missing" | "none";

export interface TokenFileResolution {
  /** The file to read; undefined when nothing was configured or found. */
  path: string | undefined;
  source: TokenFileSource;
  searchedFrom: string;
  /** Candidate paths probed, nearest first. */
  probed: string[];
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/** Every directory from `startDir` up to the filesystem root, nearest first. */
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

export function resolveTokenFile(
  env: Env,
  options: { cwd?: string; exists?: (path: string) => boolean } = {}
): TokenFileResolution {
  const exists = options.exists ?? existsSync;
  const searchedFrom = resolve(nonEmpty(env[ENV_TOKEN_SEARCH_DIR]) ?? options.cwd ?? process.cwd());
  const fileName = nonEmpty(env[ENV_TOKEN_FILE_NAME]) ?? DEFAULT_TOKEN_FILE_NAME;
  const searchEnabled = !SEARCH_OFF.has((nonEmpty(env[ENV_TOKEN_SEARCH]) ?? "on").toLowerCase());

  const configured = nonEmpty(env[ENV_TOKEN_FILE]);
  const configuredPath =
    configured === undefined ? undefined : isAbsolute(configured) ? configured : resolve(searchedFrom, configured);
  if (configuredPath !== undefined && exists(configuredPath)) {
    return { path: configuredPath, source: "env", searchedFrom, probed: [configuredPath] };
  }

  const probed: string[] = configuredPath === undefined ? [] : [configuredPath];
  let found: string | undefined;
  if (searchEnabled) {
    for (const dir of ancestorDirs(searchedFrom)) {
      const candidate = join(dir, fileName);
      probed.push(candidate);
      if (exists(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  if (found !== undefined) return { path: found, source: "search", searchedFrom, probed };
  if (configuredPath !== undefined) return { path: configuredPath, source: "env-missing", searchedFrom, probed };
  return { path: undefined, source: "none", searchedFrom, probed };
}
