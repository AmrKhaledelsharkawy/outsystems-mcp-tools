/**
 * Extractor contract (OSG-006 + ADR-0006 + ADR-0008). Input is already-unwrapped Model-API C# text
 * as returned by the servicestudio MCP read tools; output is a per-module node/edge/skip list that
 * `src/graph` turns into a Graphify snapshot.
 */

/** Canonical element kinds used in node ids (ADR-0006 table). */
export type ElementKind =
  | "Entity"
  | "Structure"
  | "ServerAction"
  | "ClientAction"
  | "Screen"
  | "Block"
  | "Role";

export type Relation = "references" | "calls" | "embeds" | "requires_role";

export type Confidence = "EXTRACTED" | "AMBIGUOUS";

export type SkipReason =
  | "NO_ANCHOR"
  | "PARSE_ERROR"
  | "DUPLICATE_NAME_UNRESOLVABLE"
  | "TOOL_ERROR";

export interface NamedText {
  name: string;
  text: string;
}

export interface FlowNamedText extends NamedText {
  /** UI flow from the names listing (`getScreenNames` / `getWebBlockNames`), mandatory per ADR-0008. */
  uiFlow: string;
}

export interface ModuleTexts {
  dataModel: string;
  structures: string;
  screens: FlowNamedText[];
  blocks: FlowNamedText[];
  clientActions: NamedText[];
  serverActions: NamedText[];
}

export interface ModuleInput {
  module: string;
  moduleType: "Reactive" | "Mobile" | "Traditional" | string;
  texts: ModuleTexts;
}

export interface ExtractedNode {
  id: string;
  label: string;
  kind: ElementKind;
  /** Producer module. Undefined only for opaque `osgraph://external/<key>` nodes. */
  module?: string;
  uiFlow?: string;
  external?: true;
  globalKey?: string;
}

export interface ExtractedEdge {
  source: string;
  target: string;
  relation: Relation;
  confidence: Confidence;
  confidenceScore: 1.0 | 0.5;
  /** Id of the element whose text produced the edge. */
  sourceElement: string;
}

export interface SkippedElement {
  kind: ElementKind | string;
  name: string;
  reason: SkipReason;
}

export interface ExtractedModule {
  module: string;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  skipped: SkippedElement[];
}
