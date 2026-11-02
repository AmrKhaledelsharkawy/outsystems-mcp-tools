import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toCallToolResult, type OsopenerTool, type ToolContext } from "./tool.js";
import { closeModule } from "./closeModule.js";
import { focusStudio } from "./focusStudio.js";
import { listOpenModules } from "./listOpenModules.js";
import { openModule } from "./openModule.js";

/** OSG-014 §3's three tools, plus `closeModule` (added 2026-10-30 for the open -> stage -> close loop). */
export const tools: readonly OsopenerTool[] = [openModule, closeModule, listOpenModules, focusStudio] as readonly OsopenerTool[];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => toCallToolResult((await tool.handler(args, ctx)) as { error?: never })
    );
  }
}
