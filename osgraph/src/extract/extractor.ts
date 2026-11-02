/**
 * Generic extractor shared by all six element kinds (OSG-006 §Extractor shape, ADR-0006, ADR-0008).
 *
 * Per text: (1) split at `/*** creating I<Kind> '<Name>' ***\/` anchors; (2) scan top-to-bottom
 * building a local-var → (kind, name, module[, flow]) table — local elements, `AddDependency`
 * externals (named through the preceding `// I<Kind>Signature <Module>/[<Flow>/]<Name>` comment),
 * reference vars (`eSpace.References.Named("M")`), flow vars and `<collection>.Named("X")` lookups;
 * (3) every use of a table element var inside another element's block is an edge whose relation
 * follows the target kind (entity/structure/screen → references, action → calls, block → embeds,
 * role → requires_role). All edges are direct, name-resolved: no heuristics, no INFERRED.
 */
import { collectionKind, isFlowQualified, normalizeKind, relationForTargetKind } from "./kinds.js";
import { buildId, externalOpaqueId, normalizeModuleName } from "./ids.js";
import type {
  ElementKind,
  ExtractedEdge,
  ExtractedModule,
  ExtractedNode,
  FlowNamedText,
  ModuleInput,
  NamedText,
  SkippedElement
} from "./types.js";

const ANCHOR_RE = /\/\*\*\* creating (I\w+) '([^']+)' \*\*\*\//;
const SIGNATURE_COMMENT_RE = /^\/\/\s*(I\w+Signature)\s+(\S+)\s*$/;
const ADD_DEPENDENCY_RE =
  /^var (\w+) = \(([\w.]+)\)\s*eSpace\.AddDependency\(Services\.ModelServices\.ParseGlobalKey\("([^"]+)"\)\);?$/;
const REFERENCE_RE = /^var (\w+) = eSpace\.References\.Named\("([^"]+)"\);?$/;
const FLOW_RE = /^var (\w+) = (\w+)\.(?:MobileFlows|WebFlows|UIFlows|Flows)\.Named\("([^"]+)"\);?$/;
const FLOW_NODE_RE = /^var (\w+) = (\w+)\.Nodes\.OfType<([\w.]+)>\(\)\.Named\("([^"]+)"\);?$/;
const COLLECTION_RE = /^var (\w+) = (\w+)\.(\w+)\.Named\("([^"]+)"\);?$/;
const SYSTEM_ROLE_RE = /^var (\w+) = eSpace\.SystemRoles\.OfType<[\w.]*ISystemRole>\(\)\.Named\("([^"]+)"\);?$/;
const LAMBDA_PARAM_RE = /^\(([\w.]+)\s+(\w+)\)\s*=>/;
const VAR_DECL_RE = /^var (\w+) = /;
const CREATE_RE = /^var (\w+) = \w+\.Create\w+(?:<[^>]*>)?\("([^"]+)"\)/;

type VarEntry =
  | { t: "ref"; module: string }
  | { t: "flow"; module: string; flow: string | undefined }
  | {
      t: "elem";
      kind: ElementKind;
      name: string;
      module: string | undefined;
      uiFlow?: string;
      external: boolean;
      globalKey?: string;
      /** True when only the opaque key is known (ADR-0006 fallback → AMBIGUOUS). */
      opaque: boolean;
    };

interface AnchorBlock {
  rawKind: string;
  kind: ElementKind | undefined;
  name: string;
  /** Line index of the anchor. */
  line: number;
}

interface TextContext {
  module: string;
  /** Name the input claims to be (screens/blocks/actions); undefined for whole-module dumps. */
  expectedName?: string;
  expectedKind?: ElementKind;
  /** Flow from the names listing for the element being extracted (screens/blocks). */
  uiFlow?: string;
  /** Flow-qualified lookup for `.Named("X")` on a flow var whose flow is unknown (ADR-0008). */
  flowsByName: Map<string, string[]>;
}

interface TextResult {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  skipped: SkippedElement[];
  anchors: AnchorBlock[];
  /** Lambda parameter var of the flow (`(IMobileFlow mainflow) =>`), when present. */
  lambdaFlowVar?: string;
  /** Flow segment of the first external dependency comment, for referenced-only inputs. */
  dependencyFlow?: string;
  /** True when at least one `AddDependency` was declared (referenced-only inputs). */
  hasDependencies: boolean;
}

function stripStringsAndComments(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "");
}

function flowsIndex(items: FlowNamedText[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const list = map.get(item.name) ?? [];
    if (!list.includes(item.uiFlow)) list.push(item.uiFlow);
    map.set(item.name, list);
  }
  return map;
}

function entryId(entry: Extract<VarEntry, { t: "elem" }>): string {
  if (entry.opaque) return externalOpaqueId(entry.globalKey ?? "");
  return buildId({ module: entry.module ?? "", kind: entry.kind, name: entry.name, uiFlow: entry.uiFlow });
}

function externalNode(entry: Extract<VarEntry, { t: "elem" }>): ExtractedNode {
  const node: ExtractedNode = {
    id: entryId(entry),
    label: entry.name,
    kind: entry.kind,
    external: true
  };
  if (entry.module !== undefined) node.module = entry.module;
  if (entry.uiFlow !== undefined) node.uiFlow = entry.uiFlow;
  if (entry.globalKey !== undefined) node.globalKey = entry.globalKey;
  return node;
}

/** Extracts one returned text. Pure; the module/kind-level orchestration is in `extractModule`. */
export function extractText(text: string, ctx: TextContext): TextResult {
  const lines = text.split(/\r?\n/);
  const vars = new Map<string, VarEntry>();
  const nodes = new Map<string, ExtractedNode>();
  const edges: ExtractedEdge[] = [];
  const skipped: SkippedElement[] = [];
  const anchors: AnchorBlock[] = [];
  const externals: Extract<VarEntry, { t: "elem" }>[] = [];

  let current: { block: AnchorBlock; id: string; varName?: string } | undefined;
  let pendingSignature: { kind: ElementKind | undefined; path: string } | undefined;
  let lambdaFlowVar: string | undefined;
  let dependencyFlow: string | undefined;

  const resolveModule = (receiver: string): string | undefined => {
    if (receiver === "eSpace") return ctx.module;
    const entry = vars.get(receiver);
    return entry && entry.t === "ref" ? entry.module : undefined;
  };

  const addEdge = (target: Extract<VarEntry, { t: "elem" }>, sourceId: string): void => {
    const targetId = entryId(target);
    if (targetId === sourceId) return;
    const edge: ExtractedEdge = {
      source: sourceId,
      target: targetId,
      relation: relationForTargetKind(target.kind),
      confidence: target.opaque ? "AMBIGUOUS" : "EXTRACTED",
      confidenceScore: target.opaque ? 0.5 : 1.0,
      sourceElement: sourceId
    };
    edges.push(edge);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    const anchor = ANCHOR_RE.exec(line);
    if (anchor) {
      const kind = normalizeKind(anchor[1]);
      const block: AnchorBlock = { rawKind: anchor[1], kind, name: anchor[2], line: i };
      anchors.push(block);
      if (kind === undefined) {
        current = undefined; // not graphed in v1 (ADR-0006): block ignored silently
        continue;
      }
      const uiFlow = isFlowQualified(kind) ? ctx.uiFlow : undefined;
      const id = buildId({ module: ctx.module, kind, name: block.name, uiFlow });
      current = { block, id };
      const node: ExtractedNode = { id, label: block.name, kind, module: ctx.module };
      if (uiFlow !== undefined) node.uiFlow = uiFlow;
      nodes.set(id, node);
      continue;
    }

    const lambda = LAMBDA_PARAM_RE.exec(line);
    if (lambda) {
      if (/Flow/.test(lambda[1])) {
        lambdaFlowVar = lambda[2];
        vars.set(lambda[2], { t: "flow", module: ctx.module, flow: ctx.uiFlow });
      }
      continue;
    }

    const signature = SIGNATURE_COMMENT_RE.exec(line);
    if (signature) {
      pendingSignature = { kind: normalizeKind(signature[1]), path: signature[2] };
      continue;
    }

    const dependency = ADD_DEPENDENCY_RE.exec(line);
    if (dependency) {
      const [, varName, castType, globalKey] = dependency;
      const kind = pendingSignature?.kind ?? normalizeKind(castType);
      const path = pendingSignature?.path;
      pendingSignature = undefined;
      if (kind === undefined) continue; // dependency on a non-graphed kind: dropped silently
      let entry: Extract<VarEntry, { t: "elem" }>;
      if (path !== undefined && path.includes("/")) {
        const segments = path.split("/");
        const module = normalizeModuleName(segments[0]);
        const name = segments[segments.length - 1];
        const uiFlow = segments.length >= 3 && isFlowQualified(kind) ? segments[1] : undefined;
        if (uiFlow !== undefined && dependencyFlow === undefined) dependencyFlow = uiFlow;
        entry = { t: "elem", kind, name, module, uiFlow, external: module !== ctx.module, globalKey, opaque: false };
      } else {
        entry = { t: "elem", kind, name: globalKey, module: undefined, external: true, globalKey, opaque: true };
      }
      vars.set(varName, entry);
      if (entry.external) externals.push(entry);
      if (current) addEdge(entry, current.id);
      continue;
    }
    // `var eSpace = <param>.GetESpace();` sits between the signature comment and its AddDependency.
    if (!/^var eSpace = /.test(line)) pendingSignature = undefined;

    const reference = REFERENCE_RE.exec(line);
    if (reference) {
      vars.set(reference[1], { t: "ref", module: normalizeModuleName(reference[2]) });
      continue;
    }

    const flow = FLOW_RE.exec(line);
    if (flow) {
      const module = resolveModule(flow[2]);
      if (module !== undefined) vars.set(flow[1], { t: "flow", module, flow: flow[3] });
      continue;
    }

    const flowNode = FLOW_NODE_RE.exec(line);
    if (flowNode) {
      const [, varName, flowVar, typeName, name] = flowNode;
      const kind = normalizeKind(typeName);
      const flowEntry = vars.get(flowVar);
      if (kind !== undefined && isFlowQualified(kind) && flowEntry?.t === "flow") {
        let uiFlow = flowEntry.flow;
        if (uiFlow === undefined && flowEntry.module === ctx.module) {
          const candidates = ctx.flowsByName.get(name) ?? [];
          if (candidates.length === 1) uiFlow = candidates[0];
          else {
            skipped.push({ kind, name, reason: "DUPLICATE_NAME_UNRESOLVABLE" });
            continue; // never attached to an arbitrary duplicate (ADR-0008)
          }
        }
        const entry: Extract<VarEntry, { t: "elem" }> = {
          t: "elem",
          kind,
          name,
          module: flowEntry.module,
          uiFlow,
          external: flowEntry.module !== ctx.module,
          opaque: false
        };
        vars.set(varName, entry);
        if (entry.external) externals.push(entry);
        if (current) addEdge(entry, current.id);
      }
      continue;
    }

    const systemRole = SYSTEM_ROLE_RE.exec(line);
    if (systemRole) {
      const entry: Extract<VarEntry, { t: "elem" }> = {
        t: "elem",
        kind: "Role",
        name: systemRole[2],
        module: "System",
        external: true,
        opaque: false
      };
      vars.set(systemRole[1], entry);
      if (current) addEdge(entry, current.id);
      continue;
    }

    const collection = COLLECTION_RE.exec(line);
    if (collection) {
      const [, varName, receiver, collectionName, name] = collection;
      const kind = collectionKind(collectionName);
      const module = resolveModule(receiver);
      if (kind !== undefined && module !== undefined) {
        const entry: Extract<VarEntry, { t: "elem" }> = {
          t: "elem",
          kind,
          name,
          module,
          external: module !== ctx.module,
          opaque: false
        };
        vars.set(varName, entry);
        if (entry.external && kind !== "Role") externals.push(entry);
        if (current) addEdge(entry, current.id);
        continue;
      }
      // other `.Named(...)` lookups (InputParameters, Placeholders, …) fall through to the generic scan
    }

    if (current && current.varName === undefined) {
      const create = CREATE_RE.exec(line);
      if (create && create[2] === current.block.name) {
        current.varName = create[1];
        vars.set(create[1], {
          t: "elem",
          kind: current.block.kind as ElementKind,
          name: current.block.name,
          module: ctx.module,
          uiFlow: isFlowQualified(current.block.kind as ElementKind) ? ctx.uiFlow : undefined,
          external: false,
          opaque: false
        });
        continue;
      }
    }

    if (!current) continue;

    // Generic scan: any element var from the table used inside this element's block is an edge.
    const scanned = stripStringsAndComments(line);
    const declared = VAR_DECL_RE.exec(scanned)?.[1];
    const tokens = scanned.match(/[A-Za-z_]\w*/g) ?? [];
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token === declared || seen.has(token)) continue;
      seen.add(token);
      const entry = vars.get(token);
      if (entry?.t === "elem") addEdge(entry, current.id);
    }
  }

  for (const entry of externals) {
    const node = externalNode(entry);
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  return {
    nodes: [...nodes.values()],
    edges,
    skipped,
    anchors,
    lambdaFlowVar,
    dependencyFlow,
    hasDependencies: externals.length > 0
  };
}

/**
 * Case- and separator-insensitive comparison of a declared flow (`mainflow`, or a de-duplicated lambda
 * var such as `mainflow2`) with a listing flow name (`Mainflow`). A trailing numeric suffix on the
 * declared side is tolerated when the exact form does not match.
 */
export function sameFlow(declared: string | undefined, listed: string | undefined): boolean {
  if (declared === undefined || listed === undefined) return false;
  const norm = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const a = norm(declared);
  const b = norm(listed);
  const stripped = a.replace(/\d+$/, "");
  return a === b || (stripped !== "" && stripped === b);
}

function extractModuleText(
  text: string,
  module: string,
  flowsByName: Map<string, string[]>,
  out: ExtractedModule
): void {
  const result = extractText(text, { module, flowsByName });
  mergeInto(out, result);
}

function extractElementText(
  item: NamedText,
  expectedKind: ElementKind,
  module: string,
  flowsByName: Map<string, string[]>,
  out: ExtractedModule,
  uiFlow?: string,
  duplicate = false
): void {
  const result = extractText(item.text, { module, expectedName: item.name, expectedKind, uiFlow, flowsByName });
  const ownAnchor = result.anchors.find((a) => a.name === item.name && a.kind === expectedKind);

  if (duplicate) {
    // ADR-0008: the tool returns one element per name; attribute it to the flow its text declares.
    // The dependency comment names the flow verbatim; the lambda var is only a camelCase proxy.
    const declaredFlow = result.dependencyFlow ?? result.lambdaFlowVar;
    if (!sameFlow(declaredFlow, uiFlow)) {
      out.skipped.push({ kind: expectedKind, name: item.name, reason: "DUPLICATE_NAME_UNRESOLVABLE" });
      return;
    }
  }

  if (!ownAnchor) {
    if (result.anchors.length === 0 && result.hasDependencies) {
      // Referenced-only input (names listing `IsReferenced: true`): the element lives in another
      // module; only its external node is emitted, nothing is skipped.
      mergeInto(out, { ...result, edges: [] });
      return;
    }
    out.skipped.push({
      kind: expectedKind,
      name: item.name,
      reason: result.anchors.length === 0 ? "NO_ANCHOR" : "PARSE_ERROR"
    });
    return;
  }
  mergeInto(out, result);
}

function mergeInto(out: ExtractedModule, result: Pick<TextResult, "nodes" | "edges" | "skipped">): void {
  out.nodes.push(...result.nodes);
  out.edges.push(...result.edges);
  out.skipped.push(...result.skipped);
}

function nodeRank(node: ExtractedNode): number {
  return node.external ? 1 : 0;
}

/** Dedupes nodes (real node wins over external), dedupes edges, sorts both deterministically. */
export function finalizeModule(out: ExtractedModule): ExtractedModule {
  const nodes = new Map<string, ExtractedNode>();
  for (const node of out.nodes) {
    const existing = nodes.get(node.id);
    if (!existing || nodeRank(node) < nodeRank(existing)) nodes.set(node.id, node);
    else if (existing.external && node.external && existing.globalKey === undefined && node.globalKey) {
      nodes.set(node.id, node);
    }
  }
  const edges = new Map<string, ExtractedEdge>();
  for (const edge of out.edges) {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (!edges.has(key)) edges.set(key, edge);
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    module: out.module,
    nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
    edges: [...edges.values()].sort(
      (a, b) => compare(a.source, b.source) || compare(a.target, b.target) || compare(a.relation, b.relation)
    ),
    skipped: out.skipped
      .filter(
        (s, i, all) => all.findIndex((o) => o.kind === s.kind && o.name === s.name && o.reason === s.reason) === i
      )
      .sort((a, b) => compare(String(a.kind), String(b.kind)) || compare(a.name, b.name) || compare(a.reason, b.reason))
  };
}

/** Extracts every text of one module into a deterministic node/edge/skip list. */
export function extractModule(input: ModuleInput): ExtractedModule {
  const { module, texts } = input;
  const out: ExtractedModule = { module, nodes: [], edges: [], skipped: [] };
  const flowsByName = flowsIndex([...texts.screens, ...texts.blocks]);

  extractModuleText(texts.dataModel, module, flowsByName, out);
  extractModuleText(texts.structures, module, flowsByName, out);

  const flowKinds: Array<[FlowNamedText[], ElementKind]> = [
    [texts.screens, "Screen"],
    [texts.blocks, "Block"]
  ];
  for (const [items, kind] of flowKinds) {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    for (const item of items) {
      extractElementText(item, kind, module, flowsByName, out, item.uiFlow, (counts.get(item.name) ?? 0) > 1);
    }
  }
  for (const item of texts.clientActions) extractElementText(item, "ClientAction", module, flowsByName, out);
  for (const item of texts.serverActions) extractElementText(item, "ServerAction", module, flowsByName, out);

  return finalizeModule(out);
}
