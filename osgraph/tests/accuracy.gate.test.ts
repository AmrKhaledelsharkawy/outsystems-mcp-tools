/**
 * #68 accuracy regression gate (Phase-1 subset of #26).
 *
 * Keeps graph correctness from regressing across the three ways a snapshot is produced:
 *
 *   - `osgraph run` (full staged build, `runScope`),
 *   - the MCP `rebuild` path (`rebuildScope`),
 *   - the offline `reextract` path (`reextractScope`).
 *
 * Every case runs on one **synthetic** scope served by the fixture-backed fakes: no Service Studio,
 * no osopener build, no token, no network, no real module name. Replay-green is not live-green
 * (see the repository CLAUDE.md): the one check that needs a real Studio is documented in the
 * README section "Accuracy regression gate" as a human procedure and is not exercised here.
 *
 * A failing assertion in the "byte-identical" block names the diverging artifact (`graph.json` or
 * `flows.json`), the two paths being compared and the JSON path of the first difference, via
 * {@link assertIdentical}.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildId } from "../src/extract/ids.js";
import { extractModule } from "../src/extract/extractor.js";
import type { ExtractedEdge, ModuleInput } from "../src/extract/types.js";
import { loadLayerRules } from "../src/layers/rules.js";
import { createOsopenerAdapter } from "../src/osopener/adapter.js";
import { reextractScope } from "../src/reextract.js";
import { rebuildScope, type RebuildResult } from "../src/rebuild/rebuild.js";
import type { ServiceStudioSession } from "../src/rebuild/reader.js";
import { runScope } from "../src/run/run.js";
import { readGraphCompleteness, resolveScopeArtifactPaths } from "../src/graph/io.js";
import type { Snapshot } from "../src/graph/types.js";
import type { ServiceStudioApp } from "../src/servicestudio/types.js";
import {
  FakeReader,
  demoPortalModule,
  fakeSession,
  syntheticWideModule,
  syntheticXModule,
  type FakeModule,
  type FakeReaderOptions
} from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-gate-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-11-01T00:00:00.000Z");
const now = (): Date => NOW;
const noSleep = async (): Promise<void> => undefined;
const N = "OutSystems.Model.Logic.Nodes";

/* -------------------------------------------------------------------------------------------- */
/* Divergence reporting: the failure message names the artifact and the JSON path                */
/* -------------------------------------------------------------------------------------------- */

function firstDivergence(a: unknown, b: unknown, path = "$"): string | undefined {
  if (a === b) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const d = firstDivergence(a[i], b[i], `${path}[${i}]`);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDivergence((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
}

/** Throws a message naming the artifact, both producers and the first diverging JSON path. */
function assertIdentical(artifact: "graph.json" | "flows.json", labelA: string, textA: string, labelB: string, textB: string): void {
  if (textA === textB) return;
  let where: string;
  try {
    where = firstDivergence(JSON.parse(textA), JSON.parse(textB)) ?? "bytes differ but parsed JSON is equal (formatting)";
  } catch {
    where = "one side is not valid JSON";
  }
  throw new Error(`${artifact} diverges between ${labelA} and ${labelB} at ${where}`);
}

/* -------------------------------------------------------------------------------------------- */
/* The synthetic scope                                                                           */
/* -------------------------------------------------------------------------------------------- */

const producerText = (action: string): string =>
  [
    "(OutSystems.Model.IESpace eSpace) => {",
    `    /*** creating IServerAction '${action}' ***/`,
    `    var action = eSpace.CreateServerAction("${action}");`,
    `    var startNode = action.CreateNode<${N}.IStartNode>();`,
    `    var endNode = action.CreateNode<${N}.IEndNode>();`,
    "}"
  ].join("\n");

/** A consumer server action that calls `producer.<called>` through `References.Named`. */
const consumerText = (action: string, producer: string, called: string): string =>
  [
    "(OutSystems.Model.IESpace eSpace) => {",
    `    /*** creating IServerAction '${action}' ***/`,
    `    var action = eSpace.CreateServerAction("${action}");`,
    `    var startNode = action.CreateNode<${N}.IStartNode>();`,
    `    var producerRef = eSpace.References.Named("${producer}");`,
    `    var calledAction2 = producerRef.ServerActions.Named("${called}");`,
    `    var calledAction = action.CreateNode<${N}.IExecuteServerActionNode>("${called}");`,
    "    calledAction.Action = calledAction2;",
    `    var endNode = action.CreateNode<${N}.IEndNode>();`,
    "}"
  ].join("\n");

function actionModule(name: string, actions: Record<string, string>): FakeModule {
  const base = syntheticWideModule(1, name);
  const texts: Record<string, string> = {};
  for (const [action, text] of Object.entries(actions)) texts[`ServerAction/${action}`] = text;
  return {
    ...base,
    clientActions: [],
    serverActions: Object.keys(actions).map((n) => ({ Name: n, IsReferenced: false })),
    texts
  };
}

const PRODUCER = "prodmod";
const CONSUMER = "consmod";
const ACTION = "ProduceThing";
const sa = (module: string, name: string): string => buildId({ module, kind: "ServerAction", name });

/** The producer as it exists upstream: an action under `producerAction` (the original, a rename or nothing). */
function producerModule(producerAction: string | null): FakeModule {
  return actionModule(PRODUCER, producerAction === null ? {} : { [producerAction]: producerText(producerAction) });
}
/** The consumer always calls the ORIGINAL name: it was captured before any upstream rename. */
const consumerModule = (): FakeModule => actionModule(CONSUMER, { UseThing: consumerText("UseThing", PRODUCER, ACTION) });

const scope = { name: "gate", modules: ["demoportal", "x", PRODUCER, CONSUMER] };

/** `producerAction`: the producer's action name upstream, or `null` when it was deleted. */
function scopeModules(producerAction: string | null = ACTION): FakeModule[] {
  return [demoPortalModule({ referencedOnly: false }), syntheticXModule(), producerModule(producerAction), consumerModule()];
}

/* -------------------------------------------------------------------------------------------- */
/* The three producers of a snapshot                                                             */
/* -------------------------------------------------------------------------------------------- */

/** `listApps` mirrors the fake Studio's open tabs, as the real one does. */
class StudioReader extends FakeReader {
  constructor(
    modules: FakeModule[],
    private readonly open: Set<string>,
    options: FakeReaderOptions
  ) {
    super(modules, options);
  }
  override async listApps(): Promise<ServiceStudioApp[]> {
    await Promise.resolve();
    return this.apps.map((a) => ({ ...a, isOpen: this.open.has(a.name) }));
  }
  apps: ServiceStudioApp[] = [];
}

interface Artifacts {
  graph: string;
  flows: string;
  snapshot: Snapshot;
  graphDir: string;
  rebuild?: RebuildResult;
}

function readArtifacts(graphDir: string): Omit<Artifacts, "rebuild"> {
  const paths = resolveScopeArtifactPaths(graphDir, scope.name);
  const graph = readFileSync(paths.graph, "utf8");
  return {
    graph,
    flows: readFileSync(paths.flows, "utf8"),
    snapshot: JSON.parse(graph) as Snapshot,
    graphDir
  };
}

/** MCP `rebuild`: all modules open, one wave, raw capture kept beside the snapshot. */
async function viaRebuild(modules: FakeModule[], options: FakeReaderOptions = {}): Promise<Artifacts> {
  const graphDir = tmp();
  const session = fakeSession(modules, options);
  const outcome = await rebuildScope({
    scope,
    snapshotPath: resolveScopeArtifactPaths(graphDir, scope.name).graph,
    session,
    rules,
    now,
    retryDelayMs: 0,
    rawGraphDir: graphDir
  });
  return { ...readArtifacts(graphDir), rebuild: outcome.result };
}

/** `osgraph run` full: open -> stage -> drain -> close per module, against a fake osopener. */
async function viaRun(modules: FakeModule[], options: FakeReaderOptions = {}): Promise<Artifacts & { reader: StudioReader; closedWithReadsPending: number }> {
  const graphDir = tmp();
  const open = new Set<string>();
  const reader = new StudioReader(modules, open, { ...options, apps: modules.map((m) => m.app) });
  reader.apps = modules.map((m) => m.app);
  let closedWithReadsPending = 0;
  const adapter = createOsopenerAdapter({
    async open(input: Record<string, unknown>): Promise<unknown> {
      const name = String(input.name);
      if (open.has(name)) return { opened: true, alreadyOpen: true, durationMs: 5 };
      open.add(name);
      return { opened: true, alreadyOpen: false, durationMs: 5 };
    },
    async close(input: Record<string, unknown>): Promise<unknown> {
      closedWithReadsPending += reader.inFlight;
      open.delete(String(input.name));
      return { closed: true, alreadyClosed: false, durationMs: 5 };
    }
  }, "fake-dist");
  const createSession = (): ServiceStudioSession => ({ reader, acquire: async () => "token", release: () => undefined });
  const result = await runScope({
    scope,
    graphDir,
    rules,
    createSession,
    opener: adapter,
    now,
    sleep: noSleep,
    gapMs: 0,
    retryDelayMs: 0,
    log: () => undefined
  });
  expect(result.finalized, `osgraph run did not finalize: ${result.stoppedEarly ?? result.incomplete ?? "unknown"}`).toBe(true);
  return { ...readArtifacts(graphDir), rebuild: result.rebuild, reader, closedWithReadsPending };
}

/** Offline `reextract` over a graph directory that already holds a raw capture. */
function viaReextract(graphDir: string): Omit<Artifacts, "rebuild"> {
  reextractScope({
    scope,
    graphDir,
    snapshotPath: resolveScopeArtifactPaths(graphDir, scope.name).graph,
    rules,
    now
  });
  return readArtifacts(graphDir);
}

/** All three paths on the same captured inputs. */
async function allThree(modules: FakeModule[], options: FakeReaderOptions = {}) {
  const run = await viaRun(modules, options);
  const rebuild = await viaRebuild(modules, options);
  // Re-extract over each path's own raw capture: it must reproduce what that path wrote live.
  const fromRun = viaReextract(run.graphDir);
  const fromRebuild = viaReextract(rebuild.graphDir);
  return { run, rebuild, reextractOfRun: fromRun, reextractOfRebuild: fromRebuild };
}

/* -------------------------------------------------------------------------------------------- */
/* 1. Byte-identical artifacts across run, rebuild and reextract                                 */
/* -------------------------------------------------------------------------------------------- */

describe("gate: run, rebuild and reextract produce byte-identical graph.json and flows.json", () => {
  it("on a synthetic scope with a producer, a consumer and flows", async () => {
    const r = await allThree(scopeModules());
    const reference = { label: "rebuild", ...r.rebuild };
    for (const [label, other] of [
      ["run", r.run],
      ["reextract(run raw)", r.reextractOfRun],
      ["reextract(rebuild raw)", r.reextractOfRebuild]
    ] as const) {
      assertIdentical("graph.json", reference.label, reference.graph, label, other.graph);
      assertIdentical("flows.json", reference.label, reference.flows, label, other.flows);
    }
    // The scope is not trivially empty: there is real graph and flow content to compare.
    expect(reference.snapshot.nodes.length).toBeGreaterThan(20);
    expect(JSON.parse(reference.flows).flowNodeCount).toBeGreaterThan(0);
    // The cross-module edge is a real edge to a real node on every path.
    expect(reference.snapshot.links).toContainEqual(expect.objectContaining({ source: sa(CONSUMER, "UseThing"), target: sa(PRODUCER, ACTION) }));
  });

  it("runs the drain before every close (ADR-0013) on the run path", async () => {
    const run = await viaRun(scopeModules());
    expect(run.closedWithReadsPending).toBe(0);
  });

  it("names the diverging artifact and the JSON path when two outputs differ", async () => {
    const a = await viaRebuild(scopeModules());
    const tampered = JSON.parse(a.graph) as Snapshot;
    tampered.nodes[3] = { ...tampered.nodes[3], label: "tampered" };
    expect(() => assertIdentical("graph.json", "run", JSON.stringify(tampered), "rebuild", a.graph)).toThrow(
      /graph\.json diverges between run and rebuild at \$\.nodes\[3\]\.label/
    );
    const flows = JSON.parse(a.flows) as { flowNodeCount: number };
    flows.flowNodeCount += 1;
    expect(() => assertIdentical("flows.json", "reextract", JSON.stringify(flows), "rebuild", a.flows)).toThrow(
      /flows\.json diverges between reextract and rebuild at \$\.flowNodeCount/
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2. A producer deleted or renamed upstream is a placeholder, never a stale node                */
/* -------------------------------------------------------------------------------------------- */

describe("gate: a producer deleted or renamed upstream yields an explicit placeholder", () => {
  const target = sa(PRODUCER, ACTION);

  it.each([
    ["renamed", "ProduceThingRenamed"],
    ["deleted", null]
  ] as const)("%s: the consumer's edge points at a counted placeholder on every path", async (_case, upstream) => {
    const r = await allThree(scopeModules(upstream));
    for (const [label, a] of Object.entries({ run: r.run, rebuild: r.rebuild, "reextract(run)": r.reextractOfRun, "reextract(rebuild)": r.reextractOfRebuild })) {
      const node = a.snapshot.nodes.find((n) => n.id === target);
      expect(node, `${label}: placeholder node for ${target}`).toBeDefined();
      expect(node, label).toMatchObject({ kind: "ServerAction", module: PRODUCER, placeholder: true });
      // It must not pass for a real read element or an out-of-scope external.
      expect(node?.external, label).toBeUndefined();
      expect(a.snapshot.graph.osgraph.placeholderCount, label).toBeGreaterThanOrEqual(1);
      // The edge is kept, pointing at the placeholder.
      expect(a.snapshot.links, label).toContainEqual(expect.objectContaining({ source: sa(CONSUMER, "UseThing"), target }));
    }
    // A rename does not leave the OLD name looking real, and the new name is a real node.
    const snap = r.rebuild.snapshot;
    expect(snap.nodes.filter((n) => n.id === target && n.placeholder !== true)).toEqual([]);
    if (upstream !== null) {
      expect(snap.nodes.find((n) => n.id === sa(PRODUCER, upstream))).toMatchObject({ kind: "ServerAction" });
      expect(snap.nodes.find((n) => n.id === sa(PRODUCER, upstream))?.placeholder).toBeUndefined();
    }
    assertIdentical("graph.json", "rebuild", r.rebuild.graph, "run", r.run.graph);
    assertIdentical("graph.json", "rebuild", r.rebuild.graph, "reextract(rebuild)", r.reextractOfRebuild.graph);
  });

  it("control: while the producer exists there is no placeholder for it", async () => {
    const a = await viaRebuild(scopeModules());
    expect(a.snapshot.nodes.find((n) => n.id === target)?.placeholder).toBeUndefined();
    expect(a.snapshot.graph.osgraph.placeholderCount).toBe(
      a.snapshot.nodes.filter((n) => n.placeholder === true).length
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 3. Skipped reads never make a module or the scope look complete                               */
/* -------------------------------------------------------------------------------------------- */

describe("gate: skipped reads never make a module or scope look complete", () => {
  const failing: FakeReaderOptions = { failures: { [`getServerAction:${CONSUMER}:UseThing`]: Infinity } };

  it("a failed element read is a recorded skip on every path, with no node stubbed for it", async () => {
    const r = await allThree(scopeModules(), failing);
    for (const [label, a] of Object.entries({ run: r.run, rebuild: r.rebuild, "reextract(run)": r.reextractOfRun, "reextract(rebuild)": r.reextractOfRebuild })) {
      expect(a.snapshot.graph.osgraph.skipped, label).toContainEqual({ module: CONSUMER, kind: "ServerAction", name: "UseThing", reason: "TOOL_ERROR" });
      // Not invented: the unread element is not in the graph at all (ADR-0009).
      expect(a.snapshot.nodes.find((n) => n.id === sa(CONSUMER, "UseThing")), label).toBeUndefined();
    }
    // The completeness surface says "incomplete", not "complete": live results and persisted meta.
    for (const [label, a] of [["rebuild", r.rebuild], ["run", r.run]] as const) {
      expect(a.rebuild?.skippedElements, label).toContainEqual({ module: CONSUMER, kind: "ServerAction", name: "UseThing", reason: "TOOL_ERROR" });
    }
    for (const a of [r.run, r.rebuild, r.reextractOfRun, r.reextractOfRebuild]) {
      const completeness = readGraphCompleteness(resolveScopeArtifactPaths(a.graphDir, scope.name).graph);
      expect(completeness.skippedCount).toBeGreaterThanOrEqual(1);
      expect(completeness.completenessUnknown).toBeUndefined();
    }
    // Skips are part of the data: the three producers still agree byte for byte.
    assertIdentical("graph.json", "rebuild", r.rebuild.graph, "run", r.run.graph);
    assertIdentical("graph.json", "rebuild", r.rebuild.graph, "reextract(rebuild)", r.reextractOfRebuild.graph);
    assertIdentical("flows.json", "rebuild", r.rebuild.flows, "run", r.run.flows);
    assertIdentical("flows.json", "rebuild", r.rebuild.flows, "reextract(rebuild)", r.reextractOfRebuild.flows);
  });

  it("an edge into a skipped producer element is dropped, not stubbed as a real node or placeholder", async () => {
    const skipProducer: FakeReaderOptions = { failures: { [`getServerAction:${PRODUCER}:${ACTION}`]: Infinity } };
    const a = await viaRebuild(scopeModules(), skipProducer);
    const id = sa(PRODUCER, ACTION);
    expect(a.snapshot.nodes.find((n) => n.id === id)).toBeUndefined();
    expect(a.snapshot.links.filter((l) => l.target === id)).toEqual([]);
    expect(a.snapshot.graph.osgraph.skipped).toContainEqual({ module: PRODUCER, kind: "ServerAction", name: ACTION, reason: "TOOL_ERROR" });
  });

  it("a module whose raw capture is missing is named by reextract and flows.json, never silently complete", async () => {
    const a = await viaRebuild(scopeModules());
    rmSync(join(a.graphDir, scope.name, "raw", CONSUMER), { recursive: true, force: true });
    const result = reextractScope({
      scope,
      graphDir: a.graphDir,
      snapshotPath: resolveScopeArtifactPaths(a.graphDir, scope.name).graph,
      rules,
      now
    });
    expect(result.missingCaptures).toEqual([expect.objectContaining({ module: CONSUMER, code: "RAW_NOT_CAPTURED" })]);
    const flows = JSON.parse(readFileSync(resolveScopeArtifactPaths(a.graphDir, scope.name).flows, "utf8")) as {
      missingCaptures: Array<{ module: string }>;
      perModule: Array<{ module: string }>;
    };
    expect(flows.missingCaptures.map((m) => m.module)).toContain(CONSUMER);
    expect(flows.perModule.map((m) => m.module)).not.toContain(CONSUMER);
    // The thinner graph is visibly thinner: the consumer's own elements are absent, not stubbed.
    const graph = JSON.parse(readFileSync(resolveScopeArtifactPaths(a.graphDir, scope.name).graph, "utf8")) as Snapshot;
    expect(graph.nodes.find((n) => n.id === sa(CONSUMER, "UseThing"))).toBeUndefined();
  });

  it("a staged `osgraph run` that has not read every module does not finalize", async () => {
    const graphDir = tmp();
    const modules = scopeModules();
    const open = new Set<string>();
    const reader = new StudioReader(modules, open, {});
    reader.apps = modules.map((m) => m.app);
    const adapter = createOsopenerAdapter({
      async open(input: Record<string, unknown>): Promise<unknown> {
        const name = String(input.name);
        // The consumer's tab can never be opened.
        if (name === CONSUMER) return { opened: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "tab not found" } };
        open.add(name);
        return { opened: true, alreadyOpen: false, durationMs: 5 };
      },
      async close(input: Record<string, unknown>): Promise<unknown> {
        open.delete(String(input.name));
        return { closed: true, alreadyClosed: false, durationMs: 5 };
      }
    }, "fake-dist");
    const result = await runScope({
      scope,
      graphDir,
      rules,
      createSession: () => ({ reader, acquire: async () => "token", release: () => undefined }),
      opener: adapter,
      now,
      sleep: noSleep,
      gapMs: 0,
      retryDelayMs: 0,
      log: () => undefined
    });
    expect(result.finalized).toBe(false);
    expect(result.rows.find((row) => row.module === CONSUMER)?.outcome).toBe("open-failed");
    // No graph.json was written: an unread module cannot leave a complete-looking scope behind.
    expect(existsSync(resolveScopeArtifactPaths(graphDir, scope.name).graph)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 4a. #60: node-order permutation invariance, asserted inside the gate                          */
/* -------------------------------------------------------------------------------------------- */

/** One node "group": the lines the emitter prints for a node and the declarations it needs. */
const groups: string[][] = [
  [`var startNode = action.CreateNode<${N}.IStartNode>();`],
  [
    `var producerRef = eSpace.References.Named("${PRODUCER}");`,
    `var first2 = producerRef.ServerActions.Named("First");`,
    `var first = action.CreateNode<${N}.IExecuteServerActionNode>("First");`,
    "first.Action = first2;"
  ],
  [
    `var second2 = producerRef.ServerActions.Named("Second");`,
    `var second = action.CreateNode<${N}.IExecuteServerActionNode>("Second");`,
    "second.Action = second2;"
  ],
  [`var endNode = action.CreateNode<${N}.IEndNode>();`]
];

function permutedConsumer(order: number[]): string {
  return [
    "(OutSystems.Model.IESpace eSpace) => {",
    `    /*** creating IServerAction 'UseThing' ***/`,
    `    var action = eSpace.CreateServerAction("UseThing");`,
    ...order.flatMap((i) => groups[i].map((l) => `    ${l}`)),
    "}"
  ].join("\n");
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const rec = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) out.push(prefix);
    for (const r of rest) rec([...prefix, r], rest.filter((x) => x !== r));
  };
  rec([], Array.from({ length: n }, (_, i) => i));
  return out;
}

describe("gate: edge resolution is invariant under node order (#60)", () => {
  const edgesOf = (order: number[]): ExtractedEdge[] => {
    const input: ModuleInput = {
      module: CONSUMER,
      moduleType: "Reactive",
      texts: { dataModel: "", structures: "", screens: [], blocks: [], clientActions: [], serverActions: [{ name: "UseThing", text: permutedConsumer(order) }] }
    };
    return extractModule(input).edges;
  };
  const baseline = edgesOf([0, 1, 2, 3]);

  it("the canonical order resolves both calls", () => {
    expect(baseline.map((e) => e.target)).toEqual(expect.arrayContaining([sa(PRODUCER, "First"), sa(PRODUCER, "Second")]));
  });

  it.each(permutations(groups.length).map((p) => [p.join(",")] as const))("extractor: permutation %s yields identical edges", (key) => {
    expect(edgesOf(key.split(",").map(Number))).toEqual(baseline);
  });

  it("end to end: every permutation yields a byte-identical graph.json through the rebuild path", async () => {
    const producer = actionModule(PRODUCER, { First: producerText("First"), Second: producerText("Second") });
    const build = async (order: number[]): Promise<string> => {
      const graphDir = tmp();
      await rebuildScope({
        scope: { name: scope.name, modules: [PRODUCER, CONSUMER] },
        snapshotPath: resolveScopeArtifactPaths(graphDir, scope.name).graph,
        session: fakeSession([producer, actionModule(CONSUMER, { UseThing: permutedConsumer(order) })]),
        rules,
        now,
        retryDelayMs: 0
      });
      return readFileSync(resolveScopeArtifactPaths(graphDir, scope.name).graph, "utf8");
    };
    const reference = await build([0, 1, 2, 3]);
    expect(JSON.parse(reference).links.map((l: { target: string }) => l.target)).toEqual(
      expect.arrayContaining([sa(PRODUCER, "First"), sa(PRODUCER, "Second")])
    );
    for (const order of permutations(groups.length)) {
      assertIdentical("graph.json", "canonical order", reference, `order ${order.join(",")}`, await build(order));
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 4b. #59: the listing-wave contract, asserted inside the gate                                  */
/* -------------------------------------------------------------------------------------------- */

describe("gate: the listing wave contract holds on both producers of live reads (#59)", () => {
  const wideModules = (service: boolean): FakeModule[] => {
    const base = syntheticWideModule(10, "widemod");
    return [service ? { ...base, app: { ...base.app, moduleType: "Service" } } : base];
  };
  const reads = (tools: string[]): string[] => tools.filter((t) => t !== "listApps");

  function assertWave(order: string[], service: boolean): void {
    const listings = service ? 5 : 4;
    const expected = service
      ? ["getActionNames", "getActionNames", "getActionNames", "getScreenNames", "getWebBlockNames"]
      : ["getActionNames", "getActionNames", "getScreenNames", "getWebBlockNames"];
    expect(order.slice(0, listings).sort(), "listing wave").toEqual(expected);
    expect(order.slice(listings, listings + 2), "module texts follow the last listing").toEqual(["getDataModel", "getStructures"]);
    expect(order.slice(listings + 2).every((t) => t === "getClientAction"), "element fetches come last").toBe(true);
  }

  it.each([[false], [true]] as const)("rebuild (service=%s): listings, then module texts, then element fetches", async (service) => {
    const session = fakeSession(wideModules(service), { delayMs: () => 2 });
    await rebuildScope({
      scope: { name: scope.name, modules: ["widemod"] },
      snapshotPath: join(tmp(), scope.name, "graph.json"),
      session,
      rules,
      retryDelayMs: 0,
      fetchConcurrency: 4
    });
    expect(session.reader.calls[0].tool).toBe("listApps");
    assertWave(reads(session.reader.calls.map((c) => c.tool)), service);
  });

  it.each([[false], [true]] as const)("run staging (service=%s) reads in the same wave order", async (service) => {
    const graphDir = tmp();
    const modules = wideModules(service);
    const open = new Set<string>();
    const reader = new StudioReader(modules, open, { delayMs: () => 2 });
    reader.apps = modules.map((m) => m.app);
    const adapter = createOsopenerAdapter({
      async open(input: Record<string, unknown>): Promise<unknown> {
        open.add(String(input.name));
        return { opened: true, alreadyOpen: false, durationMs: 5 };
      },
      async close(input: Record<string, unknown>): Promise<unknown> {
        open.delete(String(input.name));
        return { closed: true, alreadyClosed: false, durationMs: 5 };
      }
    }, "fake-dist");
    const result = await runScope({
      scope: { name: scope.name, modules: ["widemod"] },
      graphDir,
      rules,
      createSession: () => ({ reader, acquire: async () => "token", release: () => undefined }),
      opener: adapter,
      now,
      sleep: noSleep,
      gapMs: 0,
      retryDelayMs: 0,
      fetchConcurrency: 4,
      log: () => undefined
    });
    expect(result.finalized).toBe(true);
    assertWave(reads(reader.calls.map((c) => c.tool)), service);
  });
});
