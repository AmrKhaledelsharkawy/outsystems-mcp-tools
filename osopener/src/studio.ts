/**
 * Locates ServiceStudio.exe when the process is not running (OSG-014 §6 STUDIO_NOT_FOUND, §8c).
 * Order: env override → well-known install roots (recursive) → registry App Paths.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXE = "ServiceStudio.exe";

export interface LocateOptions {
  override?: string;
  env?: Record<string, string | undefined>;
  /** Injectable for tests. */
  roots?: string[];
  registryLookup?: () => Promise<string | undefined>;
}

function walk(dir: string, depth: number, found: string[]): void {
  if (depth < 0 || found.length > 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (name.toLowerCase() === EXE.toLowerCase()) {
      found.push(full);
      return;
    }
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      /* unreadable entry */
    }
    if (isDir) walk(full, depth - 1, found);
    if (found.length > 0) return;
  }
}

export function defaultRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  const pf = env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA;
  roots.push(join(pf, "OutSystems"), join(pf86, "OutSystems"));
  if (local) roots.push(join(local, "OutSystems"));
  return roots;
}

/** `reg query "HKLM\...\App Paths\ServiceStudio.exe"` → default value, or undefined. */
export function registryAppPath(): Promise<string | undefined> {
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ServiceStudio.exe",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ServiceStudio.exe"
  ];
  return (async () => {
    for (const key of keys) {
      const out = await new Promise<string>((resolve) => {
        execFile("reg", ["query", key, "/ve"], { windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout));
      });
      const m = /REG_SZ\s+(.+\.exe)/i.exec(out);
      if (m && existsSync(m[1]!.trim())) return m[1]!.trim();
    }
    return undefined;
  })();
}

/** Returns the exe path or undefined. Never throws. */
export async function locateStudioExe(options: LocateOptions = {}): Promise<string | undefined> {
  if (options.override && existsSync(options.override)) return options.override;
  const env = options.env ?? process.env;
  const roots = options.roots ?? defaultRoots(env);
  for (const root of roots) {
    const found: string[] = [];
    walk(root, 4, found);
    if (found[0]) return found[0];
  }
  const reg = options.registryLookup ?? registryAppPath;
  return reg();
}
