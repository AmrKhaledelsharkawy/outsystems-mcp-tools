/**
 * Report for the accuracy audit (#67): precision and recall with counts, every disagreement, and
 * the module-pair worksheet the human Studio step compares against Studio's dependency list.
 *
 * Definitions (sample estimates, not population figures):
 *  - precision = confirmed edges / (confirmed edges + false edges);
 *  - recall    = confirmed edges / (confirmed edges + missing edges), where a missing edge is an absent
 *    pair whose consumer text does reference the producer. K edges and K absent pairs are drawn
 *    per stratum, so recall is a ratio inside the sample: it shows that edges are being missed and
 *    where, not how many the whole graph lacks.
 * Unverifiable pairs (no captured text) are listed and excluded from both ratios.
 */
import type { CheckedStratum } from "./check.js";
import type {
  AuditReport,
  AuditSample,
  Disagreement,
  StratumReport,
  StudioWorksheetRow,
  Tally,
  UnverifiableItem
} from "./types.js";

function tally(results: Array<{ verdict: "confirmed" | "disagreement" | "unverifiable" }>): Tally {
  const t: Tally = { sampled: results.length, confirmed: 0, disagreements: 0, unverifiable: 0 };
  for (const r of results) {
    if (r.verdict === "confirmed") t.confirmed++;
    else if (r.verdict === "disagreement") t.disagreements++;
    else t.unverifiable++;
  }
  return t;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function add(a: Tally, b: Tally): Tally {
  return {
    sampled: a.sampled + b.sampled,
    confirmed: a.confirmed + b.confirmed,
    disagreements: a.disagreements + b.disagreements,
    unverifiable: a.unverifiable + b.unverifiable
  };
}

export interface BuildReportInput {
  scope: string;
  sample: AuditSample;
  checked: CheckedStratum[];
  modulesWithoutCapture?: string[];
}

export function buildReport(input: BuildReportInput): AuditReport {
  const { sample, checked } = input;
  const strata: StratumReport[] = [];
  const disagreements: Disagreement[] = [];
  const unverifiable: UnverifiableItem[] = [];
  const worksheet = new Map<string, StudioWorksheetRow>();
  let edges: Tally = { sampled: 0, confirmed: 0, disagreements: 0, unverifiable: 0 };
  let absent: Tally = { ...edges };

  for (const s of checked) {
    const e = tally(s.edges);
    const a = tally(s.absent);
    edges = add(edges, e);
    absent = add(absent, a);
    // Absent pairs whose text references the producer are the missing edges; edges the text does not
    // reference are the false ones.
    strata.push({
      layer: s.layer,
      kind: s.kind,
      edgePopulation: s.edgePopulation,
      edges: e,
      absent: a,
      precision: ratio(e.confirmed, e.confirmed + e.disagreements),
      recall: ratio(e.confirmed, e.confirmed + a.disagreements)
    });
    for (const r of s.edges) {
      record(r.pair.consumerModule, r.pair.producerModule, r.pair.layer, "listed", worksheet);
      if (r.verdict === "disagreement") disagreements.push(toDisagreement(r.type, s, r.pair, r.reason));
      if (r.verdict === "unverifiable") unverifiable.push(toUnverifiable("edge", s, r.pair, r.reason));
    }
    for (const r of s.absent) {
      record(r.pair.consumerModule, r.pair.producerModule, r.pair.layer, "not listed", worksheet);
      if (r.verdict === "disagreement") disagreements.push(toDisagreement(r.type, s, r.pair, r.reason));
      if (r.verdict === "unverifiable") unverifiable.push(toUnverifiable("absent", s, r.pair, r.reason));
    }
  }

  return {
    scope: input.scope,
    seed: sample.seed,
    k: sample.k,
    strata,
    totals: {
      edges,
      absent,
      precision: ratio(edges.confirmed, edges.confirmed + edges.disagreements),
      recall: ratio(edges.confirmed, edges.confirmed + absent.disagreements)
    },
    disagreements,
    unverifiable,
    opaqueEdgesExcluded: sample.opaqueEdgesExcluded,
    modulesWithoutCapture: [...(input.modulesWithoutCapture ?? [])].sort(),
    studioWorksheet: [...worksheet.values()].sort(
      (x, y) =>
        x.layer.localeCompare(y.layer) ||
        x.consumerModule.localeCompare(y.consumerModule) ||
        x.producerModule.localeCompare(y.producerModule)
    )
  };
}

function toDisagreement(
  type: Disagreement["type"] | undefined,
  s: CheckedStratum,
  pair: { consumer: string; producer: string },
  reason: string | undefined
): Disagreement {
  return {
    type: type ?? "edge-not-in-text",
    layer: s.layer,
    kind: s.kind,
    consumer: pair.consumer,
    producer: pair.producer,
    reason: reason ?? ""
  };
}

function toUnverifiable(
  side: UnverifiableItem["side"],
  s: CheckedStratum,
  pair: { consumer: string; producer: string },
  reason: string | undefined
): UnverifiableItem {
  return { side, layer: s.layer, kind: s.kind, consumer: pair.consumer, producer: pair.producer, reason: reason ?? "" };
}

/** A module pair that has a sampled edge is `listed`; one reached only by absent pairs is `not listed`. */
function record(
  consumerModule: string,
  producerModule: string,
  layer: string,
  graphSays: StudioWorksheetRow["graphSays"],
  rows: Map<string, StudioWorksheetRow>
): void {
  if (consumerModule === producerModule) return;
  const key = `${consumerModule}\u0000${producerModule}`;
  const existing = rows.get(key);
  if (existing === undefined) rows.set(key, { consumerModule, producerModule, layer, graphSays });
  else if (graphSays === "listed") existing.graphSays = "listed";
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** Plain-text/Markdown rendering for the CLI. */
export function formatReport(report: AuditReport): string {
  const out: string[] = [];
  out.push(`# Accuracy audit - scope '${report.scope}' (seed ${report.seed}, K ${report.k})`, "");
  out.push(
    `precision ${pct(report.totals.precision)}  (${report.totals.edges.confirmed} confirmed of ` +
      `${report.totals.edges.confirmed + report.totals.edges.disagreements} checked edges)`
  );
  out.push(
    `recall    ${pct(report.totals.recall)}  (${report.totals.edges.confirmed} confirmed edges, ` +
      `${report.totals.absent.disagreements} missing edge(s) among ${report.totals.absent.sampled} absent pairs)`
  );
  out.push(
    `unverifiable: ${report.totals.edges.unverifiable} edge(s), ${report.totals.absent.unverifiable} absent pair(s); ` +
      `${report.opaqueEdgesExcluded} opaque-external edge(s) never sampled`,
    ""
  );
  out.push("| layer | kind | edges (population) | edges ok / false / unverifiable | absent ok / missing / unverifiable | precision | recall |");
  out.push("|---|---|---|---|---|---|---|");
  for (const s of report.strata) {
    out.push(
      `| ${s.layer} | ${s.kind} | ${s.edges.sampled} (${s.edgePopulation}) | ${s.edges.confirmed} / ${s.edges.disagreements} / ${s.edges.unverifiable} | ` +
        `${s.absent.confirmed} / ${s.absent.disagreements} / ${s.absent.unverifiable} | ${pct(s.precision)} | ${pct(s.recall)} |`
    );
  }
  out.push("", `## Disagreements (${report.disagreements.length})`);
  if (report.disagreements.length === 0) out.push("none");
  for (const d of report.disagreements) out.push(`- [${d.type}] ${d.layer}/${d.kind}: ${d.consumer} -> ${d.producer}: ${d.reason}`);
  out.push("", `## Unverifiable (${report.unverifiable.length})`);
  if (report.unverifiable.length === 0) out.push("none");
  for (const u of report.unverifiable) out.push(`- [${u.side}] ${u.layer}/${u.kind}: ${u.consumer} -> ${u.producer}: ${u.reason}`);
  if (report.modulesWithoutCapture.length > 0) {
    out.push("", `Modules without a raw capture: ${report.modulesWithoutCapture.join(", ")}`);
  }
  out.push("", `## Studio worksheet (${report.studioWorksheet.length} module pair(s))`);
  out.push("| layer | consumer module | producer module | graph says | Studio says |");
  out.push("|---|---|---|---|---|");
  for (const w of report.studioWorksheet) {
    out.push(`| ${w.layer} | ${w.consumerModule} | ${w.producerModule} | ${w.graphSays} | |`);
  }
  return `${out.join("\n")}\n`;
}
