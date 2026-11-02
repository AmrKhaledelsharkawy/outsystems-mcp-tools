/**
 * `where`-like executable lookup for the pinned graphify binary (ADR-0003). Pure given `env`
 * and `platform`, so tests can point PATH at a temp directory.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export interface ResolvedExecutable {
  path: string;
  /** `cmd` = Windows batch script (`.cmd` / `.bat`), which needs cmd.exe to run; `exe` = anything else. */
  kind: "exe" | "cmd";
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string, windows: boolean): boolean {
  if (!isFile(path)) return false;
  if (windows) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function kindOf(path: string): ResolvedExecutable["kind"] {
  const ext = extname(path).toLowerCase();
  return ext === ".cmd" || ext === ".bat" ? "cmd" : "exe";
}

/** Windows: `PATHEXT` extensions (default `.COM;.EXE;.BAT;.CMD`), lower-cased, `.exe` before `.cmd`. */
function candidateExtensions(env: Record<string, string | undefined>, windows: boolean): string[] {
  if (!windows) return [""];
  const raw = env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  return ["", ...exts];
}

/**
 * Resolves `bin` to an executable path:
 *  - with a path separator: the path as given, then `<path><ext>` for each PATHEXT extension;
 *  - bare name: every PATH directory, trying as-is, then each PATHEXT extension (so `graphify`
 *    finds `graphify.exe` before `graphify.cmd` on Windows).
 * Returns `undefined` when nothing is found.
 */
export function resolveExecutable(bin: string, options: ResolveOptions = {}): ResolvedExecutable | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const exts = candidateExtensions(env, windows);
  const hasSeparator = bin.includes("/") || bin.includes("\\") || isAbsolute(bin);

  const tryBase = (base: string): ResolvedExecutable | undefined => {
    for (const ext of exts) {
      const candidate = `${base}${ext}`;
      if (ext !== "" && candidate.toLowerCase() === base.toLowerCase()) continue;
      if (isExecutableFile(candidate, windows)) return { path: candidate, kind: kindOf(candidate) };
    }
    return undefined;
  };

  if (hasSeparator) return tryBase(bin);

  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    const found = tryBase(join(dir, bin));
    if (found) return found;
  }
  return undefined;
}
