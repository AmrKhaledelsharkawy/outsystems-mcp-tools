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
  | "Role"
  /** #90: a method of an exposed REST API (`_API` modules). Id: `<Module>/RestMethod/<Api>/<Method>`. */
  | "RestMethod"
  /** #90: a method of a consumed REST API (`_IS` modules). Id: `<Module>/ConsumedRestMethod/<Api>/<Method>`. */
  | "ConsumedRestMethod";

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

/** One REST method of one (exposed or consumed) REST API; `name` is `<Api>/<Method>`. */
export interface RestMethodNamedText extends NamedText {
  consumed: boolean;
}

export interface ModuleTexts {
  dataModel: string;
  structures: string;
  screens: FlowNamedText[];
  blocks: FlowNamedText[];
  clientActions: NamedText[];
  serverActions: NamedText[];
  /** #90: only present for `_API` / `_IS` modules (read-cost rule, ADR-0016). */
  restMethods?: RestMethodNamedText[];
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
