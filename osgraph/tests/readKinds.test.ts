/**
 * #69: per-kind read cost in timings.json, the zero-yield report, and the OSGRAPH_SKIP_KINDS switch.
 * Synthetic fixtures only (see PROVENANCE.md); no Service Studio.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FETCH_CONCURRENCY, loadConfig, OsgraphConfigError } from "../src/config.js";
import { parseId } from "../src/extract/ids.js";
import { flowsPath, type FlowsArtifact } from "../src/flows/index.js";
import { metaPath, readMeta, readSnapshot } from "../src/graph/io.js";
import { loadLayerRules } from "../src/layers/rules.js";
import { readTimings, writeTimings } from "../src/progress/timings.js";
import { rebuildScope, stageModule } from "../src/rebuild/rebuild.js";
import {
  DEFAULT_SKIP_KINDS,
  KindSampler,
  parseSkipKinds,
  percentile,
  PRUNABLE_KINDS,
  READ_KINDS,
  type PrunableKind
} from "../src/rebuild/readKinds.js";
import { readStage } from "../src/rebuild/stage.js";
import { reextractScope } from "../src/reextract.js";
import { buildKindReport, formatKindReport } from "../src/report/kinds.js";
import { app, demoPortalModule, demoServicesModule, fakeSession, syntheticXModule, type FakeModule } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-kinds-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scope = { name: "demo", modules: ["demoportal", "demoservices", "x"] };
const fixedNow = () => new Date("2026-11-21T12:00:00.000Z");
const modules = (): FakeModule[] => [demoPortalModule(), demoServicesModule(), syntheticXModule()];

async function build(skipKinds?: readonly PrunableKind[], graphDir = tmp()) {
  const session = fakeSession(modules());
  const snapshotPath = join(graphDir, scope.name, "graph.json");
  const outcome = await rebuildScope({
    scope,
    snapshotPath,
    session,
    rules,
    now: fixedNow,
    retryDelayMs: 0,
    rawGraphDir: graphDir,
    ...(skipKinds !== undefined ? { skipKinds } : {})
  });
  return { graphDir, snapshotPath, session, outcome };
}

describe("percentile / KindSampler", () => {
  it("uses the nearest-rank method and is independent of completion order", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);

    const a = new KindSampler();
    const b = new KindSampler();
    for (const ms of [30, 10, 20]) a.record("Screen", ms);
    for (const ms of [10, 20, 30]) b.record("Screen", ms);
    expect(a.summary()).toEqual(b.summary());
    expect(a.summary().Screen).toEqual({ calls: 3, totalMs: 60, p50Ms: 20, p95Ms: 30 });
  });

  it("reports only kinds that were called", () => {
    const s = new KindSampler();
    s.record("Entity", 4);
    expect(Object.keys(s.summary())).toEqual(["Entity"]);
  });
});

describe("OSGRAPH_SKIP_KINDS", () => {
  it("defaults to nothing, and reads comma or space separated, case-insensitive kinds in canonical order", () => {
    expect(DEFAULT_SKIP_KINDS).toEqual([]);
    expect(parseSkipKinds(undefined).kinds).toEqual([]);
    expect(parseSkipKinds("  ").kinds).toEqual([]);
    expect(parseSkipKinds("structure, CLIENTACTION entity").kinds).toEqual(["ClientAction", "Entity", "Structure"]);
  });

  it("is plumbed to the config, and a kind that cannot be switched off is a CONFIG_INVALID, not silence", () => {
    expect(loadConfig({}, { cwd: "C:/w", existsSync: () => false }).skipKinds).toEqual([]);
    expect(loadConfig({ OSGRAPH_SKIP_KINDS: "Structure" }, { cwd: "C:/w", existsSync: () => false }).skipKinds).toEqual([
      "Structure"
    ]);
    for (const bad of ["Screen", "Block", "Entity,Nope"]) {
      try {
        loadConfig({ OSGRAPH_SKIP_KINDS: bad }, { cwd: "C:/w", existsSync: () => false });
        throw new Error("expected CONFIG_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(OsgraphConfigError);
        expect((err as OsgraphConfigError).code).toBe("CONFIG_INVALID");
      }
    }
  });
});

describe("per-kind timings", () => {
  it("records call count and p50/p95 per kind per module, matching the calls the reader saw", async () => {
    const { outcome, session, graphDir } = await build();
    for (const pm of outcome.result.perModule) {
      expect(pm.kinds).toBeDefined();
      expect(Object.keys(pm.kinds ?? {}).sort()).toEqual([...READ_KINDS].sort());
      for (const k of Object.values(pm.kinds ?? {})) {
        expect(k.calls).toBeGreaterThan(0);
        expect(k.p50Ms).toBeLessThanOrEqual(k.p95Ms);
        expect(k.p95Ms).toBeLessThanOrEqual(k.totalMs);
      }
    }
    // Module-level calls are exactly one each; element calls are the fetches the reader answered.
    const portal = outcome.result.perModule.find((m) => m.module === "demoportal")?.kinds;
    const reads = (tool: string, module: string) => session.reader.calls.filter((c) => c.tool === tool && c.module === module).length;
    expect(portal?.Entity?.calls).toBe(reads("getDataModel", "demoportal"));
    expect(portal?.Structure?.calls).toBe(reads("getStructures", "demoportal"));
    expect(portal?.Screen?.calls).toBe(reads("getScreenNames", "demoportal") + reads("getScreen", "demoportal"));
    expect(portal?.ClientAction?.calls).toBe(reads("getActionNames", "demoportal") - 1 /* server */ + reads("getClientAction", "demoportal"));

    // Persisted by the writer every caller already uses.
    writeTimings(graphDir, scope.name, outcome.result.perModule);
    const file = JSON.parse(readFileSync(join(graphDir, scope.name, "timings.json"), "utf8")) as {
      modules: Record<string, { kinds?: Record<string, { calls: number; p50Ms: number; p95Ms: number }> }>;
    };
    expect(file.modules.demoportal.kinds?.Screen?.calls).toBe(portal?.Screen?.calls);
    expect(file.modules.demoportal.kinds?.Screen).toHaveProperty("p50Ms");
    expect(file.modules.demoportal.kinds?.Screen).toHaveProperty("p95Ms");
    // ...and the ETA reader is unaffected by the extra field.
    expect(readTimings(graphDir, scope.name).get("demoportal")?.kinds?.Screen?.calls).toBe(portal?.Screen?.calls);
  });

  it("a default build writes no skippedKinds anywhere", async () => {
    const { outcome, snapshotPath, graphDir } = await build();
    expect(outcome.result.skippedKinds).toBeUndefined();
    expect(readMeta(snapshotPath)?.skippedKinds).toBeUndefined();
    expect(readFileSync(metaPath(snapshotPath), "utf8")).not.toContain("skippedKinds");
    expect(readFileSync(join(graphDir, scope.name, "raw", "demoportal", "manifest.json"), "utf8")).not.toContain("skippedKinds");
  });

  it("the staged path carries per-kind timings through the stage entry into the finalized result", async () => {
    const graphDir = tmp();
    const sc = { name: "demo", modules: ["demoportal", "x"] };
    const snapshotPath = join(graphDir, "demo", "graph.json");
    const common = { scope: sc, graphDir, snapshotPath, rules, now: fixedNow, retryDelayMs: 0 };
    await stageModule({ ...common, module: "demoportal", session: fakeSession(modules()), skipKinds: ["Structure"] });
    expect(readStage(graphDir, "demo").entries[0].kinds?.Structure).toBeUndefined();
    expect(readStage(graphDir, "demo").entries[0].skippedKinds).toEqual(["Structure"]);
    const last = await stageModule({ ...common, module: "x", session: fakeSession(modules()), skipKinds: ["Structure"] });
    expect(last.finalized).toBe(true);
    const per = last.outcome?.result.perModule ?? [];
    expect(per.map((p) => p.kinds?.Entity?.calls)).toEqual([1, 1]);
    expect(last.outcome?.result.skippedKinds).toEqual(["Structure"]);
    expect(readMeta(snapshotPath)?.skippedKinds).toEqual(["Structure"]);
  });
});

describe("switching a kind off", () => {
  const combos: PrunableKind[][] = [["Structure"], ["Entity", "ClientAction"], ["ServerAction"], [...PRUNABLE_KINDS]];

  it.each(combos)("%s: no read of the switched-off kinds is issued and concurrency stays at width 4", async (...off) => {
    const { session, outcome } = await build(off);
    const tools = new Set(session.reader.calls.map((c) => `${c.tool}${c.name !== undefined ? `(${c.name})` : ""}`));
    if (off.includes("Entity")) expect([...tools].some((t) => t.startsWith("getDataModel"))).toBe(false);
    if (off.includes("Structure")) expect([...tools].some((t) => t.startsWith("getStructures"))).toBe(false);
    if (off.includes("ClientAction")) {
      expect(tools.has("getActionNames(client)")).toBe(false);
      expect(tools.has("getClientAction")).toBe(false);
      expect([...tools].some((t) => t.startsWith("getClientAction"))).toBe(false);
    }
    if (off.includes("ServerAction")) {
      expect(tools.has("getActionNames(server)")).toBe(false);
      expect(tools.has("getActionNames(service)")).toBe(false);
      expect([...tools].some((t) => t.startsWith("getServerAction") || t.startsWith("getServiceAction"))).toBe(false);
    }
    for (const pm of outcome.result.perModule) {
      for (const k of off) expect(pm.kinds?.[k]).toBeUndefined();
      expect(pm.skippedKinds).toEqual(PRUNABLE_KINDS.filter((k) => off.includes(k)));
      expect(pm.concurrency).toBe(DEFAULT_FETCH_CONCURRENCY);
    }
    // ADR-0013: never wider than 4 in flight, switched off or not.
    expect(session.reader.maxInFlight).toBeLessThanOrEqual(4);
    expect(DEFAULT_FETCH_CONCURRENCY).toBe(4);
    expect(outcome.result.skippedKinds).toEqual(PRUNABLE_KINDS.filter((k) => off.includes(k)));
    expect(outcome.meta.skippedKinds).toEqual(outcome.result.skippedKinds);
    // Fewer calls than the full read, which is the point.
    expect(session.reader.calls.length).toBeLessThan((await build()).session.reader.calls.length);
  });

  it.each(combos)("%s: graph.json and flows.json are unchanged for every kind that is still read", async (...off) => {
    const full = await build();
    const pruned = await build(off);
    const fullSnap = readSnapshot(full.snapshotPath);
    const prunedSnap = readSnapshot(pruned.snapshotPath);
    const kindOf = (id: string) => parseId(id)?.kind;
    const kept = (id: string) => !off.includes(kindOf(id) as PrunableKind);
    const isElement = (id: string) => kindOf(id) !== "module";

    // Edges whose source is an element of a kept kind: byte-for-byte the same list, in the same order.
    const edgesFrom = (snap: typeof fullSnap) => snap.links.filter((l) => isElement(l.source) && kept(l.source));
    expect(edgesFrom(prunedSnap)).toEqual(edgesFrom(fullSnap));
    expect(edgesFrom(fullSnap).length).toBeGreaterThan(0);
    // Module-to-module edges are a rollup of every kind's references, so a pruned kind may remove the
    // ones only it caused, but the pruned run can never invent one.
    const rollup = (snap: typeof fullSnap) => snap.links.filter((l) => !isElement(l.source)).map((l) => `${l.source}>${l.target}`);
    expect(rollup(fullSnap)).toEqual(expect.arrayContaining(rollup(prunedSnap)));

    // Nodes of kept kinds, minus placeholders of kept kinds that only exist because of a pruned read.
    const nodesOf = (snap: typeof fullSnap) => snap.nodes.filter((n) => n.kind !== "module" && kept(n.id) && !n.external);
    expect(nodesOf(prunedSnap)).toEqual(nodesOf(fullSnap));

    // Flows: every action owned by a kept kind is identical.
    const flowsOf = (path: string) =>
      (JSON.parse(readFileSync(flowsPath(path), "utf8")) as FlowsArtifact).modules.map((m) => ({
        module: m.module,
        actions: m.actions.filter((a) => kept(a.owner)),
        bindings: m.bindings
      }));
    expect(flowsOf(pruned.snapshotPath)).toEqual(flowsOf(full.snapshotPath));

    // Something really was removed, or this test proves nothing.
    expect(prunedSnap.links.length + prunedSnap.nodes.length).toBeLessThan(fullSnap.links.length + fullSnap.nodes.length);
    expect(flowsOf(full.snapshotPath).flatMap((m) => m.actions).length).toBeGreaterThan(0);
  });

  it("the offline reextract of a pruned capture reproduces the snapshot and keeps saying it is partial", async () => {
    const pruned = await build(["Structure", "ClientAction"]);
    const before = readFileSync(pruned.snapshotPath, "utf8");
    reextractScope({ scope, graphDir: pruned.graphDir, snapshotPath: pruned.snapshotPath, rules, now: fixedNow });
    expect(readFileSync(pruned.snapshotPath, "utf8")).toBe(before);
    expect(readMeta(pruned.snapshotPath)?.skippedKinds).toEqual(["ClientAction", "Structure"]);
  });
});

describe("kind report", () => {
  it("attributes edges and flows to kinds and read time from timings.json", async () => {
    const { graphDir, snapshotPath, outcome } = await build();
    writeTimings(graphDir, scope.name, outcome.result.perModule);
    const report = buildKindReport({ graphDir, scope: scope.name, snapshotPath });
    expect(report.rows.map((r) => r.kind)).toEqual([...READ_KINDS]);
    const row = (k: string) => report.rows.find((r) => r.kind === k)!;
    expect(row("Screen").flowActions).toBeGreaterThan(0);
    expect(row("Screen").edgesAsSource).toBeGreaterThan(0);
    expect(row("Entity").edgesAsTarget).toBeGreaterThan(0);
    expect(row("Entity").flowActions).toBe(0); // entity text carries no flows
    expect(row("Screen").calls).toBe(outcome.result.perModule.reduce((n, m) => n + (m.kinds?.Screen?.calls ?? 0), 0));
    expect(row("Screen").switchable).toBe(false);
    expect(row("Structure").switchable).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.candidates).toEqual([]);
    expect(formatKindReport(report)).toContain("no kind combines read time with zero edges and zero flows");
  });

  it("lists kinds that cost read time and yield zero edges and zero flows, with their total time", async () => {
    // A module that owns two client actions and nothing else: its entity and structure texts are
    // empty, so those two kinds were read (one call each) and yielded nothing.
    const base = syntheticXModule();
    const bare: FakeModule = { ...base, app: app("bare"), dataModel: "", structures: "", serverActions: [], texts: { ...base.texts } };
    const graphDir = tmp();
    const sc = { name: "bare-scope", modules: ["bare"] };
    const snapshotPath = join(graphDir, sc.name, "graph.json");
    const outcome = await rebuildScope({
      scope: sc,
      snapshotPath,
      session: fakeSession([bare]),
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      rawGraphDir: graphDir
    });
    // Give the zero-yield kinds a known cost so the total is asserted, not merely positive.
    const perModule = outcome.result.perModule.map((m) => ({
      ...m,
      kinds: {
        ...m.kinds,
        Entity: { calls: 1, totalMs: 1200, p50Ms: 1200, p95Ms: 1200 },
        Structure: { calls: 1, totalMs: 800, p50Ms: 800, p95Ms: 800 },
        ServerAction: { calls: 1, totalMs: 300, p50Ms: 300, p95Ms: 300 }
      }
    }));
    writeTimings(graphDir, sc.name, perModule);
    const report = buildKindReport({ graphDir, scope: sc.name, snapshotPath });
    const names = report.candidates.map((c) => c.kind);
    expect(names).toContain("Entity");
    expect(names).toContain("Structure");
    expect(names).toContain("ServerAction");
    expect(names).not.toContain("ClientAction");
    // Costliest first, and the total is the sum of the listed kinds' read time.
    expect(report.candidates[0].kind).toBe("Entity");
    expect(report.candidateReadMs).toBe(report.candidates.reduce((n, c) => n + c.totalReadMs, 0));
    expect(report.candidates.find((c) => c.kind === "Entity")?.totalReadMs).toBe(1200);
    expect(formatKindReport(report)).toMatch(/zero-yield kinds: .*Entity/);
  });

  it("does not call a kind zero-yield when the snapshot was built without it, or when flow data is missing", async () => {
    const pruned = await build(["Structure"]);
    writeTimings(pruned.graphDir, scope.name, pruned.outcome.result.perModule);
    const report = buildKindReport({ graphDir: pruned.graphDir, scope: scope.name, snapshotPath: pruned.snapshotPath });
    expect(report.skippedKinds).toEqual(["Structure"]);
    expect(report.rows.find((r) => r.kind === "Structure")?.zeroYield).toBe(false);

    rmSync(flowsPath(pruned.snapshotPath));
    const noFlows = buildKindReport({ graphDir: pruned.graphDir, scope: scope.name, snapshotPath: pruned.snapshotPath });
    expect(noFlows.rows.every((r) => !r.zeroYield)).toBe(true);
    expect(noFlows.warnings.join(" ")).toMatch(/flows\.json is missing/);
  });

  it("warns when timings predate per-kind recording, and refuses a scope with no snapshot", async () => {
    const { graphDir, snapshotPath } = await build();
    const report = buildKindReport({ graphDir, scope: scope.name, snapshotPath });
    expect(report.warnings.join(" ")).toMatch(/no per-kind timings/);
    expect(() => buildKindReport({ graphDir, scope: "nope", snapshotPath: join(graphDir, "nope", "graph.json") })).toThrow(
      /no snapshot/
    );
  });
});
