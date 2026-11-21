/**
 * Accuracy audit entry points (#67). Offline: reads a snapshot and the raw texts beside it. The
 * live half (comparing sampled module pairs with Service Studio's dependency list) is a human
 * procedure, see LIVE-AUDIT.md.
 */
import { resolveScopeSnapshotPath, readSnapshot } from "../graph/io.js";
import type { Snapshot } from "../graph/types.js";
import { readRawModule, type RawModuleCapture } from "../rebuild/raw.js";
import { parseId } from "../extract/ids.js";
import { checkSample, type TextSource } from "./check.js";
import { buildReport } from "./report.js";
import { sampleSnapshot } from "./sample.js";
import type { AuditReport } from "./types.js";

export * from "./types.js";
export { sampleSnapshot, CONSUMER_KINDS } from "./sample.js";
export { checkEdge, checkAbsent, checkSample, textReferences, type TextSource } from "./check.js";
export { buildReport, formatReport } from "./report.js";

export const DEFAULT_K = 20;
export const DEFAULT_SEED = "1";

export interface AuditInput {
  scope: string;
  snapshot: Snapshot;
  textOf: TextSource;
  k?: number;
  seed?: string;
  /** Consumer modules known to have no raw capture, named in the report. */
  modulesWithoutCapture?: string[];
}

/** Sample, check and report one snapshot. Pure given its inputs. */
export function auditSnapshot(input: AuditInput): AuditReport {
  const sample = sampleSnapshot(input.snapshot, { k: input.k ?? DEFAULT_K, seed: input.seed ?? DEFAULT_SEED });
  const checked = checkSample(sample, input.textOf);
  return buildReport({
    scope: input.scope,
    sample,
    checked,
    modulesWithoutCapture: input.modulesWithoutCapture
  });
}

/**
 * A `TextSource` over the persisted raw captures (`<graphDir>/<scope>/raw/`). Captures are read
 * lazily, once per module; a module with no usable capture is remembered in `missing`.
 */
export function rawTextSource(
  graphDir: string,
  scope: string,
  read: (graphDir: string, scope: string, module: string) => RawModuleCapture = readRawModule
): { textOf: TextSource; missing: () => string[] } {
  const cache = new Map<string, Map<string, string> | null>();
  const keyOf = (kind: string, uiFlow: string | undefined, name: string): string => `${kind}\u0000${uiFlow ?? ""}\u0000${name}`;
  const load = (module: string): Map<string, string> | null => {
    if (cache.has(module)) return cache.get(module) ?? null;
    let map: Map<string, string> | null;
    try {
      const capture = read(graphDir, scope, module);
      map = new Map();
      for (const t of capture.texts) {
        if (t.name !== undefined) map.set(keyOf(t.kind, t.uiFlow, t.name), t.text);
      }
    } catch {
      map = null;
    }
    cache.set(module, map);
    return map;
  };
  const textOf: TextSource = (id) => {
    const parsed = parseId(id);
    if (parsed === undefined || parsed.kind === "module" || parsed.name === undefined) return undefined;
    return load(parsed.module)?.get(keyOf(parsed.kind, parsed.uiFlow, parsed.name));
  };
  return {
    textOf,
    missing: () => [...cache.entries()].filter(([, v]) => v === null).map(([m]) => m)
  };
}

/** Audits a scope straight from disk. Throws when the snapshot is missing (callers map the error). */
export function auditScope(options: { graphDir: string; scope: string; k?: number; seed?: string }): AuditReport {
  const snapshot = readSnapshot(resolveScopeSnapshotPath(options.graphDir, options.scope));
  const source = rawTextSource(options.graphDir, options.scope);
  const report = auditSnapshot({
    scope: options.scope,
    snapshot,
    textOf: source.textOf,
    k: options.k,
    seed: options.seed
  });
  // The report is built after sampling has pulled every needed capture, so `missing()` is complete.
  return { ...report, modulesWithoutCapture: source.missing().sort() };
}
