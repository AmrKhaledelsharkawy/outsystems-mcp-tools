/**
 * `summarizeTrace` (osgraph run --trace): the two pipeline mechanisms are measured separately, so the
 * interval arithmetic is pinned here with hand-built traces (no client, no timers).
 */
import { describe, expect, it } from "vitest";
import { summarizeTrace, unionIntervals, type CallTrace, type GuiSpan } from "../src/servicestudio/trace.js";

const call = (id: number, queued: number, admitted: number, released: number, attempts = 1, ok = true): CallTrace => ({
  id,
  tool: "getServerAction",
  module: "M",
  startedAtUtc: "2026-11-22T00:00:00.000Z",
  queuedMs: queued,
  admissions: [{ admittedMs: admitted, releasedMs: released }],
  attempts: Array.from({ length: attempts }, (_, i) => ({ startMs: admitted + i, endMs: released, ok: i === attempts - 1 })),
  settledMs: released,
  ok
});

describe("summarizeTrace", () => {
  it("unions overlapping intervals", () => {
    expect(unionIntervals([[5, 8], [0, 2], [1, 3], [8, 9]])).toEqual([[0, 3], [5, 9]]);
  });

  it("read-slot utilization is permit-busy time over slots x read window", () => {
    // Two permits busy 0-100 in a 4-slot client over a 100 ms window: 200 / 400.
    const s = summarizeTrace([call(1, 0, 0, 100), call(2, 0, 0, 100)], [], 4);
    expect(s.readWindowMs).toBe(100);
    expect(s.permitBusyMs).toBe(200);
    expect(s.readSlotUtilization).toBe(0.5);
    expect(s.maxConcurrentObserved).toBe(2);
  });

  it("queue wait is queued -> first admission; retries are counted", () => {
    const s = summarizeTrace([call(1, 0, 0, 10), call(2, 0, 10, 20, 2), call(3, 5, 20, 30)], [], 1);
    expect(s.queueWaitMs.total).toBe(25);
    expect(s.queueWaitMs.max).toBe(15);
    expect(s.retriedCalls).toBe(1);
    // A permit handed over at the same instant is never two at once.
    expect(s.maxConcurrentObserved).toBe(1);
  });

  it("GUI time is split into hidden-behind-reads and exposed", () => {
    const calls = [call(1, 0, 0, 50), call(2, 0, 80, 100)];
    const gui: GuiSpan[] = [
      { action: "open", module: "B", startMs: 40, endMs: 90, ok: true }, // 10 + 10 overlapped, 30 exposed
      { action: "close", module: "A", startMs: 100, endMs: 110, ok: true } // fully exposed
    ];
    const s = summarizeTrace(calls, gui, 4);
    expect(s.gui).toEqual({ opens: 1, closes: 1, totalMs: 60, overlappedMs: 20, exposedMs: 40 });
  });

  it("an empty trace is all zeros", () => {
    const s = summarizeTrace([], [], 4);
    expect(s.calls).toBe(0);
    expect(s.readSlotUtilization).toBe(0);
    expect(s.gui.totalMs).toBe(0);
  });
});
