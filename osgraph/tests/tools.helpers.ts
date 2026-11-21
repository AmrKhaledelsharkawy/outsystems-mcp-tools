/**
 * Shared `ToolContext` factory and tool-call helper for the handler tests.
 *
 * Extracted from `tools.test.ts` when `flows.tools.test.ts` needed the same context: a second copy
 * of the fake-session wiring is a second place for the two to drift apart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { DEFAULT_FETCH_CONCURRENCY, type OsgraphConfig } from "../src/config.js";
import { createFileStudioLock } from "../src/lock/studioLock.js";
import { tools } from "../src/tools/index.js";
import { createToolContext, type ToolContext, type ToolContextOverrides } from "../src/tools/tool.js";
import type { ToolResponse } from "../src/types.js";
import { demoPortalModule, fakeSession, syntheticXModule } from "./rebuild.fake.js";

const dirs: string[] = [];
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-tools-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function makeCtx(overrides: ToolContextOverrides = {}): {
  ctx: ToolContext;
  config: OsgraphConfig;
  logs: string[];
} {
  const root = tmp();
  const config: OsgraphConfig = {
    serviceStudioUrl: "http://127.0.0.1:41820/mcp",
    tokenFile: undefined,
    graphDir: join(root, "graphs"),
    scopesDir: join(root, "scopes"),
    graphifyBin: "graphify",
    fetchConcurrency: DEFAULT_FETCH_CONCURRENCY
  };
  const logs: string[] = [];
  const ctx = createToolContext(config, {
    env: {},
    now: () => new Date("2026-10-30T12:00:00.000Z"),
    log: (l) => logs.push(l),
    createSession: () => fakeSession([demoPortalModule(), syntheticXModule()]),
    // #64: never the machine-wide default lock path; parallel test files must not contend.
    studioLock: createFileStudioLock({ path: join(root, "studio.lock") }),
    ...overrides
  });
  return { ctx, config, logs };
}

export const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

export const call = <T,>(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse<T>> =>
  tool(name).handler(args, ctx) as Promise<ToolResponse<T>>;
