/**
 * #70 offline CLI mirrors of the query tools: `osgraph impact | flow | path`.
 *
 * Each command builds its arguments from flags and calls the SAME tool handler the MCP server
 * registers, so the result is identical by construction (the JSON output is the tool's response
 * envelope verbatim). Nothing here touches Service Studio or osopener or reads a session token;
 * the commands only read the local snapshot and flows files a prior `rebuild` / `run` wrote.
 */
import { tools } from "../tools/index.js";
import type { ToolContext } from "../tools/tool.js";
import type { GetFlowResult } from "../tools/getFlow.js";
import type { QueryImpactResult } from "../tools/queryImpact.js";
import type { QueryPathResult } from "../tools/queryPath.js";
import type { ToolResponse } from "../types.js";

export const QUERY_COMMANDS = ["impact", "flow", "path"] as const;
export type QueryCommand = (typeof QUERY_COMMANDS)[number];

export function isQueryCommand(command: string): command is QueryCommand {
  return (QUERY_COMMANDS as readonly string[]).includes(command);
}

const TOOL_OF: Record<QueryCommand, string> = { impact: "queryImpact", flow: "getFlow", path: "queryPath" };

export class CliUsageError extends Error {}

const present = (options: Record<string, string>, name: string): string | undefined => {
  const v = options[name];
  return v === undefined || v === "true" ? undefined : v;
};

function required(options: Record<string, string>, name: string, command: QueryCommand): string {
  const v = present(options, name);
  if (v === undefined) throw new CliUsageError(`${command} needs --${name} <value>.`);
  return v;
}

function intOption(options: Record<string, string>, name: string): number | undefined {
  const raw = options[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new CliUsageError(`--${name} must be a positive integer.`);
  return Number(raw);
}

function boolOption(options: Record<string, string>, name: string): boolean | undefined {
  const raw = options[name];
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new CliUsageError(`--${name} must be true or false.`);
}

/** Flags -> the tool's argument object. Throws `CliUsageError`. */
export function buildToolArgs(command: QueryCommand, options: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = { scope: required(options, "scope", command) };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) args[key] = value;
  };
  if (command === "impact") {
    args.nodeId = required(options, "node", command);
    const direction = required(options, "direction", command);
    if (direction !== "dependents" && direction !== "dependencies") {
      throw new CliUsageError("--direction must be 'dependents' or 'dependencies'.");
    }
    args.direction = direction;
    set("maxDepth", intOption(options, "max-depth"));
    set("limit", intOption(options, "limit"));
  } else if (command === "flow") {
    args.element = required(options, "element", command);
    set("action", present(options, "action"));
    set("module", present(options, "module"));
    set("includeIr", boolOption(options, "include-ir"));
  } else {
    args.from = required(options, "from", command);
    args.to = required(options, "to", command);
    set("undirected", boolOption(options, "undirected"));
    set("limit", intOption(options, "limit"));
  }
  return args;
}

/** Runs the mirrored tool. The response is exactly what the MCP tool would answer. */
export async function runQueryCommand(
  command: QueryCommand,
  options: Record<string, string>,
  ctx: ToolContext
): Promise<ToolResponse> {
  const args = buildToolArgs(command, options);
  const tool = tools.find((t) => t.name === TOOL_OF[command]);
  if (tool === undefined) throw new Error(`no tool ${TOOL_OF[command]}`);
  return tool.handler(args, ctx);
}

function formatImpact(r: QueryImpactResult): string {
  const lines = [
    `${r.direction} of ${r.root}${r.maxDepth !== null ? ` (max depth ${r.maxDepth})` : ""}: ${r.total} node(s), ${r.totalEdges} edge(s)`
  ];
  for (const n of r.nodes) lines.push(`  [${n.depth}] ${n.id}  (${n.kind}${n.layer ? `, ${n.layer}` : ""})`);
  if (r.truncated) lines.push(`  ... truncated: showing ${r.nodes.length} of ${r.total} (raise --limit, currently ${r.limit})`);
  return lines.join("\n");
}

function formatFlow(r: GetFlowResult): string {
  const lines = [`${r.element.id}  (${r.element.kind}, module ${r.element.module})`];
  for (const a of r.actions) {
    lines.push("", `action ${a.name} [${a.kind}] - ${a.nodeCount} node(s)`, a.text);
  }
  if (r.bindings.length > 0) {
    lines.push("", "bindings");
    for (const b of r.bindings) lines.push(`  ${b.text}`);
  }
  lines.push("", `flows built ${r.flowsBuiltAt}`);
  return lines.join("\n");
}

function formatPath(r: QueryPathResult): string {
  if (!r.found) return `no path from ${r.from} to ${r.to}${r.undirected ? " (undirected)" : ""}`;
  const lines = [`path ${r.from} -> ${r.to}: ${r.hops} hop(s)`];
  r.path.forEach((s, i) => lines.push(`  ${i + 1}. ${i === 0 ? "" : `--${s.relation ?? "?"}--> `}${s.label}`));
  if (r.truncated) lines.push(`  ... truncated: showing ${r.path.length} of ${r.total} steps (raise --limit, currently ${r.limit})`);
  return lines.join("\n");
}

/** Human-readable rendering of a response (errors include their suggestions). */
export function formatQueryResponse(command: QueryCommand, response: ToolResponse): string {
  if (response.error) {
    const lines = [`${response.error.code}: ${response.error.message}`];
    const details = response.error.details as { suggestions?: unknown } | undefined;
    if (Array.isArray(details?.suggestions) && details.suggestions.length > 0) {
      lines.push(`  suggestions: ${(details.suggestions as string[]).join(", ")}`);
    }
    return lines.join("\n");
  }
  if (command === "impact") return formatImpact(response.result as QueryImpactResult);
  if (command === "flow") return formatFlow(response.result as GetFlowResult);
  return formatPath(response.result as QueryPathResult);
}
