/**
 * Types for the live accuracy audit (#67). The audit samples element-level edges and absent pairs
 * from a snapshot, checks each against the consumer element's persisted raw text, and reports
 * precision and recall. It is offline: no Service Studio, no osopener, no session token.
 */
import type { ElementKind } from "../extract/types.js";

/** One (consumer element, producer element) pair. */
export interface AuditPair {
  consumer: string;
  producer: string;
  consumerModule: string;
  producerModule: string;
  consumerKind: ElementKind;
  /** Kind of the producer element; with `layer` it names the stratum. */
  kind: ElementKind;
  /** Layer of the consumer module (`UNKNOWN` when the layer rules do not match it). */
  layer: string;
}

/** Where an absent pair was drawn from: `near` = a module the consumer's module already uses. */
export type AbsentPool = "near" | "uniform";

export interface AbsentPair extends AuditPair {
  pool: AbsentPool;
}

export interface StratumSample {
  layer: string;
  kind: ElementKind;
  /** Candidate edges in the snapshot for this stratum, before drawing. */
  edgePopulation: number;
  edges: AuditPair[];
  absent: AbsentPair[];
}

export interface AuditSample {
  seed: string;
  k: number;
  strata: StratumSample[];
  /** Edges whose target is an opaque external key: nothing to compare against, never sampled. */
  opaqueEdgesExcluded: number;
}

export type Verdict = "confirmed" | "disagreement" | "unverifiable";

export type DisagreementType = "edge-not-in-text" | "absent-in-text";

export interface EdgeResult {
  pair: AuditPair;
  verdict: Verdict;
  /** Present for `disagreement` and `unverifiable`. */
  reason?: string;
  type?: DisagreementType;
}

export interface AbsentResult {
  pair: AbsentPair;
  verdict: Verdict;
  reason?: string;
  type?: DisagreementType;
}

export interface Tally {
  sampled: number;
  confirmed: number;
  disagreements: number;
  unverifiable: number;
}

export interface StratumReport {
  layer: string;
  kind: ElementKind;
  edgePopulation: number;
  edges: Tally;
  absent: Tally;
  precision: number | null;
  recall: number | null;
}

export interface Disagreement {
  type: DisagreementType;
  layer: string;
  kind: ElementKind;
  consumer: string;
  producer: string;
  reason: string;
}

export interface UnverifiableItem {
  side: "edge" | "absent";
  layer: string;
  kind: ElementKind;
  consumer: string;
  producer: string;
  reason: string;
}

/** One module pair for the human Studio step: compare it with Studio's module dependency list. */
export interface StudioWorksheetRow {
  consumerModule: string;
  producerModule: string;
  layer: string;
  /** `listed`: the graph has an element edge between the modules; `not listed`: it has only absent pairs. */
  graphSays: "listed" | "not listed";
}

export interface AuditReport {
  scope: string;
  seed: string;
  k: number;
  strata: StratumReport[];
  totals: { edges: Tally; absent: Tally; precision: number | null; recall: number | null };
  disagreements: Disagreement[];
  unverifiable: UnverifiableItem[];
  opaqueEdgesExcluded: number;
  /** Consumer modules with no raw capture: their pairs are unverifiable, never silently dropped. */
  modulesWithoutCapture: string[];
  studioWorksheet: StudioWorksheetRow[];
}
