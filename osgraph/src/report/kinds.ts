/**
 * The read-cost report (#69): what each element kind cost to read across a scope, and what it yielded.
 *
 * Offline: it reads three artifacts a rebuild already wrote (`timings.json` for per-kind call count
 * and latency per module, `graph.json` for edges, `flows.json` for flow actions) and needs no Service
 * Studio and no session token. Its job is the one decision #69 asks for: a kind that costs read time
 * and contributes zero edges and zero flows is a candidate for `OSGRAPH_SKIP_KINDS`.
 *
 * "Contributes an edge" counts both directions, on purpose. An `Entity` text yields few edges of its
 * own, but entities are the target of most data-access edges, and a switched-off kind turns those
 * targets into placeholders (ADR-0009). Counting only the source side would nominate exactly the kind
 * whose absence hurts `queryImpact` most.
 */
import { existsSync } from "node:fs";
import { parseId } from "../extract/ids.js";
import { readFlowsState } from "../flows/io.js";
import { readMeta, readSnapshot } from "../graph/io.js";
import type { Snapshot } from "../graph/types.js";
import { readTimings, timingsPath } from "../progress/timings.js";
import { PRUNABLE_KINDS, READ_KINDS, type ReadKind } from "../rebuild/readKinds.js";
import { OsgraphToolError } from "../servicestudio/types.js";

export interface KindReportRow {
  kind: ReadKind;
  /** Modules with a recorded read of this kind. */
  modulesTimed: number;
  /** Logical read calls, summed over modules. */
  calls: number;
  /** Summed latency of those calls. Parallel calls overlap, so this is cost, not wall-clock. */
  totalReadMs: number;
  /** Worst per-module p95: points at the slowest module, it is not a scope percentile. */
  maxModuleP95Ms: number;
  /** Edges whose source is an element of this kind. */
  edgesAsSource: number;
  /** Edges whose target is a (really read) element of this kind. */
  edgesAsTarget: number;
  /** Flow actions owned by an element of this kind. */
  flowActions: number;
  flowNodes: number;
  /** Zero edges in either direction and zero flows, with flow data available. */
  zeroYield: boolean;
  /** May be switched off (`PRUNABLE_KINDS`). */
  switchable: boolean;
}

export interface KindReport {
  scope: string;
  rows: KindReportRow[];
  /** Zero-yield kinds with read time recorded, costliest first. */
  candidates: KindReportRow[];
  /** `totalReadMs` of the candidates. */
  candidateReadMs: number;
  totalReadMs: number;
  /** Kinds this snapshot was built without (meta.json): their zeros are configuration, not evidence. */
  skippedKinds: string[];
  /** Why the numbers may not mean what they appear to; empty when the inputs are complete. */
  warnings: string[];
}

export interface BuildKindReportOptions {
  graphDir: string;
  scope: string;
  snapshotPath: string;
}

export function buildKindReport(options: BuildKindReportOptions): KindReport {
  const { graphDir, scope, snapshotPath } = options;
  if (!existsSync(snapshotPath)) {
    throw new OsgraphToolError(
      "SNAPSHOT_MISSING",
      `scope '${scope}': no snapshot at ${snapshotPath}, so there is nothing to attribute read time to. ` +
        `Build the scope first (osgraph run / rebuild).`,
      { scope, snapshotPath }
    );
  }
  const snapshot: Snapshot = readSnapshot(snapshotPath);
  const warnings: string[] = [];

  const rows = new Map<ReadKind, KindReportRow>(
    READ_KINDS.map((kind) => [
      kind,
      {
        kind,
        modulesTimed: 0,
        calls: 0,
        totalReadMs: 0,
        maxModuleP95Ms: 0,
        edgesAsSource: 0,
        edgesAsTarget: 0,
        flowActions: 0,
        flowNodes: 0,
        zeroYield: false,
        switchable: (PRUNABLE_KINDS as readonly string[]).includes(kind)
      }
    ])
  );
  const rowFor = (id: string): KindReportRow | undefined => {
    const kind = parseId(id)?.kind;
    return kind === undefined ? undefined : rows.get(kind as ReadKind);
  };

  // Yield: edges. Only nodes that were really read count as targets; a placeholder is not a read.
  const placeholder = new Set(snapshot.nodes.filter((n) => n.placeholder === true).map((n) => n.id));
  for (const link of snapshot.links) {
    const from = rowFor(link.source);
    if (from !== undefined) from.edgesAsSource++;
    const to = rowFor(link.target);
    if (to !== undefined && !placeholder.has(link.target)) to.edgesAsTarget++;
  }

  // Yield: flows.
  const flows = readFlowsState(snapshotPath);
  if (flows.state === "ok") {
    for (const m of flows.artifact.modules) {
      for (const action of m.actions) {
        const row = rowFor(action.owner);
        if (row === undefined) continue;
        row.flowActions++;
        row.flowNodes += action.nodes.length;
      }
    }
  } else {
    warnings.push(
      `flows.json is ${flows.state}: flow yield is unknown, so no kind is reported as zero-yield. ` +
        `Run \`osgraph reextract --scope ${scope}\` first.`
    );
  }

  // Cost: timings.json, restricted to the modules of this scope's snapshot.
  const inScope = new Set(snapshot.graph.osgraph.modules.map((m) => m.toLowerCase()));
  let timedModules = 0;
  for (const [module, cost] of readTimings(graphDir, scope)) {
    if (!inScope.has(module) || cost.kinds === undefined) continue;
    timedModules++;
    for (const kind of READ_KINDS) {
      const k = cost.kinds[kind];
      if (k === undefined) continue;
      const row = rows.get(kind) as KindReportRow;
      row.modulesTimed++;
      row.calls += k.calls;
      row.totalReadMs += k.totalMs;
      row.maxModuleP95Ms = Math.max(row.maxModuleP95Ms, k.p95Ms);
    }
  }
  if (timedModules === 0) {
    warnings.push(
      `${timingsPath(graphDir, scope)} has no per-kind timings for this scope's modules (a build from before ` +
        `#69, or none yet): read cost is unknown. Rebuild the scope to record it.`
    );
  } else if (timedModules < inScope.size) {
    warnings.push(`per-kind timings exist for ${timedModules} of ${inScope.size} scope modules; read cost is a lower bound.`);
  }

  const skippedKinds = readMeta(snapshotPath)?.skippedKinds ?? [];
  const list = [...rows.values()];
  for (const row of list) {
    row.zeroYield =
      flows.state === "ok" &&
      !skippedKinds.includes(row.kind) &&
      row.edgesAsSource === 0 &&
      row.edgesAsTarget === 0 &&
      row.flowActions === 0;
  }
  const candidates = list.filter((r) => r.zeroYield && r.calls > 0).sort((a, b) => b.totalReadMs - a.totalReadMs);
  return {
    scope,
    rows: list,
    candidates,
    candidateReadMs: candidates.reduce((n, r) => n + r.totalReadMs, 0),
    totalReadMs: list.reduce((n, r) => n + r.totalReadMs, 0),
    skippedKinds,
    warnings
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Human-readable table, stable column order so two runs diff cleanly. */
export function formatKindReport(report: KindReport): string {
  const lines = [`scope '${report.scope}': read cost per kind`];
  lines.push(
    `  ${"kind".padEnd(13)}${"calls".padStart(7)}${"read".padStart(10)}${"edges out".padStart(11)}` +
      `${"edges in".padStart(10)}${"flows".padStart(7)}  note`
  );
  for (const r of report.rows) {
    const note = [
      r.zeroYield ? "ZERO YIELD" : "",
      r.zeroYield && !r.switchable ? "(cannot be switched off)" : "",
      report.skippedKinds.includes(r.kind) ? "switched off in this snapshot" : ""
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  ${r.kind.padEnd(13)}${String(r.calls).padStart(7)}${secs(r.totalReadMs).padStart(10)}` +
        `${String(r.edgesAsSource).padStart(11)}${String(r.edgesAsTarget).padStart(10)}${String(r.flowActions).padStart(7)}  ${note}`
    );
  }
  const switchable = report.candidates.filter((c) => c.switchable).map((c) => c.kind);
  lines.push(
    report.candidates.length === 0
      ? "  no kind combines read time with zero edges and zero flows."
      : `  zero-yield kinds: ${report.candidates.map((c) => c.kind).join(", ")} ` +
          `(${secs(report.candidateReadMs)} of ${secs(report.totalReadMs)} read time); ` +
          `OSGRAPH_SKIP_KINDS can switch off: ${switchable.length > 0 ? switchable.join(", ") : "none of them"}`
  );
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}
