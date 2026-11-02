import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeTokenResolution, resolveTokenFile, type OsopenerConfig, type ResolveOptions } from "./config.js";
import { PowerShellHelper } from "./helper.js";
import { HttpServiceStudioClient } from "./servicestudio.js";
import { registerTools } from "./tools/index.js";
import type { ToolContext } from "./tools/tool.js";

export const SERVER_NAME = "osopener";
export const SERVER_VERSION = "0.1.0";

/**
 * The token file is looked up again on every servicestudio call, from the working directory the server was
 * started in: the session-guard hook may write `token.txt` after start-up, and one user-scope registration
 * is expected to serve whichever workspace the user is in.
 */
export function createTokenLookup(
  env: Record<string, string | undefined> = process.env,
  options: ResolveOptions = {}
): () => { path: string | undefined; detail: string } {
  return () => {
    const token = resolveTokenFile(env, options);
    return { path: token.path, detail: describeTokenResolution(token) };
  };
}

export function createContext(config: OsopenerConfig): ToolContext {
  return {
    config,
    client: new HttpServiceStudioClient({ url: config.serviceStudioUrl, tokenFile: createTokenLookup() }),
    helper: new PowerShellHelper({ powershellExe: config.powershellExe, scriptPath: config.helperScript })
  };
}

export function createServer(config: OsopenerConfig, ctx: ToolContext = createContext(config)): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, ctx);
  return server;
}

/** Serves osopener over stdio until the transport closes. Never writes to stdout itself. */
export async function startServer(config: OsopenerConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
