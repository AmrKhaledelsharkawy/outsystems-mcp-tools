import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toCallToolResult, type OsgraphTool, type ToolContext } from "./tool.js";
import { rebuild } from "./rebuild.js";
import { queryPath } from "./queryPath.js";
import { queryImpact } from "./queryImpact.js";
import { listViolations } from "./listViolations.js";
import { defineScope } from "./defineScope.js";
import { listScopes } from "./listScopes.js";
import { getFlow } from "./getFlow.js";
import { searchFlows } from "./searchFlows.js";

/**
 * The six v1 tools (OSG-007 as revised by ADR-0005), plus v1.1's two flow tools (ADR-0012).
 * `getFlow` and `searchFlows` read `flows.json`; every other query tool reads `graph.json`.
 */
export const tools: readonly OsgraphTool[] = [
  rebuild,
  queryPath,
  queryImpact,
  listViolations,
  getFlow,
  searchFlows,
  defineScope,
  listScopes
];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => toCallToolResult(await tool.handler(args, ctx))
    );
  }
}
