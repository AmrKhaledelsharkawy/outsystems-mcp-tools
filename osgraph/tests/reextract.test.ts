/**
 * F4: `flows.json` as a scope artifact, and the offline `reextract` path (ADR-0012).
 *
 * The contract under test is the one the whole design rests on: re-extracting from `raw/` with no
 * Service Studio reproduces what the live rebuild produced, **byte for byte** in the snapshot, with
 * only `meta.json`'s clock fields free to differ.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayerRules } from "../src/layers/rules.js";
import { rebuildScope, stageModule, type RebuildResult } from "../src/rebuild/rebuild.js";
import { reextractScope } from "../src/reextract.js";
import { listRawModules, rawManifestPath } from "../src/rebuild/raw.js";
import { flowsPath, readFlowsState, requireFlows, type FlowsArtifact } from "../src/flows/index.js";
import { metaPath } from "../src/graph/io.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";
import { parseArgs } from "../src/cli/args.js";
import { demoPortalModule, fakeSession, syntheticXModule } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-reextract-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scope = { name: "demo", modules: ["demoportal", "x"] };
const fixedNow = (): Date => new Date("2026-10-30T12:00:00.000Z");
const laterNow = (): Date => new Date("2026-10-31T09:30:00.000Z");

interface LiveRun {
  graphDir: string;
  snapshotPath: string;
  result: RebuildResult;
  graph: string;
  flows: FlowsArtifact;
}

async function liveRebuild(now = fixedNow): Promise<LiveRun> {
  const graphDir = join(tmp(), "graphs");
  const snapshotPath = join(graphDir, "demo", "graph.json");
  const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()]);
  const outcome = await rebuildScope({
    scope,
    snapshotPath,
    session,
    rules,
    now,
    retryDelayMs: 0,
    rawGraphDir: graphDir
  });
  return {
    graphDir,
    snapshotPath,
    result: outcome.result,
    graph: readFileSync(snapshotPath, "utf8"),
    flows: JSON.parse(readFileSync(flowsPath(snapshotPath), "utf8")) as FlowsArtifact
  };
}

describe("rebuild writes flows.json", () => {
  it("builds the artifact beside the snapshot and reports its counts", async () => {
    const run = await liveRebuild();
    expect(existsSync(flowsPath(run.snapshotPath))).toBe(true);
    expect(run.flows.scope).toBe("demo");
    expect(run.flows.schemaVersion).toBe(1);
    expect(run.flows.builtAt).toBe(fixedNow().toISOString());
    // The artifact records which rebuild it belongs to, which is how staleness is detected.
    expect(run.flows.graphRebuiltAt).toBe(fixedNow().toISOString());
    expect(run.flows.perModule.map((m) => m.module)).toEqual(["demoportal", "x"]);
    expect(run.flows.missingCaptures).toEqual([]);

    // The synthetic SignIn screen (and the local blocks and actions) carry action flows and UI bindings.
    expect(run.flows.flowActionCount).toBeGreaterThan(0);
    expect(run.flows.flowNodeCount).toBeGreaterThan(0);
    expect(run.flows.bindingCount).toBeGreaterThan(0);
    expect(run.flows.unknownNodeCount).toBe(0);
    expect(run.flows.unknownNodeTypes).toEqual([]);
    expect(run.flows.parseErrorCount).toBe(0);

    expect(run.result.flows).toMatchObject({
      path: flowsPath(run.snapshotPath),
      flowActionCount: run.flows.flowActionCount,
      flowNodeCount: run.flows.flowNodeCount,
      unknownNodeCount: 0,
      parseErrorCount: 0,
      missingCaptures: []
    });
    const portal = run.result.perModule.find((m) => m.module === "demoportal");
    expect(portal?.flows).toMatchObject({ unknownNodeCount: 0, parseErrorCount: 0 });
    expect(portal?.flows?.flowActionCount).toBeGreaterThan(0);
  });

  it("keeps graph.json free of flow data, so the Graphify contract is untouched (ADR-0001/0010)", async () => {
    const run = await liveRebuild();
    // No node id of the flow IR shape (`…#Action` or `…/n<k>`) may appear in the snapshot.
    expect(run.graph).not.toMatch(/osgraph:\/\/[^"]*#/);
    expect(run.graph).not.toMatch(/osgraph:\/\/[^"]*\/n\d+"/);
    expect(run.graph).not.toContain("ExecuteServerAction");
    expect(run.graph).not.toContain("connectors");
  });

  it("writes no flows.json when the rebuild took no raw capture", async () => {
    const graphDir = join(tmp(), "graphs");
    const snapshotPath = join(graphDir, "demo", "graph.json");
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const outcome = await rebuildScope({ scope, snapshotPath, session, rules, now: fixedNow, retryDelayMs: 0 });
    expect(existsSync(flowsPath(snapshotPath))).toBe(false);
    expect(outcome.result.flows).toBeUndefined();
  });

  it("is deterministic: two rebuilds give byte-identical flows.json", async () => {
    const a = await liveRebuild();
    const b = await liveRebuild();
    expect(readFileSync(flowsPath(b.snapshotPath), "utf8")).toBe(readFileSync(flowsPath(a.snapshotPath), "utf8"));
  });

  it("finalizes flows on the staged path too", async () => {
    const graphDir = join(tmp(), "graphs");
    const snapshotPath = join(graphDir, "demo", "graph.json");
    for (const module of scope.modules) {
      const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()]);
      const staged = await stageModule({
        scope,
        module,
        graphDir,
        snapshotPath,
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0
      });
      if (module === scope.modules[scope.modules.length - 1]) expect(staged.finalized).toBe(true);
    }
    const flows = JSON.parse(readFileSync(flowsPath(snapshotPath), "utf8")) as FlowsArtifact;
    expect(flows.perModule.map((m) => m.module)).toEqual(["demoportal", "x"]);
    expect(flows.flowNodeCount).toBeGreaterThan(0);
  });
});

describe("reextract reproduces a live rebuild offline", () => {
  it("writes a byte-identical graph.json and flows.json from raw/ alone", async () => {
    const live = await liveRebuild();

    // Nothing from the live run is reused: a fresh snapshot path, no session, no reader, no token.
    const result = reextractScope({
      scope,
      graphDir: live.graphDir,
      snapshotPath: live.snapshotPath,
      rules,
      now: fixedNow
    });

    expect(readFileSync(live.snapshotPath, "utf8")).toBe(live.graph);
    expect(JSON.parse(readFileSync(flowsPath(live.snapshotPath), "utf8"))).toEqual(live.flows);
    expect(result.nodeCount).toBe(live.result.nodeCount);
    expect(result.edgeCount).toBe(live.result.edgeCount);
    expect(result.flowActionCount).toBe(live.result.flows?.flowActionCount);
    expect(result.flowNodeCount).toBe(live.result.flows?.flowNodeCount);
    expect(result.missingCaptures).toEqual([]);
    expect(result.modules.map((m) => m.module)).toEqual(["demoportal", "x"]);
  });

  it("is byte-identical whether the captures are schema 2 or older schema 1 (#61)", async () => {
    const live = await liveRebuild();
    // Downgrade every manifest to schema 1: no identity fields, as an old capture would be.
    for (const name of listRawModules(live.graphDir, "demo")) {
      const path = rawManifestPath(live.graphDir, "demo", name);
      const m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      delete m.moduleKey;
      delete m.moduleVersion;
      delete m.moduleIdentityReason;
      writeFileSync(path, JSON.stringify({ ...m, schemaVersion: 1 }), "utf8");
    }
    reextractScope({ scope, graphDir: live.graphDir, snapshotPath: live.snapshotPath, rules, now: fixedNow });
    expect(readFileSync(live.snapshotPath, "utf8")).toBe(live.graph);
    expect(JSON.parse(readFileSync(flowsPath(live.snapshotPath), "utf8"))).toEqual(live.flows);
  });

  it("differs from the live run only in meta's clock, never in the snapshot", async () => {
    const live = await liveRebuild();
    reextractScope({ scope, graphDir: live.graphDir, snapshotPath: live.snapshotPath, rules, now: laterNow });
    // The data is identical...
    expect(readFileSync(live.snapshotPath, "utf8")).toBe(live.graph);
    // ...and only the timestamps moved, which is what makes them the one allowed difference.
    const meta = JSON.parse(readFileSync(metaPath(live.snapshotPath), "utf8")) as { rebuiltAt: string };
    expect(meta.rebuiltAt).toBe(laterNow().toISOString());
    const flows = JSON.parse(readFileSync(flowsPath(live.snapshotPath), "utf8")) as FlowsArtifact;
    expect(flows.graphRebuiltAt).toBe(laterNow().toISOString());
    expect(readFlowsState(live.snapshotPath).state).toBe("ok");
  });

  it("carries the live run's element-read skips through, so the offline snapshot claims no more than was read", async () => {
    const graphDir = join(tmp(), "graphs");
    const snapshotPath = join(graphDir, "demo", "graph.json");
    const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()], {
      failures: { "getScreen:demoportal:SignIn": Infinity }
    });
    const live = await rebuildScope({ scope, snapshotPath, session, rules, now: fixedNow, retryDelayMs: 0, rawGraphDir: graphDir });
    const before = readFileSync(snapshotPath, "utf8");
    expect(live.result.skippedElements).toContainEqual({
      module: "demoportal",
      kind: "Screen",
      name: "SignIn",
      reason: "TOOL_ERROR"
    });
    reextractScope({ scope, graphDir, snapshotPath, rules, now: fixedNow });
    expect(readFileSync(snapshotPath, "utf8")).toBe(before);
  });

  it("names a module with no raw capture instead of quietly producing a thinner graph", async () => {
    const live = await liveRebuild();
    // Simulate a capture that was never taken (or was taken by an aborted run).
    rmSync(join(live.graphDir, "demo", "raw", "x"), { recursive: true, force: true });
    const result = reextractScope({
      scope,
      graphDir: live.graphDir,
      snapshotPath: live.snapshotPath,
      rules,
      now: fixedNow
    });
    expect(result.missingCaptures).toEqual([
      expect.objectContaining({ module: "x", code: "RAW_NOT_CAPTURED" })
    ]);
    expect(result.modules.map((m) => m.module)).toEqual(["demoportal"]);
  });

  it("refuses to write anything when NO module has a usable capture", async () => {
    const live = await liveRebuild();
    const before = readFileSync(live.snapshotPath, "utf8");
    rmSync(join(live.graphDir, "demo", "raw"), { recursive: true, force: true });
    let caught: OsgraphToolError | undefined;
    try {
      reextractScope({ scope, graphDir: live.graphDir, snapshotPath: live.snapshotPath, rules, now: laterNow });
    } catch (err) {
      caught = err as OsgraphToolError;
    }
    expect(caught?.code).toBe("FLOWS_NOT_BUILT");
    // The existing snapshot survives untouched, exactly as on every other abort path (OSG-004).
    expect(readFileSync(live.snapshotPath, "utf8")).toBe(before);
  });
});

describe("flows staleness (ADR-0012)", () => {
  it("accepts an artifact built for the snapshot beside it", async () => {
    const live = await liveRebuild();
    expect(requireFlows(live.snapshotPath, "demo").graphRebuiltAt).toBe(fixedNow().toISOString());
  });

  it("rejects an artifact built for a different rebuild of the scope", async () => {
    const live = await liveRebuild();
    const path = flowsPath(live.snapshotPath);
    const artifact = JSON.parse(readFileSync(path, "utf8")) as FlowsArtifact;
    writeFileSync(path, JSON.stringify({ ...artifact, graphRebuiltAt: "2020-01-01T00:00:00.000Z" }), "utf8");
    const state = readFlowsState(live.snapshotPath);
    expect(state.state).toBe("stale");
    try {
      requireFlows(live.snapshotPath, "demo");
      throw new Error("expected FLOWS_NOT_BUILT");
    } catch (err) {
      expect((err as OsgraphToolError).code).toBe("FLOWS_NOT_BUILT");
      // The message must send the caller to the cheap fix, not to a live rebuild.
      expect((err as OsgraphToolError).message).toContain("osgraph reextract --scope demo");
    }
  });

  it("rejects a missing, unreadable or wrong-schema artifact, each with its own state", async () => {
    const live = await liveRebuild();
    const path = flowsPath(live.snapshotPath);

    writeFileSync(path, "{not json", "utf8");
    expect(readFlowsState(live.snapshotPath).state).toBe("unreadable");

    writeFileSync(path, JSON.stringify({ ...live.flows, schemaVersion: 99 }), "utf8");
    expect(readFlowsState(live.snapshotPath).state).toBe("schema");

    rmSync(path);
    expect(readFlowsState(live.snapshotPath).state).toBe("missing");
    try {
      requireFlows(live.snapshotPath, "demo");
      throw new Error("expected FLOWS_NOT_BUILT");
    } catch (err) {
      expect((err as OsgraphToolError).code).toBe("FLOWS_NOT_BUILT");
    }
  });
});

describe("cli argument parsing", () => {
  it("defaults to the server and reads both flag forms", () => {
    expect(parseArgs([])).toEqual({ command: "serve", options: {} });
    expect(parseArgs(["reextract", "--scope", "portal", "--json"])).toEqual({
      command: "reextract",
      options: { scope: "portal", json: "true" }
    });
    expect(parseArgs(["reextract", "--scope=portal", "--graph-dir=/tmp/g"])).toEqual({
      command: "reextract",
      options: { scope: "portal", "graph-dir": "/tmp/g" }
    });
    expect(parseArgs(["--help"])).toEqual({ command: "serve", options: { help: "true" } });
  });
});
