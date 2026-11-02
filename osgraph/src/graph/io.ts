/**
 * Deterministic, atomic snapshot persistence. `graph.json` holds the snapshot only; the rebuild
 * timestamp goes to the sibling `meta.json` so two rebuilds from identical inputs are byte-identical.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NO_SNAPSHOT_COMPLETENESS, UNKNOWN_COMPLETENESS, type GraphCompleteness } from "../types.js";
import type { Snapshot, SnapshotMeta } from "./types.js";

export const META_FILE = "meta.json";

/** Stable key order, 2-space indent, `\n` line endings, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The staging path for one `writeFileAtomic` call: `<path>.tmp-<pid>-<random>`.
 *
 * The random half is call-scoped on purpose (S6 audit F1). A per-process name alone let two writers
 * inside one process share a single temp path, so one could `rename` a half-written file over the
 * real one — defeating OSG-004's all-or-nothing guarantee from the inside. `ScopeStore.list()`
 * still recognises these by the `.tmp-` infix.
 */
export function atomicTempPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** Writes a call-scoped temp file then renames over `path`; one retry on EPERM (Windows AV/indexer locks). */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = atomicTempPath(path);
  try {
    writeFileSync(tmp, content, "utf8");
  } catch (error) {
    cleanup(tmp);
    throw error;
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      cleanup(tmp);
      throw error;
    }
    sleepSync(100);
    try {
      renameSync(tmp, path);
    } catch (retryError) {
      cleanup(tmp);
      throw retryError;
    }
  }
}

function cleanup(tmp: string): void {
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch {
    /* best effort */
  }
}

export function metaPath(graphPath: string): string {
  return join(dirname(graphPath), META_FILE);
}

/**
 * Writes the sibling `meta.json` first (when given), then `graph.json` (deterministic).
 *
 * The order is deliberate (S6 audit F11): the two files are two separate atomic writes, so a crash
 * between them leaves one of two states. Meta-first leaves a meta that is *newer* than the graph it
 * describes — forward-stale, and detectable, because `rebuiltAt`/`skippedCount` then describe a
 * rebuild that never landed. Graph-first would leave a fresh snapshot behind a stale `rebuiltAt` and
 * a stale `skippedCount`, i.e. `graphCompleteness` silently under-reporting the loss OSG-011 exists
 * to disclose. Either way the previous snapshot is only ever replaced by a complete file.
 */
export function writeSnapshot(path: string, snapshot: Snapshot, meta?: SnapshotMeta): void {
  if (meta) writeFileAtomic(metaPath(path), canonicalJson(meta));
  writeFileAtomic(path, canonicalJson(stripVolatile(snapshot)));
}

export function readSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

export function readMeta(graphPath: string): SnapshotMeta | null {
  const path = metaPath(graphPath);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SnapshotMeta;
}

/**
 * Removes any volatile field for byte-identity comparisons. The snapshot carries none by design;
 * this guards against a `rebuiltAt` smuggled under `graph.osgraph` by older writers.
 */
export function stripVolatile(snapshot: Snapshot): Snapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Snapshot & {
    graph: { osgraph: { rebuiltAt?: string } };
  };
  delete copy.graph.osgraph.rebuiltAt;
  return copy;
}

/** OSG-011 completeness from a snapshot plus its meta (null meta → no timestamp). */
export function graphCompleteness(snapshot: Snapshot, meta: SnapshotMeta | null): GraphCompleteness {
  return {
    skippedCount: snapshot.graph.osgraph.skipped.length,
    lastRebuildAt: meta?.rebuiltAt ?? null
  };
}

/**
 * OSG-011 completeness of the snapshot at `graphPath`:
 *  - no snapshot file            -> `NO_SNAPSHOT_COMPLETENESS` ("complete, never rebuilt");
 *  - readable `meta.json`        -> its `skippedCount` / `rebuiltAt`;
 *  - no meta but a readable graph -> the graph's own `skipped` length, `lastRebuildAt: null`;
 *  - snapshot present but unreadable (corrupt JSON, legacy graph with no `graph.osgraph.skipped`)
 *    -> `UNKNOWN_COMPLETENESS`, i.e. the same numbers plus `completenessUnknown: true`.
 *
 * The last case is S6 audit F7: the query tools still answer from that snapshot, so the one field
 * OSG-011 added must not report it as a complete, never-rebuilt graph.
 */
export function readGraphCompleteness(graphPath: string): GraphCompleteness {
  if (!existsSync(graphPath)) return NO_SNAPSHOT_COMPLETENESS;
  try {
    const meta = readMeta(graphPath);
    if (meta && typeof meta.skippedCount === "number" && typeof meta.rebuiltAt === "string") {
      return { skippedCount: meta.skippedCount, lastRebuildAt: meta.rebuiltAt };
    }
    if (meta) return UNKNOWN_COMPLETENESS;
    const snapshot = readSnapshot(graphPath);
    if (!Array.isArray(snapshot.graph?.osgraph?.skipped)) return UNKNOWN_COMPLETENESS;
    return graphCompleteness(snapshot, null);
  } catch {
    return UNKNOWN_COMPLETENESS;
  }
}
