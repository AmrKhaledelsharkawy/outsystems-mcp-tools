import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OsgraphConfig } from "./config.js";
import { createRequire } from "node:module";
import { registerTools } from "./tools/index.js";
import { createToolContext, type ToolContextOverrides } from "./tools/tool.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
export const SERVER_NAME = "osgraph";
/** Single source of truth is package.json (OSG-005 manual semver bumps). */
export const SERVER_VERSION: string = pkg.version;

/**
 * Builds the MCP server. `overrides` injects test doubles into the tool context (fake servicestudio
 * session, fake graphify runner, fixed clock, ...); production passes none.
 */
export function createServer(config: OsgraphConfig, overrides: ToolContextOverrides = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, createToolContext(config, overrides));
  return server;
}

/** Serves osgraph over stdio until the transport closes. Never writes to stdout itself. */
export async function startServer(config: OsgraphConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
