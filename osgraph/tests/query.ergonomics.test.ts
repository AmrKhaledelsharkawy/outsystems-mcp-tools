/**
 * #70: did-you-mean suggestions, result limits (`limit` / `total` / `truncated`) and the offline CLI
 * mirrors `osgraph impact | flow | path`. Synthetic snapshots only; nothing here touches Service
 * Studio, which the "studio shut" test enforces by making any session creation throw.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildToolArgs, CliUsageError, formatQueryResponse, runQueryCommand } from "../src/cli/query.js";
import { parseArgs, requiresServiceStudioAtStart, USAGE } from "../src/cli/args.js";
import { canonicalJson, type Snapshot } from "../src/graph/index.js";
import { FLOWS_SCHEMA_VERSION, type FlowsArtifact } from "../src/flows/build.js";
import { writeFlows } from "../src/flows/io.js";
import { boundedEditDistance, suggestNames } from "../src/suggest.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { QueryImpactResult } from "../src/tools/queryImpact.js";
import type { SearchFlowsResult } from "../src/tools/searchFlows.js";
import { call, makeCtx } from "./tools.helpers.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const violationGraph = join(fixtures, "synthetic", "violation-graph.json");

const HOME = "osgraph://Demo_UI/Screen/MainFlow/Home";
const CUSTOMER = "osgraph://Demo_CS/Entity/Customer";

function install(ctx: ToolContext, scope = "demo"): string {
  ctx.scopeStore.define({ name: scope, modules: ["Demo_UI", "Demo_CW", "Demo_SL", "Demo_BL", "Demo_CS"] });
  const path = ctx.snapshotPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(violationGraph, path);
  writeFileSync(join(dirname(path), "meta.json"), canonicalJson({ rebuiltAt: "2026-10-29T00:00:00.000Z", scope, skippedCount: 0 }));
  return path;
}

/** A wide synthetic graph: hub -> n0..n(count-1), each a one-hop dependency. */
function installFan(ctx: ToolContext, count: number, scope = "fan"): void {
  ctx.scopeStore.define({ name: scope, modules: ["Fan"] });
  const path = ctx.snapshotPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  const ids = Array.from({ length: count }, (_, i) => `osgraph://Fan/Entity/Item${String(i).padStart(3, "0")}`);
  const hub = "osgraph://Fan/ServerAction/Hub";
  const snapshot = {
    nodes: [hub, ...ids].map((id) => ({ id, label: id.split("/").pop(), file_type: "code", source_file: "x", kind: id.includes("Hub") ? "ServerAction" : "Entity", module: "Fan" })),
    links: ids.map((id) => ({ source: hub, target: id, relation: "references", confidence: "EXTRACTED", confidence_score: 1, source_file: "x" }))
  };
  writeFileSync(path, canonicalJson(snapshot as unknown as Snapshot));
  writeFileSync(join(dirname(path), "meta.json"), canonicalJson({ rebuiltAt: "2026-10-29T00:00:00.000Z", scope, skippedCount: 0 }));
}

function installFlows(ctx: ToolContext, scope = "demo"): void {
  const owner = "osgraph://Demo_UI/Screen/MainFlow/Home";
  const node = (k: number, type: string, extra: object = {}) => ({ id: `${owner}#Load/n${k}`, type, ...extra });
  const artifact = {
    schemaVersion: FLOWS_SCHEMA_VERSION,
    scope,
    builtAt: "2026-10-29T01:00:00.000Z",
    graphRebuiltAt: "2026-10-29T00:00:00.000Z",
    flowActionCount: 1,
    flowNodeCount: 3,
    bindingCount: 0,
    unknownNodeCount: 0,
    parseErrorCount: 0,
    unknownNodeTypes: [],
    perModule: [],
    missingCaptures: [],
    modules: [
      {
        module: "Demo_UI",
        actions: [
          {
            id: `${owner}#Load`,
            owner,
            name: "Load",
            kind: "ScreenAction",
            parameters: [],
            nodes: [
              node(1, "Start"),
              node(2, "ExecuteServerAction", { callee: { text: "SL_Do", name: "SL_Do" }, label: "Do" }),
              node(3, "ExecuteServerAction", { callee: { text: "SL_Do2", name: "SL_Do2" } })
            ],
            connectors: [
              { from: `${owner}#Load/n1`, to: `${owner}#Load/n2`, port: "Target", via: "connectedBelow" },
              { from: `${owner}#Load/n2`, to: `${owner}#Load/n3`, port: "Target", via: "connectedBelow" }
            ]
          }
        ],
        bindings: []
      }
    ]
  } as unknown as FlowsArtifact;
  writeFlows(ctx.snapshotPath(scope), artifact);
}

describe("suggestNames", () => {
  it("ranks case-insensitive equal, then prefix, substring, edit distance", () => {
    const out = suggestNames("customer", ["osgraph://M/Entity/Customer", "osgraph://M/Entity/CustomerAddress", "osgraph://M/Entity/MyCustomerX", "osgraph://M/Entity/Custmer"]);
    expect(out).toEqual([
      "osgraph://M/Entity/Customer",
      "osgraph://M/Entity/CustomerAddress",
      "osgraph://M/Entity/MyCustomerX",
      "osgraph://M/Entity/Custmer"
    ]);
  });

  it("never suggests the exact input and respects the limit", () => {
    const names = ["alpha", "alphb", "alphc", "alphd", "alphe", "alphf", "alpha2"];
    expect(suggestNames("alpha", names)).not.toContain("alpha");
    expect(suggestNames("alpha", names, 2)).toHaveLength(2);
    expect(suggestNames("alpha", names, 0)).toEqual([]);
  });

  it("finds a typo by edit distance and returns nothing for something far away", () => {
    expect(suggestNames("Custmoer", ["Customer", "Invoice"])).toEqual(["Customer"]);
    expect(suggestNames("zzzzzzzz", ["Customer", "Invoice"])).toEqual([]);
  });

  it("boundedEditDistance stops early past the bound", () => {
    expect(boundedEditDistance("kitten", "sitting", 5)).toBe(3);
    expect(boundedEditDistance("abcdef", "uvwxyz", 2)).toBe(3);
    expect(boundedEditDistance("a", "abcdef", 2)).toBe(3);
  });
});

describe("did-you-mean on UNKNOWN_NODE / SCOPE_NOT_FOUND", () => {
  it("queryImpact: a wrong-case node id fails but suggests the exact id; the exact id still succeeds", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const wrong = await call("queryImpact", { scope: "demo", nodeId: CUSTOMER.toLowerCase().replace("osgraph://demo_cs", "osgraph://Demo_CS"), direction: "dependents" }, ctx);
    expect(wrong.error?.code).toBe("UNKNOWN_NODE");
    const details = wrong.error?.details as { nodeId: string; suggestions: string[] };
    expect(details.suggestions[0]).toBe(CUSTOMER);
    expect(wrong.error?.message).toContain("Did you mean");

    const ok = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: CUSTOMER, direction: "dependents" }, ctx);
    expect(ok.error).toBeUndefined();
  });

  it("queryImpact: a near-miss typo returns ranked candidates, at most 5", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const r = await call("queryImpact", { scope: "demo", nodeId: "osgraph://Demo_CS/Entity/Custmer", direction: "dependents" }, ctx);
    const suggestions = (r.error?.details as { suggestions: string[] }).suggestions;
    expect(suggestions).toContain(CUSTOMER);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("an unknown scope suggests the defined scopes (SCOPE_NOT_FOUND)", async () => {
    const { ctx } = makeCtx();
    install(ctx, "demo");
    install(ctx, "portal");
    const r = await call("queryImpact", { scope: "dmeo", nodeId: HOME, direction: "dependents" }, ctx);
    expect(r.error?.code).toBe("SCOPE_NOT_FOUND");
    expect((r.error?.details as { suggestions: string[] }).suggestions[0]).toBe("demo");
    expect(r.error?.message).toContain("Did you mean: demo");
  });

  it("an unknown scope with nothing similar carries an empty suggestion list and no hint text", async () => {
    const { ctx } = makeCtx();
    install(ctx, "demo");
    const r = await call("queryImpact", { scope: "qqqqqqqqqq", nodeId: HOME, direction: "dependents" }, ctx);
    expect(r.error?.code).toBe("SCOPE_NOT_FOUND");
    expect((r.error?.details as { suggestions: string[] }).suggestions).toEqual([]);
    expect(r.error?.message).not.toContain("Did you mean");
  });

  it("getFlow: an unknown element suggests near names", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    installFlows(ctx);
    const r = await call("getFlow", { scope: "demo", element: "osgraph://Demo_UI/Screen/MainFlow/Hom" }, ctx);
    expect(r.error?.code).toBe("UNKNOWN_NODE");
    expect((r.error?.details as { suggestions: string[] }).suggestions).toContain(HOME);
  });

  it("queryPath: graphify's UNKNOWN_NODE is enriched with suggestions read from the snapshot", async () => {
    const { OsgraphToolError } = await import("../src/servicestudio/types.js");
    const { ctx } = makeCtx({
      runGraphifyPath: async () => {
        throw new OsgraphToolError("UNKNOWN_NODE", "No node matching", { from: "x" });
      }
    });
    install(ctx);
    const r = await call("queryPath", { scope: "demo", from: "osgraph://Demo_CS/Entity/Custmer", to: HOME }, ctx);
    expect(r.error?.code).toBe("UNKNOWN_NODE");
    const suggestions = (r.error?.details as { suggestions: Record<string, string[]> }).suggestions;
    expect(suggestions["osgraph://Demo_CS/Entity/Custmer"]).toContain(CUSTOMER);
    expect(Object.keys(suggestions)).toEqual(["osgraph://Demo_CS/Entity/Custmer"]); // HOME exists
  });
});

describe("result limits", () => {
  it("queryImpact without `limit` keeps working: same nodes, plus total/truncated/limit", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const r = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: HOME, direction: "dependencies" }, ctx);
    expect(r.result).toMatchObject({ count: 5, total: 5, truncated: false, limit: 500 });
    expect(r.result?.nodes).toHaveLength(5);
    expect(r.result?.edges).toHaveLength(7);
  });

  it("queryImpact with a limit keeps the nearest nodes, reports the true total, and drops dangling edges", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const r = await call<QueryImpactResult>("queryImpact", { scope: "demo", nodeId: HOME, direction: "dependencies", limit: 2 }, ctx);
    const res = r.result!;
    expect(res.nodes).toHaveLength(2);
    expect(res.total).toBe(5);
    expect(res.count).toBe(5);
    expect(res.truncated).toBe(true);
    expect(res.totalEdges).toBe(7);
    const kept = new Set([HOME, ...res.nodes.map((n) => n.id)]);
    expect(res.edges.every((e) => kept.has(e.source) && kept.has(e.target))).toBe(true);
    expect(res.nodes.every((n) => n.depth === 1)).toBe(true);
  });

  it("queryImpact: a limit at or above the total is not truncated; a default applies to a wide fan", async () => {
    const { ctx } = makeCtx();
    installFan(ctx, 520);
    const all = await call<QueryImpactResult>("queryImpact", { scope: "fan", nodeId: "osgraph://Fan/ServerAction/Hub", direction: "dependencies" }, ctx);
    expect(all.result).toMatchObject({ total: 520, truncated: true, limit: 500 });
    expect(all.result?.nodes).toHaveLength(500);
    const exact = await call<QueryImpactResult>("queryImpact", { scope: "fan", nodeId: "osgraph://Fan/ServerAction/Hub", direction: "dependencies", limit: 520 }, ctx);
    expect(exact.result).toMatchObject({ total: 520, truncated: false });
    expect(exact.result?.nodes).toHaveLength(520);
  });

  it("queryImpact rejects a non-positive limit as INPUT_INVALID", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const r = await call("queryImpact", { scope: "demo", nodeId: HOME, direction: "dependents", limit: 0 }, ctx);
    expect(r.error?.code).toBe("INPUT_INVALID");
  });

  it("searchFlows reports total alongside totalHits, with the default documented", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    installFlows(ctx);
    const full = await call<SearchFlowsResult>("searchFlows", { scope: "demo", pattern: "SL_Do" }, ctx);
    expect(full.result).toMatchObject({ total: 2, totalHits: 2, truncated: false, limit: 200 });
    const cut = await call<SearchFlowsResult>("searchFlows", { scope: "demo", pattern: "SL_Do", limit: 1 }, ctx);
    expect(cut.result).toMatchObject({ total: 2, totalHits: 2, truncated: true, limit: 1 });
    expect(cut.result?.hits).toHaveLength(1);
  });

  it("queryPath truncates the step list, reports total, and blanks raw only when truncated", async () => {
    const path = Array.from({ length: 6 }, (_, i) => (i === 0 ? { label: "A" } : { label: `S${i}`, relation: "calls", confidence: "EXTRACTED" }));
    const { ctx } = makeCtx({ runGraphifyPath: async () => ({ found: true, hops: 5, path, raw: "RAW" }) });
    install(ctx);
    const full = await call<Record<string, unknown>>("queryPath", { scope: "demo", from: HOME, to: CUSTOMER }, ctx);
    expect(full.result).toMatchObject({ found: true, total: 6, truncated: false, limit: 200, raw: "RAW" });
    const cut = await call<{ path: unknown[]; total: number; truncated: boolean; raw: string }>("queryPath", { scope: "demo", from: HOME, to: CUSTOMER, limit: 3 }, ctx);
    expect(cut.result).toMatchObject({ total: 6, truncated: true, raw: "" });
    expect(cut.result?.path).toHaveLength(3);
  });

  it("queryPath found:false carries total 0 and truncated false", async () => {
    const { ctx } = makeCtx({ runGraphifyPath: async () => ({ found: false, raw: "none" }) });
    install(ctx);
    const r = await call("queryPath", { scope: "demo", from: HOME, to: CUSTOMER }, ctx);
    expect(r.result).toMatchObject({ found: false, total: 0, truncated: false, limit: 200 });
  });
});

describe("offline CLI mirrors", () => {
  const pathRunner = async () => ({
    found: true as const,
    hops: 1,
    path: [{ label: "Home" }, { label: "Customer", relation: "references", confidence: "EXTRACTED" }],
    raw: "Shortest path (1 hop)"
  });

  it("impact: identical response to the MCP tool on the same snapshot", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    const options = { scope: "demo", node: HOME, direction: "dependencies", limit: "3" };
    const viaCli = await runQueryCommand("impact", options, ctx);
    const viaTool = await call("queryImpact", { scope: "demo", nodeId: HOME, direction: "dependencies", limit: 3 }, ctx);
    expect(viaCli).toEqual(viaTool);
    expect(JSON.stringify(viaCli)).toBe(JSON.stringify(viaTool));
    expect((viaCli.result as QueryImpactResult).truncated).toBe(true);
  });

  it("flow: identical response to getFlow", async () => {
    const { ctx } = makeCtx();
    install(ctx);
    installFlows(ctx);
    const viaCli = await runQueryCommand("flow", { scope: "demo", element: HOME, "include-ir": "false" }, ctx);
    const viaTool = await call("getFlow", { scope: "demo", element: HOME, includeIr: false }, ctx);
    expect(viaCli.error).toBeUndefined();
    expect(viaCli).toEqual(viaTool);
  });

  it("path: identical response to queryPath", async () => {
    const { ctx } = makeCtx({ runGraphifyPath: pathRunner });
    install(ctx);
    const viaCli = await runQueryCommand("path", { scope: "demo", from: HOME, to: CUSTOMER, undirected: "true" }, ctx);
    const viaTool = await call("queryPath", { scope: "demo", from: HOME, to: CUSTOMER, undirected: true }, ctx);
    expect(viaCli).toEqual(viaTool);
    expect(viaCli.error).toBeUndefined();
  });

  it("works with Service Studio shut: no session is ever created and no endpoint is needed", async () => {
    let sessions = 0;
    const { ctx, config } = makeCtx({
      createSession: () => {
        sessions++;
        throw new Error("Service Studio must not be touched");
      },
      runGraphifyPath: pathRunner
    });
    (config as { serviceStudioUrl?: string }).serviceStudioUrl = undefined;
    install(ctx);
    installFlows(ctx);
    for (const [cmd, opts] of [
      ["impact", { scope: "demo", node: HOME, direction: "dependents" }],
      ["flow", { scope: "demo", element: HOME }],
      ["path", { scope: "demo", from: HOME, to: CUSTOMER }]
    ] as const) {
      const r = await runQueryCommand(cmd, { ...opts }, ctx);
      expect(r.error, `${cmd}: ${r.error?.message}`).toBeUndefined();
    }
    expect(sessions).toBe(0);
    for (const c of ["impact", "flow", "path"]) expect(requiresServiceStudioAtStart(c)).toBe(false);
  });

  it("human-readable output: results, truncation notice, and error suggestions", async () => {
    const { ctx } = makeCtx({ runGraphifyPath: pathRunner });
    install(ctx);
    installFlows(ctx);
    const impact = formatQueryResponse("impact", await runQueryCommand("impact", { scope: "demo", node: HOME, direction: "dependencies", limit: "2" }, ctx));
    expect(impact).toContain("5 node(s)");
    expect(impact).toContain("truncated: showing 2 of 5");
    const flow = formatQueryResponse("flow", await runQueryCommand("flow", { scope: "demo", element: HOME }, ctx));
    expect(flow).toContain("action Load");
    const path = formatQueryResponse("path", await runQueryCommand("path", { scope: "demo", from: HOME, to: CUSTOMER }, ctx));
    expect(path).toContain("1 hop(s)");
    const err = formatQueryResponse("impact", await runQueryCommand("impact", { scope: "demo", node: "osgraph://Demo_CS/Entity/Custmer", direction: "dependents" }, ctx));
    expect(err).toContain("UNKNOWN_NODE");
    expect(err).toContain(`suggestions: ${CUSTOMER}`);
  });

  it("flag parsing: missing and malformed flags are usage errors, with node ids surviving parseArgs", () => {
    expect(() => buildToolArgs("impact", { scope: "demo", direction: "dependents" })).toThrow(CliUsageError);
    expect(() => buildToolArgs("impact", { scope: "demo", node: HOME, direction: "sideways" })).toThrow(/--direction/);
    expect(() => buildToolArgs("impact", { scope: "demo", node: HOME, direction: "dependents", limit: "0" })).toThrow(/--limit/);
    expect(() => buildToolArgs("path", { scope: "demo", from: HOME })).toThrow(/--to/);
    const { command, options } = parseArgs(["impact", "--scope", "demo", "--node", HOME, "--direction=dependents", "--max-depth", "2"]);
    expect(command).toBe("impact");
    expect(buildToolArgs("impact", options)).toEqual({ scope: "demo", nodeId: HOME, direction: "dependents", maxDepth: 2 });
  });

  it("USAGE documents the three commands", () => {
    for (const c of ["osgraph impact", "osgraph flow", "osgraph path"]) expect(USAGE).toContain(c);
  });
});
