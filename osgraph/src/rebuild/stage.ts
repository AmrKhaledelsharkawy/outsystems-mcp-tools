/**
 * Staged rebuild storage (ADR-0005's staged fallback, built 2026-10-30).
 *
 * `rebuild({ scope })` reads every scope module in one call and needs all of them open at once.
 * That stops working at scale: Service Studio spreads ~30+ open modules across several top-level
 * windows, its environment-list fetch grows from ≈5 s to over 45 s, and per-call latency rises with
 * it (see `.scratch/osgraph/live-evidence.md` §S9). The staged path lets a caller run
 * open → `rebuild({ scope, module })` → close, one module at a time, so Studio never holds more
 * than a couple of modules.
 *
 * Each staged module is persisted whole under `<graphDir>/<scope>/stage/<module>.json`. When every
 * module of the scope has a stage entry, the next staged call finalizes: it builds the snapshot
 * from the stage entries exactly as the all-at-once path would and writes `graph.json` atomically.
 * The stage is never read by the query tools — only `graph.json` is.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedModule } from "../extract/index.js";
import type { RebuildPhase } from "./rebuild.js";

/**
 * Bumped whenever `StageEntry`'s shape changes incompatibly. An entry carrying a different version
 * is treated as **not staged** rather than fed to `buildSnapshot`: S6 re-audit MAJOR-1 showed that
 * an entry from another code version was accepted on the strength of `extracted.nodes` alone, and
 * then killed every later staged call with `m.skipped is not iterable` — after paying for a full
 * live module read each time, permanently, because the stage is only cleared on a *successful*
 * finalize. An entry with **no** version field predates this check and has today's shape, so it is
 * accepted; that keeps stages written by the previous build usable instead of forcing a re-read.
 */
export const STAGE_SCHEMA_VERSION = 1;

/** One module's complete extraction, plus the timings `perModule` reports after finalizing. */
export interface StageEntry {
  /** Absent in entries written before the version check existed; those are schema 1 by definition. */
  schemaVersion?: number;
  scope: string;
  /** Canonical module name as `listApps` reports it. */
  module: string;
  /** Present only when the scope file spelled the module differently. */
  requestedAs?: string;
  moduleType: string;
  /** ISO-8601; `finalize` reports the oldest and newest so a stale stage is visible. */
  stagedAt: string;
  durationMs: number;
  referencedOnlyCount: number;
  phaseDurationsMs: Record<RebuildPhase, number>;
  /**
   * Read width the module was staged at (OSG-016/ADR-0013). Optional: entries written before the
   * width existed carry no value, and a finalize then reports the width it is itself running at
   * rather than inventing one. `phaseDurationsMs` is only interpretable against this.
   */
  concurrency?: number;
  extracted: ExtractedModule;
}

export function stageDir(graphDir: string, scope: string): string {
  return join(graphDir, scope, "stage");
}

/**
 * Module names are case-insensitively unique within a scope and contain no path separators (they
 * come from `listApps`), but the file name is still encoded so a surprising name cannot escape the
 * stage directory.
 */
export function stagePath(graphDir: string, scope: string, module: string): string {
  return join(stageDir(graphDir, scope), `${encodeURIComponent(module)}.json`);
}

export function writeStageEntry(graphDir: string, entry: StageEntry): string {
  const path = stagePath(graphDir, entry.scope, entry.module);
  mkdirSync(stageDir(graphDir, entry.scope), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: STAGE_SCHEMA_VERSION, ...entry }, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Everything `buildSnapshot` and `buildOutcome` will later touch, checked before the entry counts
 * as staged. Deliberately exhaustive: accepting a bad entry costs a wasted live module read on
 * every subsequent staged call (4–22 min each) and wedges the scope permanently, whereas rejecting
 * a good one costs only that one module being read again.
 */
export function isUsableStageEntry(value: unknown): value is StageEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<StageEntry>;
  if (e.schemaVersion !== undefined && e.schemaVersion !== STAGE_SCHEMA_VERSION) return false;
  if (typeof e.module !== "string" || e.module.length === 0) return false;
  if (typeof e.scope !== "string" || typeof e.moduleType !== "string") return false;
  if (typeof e.stagedAt !== "string" || Number.isNaN(Date.parse(e.stagedAt))) return false;
  if (typeof e.durationMs !== "number" || typeof e.referencedOnlyCount !== "number") return false;
  if (typeof e.phaseDurationsMs !== "object" || e.phaseDurationsMs === null) return false;
  const x = e.extracted as Partial<ExtractedModule> | undefined;
  if (typeof x !== "object" || x === null) return false;
  return Array.isArray(x.nodes) && Array.isArray(x.edges) && Array.isArray(x.skipped) && typeof x.module === "string";
}

/**
 * Every readable stage entry for the scope, sorted by module name. An unreadable or malformed file
 * is reported rather than thrown on: a corrupt stage entry must look like "this module is not
 * staged", so the caller re-stages it instead of finalizing a snapshot with a hole in it.
 */
export function readStage(graphDir: string, scope: string): { entries: StageEntry[]; unreadable: string[] } {
  const dir = stageDir(graphDir, scope);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { entries: [], unreadable: [] };
  }
  const entries: StageEntry[] = [];
  const unreadable: string[] = [];
  for (const file of files.sort()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (isUsableStageEntry(parsed)) {
        entries.push(parsed);
      } else {
        unreadable.push(file);
      }
    } catch {
      unreadable.push(file);
    }
  }
  entries.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
  return { entries, unreadable };
}

/** Deletes the whole stage for a scope. Called after a successful finalize. */
export function clearStage(graphDir: string, scope: string): void {
  rmSync(stageDir(graphDir, scope), { recursive: true, force: true });
}

/**
 * Which scope modules are still missing from the stage, compared case-insensitively because the
 * scope file's spelling need not match `listApps`' canonical name (S6 audit F8).
 */
export function missingFromStage(scopeModules: string[], entries: StageEntry[]): string[] {
  const staged = new Set(entries.map((e) => e.module.toLowerCase()));
  const missing: string[] = [];
  for (const m of scopeModules) {
    if (!staged.has(m.toLowerCase()) && !missing.some((x) => x.toLowerCase() === m.toLowerCase())) missing.push(m);
  }
  return missing;
}
