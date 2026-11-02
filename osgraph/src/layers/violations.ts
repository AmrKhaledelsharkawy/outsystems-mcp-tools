/**
 * OSG-003 / OSG-012: evaluate every cross-module edge of a snapshot against the layer allow-list.
 *
 * `SnapshotLike` is a minimal structural view of the NetworkX node-link `graph.json` (OSG-001/009):
 * S6 passes the real snapshot type, which is a superset of this.
 */
import { assignLayer, isAllowed } from "./assign.js";
import type { LayerRules } from "./rules.js";

export interface SnapshotNodeLike {
  id: string;
  module?: string;
  layer?: string;
}

export interface SnapshotLinkLike {
  source: string;
  target: string;
  relation: string;
}

export interface SnapshotLike {
  nodes: SnapshotNodeLike[];
  links: SnapshotLinkLike[];
}

export interface LayerViolation {
  /** Source node id (element-level or module-level `osgraph://<Module>`). */
  source: string;
  /** Target node id. */
  target: string;
  sourceLayer: string;
  targetLayer: string;
  relation: string;
  sourceModule: string;
  targetModule: string;
}

export interface ViolationReport {
  /** Sorted by (source, target, relation); unique per (source, target, relation). */
  violations: LayerViolation[];
  /** Module names tagged UNKNOWN that took part in at least one cross-module edge; sorted, unique. */
  unknownModules: string[];
}

const ID_PREFIX = "osgraph://";
const EXTERNAL_SEGMENT = "external";

/**
 * Module owning a node: the `module` attribute when present, else the first id segment
 * (`osgraph://<Module>[/...]`). Returns `undefined` for the OSG-006 opaque fallback
 * `osgraph://external/<key>` and for ids outside the `osgraph://` scheme — such nodes have no
 * module and are never evaluated.
 */
export function moduleOfNode(node: SnapshotNodeLike): string | undefined {
  // The id is the contract (ADR-0006): when the id names a module it wins over a
  // conflicting `module` attribute, so a writer defect cannot hide a violation.
  if (node.id.startsWith(ID_PREFIX)) {
    const rest = node.id.slice(ID_PREFIX.length);
    const segment = rest.split("/", 1)[0] ?? "";
    if (segment.length > 0 && segment !== EXTERNAL_SEGMENT) return segment;
    if (segment === EXTERNAL_SEGMENT) return undefined;
  }
  if (node.module !== undefined && node.module.length > 0) return node.module;
  return undefined;
}

function compareViolations(a: LayerViolation, b: LayerViolation): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;
  return 0;
}

/**
 * Evaluates every edge whose endpoints belong to different modules (element-level and
 * module-level edges alike). Same-layer pairs are always allowed; an UNKNOWN layer on either side
 * exempts the edge and records the UNKNOWN module name(s). Layers are derived from the module name
 * via `rules` (not read from `node.layer`) so the report is consistent with the ruleset in force.
 * Edges whose endpoint node is absent from `nodes` are evaluated from the id alone (fail-closed);
 * edges whose module cannot be determined (opaque `osgraph://external/<key>`) are skipped.
 */
export function listViolations(snapshot: SnapshotLike, rules: LayerRules): ViolationReport {
  const nodesById = new Map<string, SnapshotNodeLike>();
  for (const node of snapshot.nodes) nodesById.set(node.id, node);

  const layerByModule = new Map<string, string>();
  const layerOf = (module: string): string => {
    let layer = layerByModule.get(module);
    if (layer === undefined) {
      layer = assignLayer(module, rules);
      layerByModule.set(module, layer);
    }
    return layer;
  };

  const seen = new Set<string>();
  const violations: LayerViolation[] = [];
  const unknown = new Set<string>();

  for (const link of snapshot.links) {
    // Fail-closed (OSG-003): an endpoint missing from `nodes` is still evaluated from its id.
    const sourceNode = nodesById.get(link.source) ?? { id: link.source };
    const targetNode = nodesById.get(link.target) ?? { id: link.target };

    const sourceModule = moduleOfNode(sourceNode);
    const targetModule = moduleOfNode(targetNode);
    if (sourceModule === undefined || targetModule === undefined) continue;
    if (sourceModule === targetModule) continue;

    const sourceLayer = layerOf(sourceModule);
    const targetLayer = layerOf(targetModule);
    const verdict = isAllowed(sourceLayer, targetLayer, rules);

    if (verdict === "exempt") {
      if (sourceLayer === rules.unknownLayerTag) unknown.add(sourceModule);
      if (targetLayer === rules.unknownLayerTag) unknown.add(targetModule);
      continue;
    }
    if (verdict) continue;

    const key = `${link.source}\u0000${link.target}\u0000${link.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({
      source: link.source,
      target: link.target,
      sourceLayer,
      targetLayer,
      relation: link.relation,
      sourceModule,
      targetModule
    });
  }

  violations.sort(compareViolations);
  return { violations, unknownModules: [...unknown].sort() };
}
