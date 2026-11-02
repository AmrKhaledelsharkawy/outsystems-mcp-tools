import { z } from "zod";
import { requireFlows, type FlowsArtifact } from "../flows/index.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool, type ToolContext } from "./tool.js";

/** Which kinds of text a search looks at. */
export const SEARCH_FIELDS = ["calls", "assignments", "conditions", "arguments", "bindings", "labels", "properties"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope whose flow data to search."),
  pattern: z.string().min(1).describe("JavaScript regular expression, matched against the text of each selected field."),
  in: z
    .array(z.enum(SEARCH_FIELDS))
    .min(1)
    .optional()
    .describe(`Which fields to search; defaults to all of ${SEARCH_FIELDS.join(", ")}.`),
  module: z.string().min(1).optional().describe("Restrict to one module (case-insensitive)."),
  element: z.string().min(1).optional().describe("Restrict to one element, by node id or bare name (case-insensitive substring)."),
  ignoreCase: z.boolean().optional().describe("Case-insensitive matching; default TRUE."),
  limit: z.number().int().positive().max(5000).optional().describe("Maximum hits to return; default 200. `totalHits` reports the true count.")
});

const inputSchema = permissiveShape(strictSchema);

export interface FlowHit {
  module: string;
  /** Element id the hit belongs to. */
  owner: string;
  /** Absent for a binding, which belongs to the element and not to any action. */
  actionId?: string;
  actionName?: string;
  /** Absent for a binding. */
  nodeId?: string;
  nodeType?: string;
  /** Which field matched: `call`, `assignment.left`, `condition`, `argument.Request`, `binding.event`, … */
  field: string;
  /** The matched text, verbatim. */
  text: string;
}

export interface SearchFlowsResult {
  scope: string;
  pattern: string;
  in: SearchField[];
  /** Hits, sorted by (module, actionId, nodeId, field); truncated to `limit`. */
  hits: FlowHit[];
  /** Hits found before `limit` was applied. */
  totalHits: number;
  truncated: boolean;
  flowsBuiltAt: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure search over the artifact. Every candidate is a `(field, text)` pair, so adding a field is
 * adding a pair and never a new matching rule — and the regex only ever sees expression text or a
 * name, never JSON, so a pattern cannot accidentally match the IR's own structure.
 */
export function searchArtifact(
  artifact: FlowsArtifact,
  input: {
    scope: string;
    pattern: string;
    in?: SearchField[];
    module?: string;
    element?: string;
    ignoreCase?: boolean;
    limit?: number;
  }
): SearchFlowsResult {
  const fields: SearchField[] = input.in ?? [...SEARCH_FIELDS];
  const wanted = new Set<SearchField>(fields);
  const limit = input.limit ?? 200;
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.ignoreCase === false ? "" : "i");
  } catch (err) {
    throw new OsgraphToolError(
      "INPUT_INVALID",
      `searchFlows: pattern '${input.pattern}' is not a valid regular expression: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { scope: input.scope, pattern: input.pattern }
    );
  }
  const elementFilter = input.element?.toLowerCase();
  const moduleFilter = input.module?.toLowerCase();
  const hits: FlowHit[] = [];
  let totalHits = 0;

  const push = (hit: FlowHit): void => {
    totalHits++;
    if (hits.length < limit) hits.push(hit);
  };

  for (const m of artifact.modules) {
    if (moduleFilter !== undefined && m.module.toLowerCase() !== moduleFilter) continue;

    for (const action of m.actions) {
      if (elementFilter !== undefined && !action.owner.toLowerCase().includes(elementFilter)) continue;
      const base = { module: m.module, owner: action.owner, actionId: action.id, actionName: action.name };
      for (const node of action.nodes) {
        const at = { ...base, nodeId: node.id, nodeType: node.type };
        const test = (field: string, text: string | undefined): void => {
          if (text !== undefined && text.length > 0 && re.test(text)) push({ ...at, field, text });
        };
        if (wanted.has("calls")) {
          test("call", node.callee?.text);
          test("call.id", node.callee?.id);
          test("destination", node.destination?.text);
          test("exception", node.exception?.text);
        }
        if (wanted.has("assignments")) {
          for (const a of node.assignments ?? []) {
            test("assignment.left", a.left);
            test("assignment.right", a.right);
          }
        }
        if (wanted.has("conditions")) {
          test("condition", node.condition);
          test("recordList", node.recordList);
          test("message", node.message);
        }
        if (wanted.has("arguments")) {
          for (const a of node.arguments ?? []) {
            test(`argument.${a.param}`, a.expr);
            test("argument.param", a.param);
          }
        }
        if (wanted.has("labels")) test("label", node.label);
        if (wanted.has("properties")) {
          for (const p of node.properties ?? []) test(`property.${p.name}`, p.value);
          for (const line of node.raw ?? []) test("raw", line);
        }
      }
    }

    if (!wanted.has("bindings")) continue;
    for (const binding of m.bindings) {
      if (elementFilter !== undefined && !binding.owner.toLowerCase().includes(elementFilter)) continue;
      const at = { module: m.module, owner: binding.owner };
      const test = (field: string, text: string | undefined): void => {
        if (text !== undefined && text.length > 0 && re.test(text)) push({ ...at, field, text });
      };
      test(`binding.${binding.kind}`, binding.name);
      test(`binding.${binding.kind}.expr`, binding.expr);
      test(`binding.${binding.kind}.handler`, binding.handler?.text);
      test(`binding.${binding.kind}.handlerId`, binding.handler?.id);
      test(`binding.${binding.kind}.widget`, binding.widgetLabel);
    }
  }

  hits.sort(
    (a, b) =>
      compare(a.module, b.module) ||
      compare(a.actionId ?? "", b.actionId ?? "") ||
      compare(a.nodeId ?? "", b.nodeId ?? "") ||
      compare(a.field, b.field) ||
      compare(a.text, b.text)
  );

  return {
    scope: input.scope,
    pattern: input.pattern,
    in: fields,
    hits,
    totalHits,
    truncated: totalHits > hits.length,
    flowsBuiltAt: artifact.builtAt
  };
}

export const searchFlows: OsgraphTool<typeof inputSchema> = {
  name: "searchFlows",
  description:
    "Regex search across the logic of every action in a scope, from flows.json (no servicestudio call). " +
    "Searches callee names and node ids (`calls`), assignment left/right sides (`assignments`), If conditions, " +
    "ForEach record lists and exception/message text (`conditions`), call arguments by parameter name " +
    "(`arguments`), UI wiring — widget events, lifecycle handlers, block-instance arguments and event handlers, " +
    "If-widget conditions (`bindings`), node labels (`labels`), and everything else a node set including the raw " +
    "statements of an unrecognised node type (`properties`). Matching is CASE-INSENSITIVE by default. " +
    "Each hit names the module, the element, the action, the node, the field and the matched text verbatim, so a " +
    "nodeId can be handed straight to getFlow. Expressions are never parsed — this regex IS the query over them. " +
    "Returns at most `limit` hits (default 200) with `totalHits` reporting the true count. " +
    "Errors: INPUT_INVALID (including an invalid regex), SCOPE_NOT_FOUND, FLOWS_NOT_BUILT " +
    "(run `osgraph reextract --scope <name>`, which is offline and takes seconds).",
  inputSchema,
  handler: (args, ctx: ToolContext) => {
    const scope = scopeArg(args.scope);
    return runTool<SearchFlowsResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "searchFlows");
      const artifact = requireFlows(ctx.snapshotPath(input.scope), input.scope);
      return { result: searchArtifact(artifact, input) };
    });
  }
};
