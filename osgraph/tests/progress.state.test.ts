/**
 * RunState + timings: the in-process replacement for the kit dashboard's log-regex reconstruction.
 *
 * What these tests are really pinning down is the `/api/status` contract, because
 * `dashboard/index.html` was written against it and a silently-renamed field would break the page
 * with no compile error anywhere.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RebuildPerModule, RebuildProgressEvent } from "../src/rebuild/rebuild.js";
import { OPEN_CLOSE_OVERHEAD_MS, RunState, STALL_AFTER_MS, layerOf } from "../src/progress/state.js";
import { readAllTimings, readTimings, writeTimings } from "../src/progress/timings.js";

let dir: string;
/** Controllable clock: every assertion about elapsed/ETA needs time to stand still. */
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osgraph-progress-"));
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (): RunState => new RunState({ graphDir: dir, now });
const MODULES = ["MOD_A_BL", "MOD_B_CW"];

describe("layerOf", () => {
  it("reads the layer suffix and falls back to 'other'", () => {
    expect(layerOf("MOD_X_BL")).toBe("BL");
    expect(layerOf("MOD_X_CW")).toBe("CW");
    expect(layerOf("somelibrary")).toBe("other");
  });
});

describe("RunState", () => {
  it("renders every scope module as pending from the first poll", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    const st = s.status("sc", MODULES, null, null);

    expect(st.modules.map((m) => m.module)).toEqual(MODULES);
    expect(st.modules.map((m) => m.state)).toEqual(["pending", "pending"]);
    expect(st.progress.modulesTotal).toBe(2);
    expect(st.progress.modulesDone).toBe(0);
    expect(st.current).toBeNull();
    expect(st.run.noRunLog).toBe(false);
  });

  it("tracks the current module, its phase and the elements read within it", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
    s.handle({ type: "phase-start", module: "MOD_A_BL", phase: "screens", total: 4 });
    clock += 2_000;
    s.handle({ type: "element", module: "MOD_A_BL", phase: "screens", kind: "Screen", name: "S1", index: 1, total: 4, outcome: "ok", durationMs: 10 });
    // Out-of-order index: a concurrent walk reports listing position, not a serial counter.
    s.handle({ type: "element", module: "MOD_A_BL", phase: "screens", kind: "Screen", name: "S3", index: 3, total: 4, outcome: "ok", durationMs: 10 });

    const st = s.status("sc", MODULES, null, null);
    expect(st.current?.module).toBe("MOD_A_BL");
    expect(st.current?.phase).toBe("screens");
    expect(st.current?.phaseCount).toBe(4);
    // Counted, not inferred from `index` — which is why the out-of-order event still counts as 2.
    expect(st.current?.phaseItemsRead).toBe(2);
    expect(st.current?.elapsedMs).toBe(2_000);
    expect(st.modules[0]?.state).toBe("running");
  });

  it("moves a module to done and reports node/edge counts from the result", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
    s.handle({ type: "phase-done", module: "MOD_A_BL", phase: "screens", durationMs: 1_234 });
    s.handle({ type: "module-done", module: "MOD_A_BL", durationMs: 5_000, skippedCount: 1 });

    let st = s.status("sc", MODULES, null, null);
    expect(st.modules[0]?.state).toBe("done");
    expect(st.modules[0]?.actualMs).toBe(5_000);
    expect(st.modules[0]?.skipped).toBe(1);
    expect(st.modules[0]?.stagedAt).toBe(new Date(clock).toISOString());
    // Counts are not in the event stream; they arrive with the result.
    expect(st.modules[0]?.nodes).toBeNull();

    s.finishRun([perModule("MOD_A_BL", { nodeCount: 11, edgeCount: 7, durationMs: 5_000 })]);
    st = s.status("sc", MODULES, null, null);
    expect(st.modules[0]?.nodes).toBe(11);
    expect(st.modules[0]?.edges).toBe(7);
    expect(st.run.finalized).toBe(true);
    expect(st.progress.pctByTime).toBe(1);
  });

  it("answers rebuildActive without a process scan, and clears it when the run finishes", () => {
    const s = state();
    expect(s.rebuildActive).toBe(false);
    s.beginRun("sc", MODULES);
    expect(s.rebuildActive).toBe(true);
    s.handle({ type: "done", durationMs: 1, snapshotPath: "x" });
    expect(s.rebuildActive).toBe(false);
  });

  it("marks the running module failed when the run aborts, so the page shows where it died", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    s.handle({ type: "module-start", module: "MOD_B_CW", index: 2, total: 2, moduleType: "eSpace" });
    s.failRun("KIND_READ_FAILED", "getScreenNames failed twice");

    const st = s.status("sc", MODULES, null, null);
    const row = st.modules.find((m) => m.module === "MOD_B_CW");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("KIND_READ_FAILED");
    expect(st.progress.modulesFailed).toBe(1);
    expect(st.run.finalized).toBe(false);
    expect(st.logTail.at(-1)?.text).toContain("FAILED KIND_READ_FAILED");
  });

  it("reports stalled only after the silence threshold", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });

    clock += STALL_AFTER_MS - 1_000;
    expect(s.status("sc", MODULES, null, null).run.stalled).toBe(false);
    clock += 2_000;
    expect(s.status("sc", MODULES, null, null).run.stalled).toBe(true);
  });

  it("serves a scope that has no run in this process, with no live fields", () => {
    const s = state();
    s.beginRun("active", MODULES);
    s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });

    const other = s.status("other", ["MOD_Z_UI"], null, null);
    expect(other.scope).toBe("other");
    expect(other.modules.map((m) => m.module)).toEqual(["MOD_Z_UI"]);
    expect(other.current).toBeNull();
    expect(other.run.noRunLog).toBe(true);
    expect(other.run.startedAt).toBeNull();
    expect(other.logTail).toEqual([]);
  });

  it("reports the snapshot's existence and mtime from disk", () => {
    const s = state();
    mkdirSync(join(dir, "sc"), { recursive: true });
    writeFileSync(join(dir, "sc", "graph.json"), "{}");
    s.beginRun("sc", MODULES);

    const st = s.status("sc", MODULES, null, null);
    expect(st.snapshot.exists).toBe(true);
    expect(st.snapshot.writtenAt).toBeGreaterThan(0);
  });

  describe("ETA", () => {
    it("is null while any unfinished module has no history", () => {
      const s = state();
      s.beginRun("sc", MODULES);
      expect(s.status("sc", MODULES, null, null).progress.etaMs).toBeNull();
    });

    it("uses history plus this run's pace once every remaining module is known", () => {
      // Both modules measured at 10s last time.
      writeTimings(dir, "sc", [
        { module: "MOD_A_BL", durationMs: 10_000 },
        { module: "MOD_B_CW", durationMs: 10_000 }
      ]);
      const s = state();
      s.beginRun("sc", MODULES);
      // A finishes in 20s — this run is pacing at 2x its history.
      s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
      s.handle({ type: "module-done", module: "MOD_A_BL", durationMs: 20_000, skippedCount: 0 });

      const st = s.status("sc", MODULES, null, null);
      expect(st.progress.pace).toBe(2);
      // One module left: (10s expected + 25s open/close) * 2x pace.
      expect(st.progress.etaMs).toBe((10_000 + OPEN_CLOSE_OVERHEAD_MS) * 2);
      expect(st.progress.etaAt).toBe(clock + (st.progress.etaMs ?? 0));
    });

    it("is zero once the run is complete", () => {
      const s = state();
      s.beginRun("sc", MODULES);
      s.handle({ type: "done", durationMs: 1, snapshotPath: "x" });
      expect(s.status("sc", MODULES, null, null).progress.etaMs).toBe(0);
    });
  });

  describe("module percentage", () => {
    it("weights finished phases by their share of the summed spans, never exceeding 1", () => {
      // Phases summing to 4000ms while the module's wall clock was 3000ms — the overlap that
      // made the kit's phaseSpan/totalMs divisor wrong.
      writeTimings(dir, "sc", [
        { module: "MOD_A_BL", durationMs: 3_000, phaseDurationsMs: { screens: 3_000, blocks: 1_000 } }
      ]);
      const s = state();
      s.beginRun("sc", MODULES);
      s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
      s.handle({ type: "phase-done", module: "MOD_A_BL", phase: "screens", durationMs: 3_000 });

      const pct = s.status("sc", MODULES, null, null).current?.pct;
      // screens is 3000/4000 of the work, so 0.75 — not 3000/3000 = 1.0.
      expect(pct).toBeCloseTo(0.75, 5);
    });

    it("falls back to elements read when there is no history at all", () => {
      const s = state();
      s.beginRun("sc", MODULES);
      s.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
      s.handle({ type: "phase-start", module: "MOD_A_BL", phase: "screens", total: 2 });

      const before = s.status("sc", MODULES, null, null).current?.pct ?? 0;
      s.handle({ type: "element", module: "MOD_A_BL", phase: "screens", kind: "Screen", name: "S1", index: 1, total: 2, outcome: "ok", durationMs: 5 });
      const after = s.status("sc", MODULES, null, null).current?.pct ?? 0;

      expect(after).toBeGreaterThan(before);
      expect(after).toBeLessThanOrEqual(0.95);
    });
  });

  it("keeps the log tail bounded and formatted like the stderr lines", () => {
    const s = state();
    s.beginRun("sc", MODULES);
    for (let i = 0; i < 500; i++) s.handle({ type: "session", message: `line ${i}` });

    const st = s.status("sc", MODULES, null, null);
    expect(st.logTail.length).toBeLessThanOrEqual(14);
    expect(st.logTail.at(-1)?.text).toBe("rebuild: line 499");
  });
});

describe("timings store", () => {
  it("round-trips, keyed case-insensitively", () => {
    writeTimings(dir, "sc", [{ module: "MOD_A_BL", durationMs: 1_234, phaseDurationsMs: { screens: 1_000 } }]);
    const read = readTimings(dir, "sc");
    expect(read.get("mod_a_bl")?.ms).toBe(1_234);
    expect(read.get("mod_a_bl")?.phases.screens).toBe(1_000);
  });

  it("merges across scopes, because latency belongs to the module not the scope", () => {
    writeTimings(dir, "one", [{ module: "MOD_A_BL", durationMs: 1_000 }]);
    writeTimings(dir, "two", [{ module: "MOD_B_CW", durationMs: 2_000 }]);
    const all = readAllTimings(dir);
    expect(all.get("mod_a_bl")?.ms).toBe(1_000);
    expect(all.get("mod_b_cw")?.ms).toBe(2_000);
  });

  it("replaces a module's previous measurement and leaves untouched modules alone", () => {
    writeTimings(dir, "sc", [
      { module: "MOD_A_BL", durationMs: 1_000 },
      { module: "MOD_B_CW", durationMs: 2_000 }
    ]);
    writeTimings(dir, "sc", [{ module: "MOD_A_BL", durationMs: 9_000 }]);
    const read = readTimings(dir, "sc");
    expect(read.get("mod_a_bl")?.ms).toBe(9_000);
    expect(read.get("mod_b_cw")?.ms).toBe(2_000);
  });

  it("returns empty rather than throwing on a missing or corrupt file", () => {
    expect(readTimings(dir, "nope").size).toBe(0);
    mkdirSync(join(dir, "bad"), { recursive: true });
    writeFileSync(join(dir, "bad", "timings.json"), "{ not json");
    expect(readTimings(dir, "bad").size).toBe(0);
  });

  it("writes nothing for an empty run", () => {
    expect(writeTimings(dir, "sc", [])).toBe(false);
  });
});

function perModule(module: string, over: Partial<RebuildPerModule>): RebuildPerModule {
  return {
    module,
    layer: layerOf(module),
    nodeCount: 0,
    edgeCount: 0,
    skippedCount: 0,
    referencedOnlyCount: 0,
    durationMs: 0,
    phaseDurationsMs: {} as RebuildPerModule["phaseDurationsMs"],
    concurrency: 4,
    ...over
  };
}

// Keeps the event union honest: if a new event type is added, this stops compiling.
const _exhaustive: RebuildProgressEvent["type"][] = [
  "session",
  "module-start",
  "phase-start",
  "element",
  "phase-done",
  "module-done",
  "done"
];
void _exhaustive;
