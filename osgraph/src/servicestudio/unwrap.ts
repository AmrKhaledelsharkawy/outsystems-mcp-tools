/**
 * Response-envelope helpers for the servicestudio MCP (live shapes verified 2026-10-29):
 *  - streamable HTTP answers are SSE-framed (`event: message` / `data: {json-rpc}`) or plain JSON;
 *  - tool text is either raw fenced code ("```csharp\n...\n```") or a JSON string
 *    `{"result":"```csharp\n...```"}`, sometimes nested twice;
 *  - names tools return `{"result":"[{\"Name\":...}]"}` (a JSON-encoded array string inside `result`).
 */
import type { JsonRpcResponse } from "./types.js";

const MAX_RESULT_NESTING = 4;

/**
 * Parses an HTTP body that is either SSE-framed or plain JSON into the JSON-RPC envelope.
 * SSE: events are blank-line separated; the `data:` lines of one event are joined with LF
 * (per the SSE spec); the LAST event that carries data is used.
 */
export function parseSseBody(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new Error("empty response body");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  let lastData: string | undefined;
  for (const event of trimmed.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const rawLine of event.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (dataLines.length > 0) lastData = dataLines.join("\n");
  }
  if (lastData === undefined) throw new Error("no `data:` line in SSE response body");
  return JSON.parse(lastData) as JsonRpcResponse;
}

function tryParseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function hasResultKey(value: unknown): value is { result: unknown } {
  return typeof value === "object" && value !== null && "result" in value;
}

/**
 * Unwraps `{"result": <json-or-string>}` envelopes (nested up to 4 deep) and returns the innermost
 * JSON value. A string that is not JSON is returned as-is.
 */
export function unwrapJson(text: string): unknown {
  let current: unknown = text;
  for (let i = 0; i < MAX_RESULT_NESTING; i++) {
    if (typeof current === "string") {
      const parsed = tryParseJson(current);
      if (parsed === undefined) return current;
      current = parsed;
    }
    if (hasResultKey(current)) {
      current = current.result;
      continue;
    }
    return current;
  }
  return current;
}

const FENCE_RE = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/;

/** Strips one surrounding ``` fence (optional language tag); returns the trimmed text otherwise. */
export function stripCodeFence(text: string): string {
  const m = FENCE_RE.exec(text.trim());
  return m ? m[1]! : text.trim();
}

/**
 * Model-API code text of a `getX` tool: handles raw fenced code, `{"result":"```csharp..."}` and
 * the same wrapped twice; returns the code without fences.
 */
export function unwrapCodeText(text: string): string {
  const inner = unwrapJson(text);
  if (typeof inner !== "string") {
    throw new Error(`expected code text, got JSON ${Array.isArray(inner) ? "array" : typeof inner}`);
  }
  return stripCodeFence(inner);
}

/** Names tools: `{"result":"[{\"Name\":...}]"}` (or a plain array) -> parsed array. */
export function unwrapJsonArray<T = unknown>(text: string): T[] {
  const inner = unwrapJson(text);
  if (!Array.isArray(inner)) {
    throw new Error(`expected a JSON array, got ${inner === null ? "null" : typeof inner}`);
  }
  return inner as T[];
}

/** Object tools (`listApps` -> `{apps:[...]}`): unwraps `result` envelopes and returns the object. */
export function unwrapJsonObject<T extends object = Record<string, unknown>>(text: string): T {
  const inner = unwrapJson(text);
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
    throw new Error(`expected a JSON object, got ${inner === null ? "null" : typeof inner}`);
  }
  return inner as T;
}
