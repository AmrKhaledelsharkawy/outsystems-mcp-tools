/**
 * Snapshot model: NetworkX node-link JSON as Graphify reads it (OSG-001, verified in OSG-009), plus
 * osgraph's own attributes. `graph.json` is fully deterministic; the only volatile value
 * (`rebuiltAt`) lives in the sibling `meta.json` (see `io.ts`).
 */
import type { Confidence, ElementKind, Relation, SkipReason } from "../extract/types.js";

export const SCHEMA_VERSION = "1.0";
export const GRAPHIFY_VERSION = "0.9.91";
export const UNKNOWN_LAYER = "UNKNOWN";

export interface SnapshotNode {
  id: string;
  label: string;
  file_type: "code";
  /** `<Module>/<Kind>/[<UIFlow>/]<Name>` for elements, `<Module>` for module nodes. */
  source_file: string;
  /** `unknown` only for an opaque external whose cast type could not be normalized. */
  kind: ElementKind | "module" | "unknown";
  module?: string;
  /** Module nodes only (OSG-003 layer or `UNKNOWN`). */
  layer?: string;
  uiFlow?: string;
  external?: true;
  /** ADR-0009: in-scope element named by an edge but never read; excluded from `perModule.nodeCount`. */
  placeholder?: true;
  globalKey?: string;
}

export interface SnapshotLink {
  source: string;
  target: string;
  relation: Relation;
  confidence: Confidence;
  confidence_score: number;
  source_file: string;
}

export interface SnapshotSkipped {
  module: string;
  kind: string;
  name: string;
  reason: SkipReason;
}

export interface SnapshotPerModule {
  module: string;
  layer: string;
  nodeCount: number;
  edgeCount: number;
  skippedCount: number;
}

export interface SnapshotOsgraph {
  scope: string;
  modules: string[];
  skipped: SnapshotSkipped[];
  perModule: SnapshotPerModule[];
  /** Distinct `osgraph://external/<key>` targets (comment absent, AMBIGUOUS) — ADR-0005/0006/0009. */
  unresolvedExternalCount: number;
  /** Distinct module nodes (in scope or referenced) whose layer is `UNKNOWN` — informational, ADR-0009. */
  unknownModuleCount: number;
  /** Nodes tagged `placeholder: true` (ADR-0009). */
  placeholderCount: number;
  /** Edges dropped because their in-scope target is a skipped element (ADR-0009, OSG-011). */
  droppedEdgeCount: number;
}

export interface Snapshot {
  directed: true;
  multigraph: false;
  graph: {
    schema_version: string;
    graphify_version: string;
    osgraph: SnapshotOsgraph;
  };
  nodes: SnapshotNode[];
  links: SnapshotLink[];
}

/** Sibling `meta.json`: the only place the rebuild timestamp is written. */
export interface SnapshotMeta {
  rebuiltAt: string;
  scope: string;
  skippedCount: number;
  /**
   * Present only when the snapshot was finalized from a **staged** rebuild. `rebuiltAt` is the
   * clock at finalize, which on its own would claim a scope staged over days was "rebuilt minutes
   * ago" (S6 re-audit MAJOR-2). These record when the oldest and newest module data behind this
   * snapshot were actually read, so a reader can see the real age of the graph.
   */
  stagedFrom?: string;
  stagedTo?: string;
}
