import { z } from "zod";
import { parseId } from "../extract/ids.js";
import { renderBinding, renderFlow, walkFlow } from "../flows/render.js";
import { requireFlows, type FlowsArtifact } from "../flows/index.js";
import type { Binding, FlowAction } from "../flows/types.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool, type ToolContext } from "./tool.js";

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope whose flow data to read."),
  element: z
    .string()
    .min(1)
    .describe(
      "The screen, block, client action or server action whose flows to return. Accepts a full node id " +
        "(osgraph://<Module>/<Kind>/[<UIFlow>/]<Name>) or a bare element name; an ambiguous name is rejected " +
        "with the candidates listed."
    ),
  action: z
    .string()
    .min(1)
    .optional()
    .describe("Return only this action of the element (exact name, case-insensitive). Omit for all of them."),
  module: z.string().min(1).optional().describe("Disambiguate a bare element name to one module."),
  includeIr: z
    .boolean()
    .optional()
    .describe(
      "Include the full node/connector IR beside the text rendering (default true). Set false for just the " +
        "listing, which is much smaller on a large flow."
    )
});

const inputSchema = permissiveShape(strictSchema);

export interface GetFlowAction {
  id: string;
  name: string;
  kind: string;
  description?: string;
  nodeCount: number;
  /** Node ids in walk order (Start first, then along the connectors); the text uses these positions. */
  walkOrder: string[];
  /** The compact listing described in the tool's output. */
  text: string;
  /** Present unless `includeIr: false`. */
  action?: FlowAction;
}

export interface GetFlowResult {
  scope: string;
  element: { id: string; module: string; kind: string; uiFlow?: string; name: string };
  actions: GetFlowAction[];
  /** UI wiring declared by the element outside any action (events, block instances, If widgets). */
  bindings: Array<Binding & { text: string }>;
  /** `builtAt` of the flow artifact, so a caller can see how fresh the answer is. */
  flowsBuiltAt: string;
}

interface Owner {
  id: string;
  module: string;
  kind: string;
  uiFlow?: string;
  name: string;
  actions: FlowAction[];
  bindings: Binding[];
}

/** Every element the artifact has flows or bindings for, keyed by its node id. */
export function ownersOf(artifact: FlowsArtifact): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  const ensure = (id: string, module: string): Owner => {
    let owner = owners.get(id);
    if (owner === undefined) {
      const parsed = parseId(id.split("#")[0]);
      owner = {
        id,
        module: parsed?.module ?? module,
        kind: String(parsed?.kind ?? "unknown"),
        name: parsed?.name ?? id,
        actions: [],
        bindings: []
      };
      if (parsed?.uiFlow !== undefined) owner.uiFlow = parsed.uiFlow;
      owners.set(id, owner);
    }
    return owner;
  };
  for (const m of artifact.modules) {
    for (const action of m.actions) ensure(action.owner, m.module).actions.push(action);
    for (const binding of m.bindings) ensure(binding.owner, m.module).bindings.push(binding);
  }
  return owners;
}

/**
 * Resolves `element` to exactly one owner: an exact id first, then a case-insensitive id, then a
 * name match. An ambiguous name is an **error with the candidates**, never a guess — ADR-0008 exists
 * because screen and block names are not unique within a module, let alone across one.
 */
export function resolveElement(
  owners: Map<string, Owner>,
  element: string,
  module: string | undefined,
  scope: string
): Owner {
  const inModule = (o: Owner): boolean => module === undefined || o.module.toLowerCase() === module.toLowerCase();
  const exact = owners.get(element);
  if (exact !== undefined && inModule(exact)) return exact;
  const all = [...owners.values()].filter(inModule);
  const lower = element.toLowerCase();
  const byId = all.filter((o) => o.id.toLowerCase() === lower);
  if (byId.length === 1) return byId[0];
  const byName = all.filter((o) => o.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new OsgraphToolError(
      "UNKNOWN_NODE",
      `scope '${scope}': '${element}' matches ${byName.length} elements. Pass the full node id, or add ` +
        `module, to say which: ${byName.map((o) => o.id).join(", ")}`,
      { scope, element, candidates: byName.map((o) => o.id) }
    );
  }
  const suffix = all.filter((o) => o.id.toLowerCase().endsWith(`/${lower}`));
  if (suffix.length === 1) return suffix[0];
  throw new OsgraphToolError(
    "UNKNOWN_NODE",
    `scope '${scope}': no element '${element}' has flow data${module !== undefined ? ` in module '${module}'` : ""}. ` +
      `An element with no actions and no UI wiring has no entry here; check the name against graph.json.`,
    { scope, element, ...(module !== undefined ? { module } : {}) }
  );
}

export function buildGetFlowResult(
  artifact: FlowsArtifact,
  input: { scope: string; element: string; action?: string; module?: string; includeIr?: boolean }
): GetFlowResult {
  const owner = resolveElement(ownersOf(artifact), input.element, input.module, input.scope);
  const wanted =
    input.action === undefined
      ? owner.actions
      : owner.actions.filter((a) => a.name.toLowerCase() === input.action?.toLowerCase());
  if (input.action !== undefined && wanted.length === 0) {
    throw new OsgraphToolError(
      "UNKNOWN_NODE",
      `element '${owner.id}' has no action '${input.action}'. It has: ${
        owner.actions.map((a) => a.name).join(", ") || "(none)"
      }`,
      { scope: input.scope, element: owner.id, action: input.action, actions: owner.actions.map((a) => a.name) }
    );
  }
  return {
    scope: input.scope,
    element: {
      id: owner.id,
      module: owner.module,
      kind: owner.kind,
      ...(owner.uiFlow !== undefined ? { uiFlow: owner.uiFlow } : {}),
      name: owner.name
    },
    actions: wanted.map((action) => {
      const walked = walkFlow(action);
      const out: GetFlowAction = {
        id: action.id,
        name: action.name,
        kind: action.kind,
        nodeCount: action.nodes.length,
        walkOrder: walked.map((w) => w.node.id),
        text: renderFlow(action, walked)
      };
      if (action.description !== undefined) out.description = action.description;
      if (input.includeIr !== false) out.action = action;
      return out;
    }),
    bindings: owner.bindings.map((b) => ({ ...b, text: renderBinding(b) })),
    flowsBuiltAt: artifact.builtAt
  };
}

export const getFlow: OsgraphTool<typeof inputSchema> = {
  name: "getFlow",
  description:
    "The logic INSIDE one element's actions, read from the scope's flows.json (no servicestudio call). " +
    "For each screen action / block action / client action / server action of the element it returns the flow " +
    "nodes in WALK order (Start first, then along the connectors; an unreachable node is marked '*', which is " +
    "normal for an exception handler), a compact text listing, and — unless includeIr:false — the full IR with " +
    "every connector, condition, assignment, call argument and callee. Also returns the element's UI bindings: " +
    "which widget event calls which action, which lifecycle handler (OnReady…) runs which action, each block " +
    "instance's source block, its input arguments and its event handlers, and each If widget's condition. " +
    "ForEach ports read as cycle→ (the loop BODY) and exit→ (the continuation). Expressions are verbatim text, " +
    "never parsed. Errors: INPUT_INVALID, SCOPE_NOT_FOUND, FLOWS_NOT_BUILT (run `osgraph reextract --scope <name>`, " +
    "which is offline and takes seconds), UNKNOWN_NODE (no such element, no such action, or an ambiguous name — " +
    "the candidates are listed).",
  inputSchema,
  handler: (args, ctx: ToolContext) => {
    const scope = scopeArg(args.scope);
    return runTool<GetFlowResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "getFlow");
      // A scope with no snapshot has no flows either; `requireFlows` names the cheap fix.
      const artifact = requireFlows(ctx.snapshotPath(input.scope), input.scope);
      return { result: buildGetFlowResult(artifact, input) };
    });
  }
};
