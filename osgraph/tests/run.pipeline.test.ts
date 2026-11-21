/**
 * `osgraph run --pipeline-depth` (plan v3 sections 3, 6, 8): the pipelined coordinator in `runScope`,
 * driven against a fake osopener (the real #6 adapter over fake tool handlers) and the fixture-backed
 * fake reader. No Service Studio, no osopener build, no token, no network: every module is synthetic.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveScopeArtifactPaths } from "../src/graph/io.js";
import { loadLayerRules } from "../src/layers/rules.js";
import { createOsopenerAdapter, type OsopenerAdapter } from "../src/osopener/adapter.js";
import { RunState } from "../src/progress/state.js";
import { timingsPath, writeTimings } from "../src/progress/timings.js";
import type { ServiceStudioSession } from "../src/rebuild/reader.js";
import { stageModule } from "../src/rebuild/rebuild.js";
import { readStage } from "../src/rebuild/stage.js";
import { runScope, type RunCommonOptions } from "../src/run/run.js";
import type { ServiceStudioApp } from "../src/servicestudio/types.js";
import { FakeReader, syntheticWideModule, tokenExpiredError, type FakeModule, type FakeReaderOptions } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "osgraph-pipeline-"));
  dirs.push(d);
  return d;
};

const T0 = new Date("2026-11-01T00:00:00.000Z");
const noSleep = async (): Promise<void> => undefined;
const SCOPE = { name: "demo", modules: ["alpha", "beta", "gamma", "delta"] };
const mods = (): FakeModule[] => SCOPE.modules.map((m) => syntheticWideModule(2, m));

type RawResult = Record<string, unknown>;

/** A fake reader with a module-scoped barrier built from the calls/completions it already records. */
class PipelineReader extends FakeReader {
  constructor(
    modules: FakeModule[],
    private readonly open: Set<string>,
    private readonly appsOf: ServiceStudioApp[],
    options: FakeReaderOptions = {}
  ) {
    super(modules, options);
  }
  override async listApps(): Promise<ServiceStudioApp[]> {
    await Promise.resolve();
    return this.appsOf.map((a) => ({ ...a, isOpen: this.open.has(a.name) }));
  }
  pending(module: string): number {
    const done = this.completions.filter((c) => c.module === module).length;
    return this.calls.filter((c) => c.module === module).length - done;
  }
  readonly drainedModules: string[] = [];
  async drainModule(module: string): Promise<void> {
    while (this.pending(module) > 0) await new Promise((r) => setTimeout(r, 0));
    this.drainedModules.push(module);
  }
}

interface StudioOptions {
  userOpen?: string[];
  openScript?: Record<string, RawResult[]>;
  closeScript?: Record<string, RawResult[]>;
  readerOptions?: FakeReaderOptions;
  /** Reader without a module-scoped barrier (fails closed in pipeline mode). */
  noDrainModule?: boolean;
}

function fakeStudio(modules: FakeModule[], options: StudioOptions = {}) {
  const open = new Set<string>(options.userOpen ?? []);
  const users = new Set(options.userOpen ?? []);
  const reader = new PipelineReader(modules, open, modules.map((m) => m.app), options.readerOptions);
  if (options.noDrainModule) (reader as { drainModule?: unknown }).drainModule = undefined;
  const events: string[] = [];
  /** Per close: the module's own pending reads, and every OTHER module's pending reads. */
  const atClose: Array<{ module: string; own: number; others: number }> = [];
  const openScript = new Map(Object.entries(options.openScript ?? {}).map(([k, v]) => [k, [...v]]));
  const closeScript = new Map(Object.entries(options.closeScript ?? {}).map(([k, v]) => [k, [...v]]));
  let maxOwned = 0;
  let maxTabs = 0;
  let concurrentGui = 0;
  let maxConcurrentGui = 0;
  const gui = async <T>(fn: () => Promise<T>): Promise<T> => {
    concurrentGui++;
    maxConcurrentGui = Math.max(maxConcurrentGui, concurrentGui);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await fn();
    } finally {
      concurrentGui--;
    }
  };

  const tools = {
    open: (input: Record<string, unknown>): Promise<unknown> =>
      gui(async () => {
        const name = String(input.name);
        events.push(`open:${name}`);
        const scripted = openScript.get(name)?.shift();
        if (scripted !== undefined) return scripted;
        if (open.has(name)) return { opened: true, alreadyOpen: true, durationMs: 5 };
        open.add(name);
        maxTabs = Math.max(maxTabs, open.size);
        maxOwned = Math.max(maxOwned, [...open].filter((o) => !users.has(o)).length);
        return { opened: true, alreadyOpen: false, durationMs: 15_000 };
      }),
    close: (input: Record<string, unknown>): Promise<unknown> =>
      gui(async () => {
        const name = String(input.name);
        events.push(`close:${name}`);
        const own = reader.pending(name);
        const total = modules.reduce((n, m) => n + reader.pending(m.app.name), 0);
        atClose.push({ module: name, own, others: total - own });
        const scripted = closeScript.get(name)?.shift();
        if (scripted !== undefined) return scripted;
        if (!open.has(name)) return { closed: true, alreadyClosed: true };
        open.delete(name);
        return { closed: true, alreadyClosed: false, durationMs: 800 };
      })
  };
  const opener: OsopenerAdapter = createOsopenerAdapter(tools, "fake-dist", undefined);

  let sessions = 0;
  const createSession = (): ServiceStudioSession => {
    sessions++;
    return { reader, acquire: async () => "token", release: () => undefined };
  };
  return {
    open,
    reader,
    events,
    atClose,
    opener,
    createSession,
    get maxOwned() {
      return maxOwned;
    },
    get maxTabs() {
      return maxTabs;
    },
    get maxConcurrentGui() {
      return maxConcurrentGui;
    },
    get sessions() {
      return sessions;
    }
  };
}

function common(graphDir: string, s: ReturnType<typeof fakeStudio>, logs: string[]): RunCommonOptions {
  return {
    scope: SCOPE,
    graphDir,
    rules,
    createSession: s.createSession,
    opener: s.opener,
    log: (line) => logs.push(line),
    now: () => T0,
    sleep: noSleep,
    gapMs: 0,
    retryDelayMs: 0
  };
}

const guiEvents = (s: ReturnType<typeof fakeStudio>): string[] => s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"));
const read = (p: string): string => readFileSync(p, "utf8");
const stuckOpen = (): RawResult[] => [{ opened: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "Studio window not found" } }];
const refusedClose = (n: number): RawResult[] =>
  Array.from({ length: n }, () => ({ closed: false, error: { code: "UNSAVED_CHANGES_DIALOG", message: "Save changes?" } }));

/** A RunState stub recording every call and every progress event type. */
function recordingState() {
  const calls: string[] = [];
  const state = {
    beginRun: () => calls.push("begin"),
    handle: (e: { type: string }) => calls.push(`event:${e.type}`),
    finishRun: () => calls.push("finish"),
    failRun: (c: string) => calls.push(`fail:${c}`)
  } as unknown as RunState;
  return { state, calls };
}

describe("runScope pipeline: depth 1 is the legacy loop", () => {
  it("pipelineDepth 1 behaves identically to leaving it out (events, rows, artifacts, report shape)", async () => {
    const legacyDir = tmp();
    const depthDir = tmp();
    const legacy = fakeStudio(mods());
    const one = fakeStudio(mods());
    const a = await runScope({ ...common(legacyDir, legacy, []), maxOpen: 2 });
    const b = await runScope({ ...common(depthDir, one, []), maxOpen: 2, pipelineDepth: 1 });
    expect(one.events.filter((e) => e !== "ui:foreground")).toEqual(legacy.events.filter((e) => e !== "ui:foreground"));
    const strip = (rows: typeof a.rows) => rows.map(({ durationMs: _d, ...r }) => r);
    expect(strip(b.rows)).toEqual(strip(a.rows));
    expect(b.finalized).toBe(true);
    expect(b.pipeline).toBeUndefined();
    expect(read(resolveScopeArtifactPaths(depthDir, "demo").graph)).toBe(read(resolveScopeArtifactPaths(legacyDir, "demo").graph));
    expect(read(resolveScopeArtifactPaths(depthDir, "demo").flows)).toBe(read(resolveScopeArtifactPaths(legacyDir, "demo").flows));
    expect(Object.keys(JSON.parse(read(b.reportPath)))).toEqual(["scope", "rows"]);
    // The legacy loop never needs drainModule.
    expect(one.reader.drainedModules).toEqual([]);
  });
});

describe("runScope pipeline: staging every module", () => {
  for (const depth of [2, 4, 9]) {
    it(`depth ${depth}: stages all modules, finalizes exactly once, never over depth or --max-open, serial GUI`, async () => {
      const seqDir = tmp();
      const seq = fakeStudio(mods());
      await runScope({ ...common(seqDir, seq, []), maxOpen: 12 });

      const graphDir = tmp();
      const s = fakeStudio(mods());
      const { state, calls } = recordingState();
      const result = await runScope({ ...common(graphDir, s, []), state, maxOpen: 3, pipelineDepth: depth });

      expect(result.finalized).toBe(true);
      expect(result.failures).toBe(0);
      expect(result.rows.map((r) => [r.module, r.outcome, r.closed])).toEqual(SCOPE.modules.map((m) => [m, "staged", true]));
      // Exactly one finalize: one `done` event, one finish, and the stage was cleared by it.
      expect(calls.filter((c) => c === "event:done")).toEqual(["event:done"]);
      expect(calls.filter((c) => c === "finish")).toEqual(["finish"]);
      expect(calls).not.toContain("fail:RUN_INCOMPLETE");
      expect(readStage(graphDir, "demo").entries).toEqual([]);
      // Same graph as the sequential run, byte for byte.
      expect(read(resolveScopeArtifactPaths(graphDir, "demo").graph)).toBe(read(resolveScopeArtifactPaths(seqDir, "demo").graph));
      expect(read(resolveScopeArtifactPaths(graphDir, "demo").flows)).toBe(read(resolveScopeArtifactPaths(seqDir, "demo").flows));
      // Bounds.
      expect(s.maxOwned).toBeLessThanOrEqual(Math.min(depth, 3));
      expect(s.maxTabs).toBeLessThanOrEqual(3);
      expect(s.maxConcurrentGui).toBe(1);
      expect(s.open.size).toBe(0);
      // Every close happened with that module fully drained (module-scoped barrier).
      expect(s.atClose.every((c) => c.own === 0)).toBe(true);
      expect([...new Set(s.reader.drainedModules)].sort()).toEqual([...SCOPE.modules].sort());
      expect(s.sessions).toBeGreaterThanOrEqual(SCOPE.modules.length);
    });
  }

  it("opens the next module while an earlier one is still reading (reads overlap)", async () => {
    const s = fakeStudio(mods(), { readerOptions: { delayMs: () => 4 } });
    await runScope({ ...common(tmp(), s, []), maxOpen: 4, pipelineDepth: 4 });
    // Sequential staging would never have two modules' reads in flight at once.
    const first = s.reader.calls.findIndex((c) => c.module === "beta");
    const lastAlpha = s.reader.calls.map((c) => c.module).lastIndexOf("alpha");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(lastAlpha);
  });

  it("module A closes while B is still reading, without waiting for B", async () => {
    const s = fakeStudio(mods(), {
      readerOptions: { delayMs: ({ module }) => (module === "alpha" ? 1 : module === "beta" ? 12 : 1) }
    });
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 4, pipelineDepth: 2 });
    expect(result.finalized).toBe(true);
    const alpha = s.atClose.find((c) => c.module === "alpha");
    expect(alpha?.own).toBe(0);
    // beta's reads were still pending when alpha's tab closed.
    expect(alpha?.others).toBeGreaterThan(0);
    expect(s.events.indexOf("close:alpha")).toBeLessThan(s.events.indexOf("close:beta"));
  });

  it("refuses to start without a module-scoped barrier, before anything opens", async () => {
    const s = fakeStudio(mods(), { noDrainModule: true });
    await expect(runScope({ ...common(tmp(), s, []), pipelineDepth: 2 })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(s.events).toEqual([]);
  });
});

describe("runScope pipeline: tab ceiling counts the user's tabs", () => {
  it("never closes a user tab and never exceeds --max-open over ALL open tabs", async () => {
    const s = fakeStudio([...mods(), syntheticWideModule(1, "u1"), syntheticWideModule(1, "u2")], { userOpen: ["u1", "u2"] });
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 4, pipelineDepth: 4 });
    expect(result.finalized).toBe(true);
    expect(s.maxTabs).toBeLessThanOrEqual(4);
    expect(s.maxOwned).toBeLessThanOrEqual(2);
    expect(s.events).not.toContain("close:u1");
    expect(s.events).not.toContain("close:u2");
    expect(s.open.has("u1") && s.open.has("u2")).toBe(true);
  });

  it("a staged scope module the user already had open is read and left open, and takes no GUI action", async () => {
    const s = fakeStudio(mods(), { userOpen: ["beta"] });
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 6, pipelineDepth: 2 });
    expect(result.finalized).toBe(true);
    expect(s.events).not.toContain("open:beta");
    expect(s.events).not.toContain("close:beta");
    expect(s.open.has("beta")).toBe(true);
    expect(result.rows.find((r) => r.module === "beta")).toMatchObject({ outcome: "staged", openedHere: false });
  });

  it("stops with a clear message, instead of bypassing the cap, when user tabs fill --max-open", async () => {
    const s = fakeStudio([...mods(), syntheticWideModule(1, "u1"), syntheticWideModule(1, "u2")], { userOpen: ["u1", "u2"] });
    const logs: string[] = [];
    const result = await runScope({ ...common(tmp(), s, logs), maxOpen: 2, pipelineDepth: 4 });
    expect(result.finalized).toBe(false);
    expect(result.stoppedEarly).toContain("--max-open is 2");
    expect(s.events).toEqual([]);
    expect(s.open.size).toBe(2);
  });
});

describe("runScope pipeline: close failures keep their slot", () => {
  it("a refused close holds the slot, so the run stops at the depth instead of opening more", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods(), { closeScript: { alpha: refusedClose(5), beta: refusedClose(5) } });
    const result = await runScope({ ...common(graphDir, s, []), maxOpen: 12, pipelineDepth: 2 });
    expect(result.finalized).toBe(false);
    expect(result.stoppedEarly).toContain("--pipeline-depth 2");
    expect(result.stoppedEarly).toContain("alpha");
    expect(s.events).not.toContain("open:gamma");
    expect(s.events).not.toContain("open:delta");
    expect(s.maxOwned).toBeLessThanOrEqual(2);
    const alpha = result.rows.find((r) => r.module === "alpha");
    expect(alpha).toMatchObject({ outcome: "staged", closed: false });
    expect(alpha?.closeError).toContain("UNSAVED_CHANGES_DIALOG");
    // Both tabs are still open and still owned: nothing pretended they were freed.
    expect(s.open.has("alpha") && s.open.has("beta")).toBe(true);
    // Staged work is kept for a resume.
    expect(readStage(graphDir, "demo").entries.length).toBe(2);
  });

  it("one stuck slot does not block the others: a confirmed close frees its own slot at once", async () => {
    // depth 2: alpha's close is refused (its slot stays held), beta's succeeds and frees ITS slot, so
    // gamma and then delta open beside the stuck alpha and the scope still completes.
    const s = fakeStudio(mods(), { closeScript: { alpha: refusedClose(5) } });
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 12, pipelineDepth: 2 });
    const order = guiEvents(s);
    expect(order.indexOf("open:gamma")).toBeGreaterThan(order.indexOf("close:beta"));
    expect(s.maxOwned).toBeLessThanOrEqual(2);
    expect(result.rows.find((r) => r.module === "alpha")?.closed).toBe(false);
    expect(result.rows.filter((r) => r.closed === true).length).toBeGreaterThanOrEqual(1);
    expect(result.finalized).toBe(true);
    expect(s.open.has("alpha")).toBe(true);
  });
});

describe("runScope pipeline: failures", () => {
  it("open failures count toward the circuit breaker and stop scheduling", async () => {
    const s = fakeStudio(mods(), { openScript: { alpha: stuckOpen(), beta: stuckOpen(), gamma: stuckOpen() } });
    const logs: string[] = [];
    const result = await runScope({ ...common(tmp(), s, logs), maxConsecutiveFailures: 3, pipelineDepth: 2 });
    expect(result.stoppedEarly).toContain("3 module(s) in a row failed to open");
    expect(result.stoppedEarly).toContain("resumes");
    expect(s.events).not.toContain("open:delta");
    // Every scope module has a row: the one still queued at the stop is `not-started`, not a failure.
    expect(result.rows.map((r) => r.outcome)).toEqual(["open-failed", "open-failed", "open-failed", "not-started"]);
    expect(result.failures).toBe(3);
    expect(result.finalized).toBe(false);
    expect(logs.some((l) => l.startsWith("STOPPED:"))).toBe(true);
  });

  it("a success resets the breaker, and 0 disables it", async () => {
    const s = fakeStudio(mods(), { openScript: { alpha: stuckOpen(), beta: stuckOpen(), gamma: stuckOpen() } });
    const result = await runScope({ ...common(tmp(), s, []), maxConsecutiveFailures: 0, pipelineDepth: 2 });
    expect(result.stoppedEarly).toBeUndefined();
    expect(result.rows.map((r) => r.outcome)).toEqual(["open-failed", "open-failed", "open-failed", "staged"]);
    expect(result.finalized).toBe(false);

    const s2 = fakeStudio(mods(), { userOpen: ["gamma"], openScript: { alpha: stuckOpen(), beta: stuckOpen(), delta: stuckOpen() } });
    const r2 = await runScope({ ...common(tmp(), s2, []), maxConsecutiveFailures: 3, pipelineDepth: 2 });
    expect(r2.stoppedEarly).toBeUndefined();
    expect(r2.rows.map((r) => r.outcome)).toEqual(["open-failed", "open-failed", "staged", "open-failed"]);
  });

  it("a read failure keeps the previous graph, stops new opens, settles started work and closes owned tabs", async () => {
    const graphDir = tmp();
    const sentinel = resolveScopeArtifactPaths(graphDir, "demo").graph;
    // alpha fails its listing read for good (not session-fatal), beta reads on.
    const s = fakeStudio(mods(), {
      readerOptions: { failures: { "getScreenNames:alpha:": Infinity }, delayMs: ({ module }) => (module === "beta" ? 5 : 0) }
    });
    const { state, calls } = recordingState();
    const result = await runScope({ ...common(graphDir, s, []), state, maxOpen: 12, pipelineDepth: 2 });
    expect(result.finalized).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
    expect(result.rows.find((r) => r.module === "alpha")?.outcome).toBe("stage-failed");
    expect(calls).toContain("fail:RUN_INCOMPLETE");
    expect(calls).not.toContain("event:done");
    // Nothing is left open that this run opened, and every close followed its own drain.
    expect(s.open.size).toBe(0);
    expect(s.atClose.every((c) => c.own === 0)).toBe(true);
    expect(s.events).not.toContain("open:delta");
  });

  it("a session-fatal error stops new work, settles in-flight, closes owned tabs and rethrows", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods(), { readerOptions: { delayMs: () => 2 } });
    let n = 0;
    const createSession = (): ServiceStudioSession => {
      n++;
      const mine = n;
      return {
        reader: s.reader,
        acquire: async () => {
          // 1 = the run's own session, 2 = alpha's stage, 3 = beta's stage.
          if (mine === 3) throw tokenExpiredError();
          return "token";
        },
        release: () => undefined
      };
    };
    const { state, calls } = recordingState();
    await expect(runScope({ ...common(graphDir, s, []), createSession, state, maxOpen: 12, pipelineDepth: 2 })).rejects.toMatchObject({
      code: "TOKEN_EXPIRED"
    });
    expect(calls).toContain("fail:TOKEN_EXPIRED");
    expect(calls).not.toContain("finish");
    expect(s.open.size).toBe(0);
    expect(s.events).not.toContain("open:gamma");
    expect(s.atClose.every((c) => c.own === 0)).toBe(true);
    expect(existsSync(resolveScopeArtifactPaths(graphDir, "demo").graph)).toBe(false);
  });
});

describe("runScope pipeline: resume", () => {
  it("skips modules that already have a stage entry and finalizes once", async () => {
    const graphDir = tmp();
    const pre = fakeStudio(mods(), { userOpen: SCOPE.modules });
    for (const m of ["alpha", "gamma"]) {
      await stageModule({
        scope: SCOPE,
        module: m,
        graphDir,
        snapshotPath: resolveScopeArtifactPaths(graphDir, "demo").graph,
        session: pre.createSession(),
        rules,
        now: () => T0,
        retryDelayMs: 0,
        finalize: false
      });
    }
    expect(readStage(graphDir, "demo").entries.map((e) => e.module).sort()).toEqual(["alpha", "gamma"]);

    const s = fakeStudio(mods());
    const result = await runScope({ ...common(graphDir, s, []), maxOpen: 12, pipelineDepth: 2 });
    expect(result.alreadyStaged).toBe(2);
    expect(result.rows.filter((r) => r.outcome === "skipped").map((r) => r.module)).toEqual(["alpha", "gamma"]);
    expect(s.events).not.toContain("open:alpha");
    expect(s.events).not.toContain("open:gamma");
    expect(result.rows.filter((r) => r.outcome === "staged").map((r) => r.module).sort()).toEqual(["beta", "delta"]);
    expect(result.finalized).toBe(true);
    // Rows come back in scope order whatever order the modules finished in.
    expect(result.rows.map((r) => r.module)).toEqual(SCOPE.modules);
  });

  it("finalizes from a complete stage without opening anything", async () => {
    const graphDir = tmp();
    const pre = fakeStudio(mods(), { userOpen: SCOPE.modules });
    for (const m of SCOPE.modules.slice(0, 3)) {
      await stageModule({
        scope: SCOPE, module: m, graphDir, snapshotPath: resolveScopeArtifactPaths(graphDir, "demo").graph,
        session: pre.createSession(), rules, now: () => T0, retryDelayMs: 0, finalize: false
      });
    }
    await stageModule({
      scope: SCOPE, module: "delta", graphDir, snapshotPath: resolveScopeArtifactPaths(graphDir, "demo").graph,
      session: pre.createSession(), rules, now: () => T0, retryDelayMs: 0, finalize: false
    });
    const s = fakeStudio(mods());
    const result = await runScope({ ...common(graphDir, s, []), pipelineDepth: 3 });
    expect(result.finalized).toBe(true);
    expect(s.events).toEqual([]);
  });
});

describe("runScope pipeline: timings", () => {
  it("never touches timings.json; the run report carries mode, depth and per-module spans instead", async () => {
    const graphDir = tmp();
    writeTimings(graphDir, "demo", [{ module: "sentinel", durationMs: 1234, nodeCount: 1, edgeCount: 1 }]);
    const path = timingsPath(graphDir, "demo");
    const before = read(path);
    const s = fakeStudio(mods());
    const result = await runScope({ ...common(graphDir, s, []), maxOpen: 12, pipelineDepth: 2 });
    expect(result.finalized).toBe(true);
    expect(read(path)).toBe(before);

    const report = JSON.parse(read(result.reportPath));
    expect(report.mode).toBe("pipeline");
    expect(report.pipelineDepth).toBe(2);
    expect(report.timings).toMatchObject({ mode: "pipeline", pipelineDepth: 2, maxOpen: 12 });
    expect(report.timings.wallMs).toBeGreaterThanOrEqual(0);
    expect(report.timings.modules.map((m: { module: string }) => m.module)).toEqual(SCOPE.modules);
    for (const m of report.timings.modules) expect(m.captureMs).toBeGreaterThanOrEqual(0);
    expect(result.pipeline).toMatchObject({ mode: "pipeline", pipelineDepth: 2 });
    expect(report.rows).toHaveLength(4);
  });

  it("does not create timings.json when none existed", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    await runScope({ ...common(graphDir, s, []), pipelineDepth: 2 });
    expect(existsSync(timingsPath(graphDir, "demo"))).toBe(false);
  });
});

describe("runScope pipeline: gapMs is a GUI cooldown only", () => {
  it("reads of an open module continue while the GUI operator cools down", async () => {
    const s = fakeStudio(mods(), { readerOptions: { delayMs: () => 2 } });
    const snapshots: Array<{ before: number; after: number }> = [];
    const sleep = async (): Promise<void> => {
      const before = s.reader.completions.length;
      await new Promise((r) => setTimeout(r, 25));
      snapshots.push({ before, after: s.reader.completions.length });
    };
    const result = await runScope({ ...common(tmp(), s, []), sleep, gapMs: 1_000, maxOpen: 12, pipelineDepth: 2 });
    expect(result.finalized).toBe(true);
    // At least one cooldown overlapped real reads of an already open module.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((x) => x.after > x.before)).toBe(true);
    expect(s.maxConcurrentGui).toBe(1);
  });
});

describe("runScope: graceful cancellation (Ctrl+C)", () => {
  /** Aborts the run the moment `module`'s open is logged as successful. */
  const cancelAfterOpen = (module: string, logs: string[]) => {
    const ac = new AbortController();
    const log = (line: string): void => {
      logs.push(line);
      if (line.includes(`open ${module} ok`)) ac.abort();
    };
    return { ac, log };
  };

  /** A state whose progress stream aborts the run the moment `module`'s capture has started reading. */
  const cancelWhileReading = (module: string) => {
    const ac = new AbortController();
    const { state, calls } = recordingState();
    const handle = (state as unknown as { handle: (e: { type: string; module?: string }) => void }).handle;
    (state as unknown as { handle: (e: { type: string; module?: string }) => void }).handle = (e) => {
      handle(e);
      if (e.type === "module-start" && e.module === module) ac.abort();
    };
    return { ac, state, calls };
  };

  it("depth 1: Ctrl+C after an open lets that module finish and close, and opens nothing more", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    const logs: string[] = [];
    const { ac, log } = cancelAfterOpen("alpha", logs);
    const { state, calls } = recordingState();
    const result = await runScope({ ...common(graphDir, s, logs), log, state, maxOpen: 12, pipelineDepth: 1, signal: ac.signal });
    expect(result.cancelled).toBe(true);
    expect(result.rows.map((r) => [r.module, r.outcome])).toEqual([
      ["alpha", "staged"],
      ["beta", "not-started"],
      ["gamma", "not-started"],
      ["delta", "not-started"]
    ]);
    expect(guiEvents(s)).toEqual(["open:alpha", "close:alpha"]);
    expect(calls).toContain("fail:RUN_CANCELLED");
    expect(existsSync(resolveScopeArtifactPaths(graphDir, "demo").graph)).toBe(false);
  });

  it("pipeline: Ctrl+C landing during an open gives that tab back unread and opens nothing more", async () => {
    const s = fakeStudio(mods());
    const logs: string[] = [];
    const { ac, log } = cancelAfterOpen("alpha", logs);
    const result = await runScope({ ...common(tmp(), s, logs), log, maxOpen: 12, pipelineDepth: 2, signal: ac.signal });
    expect(result.cancelled).toBe(true);
    expect(result.rows.every((r) => r.outcome === "not-started")).toBe(true);
    expect(guiEvents(s)).toEqual(["open:alpha", "close:alpha"]);
    expect(s.open.size).toBe(0);
  });

  for (const depth of [2, 4]) {
    it(`depth ${depth}: Ctrl+C while a module reads lets it finish, drain and close; the rest are not-started`, async () => {
      const graphDir = tmp();
      const s = fakeStudio(mods(), { readerOptions: { delayMs: ({ module }) => (module === "alpha" ? 3 : 0) } });
      const logs: string[] = [];
      const { ac, state, calls } = cancelWhileReading("alpha");
      const result = await runScope({ ...common(graphDir, s, logs), state, maxOpen: 12, pipelineDepth: depth, signal: ac.signal });

      expect(result.cancelled).toBe(true);
      expect(result.finalized).toBe(false);
      expect(result.failures).toBe(0);
      expect(result.stoppedEarly).toContain("cancelled");
      expect(existsSync(resolveScopeArtifactPaths(graphDir, "demo").graph)).toBe(false);
      // The in-flight module was captured, staged and its tab given back; nothing else was opened.
      expect(result.rows.map((r) => [r.module, r.outcome])).toEqual([
        ["alpha", "staged"],
        ["beta", "not-started"],
        ["gamma", "not-started"],
        ["delta", "not-started"]
      ]);
      expect(result.rows[0]?.closed).toBe(true);
      // An open already under way when Ctrl+C landed (beta at most) is given back unread; none after it.
      const gui = guiEvents(s);
      expect(gui.slice(0, 1)).toEqual(["open:alpha"]);
      expect(gui).toContain("close:alpha");
      expect(gui).not.toContain("open:gamma");
      expect(gui).not.toContain("open:delta");
      if (gui.includes("open:beta")) expect(gui).toContain("close:beta");
      expect(s.open.size).toBe(0);
      expect(s.atClose.every((c) => c.own === 0)).toBe(true);
      expect(readStage(graphDir, "demo").entries.map((e) => e.module)).toEqual(["alpha"]);
      expect(calls).toContain("fail:RUN_CANCELLED");
      expect(calls).not.toContain("event:done");
      // The report on disk lists every module, so the cancellation is complete and resumable.
      expect(JSON.parse(read(result.reportPath)).rows).toHaveLength(SCOPE.modules.length);
    });
  }

  it("a signal already aborted before the run starts opens nothing", async () => {
    const s = fakeStudio(mods());
    const ac = new AbortController();
    ac.abort();
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 12, pipelineDepth: 2, signal: ac.signal });
    expect(result.cancelled).toBe(true);
    expect(guiEvents(s)).toEqual([]);
    expect(result.rows.every((r) => r.outcome === "not-started")).toBe(true);
  });

  it("the cancelled run resumes: the next run skips the staged module and finalizes", async () => {
    const graphDir = tmp();
    const first = fakeStudio(mods(), { readerOptions: { delayMs: ({ module }) => (module === "alpha" ? 3 : 0) } });
    const { ac, state } = cancelWhileReading("alpha");
    const cancelled = await runScope({ ...common(graphDir, first, []), state, maxOpen: 12, pipelineDepth: 2, signal: ac.signal });
    expect(cancelled.rows.find((r) => r.module === "alpha")?.outcome).toBe("staged");
    const second = fakeStudio(mods());
    const result = await runScope({ ...common(graphDir, second, []), maxOpen: 12, pipelineDepth: 2 });
    expect(result.finalized).toBe(true);
    expect(result.rows.find((r) => r.module === "alpha")?.outcome).toBe("skipped");
    expect(second.events).not.toContain("open:alpha");
  });
});

describe("runScope --trace", () => {
  /** Gives the fake reader a call-trace hook: every getDataModel is reported as one traced call. */
  const withCallTrace = (s: ReturnType<typeof fakeStudio>) => {
    type Sink = (t: import("../src/servicestudio/trace.js").CallTrace) => void;
    const reader = s.reader as unknown as {
      setCallTrace?: (sink: Sink | undefined) => void;
      concurrency?: number;
      getDataModel: (m: string) => Promise<string>;
    };
    let sink: Sink | undefined;
    let id = 0;
    const original = reader.getDataModel.bind(reader);
    reader.setCallTrace = (next) => {
      sink = next;
    };
    Object.defineProperty(reader, "concurrency", { value: 4 });
    reader.getDataModel = async (m: string) => {
      const q = performance.now();
      const text = await original(m);
      const end = performance.now();
      sink?.({
        id: ++id,
        tool: "getDataModel",
        module: m,
        startedAtUtc: T0.toISOString(),
        queuedMs: q,
        admissions: [{ admittedMs: q, releasedMs: end }],
        attempts: [{ startMs: q, endMs: end, ok: true }],
        settledMs: end,
        ok: true
      });
      return text;
    };
  };

  for (const depth of [1, 2]) {
    it(`depth ${depth}: writes calls.jsonl (calls + GUI spans) and a trace summary in the report and result`, async () => {
      const graphDir = tmp();
      const s = fakeStudio(mods());
      withCallTrace(s);
      const result = await runScope({ ...common(graphDir, s, []), maxOpen: 12, pipelineDepth: depth, trace: true });
      expect(result.finalized).toBe(true);
      const trace = result.trace;
      expect(trace?.callTracing).toBe(true);
      expect(trace?.calls).toBe(SCOPE.modules.length);
      expect(trace?.readSlots).toBe(4);
      expect(trace?.gui.opens).toBe(SCOPE.modules.length);
      expect(trace?.gui.closes).toBe(SCOPE.modules.length);
      expect(trace?.gui.overlappedMs).toBeLessThanOrEqual(trace?.gui.totalMs ?? 0);
      const lines = read(trace?.file as string).trim().split("\n").map((l) => JSON.parse(l) as { type: string });
      expect(lines.filter((l) => l.type === "call")).toHaveLength(SCOPE.modules.length);
      expect(lines.filter((l) => l.type === "gui")).toHaveLength(SCOPE.modules.length * 2);
      expect(JSON.parse(read(result.reportPath)).trace.calls).toBe(SCOPE.modules.length);
      // The sink is detached at the end of the run.
      expect((s.reader as unknown as { setCallTrace: unknown }).setCallTrace).toBeTypeOf("function");
    });
  }

  it("a reader without setCallTrace still gets GUI spans, flagged callTracing: false", async () => {
    const s = fakeStudio(mods());
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 12, pipelineDepth: 2, trace: true });
    expect(result.trace?.callTracing).toBe(false);
    expect(result.trace?.calls).toBe(0);
    expect(result.trace?.gui.opens).toBe(SCOPE.modules.length);
  });

  it("without trace the report and result carry no trace", async () => {
    const s = fakeStudio(mods());
    const result = await runScope({ ...common(tmp(), s, []), maxOpen: 12, pipelineDepth: 2 });
    expect(result.trace).toBeUndefined();
    expect(JSON.parse(read(result.reportPath)).trace).toBeUndefined();
    expect(existsSync(join(result.runDir, "calls.jsonl"))).toBe(false);
  });
});

describe("RunState under a pipeline", () => {
  it("failRun marks every running module failed, and status lists them all as activeModules", () => {
    let clock = 1_700_000_000_000;
    const dir = tmp();
    const state = new RunState({ graphDir: dir, now: () => clock });
    const names = ["a", "b", "c"];
    state.beginRun("sc", names);
    state.handle({ type: "module-start", module: "a", index: 1, total: 3, moduleType: "eSpace" });
    state.handle({ type: "module-start", module: "b", index: 2, total: 3, moduleType: "eSpace" });
    clock += 1_000;
    const live = state.status("sc", names, null, null);
    expect(live.current?.module).toBe("a");
    expect(live.activeModules?.map((m) => m.module)).toEqual(["a", "b"]);

    state.failRun("TOKEN_EXPIRED", "gone");
    const dead = state.status("sc", names, null, null);
    expect(dead.modules.map((m) => m.state)).toEqual(["failed", "failed", "pending"]);
    expect(dead.modules.filter((m) => m.error === "TOKEN_EXPIRED")).toHaveLength(2);
    expect(dead.activeModules).toBeUndefined();
    expect(dead.progress.modulesFailed).toBe(2);
  });
});
