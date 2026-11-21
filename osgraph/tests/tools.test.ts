/**
 * The six MCP tool handlers through an injected `ToolContext` (OSG-007 as revised by ADR-0005;
 * OSG-011 graphCompleteness on every response).
 */
import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, type Snapshot } from "../src/graph/index.js";
import { tools } from "../src/tools/index.js";
import { createSharedSessionFactory, createToolContext, type ToolContext } from "../src/tools/tool.js";
import { computeImpact, type QueryImpactResult } from "../src/tools/queryImpact.js";
import { progressSink } from "../src/tools/rebuild.js";
import type { RebuildResult } from "../src/rebuild/rebuild.js";
import { app, demoPortalModule, fakeSession, syntheticXModule, tokenExpiredError } from "./rebuild.fake.js";
import { call, makeCtx, tmp, tool } from "./tools.helpers.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const violationGraph = join(fixtures, "synthetic", "violation-graph.json");
/** Installs the synthetic violation graph as scope `demo`'s snapshot (+ meta) and defines the scope. */
function installViolationGraph(ctx: ToolContext, scope = "demo", withMeta = true): string {
  ctx.scopeStore.define({ name: scope, modules: ["Demo_UI", "Demo_CW", "Demo_SL", "Demo_BL", "Demo_CS"] });
  const path = ctx.snapshotPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(violationGraph, path);
  if (withMeta) {
    writeFileSync(join(dirname(path), "meta.json"), canonicalJson({ rebuiltAt: "2026-10-29T00:00:00.000Z", scope, skippedCount: 3 }));
  }
  return path;
}

/**
 * S6 audit F2 (orchestrator decision, 2026-10-30): protocol-level input validation is inside
 * OSG-011's "every osgraph tool response carries graphCompleteness" rule. The SDK is registered with
 * permissive schemas so it can never answer before the handler; the strict check runs inside and
 * maps to the normal envelope with the `INPUT_INVALID` code.
 */
describe("INPUT_INVALID (F2)", () => {
  const bad: Array<{ tool: string; args: Record<string, unknown>; fields: string[] }> = [
    { tool: "rebuild", args: {}, fields: ["scope"] },
    { tool: "rebuild", args: { scope: 7 }, fields: ["scope"] },
    { tool: "rebuild", args: { scope: "" }, fields: ["scope"] },
    { tool: "queryPath", args: { scope: "demo", from: "-x", to: "osgraph://a/Entity/B" }, fields: ["from"] },
    { tool: "queryPath", args: { scope: "demo" }, fields: ["from", "to"] },
    { tool: "queryImpact", args: { scope: "demo", nodeId: "osgraph://a/Entity/B", direction: "sideways" }, fields: ["direction"] },
    { tool: "queryImpact", args: { scope: "demo", nodeId: "osgraph://a/Entity/B", direction: "dependents", maxDepth: 0 }, fields: ["maxDepth"] },
    { tool: "listViolations", args: {}, fields: ["scope"] },
    { tool: "defineScope", args: { name: "portal", modules: [] }, fields: ["modules"] },
    { tool: "defineScope", args: { modules: ["x"] }, fields: ["name"] }
  ];

  for (const { tool: name, args, fields } of bad) {
    it(`${name}(${JSON.stringify(args)}) → INPUT_INVALID with graphCompleteness`, async () => {
      const { ctx } = makeCtx();
      installViolationGraph(ctx); // scope `demo` has a snapshot with skippedCount 3
      const r = await call(name, args, ctx);
      expect(r.result).toBeUndefined();
      expect(r.error?.code).toBe("INPUT_INVALID");
      for (const field of fields) expect(r.error?.message).toContain(`'${field}'`);
      expect(r.error?.details).toMatchObject({ tool: name, fields });
      expect(Array.isArray((r.error?.details as { issues: unknown[] }).issues)).toBe(true);
      // the envelope is the normal one: graphCompleteness is always present
      expect(r.graphCompleteness).toBeDefined();
      const addressesDemo = args.scope === "demo";
      expect(r.graphCompleteness).toEqual(
        addressesDemo ? { skippedCount: 3, lastRebuildAt: "2026-10-29T00:00:00.000Z" } : { skippedCount: 0, lastRebuildAt: null }
      );
    });
  }

  it("an invalid `scope` is handled without crashing: completeness falls back to the no-snapshot value", async () => {
    const { ctx } = makeCtx();
    for (const scope of [undefined, 7, "", null, { a: 1 }, []]) {
      const r = await call("listViolations", { scope }, ctx);
      expect(r.error?.code, JSON.stringify(scope)).toBe("INPUT_INVALID");
      expect(r.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
    }
  });

  it("the registered schemas are permissive, so the SDK can never answer before the handler", () => {
    for (const t of tools) {
      for (const [field, schema] of Object.entries(t.inputSchema)) {
        // every field accepts anything (including undefined) — the strict check is in the handler
        expect(schema.safeParse(undefined).success, `${t.name}.${field} undefined`).toBe(true);
        expect(schema.safeParse(123).success, `${t.name}.${field} number`).toBe(true);
        expect(schema.safeParse({ nope: true }).success, `${t.name}.${field} object`).toBe(true);
      }
    }
  });

  it("tool discovery still documents every field (the .describe() text survives)", () => {
    const described = (name: string): string[] =>
      Object.values(tool(name).inputSchema).map((s) => s.description ?? "");
    expect(described("rebuild")).toEqual([expect.stringContaining("Scope name"), expect.stringContaining("Staged mode")]);
    expect(described("queryPath")).toEqual([
      expect.stringContaining("Scope"),
      expect.stringContaining("Source node id"),
      expect.stringContaining("Target node id"),
      expect.stringContaining("edge direction"),
      expect.stringContaining("Maximum path steps")
    ]);
    expect(described("queryImpact")).toHaveLength(5);
    for (const line of described("queryImpact")) expect(line.length).toBeGreaterThan(0);
    expect(described("defineScope")).toHaveLength(2);
    expect(described("listViolations")).toHaveLength(1);
    expect(described("listScopes")).toEqual([]);
  });

  it("valid input still reaches the handler for every tool", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx);
    expect((await call("listViolations", { scope: "demo" }, ctx)).error).toBeUndefined();
    expect((await call("listScopes", {}, ctx)).error).toBeUndefined();
    // extra, undeclared keys are stripped, never rejected
    expect((await call("listScopes", { stray: 1 }, ctx)).error).toBeUndefined();
    expect((await call("listViolations", { scope: "demo", stray: 1 }, ctx)).error).toBeUndefined();
  });
});

describe("defineScope / listScopes", () => {
  it("defineScope writes the file and returns { name, modules, path }; listScopes lists it", async () => {
    const { ctx, config } = makeCtx();
    const r = await call<{ name: string; modules: string[]; path: string }>("defineScope", { name: "portal", modules: ["demoportal", "x", "x"] }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ name: "portal", modules: ["demoportal", "x"], path: join(config.scopesDir, "portal.json") });
    expect(r.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
    expect(JSON.parse(readFileSync(r.result!.path, "utf8"))).toEqual({ name: "portal", modules: ["demoportal", "x"] });

    const l = await call<{ scopes: unknown[]; count: number; scopesDir: string }>("listScopes", {}, ctx);
    expect(l.result).toEqual({ scopes: [r.result], count: 1, scopesDir: config.scopesDir });
  });

  it("listScopes with no scopes dir → empty result, not an error", async () => {
    const { ctx } = makeCtx();
    const l = await call<{ scopes: unknown[]; count: number }>("listScopes", {}, ctx);
    expect(l.error).toBeUndefined();
    expect(l.result?.scopes).toEqual([]);
    expect(l.result?.count).toBe(0);
  });

  it("defineScope rejects a bad name with SCOPE_INVALID", async () => {
    const { ctx } = makeCtx();
    const r = await call("defineScope", { name: "a/b", modules: ["x"] }, ctx);
    expect(r.error?.code).toBe("SCOPE_INVALID");
    expect(r.result).toBeUndefined();
    expect(r.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
  });
});

describe("listViolations", () => {
  it("reports the two planted violations and the UNKNOWN module, with graphCompleteness from meta.json", async () => {
    const { ctx } = makeCtx();
    const path = installViolationGraph(ctx);
    const r = await call<{ violations: Array<Record<string, string>>; unknownModules: string[]; count: number; snapshotPath: string }>(
      "listViolations",
      { scope: "demo" },
      ctx
    );
    expect(r.error).toBeUndefined();
    expect(r.result?.count).toBe(2);
    expect(r.result?.violations.map((v) => [v.sourceLayer, v.targetLayer])).toEqual([
      ["BL", "CW"],
      ["UI", "CS"]
    ]);
    expect(r.result?.violations[1]).toEqual({
      source: "osgraph://Demo_UI/Screen/MainFlow/Home",
      target: "osgraph://Demo_CS/Entity/Customer",
      sourceLayer: "UI",
      targetLayer: "CS",
      relation: "references",
      sourceModule: "Demo_UI",
      targetModule: "Demo_CS"
    });
    expect(r.result?.unknownModules).toEqual(["Foundation"]);
    expect(r.result?.snapshotPath).toBe(path);
    expect(r.graphCompleteness).toEqual({ skippedCount: 3, lastRebuildAt: "2026-10-29T00:00:00.000Z" });
  });

  it("SCOPE_NOT_FOUND when neither scope nor snapshot exists; SNAPSHOT_MISSING when only the scope exists", async () => {
    const { ctx } = makeCtx();
    expect((await call("listViolations", { scope: "nope" }, ctx)).error?.code).toBe("SCOPE_NOT_FOUND");
    ctx.scopeStore.define({ name: "empty", modules: ["A"] });
    const r = await call("listViolations", { scope: "empty" }, ctx);
    expect(r.error?.code).toBe("SNAPSHOT_MISSING");
    expect(r.error?.message).toContain("rebuild");
    expect(r.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
  });

  /**
   * S6 audit F7. This previously asserted `{0, null}` — the same value as "no snapshot exists" —
   * for a snapshot the tool is nonetheless answering from, with a comment acknowledging it. The
   * uncertainty is now explicit: the fixture graph has no `graph.osgraph.skipped` and no meta.json,
   * so the two numbers are placeholders and `completenessUnknown` says so.
   */
  it("a snapshot without meta.json still answers, but flags its completeness as unknown", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx, "nometa", false);
    const r = await call<{ count: number }>("listViolations", { scope: "nometa" }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.result?.count).toBe(2); // the tool answers from that snapshot...
    expect(r.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null, completenessUnknown: true });
    // ...and "no snapshot at all" is still distinguishable from it
    const absent = await call("listViolations", { scope: "nope" }, ctx);
    expect(absent.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
  });

  it("a snapshot WITH a readable graph but no meta.json reports the graph's own skipped count", async () => {
    const { ctx } = makeCtx();
    ctx.scopeStore.define({ name: "nometa2", modules: ["A"] });
    const path = ctx.snapshotPath("nometa2");
    mkdirSync(dirname(path), { recursive: true });
    const graph = JSON.parse(readFileSync(violationGraph, "utf8")) as Snapshot;
    graph.graph.osgraph = { ...graph.graph.osgraph, skipped: [{ module: "A", kind: "Screen", name: "S", reason: "TOOL_ERROR" }] };
    writeFileSync(path, canonicalJson(graph));
    const r = await call("listViolations", { scope: "nometa2" }, ctx);
    expect(r.graphCompleteness).toEqual({ skippedCount: 1, lastRebuildAt: null });
  });
});

describe("queryImpact", () => {
  const home = "osgraph://Demo_UI/Screen/MainFlow/Home";
  const header = "osgraph://Demo_CW/Block/Common/Header";
  const customer = "osgraph://Demo_CS/Entity/Customer";

  it("dependencies: everything Home reaches, sorted by (depth, id), with traversed edges", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx);
    const r = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: home, direction: "dependencies" }, ctx);
    expect(r.error).toBeUndefined();
    const res = r.result!;
    expect(res.root).toBe(home);
    expect(res.direction).toBe("dependencies");
    expect(res.maxDepth).toBeNull();
    expect(res.nodes.map((n) => [n.depth, n.id])).toEqual([
      [1, customer],
      [1, header],
      [1, "osgraph://Foundation/Block/Layouts/LayoutMain"],
      [2, "osgraph://Demo_SL/ServerAction/SL_Do"],
      [3, "osgraph://Demo_BL/ServerAction/BL_Do"]
    ]);
    expect(res.count).toBe(5);
    expect(res.nodes[2]).toMatchObject({ external: true, module: "Foundation", layer: "UNKNOWN", kind: "Block", label: "LayoutMain" });
    expect(res.edges).toHaveLength(7); // 4-edge chain + UI->CS + BL->CW back-edge + Home->LayoutMain
    expect(res.edges.every((e) => typeof e.relation === "string" && typeof e.confidence === "string")).toBe(true);
    expect(r.graphCompleteness).toEqual({ skippedCount: 3, lastRebuildAt: "2026-10-29T00:00:00.000Z" });
  });

  it("dependents: who points at Customer, directly and transitively", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx);
    const r = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: customer, direction: "dependents" }, ctx);
    expect(r.result?.nodes.map((n) => [n.depth, n.id])).toEqual([
      [1, "osgraph://Demo_BL/ServerAction/BL_Do"],
      [1, home],
      [2, "osgraph://Demo_SL/ServerAction/SL_Do"],
      [3, header]
    ]);
  });

  it("maxDepth caps the traversal", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx);
    const r = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: customer, direction: "dependents", maxDepth: 1 }, ctx);
    expect(r.result?.maxDepth).toBe(1);
    expect(r.result?.nodes.map((n) => n.id)).toEqual(["osgraph://Demo_BL/ServerAction/BL_Do", home]);
    expect(r.result?.edges).toHaveLength(2);
  });

  it("UNKNOWN_NODE for an id not in the snapshot (error still carries graphCompleteness)", async () => {
    const { ctx } = makeCtx();
    installViolationGraph(ctx);
    const r = await call("queryImpact", { scope: "demo", nodeId: "osgraph://Demo_UI/Screen/Nope", direction: "dependents" }, ctx);
    expect(r.error?.code).toBe("UNKNOWN_NODE");
    expect(r.error?.details).toMatchObject({ nodeId: "osgraph://Demo_UI/Screen/Nope", suggestions: expect.any(Array) });
    expect(r.graphCompleteness).toEqual({ skippedCount: 3, lastRebuildAt: "2026-10-29T00:00:00.000Z" });
  });

  it("module-level nodes work as roots and cycles terminate", () => {
    const snap: Pick<Snapshot, "nodes" | "links"> = {
      nodes: ["a", "b", "c"].map((id) => ({ id, label: id, file_type: "code", source_file: id, kind: "Entity" })),
      links: [
        { source: "a", target: "b", relation: "references", confidence: "EXTRACTED", confidence_score: 1, source_file: "a" },
        { source: "b", target: "c", relation: "references", confidence: "EXTRACTED", confidence_score: 1, source_file: "b" },
        { source: "c", target: "a", relation: "references", confidence: "EXTRACTED", confidence_score: 1, source_file: "c" }
      ]
    };
    const r = computeImpact(snap, "a", "dependencies");
    expect(r.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(r.edges).toHaveLength(3);
  });
});

describe("queryPath (handler with injected graphify runner)", () => {
  // F6: `from`/`to` are bare positionals for graphify, so the schema requires the osgraph:// scheme.
  const FROM = "osgraph://Demo_UI/Screen/MainFlow/Home";
  const TO = "osgraph://Demo_CS/Entity/Customer";

  it("passes bin/snapshot/args through, returns found/hops/path/raw", async () => {
    const calls: unknown[] = [];
    const { ctx, config } = makeCtx({
      runGraphifyPath: async (o) => {
        calls.push(o);
        return { found: true, hops: 1, path: [{ label: "A" }, { label: "B", relation: "calls", confidence: "EXTRACTED" }], raw: "Shortest path (1 hop):\n  A --calls [EXTRACTED]--> B\n" };
      }
    });
    const path = installViolationGraph(ctx);
    const r = await call<Record<string, unknown>>("queryPath", { scope: "demo", from: FROM, to: TO, undirected: true }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ found: true, hops: 1, from: FROM, to: TO, undirected: true, graphifyVersion: null });
    expect(calls[0]).toMatchObject({ graphifyBin: config.graphifyBin, from: FROM, to: TO, undirected: true, snapshotPath: path });
    expect(r.graphCompleteness.skippedCount).toBe(3);
  });

  it("found:false passes through; runner errors keep their code", async () => {
    const { ctx } = makeCtx({ runGraphifyPath: async () => ({ found: false, raw: "No directed path found" }) });
    installViolationGraph(ctx);
    const r = await call<Record<string, unknown>>("queryPath", { scope: "demo", from: FROM, to: TO }, ctx);
    expect(r.result).toEqual({ found: false, total: 0, limit: 200, truncated: false, from: FROM, to: TO, undirected: false, raw: "No directed path found", graphifyVersion: null });

    const { ctx: ctx2 } = makeCtx({
      runGraphifyPath: async () => {
        const { OsgraphToolError } = await import("../src/servicestudio/types.js");
        throw new OsgraphToolError("GRAPHIFY_NOT_FOUND", "graphify executable 'graphify' was not found on PATH");
      }
    });
    installViolationGraph(ctx2);
    const r2 = await call("queryPath", { scope: "demo", from: FROM, to: TO }, ctx2);
    expect(r2.error?.code).toBe("GRAPHIFY_NOT_FOUND");
    expect(r2.graphCompleteness.skippedCount).toBe(3);
  });

  it("SNAPSHOT_MISSING / SCOPE_NOT_FOUND before any spawn", async () => {
    let spawned = false;
    const { ctx } = makeCtx({
      runGraphifyPath: async () => {
        spawned = true;
        return { found: false, raw: "" };
      }
    });
    expect((await call("queryPath", { scope: "demo", from: FROM, to: TO }, ctx)).error?.code).toBe("SCOPE_NOT_FOUND");
    ctx.scopeStore.define({ name: "demo", modules: ["A"] });
    expect((await call("queryPath", { scope: "demo", from: FROM, to: TO }, ctx)).error?.code).toBe("SNAPSHOT_MISSING");
    expect(spawned).toBe(false);
  });
});

describe("rebuild (handler)", () => {
  it("rebuilds a defined scope through the fake session and reports the OSG-007/ADR-0005 result shape", async () => {
    const { ctx, logs } = makeCtx();
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);
    const r = await call<RebuildResult>("rebuild", { scope: "portal" }, ctx);
    expect(r.error).toBeUndefined();
    const res = r.result!;
    expect(Object.keys(res).sort()).toEqual([
      "droppedEdgeCount",
      "durationMs",
      "edgeCount",
      "fetchConcurrency",
      "flows",
      "nodeCount",
      "perModule",
      "placeholderCount",
      // The live progress site's URL travels in the result, because stderr is commonly swallowed.
      "progressSite",
      "referencedOnlyCount",
      "skippedElements",
      "snapshotPath",
      "unknownModuleCount",
      "unresolvedExternalCount",
      "violationCount"
    ]);
    expect(res.snapshotPath).toBe(ctx.snapshotPath("portal"));
    expect(existsSync(res.snapshotPath)).toBe(true);
    expect(res.perModule.map((m) => m.module)).toEqual(["demoportal", "x"]);
    expect(r.graphCompleteness).toEqual({ skippedCount: res.skippedElements.length, lastRebuildAt: "2026-10-30T12:00:00.000Z" });
    // progress went to the injected log sink (module + phase lines by default, no per-element ok lines)
    expect(logs.some((l) => l.includes("module 1/2 'demoportal'"))).toBe(true);
    expect(logs.some((l) => / ok \d+ms$/.test(l))).toBe(false);
    expect(logs.at(-1)).toContain("rebuild: done");

    // queries now work against the fresh snapshot
    const v = await call<{ count: number }>("listViolations", { scope: "portal" }, ctx);
    expect(v.error).toBeUndefined();
    const i = await call<QueryImpactResult>("queryImpact", { scope: "portal", nodeId: "osgraph://demoportal/Screen/SignIn/SignIn", direction: "dependencies", maxDepth: 1 }, ctx);
    expect(i.error).toBeUndefined();
    expect(i.result?.nodes.map((n) => n.id)).toContain("osgraph://demoportal/ServerAction/OnSignInReady");
  });

  it("SCOPE_NOT_FOUND without touching servicestudio", async () => {
    let sessions = 0;
    const { ctx } = makeCtx({
      createSession: () => {
        sessions++;
        return fakeSession([]);
      }
    });
    const r = await call("rebuild", { scope: "missing" }, ctx);
    expect(r.error?.code).toBe("SCOPE_NOT_FOUND");
    expect(sessions).toBe(0);
  });

  it("MODULES_NOT_OPEN error response keeps the previous snapshot and reports its completeness", async () => {
    const { ctx } = makeCtx({
      createSession: () => fakeSession([demoPortalModule()], { apps: [app("demoportal"), app("x", { isOpen: false })] })
    });
    const path = installViolationGraph(ctx, "portal");
    ctx.scopeStore.define({ name: "portal", modules: ["demoportal", "x"] });
    const before = readFileSync(path, "utf8");
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error?.code).toBe("MODULES_NOT_OPEN");
    expect(r.error?.details).toEqual({ scope: "portal", missing: ["x"], open: ["demoportal"] });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(r.graphCompleteness).toEqual({ skippedCount: 3, lastRebuildAt: "2026-10-29T00:00:00.000Z" });
  });

  it("TOKEN_EXPIRED propagates with the exact ADR-0004 message", async () => {
    const { ctx } = makeCtx({ createSession: () => fakeSession([demoPortalModule(), syntheticXModule()], { acquireError: tokenExpiredError() }) });
    ctx.scopeStore.define({ name: "portal", modules: ["demoportal"] });
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error).toMatchObject({ code: "TOKEN_EXPIRED", message: "session token invalid; a human must approve a new one in Service Studio" });
  });

  it("unexpected exceptions become INTERNAL_ERROR responses", async () => {
    const { ctx } = makeCtx({
      createSession: () => {
        throw new Error("kaboom");
      }
    });
    ctx.scopeStore.define({ name: "portal", modules: ["demoportal"] });
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error).toEqual({ code: "INTERNAL_ERROR", message: "kaboom" });
  });

  it("two concurrent rebuilds: the second gets REBUILD_IN_PROGRESS, and the read pool stays one pool", async () => {
    // one shared fake session, so `maxInFlight` measures the whole process, not one call (F1)
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const { ctx } = makeCtx({ createSession: () => session });
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);

    const first = call<RebuildResult>("rebuild", { scope: "portal" }, ctx);
    // the first rebuild has already yielded at its first await, so this one overlaps it
    const second = await call("rebuild", { scope: "portal" }, ctx);
    expect(second.error?.code).toBe("REBUILD_IN_PROGRESS");
    expect(second.error?.details).toEqual({ scope: "portal" });
    expect(second.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null }); // OSG-011 still rides along
    expect(second.result).toBeUndefined();

    const done = await first;
    expect(done.error).toBeUndefined();
    expect(session.acquired).toBe(1);
    expect(session.released).toBe(1);
    // ADR-0013: reads run up to `fetchConcurrency` wide, but the pool is per PROCESS — the second
    // rebuild was refused, so the width never doubled even though two tool calls overlapped.
    expect(session.reader.maxInFlight).toBe(ctx.config.fetchConcurrency);
    expect(done.result?.fetchConcurrency).toBe(ctx.config.fetchConcurrency);
    // exactly one writer touched the snapshot: it parses, and no staging file was left behind
    const dir = dirname(ctx.snapshotPath("portal"));
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    // `raw/` is the F0 capture, written by the one rebuild that ran; nothing else may be here.
    expect(readdirSync(dir).sort()).toEqual(["flows.json", "graph.json", "meta.json", "raw", "timings.json"]);
    expect(() => JSON.parse(readFileSync(ctx.snapshotPath("portal"), "utf8"))).not.toThrow();

    // the gate is released, so a later rebuild runs normally
    expect((await call("rebuild", { scope: "portal" }, ctx)).error).toBeUndefined();
  });

  it("the default context builds one servicestudio client for the whole process (ADR-0007/F1)", () => {
    const root = tmp();
    const ctx = createToolContext({
      // the discard port: refused immediately, so no test can reach a live Service Studio
      serviceStudioUrl: "http://127.0.0.1:9/mcp",
      tokenFile: undefined,
      graphDir: join(root, "graphs"),
      scopesDir: join(root, "scopes"),
      graphifyBin: "graphify"
    });
    const a = ctx.createSession();
    const b = ctx.createSession();
    expect(a.reader).toBe(b.reader); // same client ⇒ one promise queue across tool calls
  });

  it("F1: a shared session's release() keeps the token until the last holder is done", async () => {
    const events: string[] = [];
    const factory = createSharedSessionFactory(() => {
      events.push("built");
      return {
        reader: fakeSession([]).reader,
        tokenProvider: {
          acquire: async () => {
            events.push("acquire");
            return "tok";
          },
          clear: () => events.push("clear")
        }
      };
    });
    const a = factory();
    const b = factory();
    expect(a.reader).toBe(b.reader);
    await a.acquire();
    await b.acquire();
    a.release();
    expect(events).toEqual(["built", "acquire", "acquire"]); // b is still reading: no clear
    b.release();
    expect(events).toEqual(["built", "acquire", "acquire", "clear"]);
    // a failed acquire still balances its own release
    const c = factory();
    c.release();
    expect(events.filter((e) => e === "clear")).toHaveLength(2);
    expect(events.filter((e) => e === "built")).toHaveLength(1); // built once, memoised
  });

  it("F12: the token is redacted out of an INTERNAL_ERROR message", async () => {
    const SECRET = "tok-abcdef0123456789";
    const { ctx } = makeCtx({
      createSession: () => {
        throw new Error(`boom while using sessionToken=${SECRET}`);
      },
      redactSecrets: (text) => text.split(SECRET).join("[redacted]")
    });
    ctx.scopeStore.define({ name: "portal", modules: ["demoportal"] });
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error?.code).toBe("INTERNAL_ERROR");
    expect(r.error?.message).not.toContain(SECRET);
    expect(r.error?.message).toContain("[redacted]");
  });

  it("ADR-0004/DoD: the session token appears in no rebuild response, graph.json or meta.json", async () => {
    const SECRET = "osgraph-test-token-9f3c7b1e";
    const session = fakeSession([demoPortalModule(), syntheticXModule()], { token: SECRET });
    const { ctx, logs } = makeCtx({ createSession: () => session });
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);
    const r = await call<RebuildResult>("rebuild", { scope: "portal" }, ctx);
    expect(r.error).toBeUndefined();
    const path = r.result!.snapshotPath;
    for (const text of [
      JSON.stringify(r),
      readFileSync(path, "utf8"),
      readFileSync(join(dirname(path), "meta.json"), "utf8"),
      logs.join("\n")
    ]) {
      expect(text).not.toContain(SECRET);
    }
    expect(session.handedOut).toBe(SECRET); // the token really was in play
  });

  it("progressSink honours OSGRAPH_REBUILD_PROGRESS", () => {
    const { ctx } = makeCtx({ env: { OSGRAPH_REBUILD_PROGRESS: "off" } });
    expect(progressSink(ctx)).toBeUndefined();
    const { ctx: verbose, logs } = makeCtx({ env: { OSGRAPH_REBUILD_PROGRESS: "verbose" } });
    progressSink(verbose)!({ type: "element", module: "m", phase: "screens", kind: "Screen", name: "Home", index: 1, total: 1, outcome: "ok", durationMs: 5 });
    expect(logs).toHaveLength(1);
    const { ctx: dflt, logs: logs2 } = makeCtx();
    progressSink(dflt)!({ type: "element", module: "m", phase: "screens", kind: "Screen", name: "Home", index: 1, total: 1, outcome: "ok", durationMs: 5 });
    progressSink(dflt)!({ type: "element", module: "m", phase: "screens", kind: "Screen", name: "Home", index: 1, total: 1, outcome: "skipped", durationMs: 5 });
    expect(logs2).toHaveLength(1);
    expect(logs2[0]).toContain("skipped");
  });
});
