/**
 * Scope store (ADR-0005): one JSON file per user-defined scope at `<scopesDir>/<name>.json`,
 * canonical JSON `{ "name", "modules" }`. osgraph never adds or drops modules by itself; the
 * module order is the user's (duplicates removed), never re-sorted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, writeFileAtomic } from "../graph/io.js";
import { OsgraphToolError } from "../servicestudio/types.js";

export const SCOPE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export interface ScopeDefinition {
  name: string;
  modules: string[];
}

export interface ScopeEntry extends ScopeDefinition {
  /** Absolute path of the scope file. */
  path: string;
}

function scopeInvalid(message: string, details?: unknown): OsgraphToolError {
  return new OsgraphToolError("SCOPE_INVALID", message, details);
}

/** Validates `name`; throws `SCOPE_INVALID` for anything that is not a safe single path segment. */
export function assertScopeName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw scopeInvalid("scope name must be a non-empty string");
  }
  if (!SCOPE_NAME_RE.test(name) || name === "." || name === "..") {
    throw scopeInvalid(
      `scope name '${name}' is invalid: use only letters, digits, '_', '.', '-' (not '.' or '..')`,
      { name }
    );
  }
}

/** Validates + dedupes the module list (user order kept). Throws `SCOPE_INVALID`. */
export function normalizeModules(modules: unknown): string[] {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw scopeInvalid("scope modules must be a non-empty array of module names");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of modules) {
    if (typeof m !== "string" || m.trim().length === 0) {
      throw scopeInvalid("every scope module must be a non-empty string", { module: m });
    }
    const name = m.trim();
    if (name.includes("/") || name.includes("\\")) {
      throw scopeInvalid(`module name '${name}' must not contain path separators`, { module: name });
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export class ScopeStore {
  constructor(readonly scopesDir: string) {}

  scopePath(name: string): string {
    assertScopeName(name);
    return join(this.scopesDir, `${name}.json`);
  }

  /** Writes `<scopesDir>/<name>.json` atomically (creating the directory). Overwrites silently. */
  define(input: { name: unknown; modules: unknown }): ScopeEntry {
    assertScopeName(input.name);
    const modules = normalizeModules(input.modules);
    const path = this.scopePath(input.name);
    mkdirSync(this.scopesDir, { recursive: true });
    writeFileAtomic(path, canonicalJson({ name: input.name, modules }));
    return { name: input.name, modules, path };
  }

  /** Every `*.json` scope file, sorted by name. Missing directory → `[]`. Malformed files are skipped. */
  list(): ScopeEntry[] {
    if (!existsSync(this.scopesDir)) return [];
    const entries: ScopeEntry[] = [];
    for (const file of readdirSync(this.scopesDir)) {
      if (!file.endsWith(".json") || file.includes(".tmp-")) continue;
      const name = file.slice(0, -".json".length);
      if (!SCOPE_NAME_RE.test(name)) continue;
      try {
        entries.push(this.read(name));
      } catch {
        /* a malformed file is reported by read(name), not by the listing */
      }
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Throws `SCOPE_NOT_FOUND` when the file is missing, `SCOPE_INVALID` when it is malformed. */
  read(name: string): ScopeEntry {
    const path = this.scopePath(name);
    if (!existsSync(path)) {
      throw new OsgraphToolError("SCOPE_NOT_FOUND", `scope '${name}' is not defined (expected ${path})`, {
        scope: name,
        path
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw scopeInvalid(`scope file ${path} is not valid JSON: ${(err as Error).message}`, { scope: name, path });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw scopeInvalid(`scope file ${path} is not a JSON object`, { scope: name, path });
    }
    const obj = parsed as { name?: unknown; modules?: unknown };
    if (obj.name !== name) {
      throw scopeInvalid(`scope file ${path} declares name '${String(obj.name)}', expected '${name}'`, {
        scope: name,
        path
      });
    }
    return { name, modules: normalizeModules(obj.modules), path };
  }

  exists(name: string): boolean {
    return existsSync(this.scopePath(name));
  }
}

export function defineScope(scopesDir: string, input: { name: unknown; modules: unknown }): ScopeEntry {
  return new ScopeStore(scopesDir).define(input);
}

export function listScopes(scopesDir: string): ScopeEntry[] {
  return new ScopeStore(scopesDir).list();
}

export function readScope(scopesDir: string, name: string): ScopeEntry {
  return new ScopeStore(scopesDir).read(name);
}
