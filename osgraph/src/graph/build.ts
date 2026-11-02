/**
 * Scope merge + snapshot construction (ADR-0005, ADR-0006, ADR-0008). Pure and deterministic:
 * identical `modules` input → identical `Snapshot`; `now` only feeds `meta.rebuiltAt`.
 */
import { ID_PREFIX, isOpaqueExternalId, moduleId, parseId } from "../extract/ids.js";
import { isFlowQualified } from "../extract/kinds.js";
import type { ExtractedEdge, ExtractedModule, ExtractedNode } from "../extract/types.js";
import {
  GRAPHIFY_VERSION,
  SCHEMA_VERSION,
  UNKNOWN_LAYER,
  type Snapshot,
  type SnapshotLink,
  type SnapshotMeta,
  type SnapshotNode,
  type SnapshotSkipped
} from "./types.js";

export interface BuildSnapshotOptions {
  scopeName: string;
  modules: ExtractedModule[];
  /** OSG-003 layer for a module name, or `UNKNOWN`. */
  layerAssign: (module: string) => string;
  now: Date;
}

export interface BuildResult {
  snapshot: Snapshot;
  meta: SnapshotMeta;
  /** Mirrors `snapshot.graph.osgraph.placeholderCount` (ADR-0009). */
  placeholderCount: number;
  /** Mirrors `snapshot.graph.osgraph.droppedEdgeCount` (ADR-0009). */
  droppedEdgeCount: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sourceFile(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

function toSnapshotNode(node: ExtractedNode): SnapshotNode {
  const out: SnapshotNode = {
    id: node.id,
    label: node.label,
    file_type: "code",
    source_file: sourceFile(node.id),
    kind: node.kind
  };
  if (node.module !== undefined) out.module = node.module;
  if (node.uiFlow !== undefined) out.uiFlow = node.uiFlow;
  if (node.external) out.external = true;
  if (node.globalKey !== undefined) out.globalKey = node.globalKey;
  return out;
}

export function buildSnapshot(options: BuildSnapshotOptions): BuildResult {
  const { scopeName, modules, layerAssign, now } = options;
  const scopeModules = modules.map((m) => m.module);
  const inScope = new Set(scopeModules);

  // 1. Real nodes win over externals with the same id (ADR-0006 id identity).
  const realNodes = new Map<string, ExtractedNode>();
  const externalNodes = new Map<string, ExtractedNode>();
  for (const m of modules) {
    for (const node of m.nodes) {
      if (node.external) {
        const existing = externalNodes.get(node.id);
        if (!existing || (existing.globalKey === undefined && node.globalKey !== undefined)) {
          externalNodes.set(node.id, node);
        }
      } else if (!realNodes.has(node.id)) {
        realNodes.set(node.id, node);
      }
    }
  }

  // Name index of in-scope flow-qualified nodes, for flow-less external Screen/Block refs (ADR-0008).
  const byModuleKindName = new Map<string, string[]>();
  for (const node of realNodes.values()) {
    if (!isFlowQualified(node.kind) || node.module === undefined) continue;
    const key = `${node.module}\u0000${node.kind}\u0000${node.label}`;
    byModuleKindName.set(key, [...(byModuleKindName.get(key) ?? []), node.id]);
  }
  /**
   * In-scope cross-module refs (ADR-0008, amended by final-audit MAJOR-1). Studio's dependency
   * comment carries the CONSUMER's local name for an imported UI flow (`MainFlow3`, `Content2`), not
   * the producer's, so for an in-scope module the flow segment cannot be trusted: a Screen/Block ref
   * that is not a real node id resolves by (module, kind, name) — unique match → that node, more than
   * one → `DUPLICATE_NAME_UNRESOLVABLE`. Anything else in an in-scope module that matches no real node
   * (a historical or renamed element) is reported as `unmatched`, which becomes a counted placeholder
   * rather than a silent `external` node.
   */
  const byName = (module: string, kind: string, name: string): string[] =>
    isFlowQualified(kind as never)
      ? byModuleKindName.get(`${module}\u0000${kind}\u0000${name}`) ?? []
      : realNodes.has(`${ID_PREFIX}${module}/${kind}/${name}`)
        ? [`${ID_PREFIX}${module}/${kind}/${name}`]
        : [];
  /**
   * `alias: true` = resolved through Studio's consumer-side clash rename (ADR-0008 Amendment 3): a consumer that
   * imports two elements with the same name keeps one as `Name2`, `Name3`…, and the dependency comment carries that
   * LOCAL name (`OutSystemsUI/Size2` for `OutSystemsUI.Size`). Used only when the exact name matches nothing and the
   * name without its trailing number matches exactly one element of the same kind in the same module.
   */
  const resolveInScope = (
    id: string
  ): { id: string; alias?: true } | { duplicate: true } | { unmatched: true } | undefined => {
    if (realNodes.has(id)) return undefined;
    const parsed = parseId(id);
    if (!parsed || parsed.kind === "module" || parsed.name === undefined) return undefined;
    if (!inScope.has(parsed.module) || parsed.kind === "Role") return undefined;
    if (isFlowQualified(parsed.kind)) {
      const matches = byName(parsed.module, parsed.kind, parsed.name);
      if (matches.length === 1) return { id: matches[0] };
      if (matches.length > 1) return { duplicate: true };
    }
    const renamed = /^(.*\D)\d+$/.exec(parsed.name);
    if (renamed) {
      const matches = byName(parsed.module, parsed.kind, renamed[1]);
      if (matches.length === 1) return { id: matches[0], alias: true };
    }
    return { unmatched: true };
  };

  // 2. Edges: resolve flow-less in-scope targets, drop duplicates, dedupe.
  const skipped: SnapshotSkipped[] = [];
  for (const m of modules) for (const s of m.skipped) skipped.push({ module: m.module, ...s });
  // ADR-0009: a skipped in-scope element is never stubbed; edges pointing at it are dropped.
  const skippedKeys = new Set(skipped.map((s) => `${s.module}\u0000${s.kind}\u0000${s.name}`));
  const isSkippedTarget = (id: string): boolean => {
    const parsed = parseId(id);
    if (!parsed || parsed.kind === "module" || parsed.name === undefined || !inScope.has(parsed.module)) return false;
    return skippedKeys.has(`${parsed.module}\u0000${parsed.kind}\u0000${parsed.name}`);
  };
  const droppedEdges = new Set<string>();

  const edges = new Map<string, ExtractedEdge>();
  const moduleEdges = new Set<string>();
  const addModuleEdge = (from: string, to: string): void => {
    if (from !== to) moduleEdges.add(`${from}\u0000${to}`);
  };
  for (const m of modules) {
    for (const edge of m.edges) {
      let target = edge.target;
      const resolved = resolveInScope(target);
      if (resolved && "duplicate" in resolved) {
        const parsed = parseId(target);
        if (parsed && parsed.kind !== "module" && parsed.name !== undefined) {
          skipped.push({ module: m.module, kind: parsed.kind, name: parsed.name, reason: "DUPLICATE_NAME_UNRESOLVABLE" });
        }
        droppedEdges.add(`${edge.source}\u0000${target}\u0000${edge.relation}`);
        continue;
      }
      let resolvedEdge = edge;
      if (resolved && "id" in resolved) {
        target = resolved.id;
        // A rename-alias match is inferred from Studio's naming, not read: say so in the confidence.
        if (resolved.alias) resolvedEdge = { ...edge, confidence: "AMBIGUOUS", confidenceScore: 0.5 };
      }
      const key = `${edge.source}\u0000${target}\u0000${edge.relation}`;
      if (isSkippedTarget(target)) {
        droppedEdges.add(key);
        continue;
      }
      if (!edges.has(key)) edges.set(key, { ...resolvedEdge, target });
      const targetModule = parseId(target)?.module;
      if (targetModule !== undefined) addModuleEdge(m.module, targetModule);
    }
    // Declared dependencies (`AddDependency`) are module-level references even without element edges.
    for (const node of m.nodes) {
      if (node.external && node.module !== undefined) addModuleEdge(m.module, node.module);
    }
  }

  let placeholderCount = 0;
  // 3. Node set: real nodes, then externals not replaced by a real node (or a unique in-scope match).
  const nodes = new Map<string, SnapshotNode>();
  for (const node of realNodes.values()) nodes.set(node.id, toSnapshotNode(node));
  for (const node of externalNodes.values()) {
    if (nodes.has(node.id)) continue;
    const resolved = resolveInScope(node.id);
    if (resolved && "unmatched" in resolved) {
      // A declared dependency on an element its in-scope module does not have (historical / renamed
      // name): a counted placeholder, never a silent `external` and never silently dropped.
      const { external: _external, globalKey: _globalKey, ...rest } = toSnapshotNode(node);
      void _external;
      void _globalKey;
      nodes.set(node.id, { ...rest, placeholder: true });
      placeholderCount++;
      continue;
    }
    // Resolved / duplicate: the real node (or the recorded skip) stands for it.
    if (resolved) continue;
    nodes.set(node.id, toSnapshotNode(node));
  }

  // 4. Dangling endpoints (ADR-0009): Role and external targets get a plain node; any other in-scope
  //    target that was never read is tagged `placeholder: true` and counted.
  for (const edge of edges.values()) {
    for (const id of [edge.source, edge.target]) {
      if (nodes.has(id)) continue;
      const parsed = parseId(id);
      if (!parsed || parsed.kind === "module" || parsed.name === undefined) {
        const known = externalNodes.get(id);
        const opaque: SnapshotNode = {
          id,
          label: isOpaqueExternalId(id) ? sourceFile(id).slice("external/".length) : id,
          file_type: "code",
          source_file: sourceFile(id),
          kind: known?.kind ?? "unknown",
          external: true
        };
        if (known?.globalKey !== undefined) opaque.globalKey = known.globalKey;
        nodes.set(id, opaque);
        continue;
      }
      const node: SnapshotNode = {
        id,
        label: parsed.name,
        file_type: "code",
        source_file: sourceFile(id),
        kind: parsed.kind,
        module: parsed.module
      };
      if (parsed.uiFlow !== undefined) node.uiFlow = parsed.uiFlow;
      if (!inScope.has(parsed.module)) node.external = true;
      else if (parsed.kind !== "Role") {
        node.placeholder = true;
        placeholderCount++;
      }
      nodes.set(id, node);
    }
  }

  // 5. Module nodes for every scope module and every module any node belongs to.
  const allModules = new Set<string>(scopeModules);
  for (const node of nodes.values()) if (node.module !== undefined) allModules.add(node.module);
  const layers = new Map<string, string>();
  for (const module of allModules) {
    const layer = layerAssign(module) || UNKNOWN_LAYER;
    layers.set(module, layer);
    nodes.set(moduleId(module), {
      id: moduleId(module),
      label: module,
      file_type: "code",
      source_file: module,
      kind: "module",
      module,
      layer
    });
  }

  const links: SnapshotLink[] = [...edges.values()].map((e) => ({
    source: e.source,
    target: e.target,
    relation: e.relation,
    confidence: e.confidence,
    confidence_score: e.confidenceScore,
    source_file: sourceFile(e.sourceElement)
  }));
  for (const key of moduleEdges) {
    const [from, to] = key.split("\u0000");
    links.push({
      source: moduleId(from),
      target: moduleId(to),
      relation: "references",
      confidence: "EXTRACTED",
      confidence_score: 1.0,
      source_file: from
    });
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => compare(a.id, b.id));
  const sortedLinks = links.sort(
    (a, b) => compare(a.source, b.source) || compare(a.target, b.target) || compare(a.relation, b.relation)
  );

  const unresolvedTargets = new Set<string>();
  for (const l of sortedLinks) if (isOpaqueExternalId(l.target)) unresolvedTargets.add(l.target);

  const perModule = scopeModules.map((module) => ({
    module,
    layer: layers.get(module) ?? UNKNOWN_LAYER,
    nodeCount: sortedNodes.filter((n) => n.module === module && n.kind !== "module" && !n.external && !n.placeholder)
      .length,
    edgeCount: sortedLinks.filter((l) => parseId(l.source)?.module === module && parseId(l.source)?.kind !== "module")
      .length,
    skippedCount: skipped.filter((s) => s.module === module).length
  }));

  const sortedSkipped = skipped
    .filter(
      (s, i, all) =>
        all.findIndex((o) => o.module === s.module && o.kind === s.kind && o.name === s.name && o.reason === s.reason) ===
        i
    )
    .sort(
      (a, b) => compare(a.module, b.module) || compare(a.kind, b.kind) || compare(a.name, b.name) || compare(a.reason, b.reason)
    );

  const snapshot: Snapshot = {
    directed: true,
    multigraph: false,
    graph: {
      schema_version: SCHEMA_VERSION,
      graphify_version: GRAPHIFY_VERSION,
      osgraph: {
        scope: scopeName,
        modules: scopeModules,
        skipped: sortedSkipped,
        perModule,
        // distinct opaque `osgraph://external/<key>` targets (ADR-0009)
        unresolvedExternalCount: unresolvedTargets.size,
        // distinct module nodes (scope + referenced) whose layer is UNKNOWN (ADR-0009)
        unknownModuleCount: [...layers.values()].filter((l) => l === UNKNOWN_LAYER).length,
        placeholderCount,
        droppedEdgeCount: droppedEdges.size
      }
    },
    nodes: sortedNodes,
    links: sortedLinks
  };

  return {
    snapshot,
    meta: { rebuiltAt: now.toISOString(), scope: scopeName, skippedCount: sortedSkipped.length },
    placeholderCount,
    droppedEdgeCount: droppedEdges.size
  };
}
