import { z } from "zod";
import type { Snapshot, SnapshotLink, SnapshotNode } from "../graph/types.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { DEFAULT_SUGGESTION_LIMIT, didYouMean, suggestNames } from "../suggest.js";
import { loadSnapshot, parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool } from "./tool.js";

/** Default / ceiling for `queryImpact`'s `limit` (#70). */
export const DEFAULT_IMPACT_LIMIT = 500;
export const MAX_IMPACT_LIMIT = 50000;

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope whose snapshot to query."),
  nodeId: z.string().min(1).describe("Node id (osgraph://<Module>/<Kind>/[<UIFlow>/]<Name>, or osgraph://<Module>) to start from."),
  direction: z
    .enum(["dependents", "dependencies"])
    .describe("dependents = what references this node (follow edges target→source); dependencies = what this node references (source→target)."),
  maxDepth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap traversal depth; unbounded when omitted."),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_IMPACT_LIMIT)
    .optional()
    .describe(
      `Maximum nodes to return; default ${DEFAULT_IMPACT_LIMIT}. The nearest nodes (by depth) are kept; \`total\` reports the true count and \`truncated\` says whether any were dropped.`
    )
});

/** F2: the SDK gets the permissive shape; `strictSchema` runs inside the handler. */
const inputSchema = permissiveShape(strictSchema);

export type ImpactDirection = "dependents" | "dependencies";

export interface ImpactNode {
  id: string;
  label: string;
  kind: string;
  module?: string;
  layer?: string;
  depth: number;
  external?: true;
}

export interface ImpactEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
}

export interface QueryImpactResult {
  root: string;
  direction: ImpactDirection;
  maxDepth: number | null;
  /** Reachable nodes (root excluded), sorted by (depth, id); at most `limit`, nearest first. */
  nodes: ImpactNode[];
  /** Traversed edges whose both ends are the root or a returned node, sorted by (source, target, relation). */
  edges: ImpactEdge[];
  /** Total reachable nodes before `limit` (unchanged meaning from before #70). */
  count: number;
  /** Same as `count`; the name shared with the other limited query tools. */
  total: number;
  /** Total traversed edges before `limit`. */
  totalEdges: number;
  limit: number;
  truncated: boolean;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure BFS over `snapshot.links`. Throws `UNKNOWN_NODE` when `nodeId` is not a node of the snapshot. */
export function computeImpact(
  snapshot: Pick<Snapshot, "nodes" | "links">,
  nodeId: string,
  direction: ImpactDirection,
  maxDepth?: number,
  limit: number = DEFAULT_IMPACT_LIMIT
): QueryImpactResult {
  const byId = new Map<string, SnapshotNode>();
  for (const n of snapshot.nodes) byId.set(n.id, n);
  if (!byId.has(nodeId)) {
    const suggestions = suggestNames(nodeId, byId.keys(), DEFAULT_SUGGESTION_LIMIT);
    throw new OsgraphToolError("UNKNOWN_NODE", `node '${nodeId}' is not in the snapshot.${didYouMean(suggestions)}`, {
      nodeId,
      suggestions
    });
  }

  // dependents: who points at X → index links by target; dependencies: what X points at → by source.
  const adjacency = new Map<string, SnapshotLink[]>();
  for (const link of snapshot.links) {
    const key = direction === "dependents" ? link.target : link.source;
    const list = adjacency.get(key);
    if (list) list.push(link);
    else adjacency.set(key, [link]);
  }

  const depthOf = new Map<string, number>([[nodeId, 0]]);
  const traversed = new Map<string, SnapshotLink>();
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depthOf.get(current)!;
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    for (const link of adjacency.get(current) ?? []) {
      const next = direction === "dependents" ? link.source : link.target;
      traversed.set(`${link.source}\u0000${link.target}\u0000${link.relation}`, link);
      if (!depthOf.has(next)) {
        depthOf.set(next, depth + 1);
        queue.push(next);
      }
    }
  }

  const nodes: ImpactNode[] = [];
  for (const [id, depth] of depthOf) {
    if (id === nodeId) continue;
    const n = byId.get(id);
    const out: ImpactNode = {
      id,
      label: n?.label ?? id,
      kind: n?.kind ?? "unknown",
      depth
    };
    if (n?.module !== undefined) out.module = n.module;
    if (n?.layer !== undefined) out.layer = n.layer;
    if (n?.external) out.external = true;
    nodes.push(out);
  }
  nodes.sort((a, b) => a.depth - b.depth || compare(a.id, b.id));

  const keptNodes = nodes.slice(0, limit);
  const keep = new Set<string>([nodeId, ...keptNodes.map((n) => n.id)]);
  const allEdges: ImpactEdge[] = [...traversed.values()]
    .map((l) => ({ source: l.source, target: l.target, relation: l.relation, confidence: l.confidence }))
    .sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target) || compare(a.relation, b.relation));

  const edges = allEdges.filter((e) => keep.has(e.source) && keep.has(e.target));

  return {
    root: nodeId,
    direction,
    maxDepth: maxDepth ?? null,
    nodes: keptNodes,
    edges,
    count: nodes.length,
    total: nodes.length,
    totalEdges: allEdges.length,
    limit,
    truncated: nodes.length > keptNodes.length
  };
}

export const queryImpact: OsgraphTool<typeof inputSchema> = {
  name: "queryImpact",
  description:
    "Reachable node set from one node by in-process BFS over the scope's snapshot " +
    "(dependents or dependencies, optionally depth-capped). Returns at most `limit` nodes (default 500, nearest first) with " +
    "`total` (true count) and `truncated`. An unknown node id answers UNKNOWN_NODE with ranked `suggestions` (case-insensitive, " +
    "edit distance); the exact id is still required for success. Errors: INPUT_INVALID, SCOPE_NOT_FOUND, SNAPSHOT_MISSING, UNKNOWN_NODE.",
  inputSchema,
  handler: (args, ctx) => {
    const scope = scopeArg(args.scope);
    return runTool<QueryImpactResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "queryImpact");
      const { snapshot } = loadSnapshot(ctx, input.scope);
      return { result: computeImpact(snapshot, input.nodeId, input.direction, input.maxDepth, input.limit) };
    });
  }
};
