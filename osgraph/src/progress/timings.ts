/**
 * Per-module measured durations, persisted so a rebuild can predict its own ETA.
 *
 * Why this file exists at all: the "Time remaining" panel is what makes a two-hour rebuild
 * bearable, and it cannot be computed from the current run alone — early on there is nothing to
 * extrapolate from, and module costs vary by more than an order of magnitude, so "modules done /
 * modules total" is a badly wrong predictor. The kit solved this by reading previous runs'
 * reports out of its own runs directory; osgraph has no such directory, so it keeps a small file
 * of its own inside the graph dir it already owns.
 *
 * Keyed by lower-cased module name, and read across **all** scopes: per-call latency is a
 * property of the module (its size, its element count), not of the scope being rebuilt. A module
 * first met in scope A therefore already has an expected duration when scope B includes it.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RebuildPhase } from "../rebuild/rebuild.js";
import type { ModuleCost, TimingsFile } from "./types.js";

export const TIMINGS_FILENAME = "timings.json";

/** `<graphDir>/<scope>/timings.json`. */
export function timingsPath(graphDir: string, scope: string): string {
  return join(graphDir, scope, TIMINGS_FILENAME);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** One scope's timings, or an empty map when the file is missing or unreadable. */
export function readTimings(graphDir: string, scope: string): Map<string, ModuleCost> {
  const file = readJson<TimingsFile>(timingsPath(graphDir, scope));
  const out = new Map<string, ModuleCost>();
  if (!file || typeof file.modules !== "object" || file.modules === null) return out;
  for (const [key, timing] of Object.entries(file.modules)) {
    if (timing && typeof timing.ms === "number" && timing.ms > 0) out.set(key.toLowerCase(), timing);
  }
  return out;
}

/**
 * Every scope's timings merged, newest-first by scope directory order. A module already timed by
 * an earlier entry is not overwritten — one measurement is enough to predict with, and merging
 * means a brand-new scope made of known modules has a usable ETA on its *first* run.
 */
export function readAllTimings(graphDir: string): Map<string, ModuleCost> {
  const merged = new Map<string, ModuleCost>();
  let scopes: string[];
  try {
    scopes = readdirSync(graphDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return merged;
  }
  for (const scope of scopes) {
    for (const [key, timing] of readTimings(graphDir, scope)) {
      if (!merged.has(key)) merged.set(key, timing);
    }
  }
  return merged;
}

/** What a finished module contributes to the store. */
export interface TimingInput {
  module: string;
  durationMs: number;
  phaseDurationsMs?: Partial<Record<RebuildPhase, number>>;
  nodeCount?: number;
  edgeCount?: number;
}

/**
 * Merges this run's measurements into the scope's timings file, replacing a module's previous
 * entry (the newest measurement is the best predictor — Studio load drifts) and leaving modules
 * this run did not touch alone.
 *
 * Failure is swallowed deliberately: losing an ETA is a far better outcome than failing a
 * completed rebuild because a timings file could not be written.
 */
export function writeTimings(graphDir: string, scope: string, runs: readonly TimingInput[]): boolean {
  if (runs.length === 0) return false;
  const existing = readTimings(graphDir, scope);
  const modules: Record<string, ModuleCost> = {};
  for (const [key, timing] of existing) modules[key] = timing;
  for (const run of runs) {
    if (!run.module || !(run.durationMs > 0)) continue;
    modules[run.module.toLowerCase()] = {
      ms: run.durationMs,
      phases: run.phaseDurationsMs ?? {},
      ...(run.nodeCount === undefined ? {} : { nodes: run.nodeCount }),
      ...(run.edgeCount === undefined ? {} : { edges: run.edgeCount })
    };
  }
  const file: TimingsFile = { schemaVersion: 1, writtenAt: new Date().toISOString(), modules };
  const path = timingsPath(graphDir, scope);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
