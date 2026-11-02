import type { ZodRawShape } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OsopenerConfig } from "../config.js";
import type { HelperRunner } from "../helper.js";
import type { ServiceStudioClient } from "../servicestudio.js";
import type { OsopenerError } from "../types.js";

/** Context handed to every tool handler. Tests inject fakes for `client` and `helper`. */
export interface ToolContext {
  config: OsopenerConfig;
  client: ServiceStudioClient;
  helper: HelperRunner;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface OsopenerTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown & { error?: OsopenerError }>;
}

export function toCallToolResult(response: { error?: OsopenerError }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    ...(response.error ? { isError: true } : {})
  };
}

/** Converts any thrown value carrying `{ code, message, details? }` into an OsopenerError. */
export function toOsopenerError(err: unknown, fallbackMessage = "unexpected failure"): OsopenerError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: string; message: string; details?: unknown };
    return {
      code: e.code as OsopenerError["code"],
      message: e.message,
      ...(e.details !== undefined ? { details: e.details } : {})
    };
  }
  return { code: "HELPER_FAILED", message: err instanceof Error ? err.message : fallbackMessage };
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
