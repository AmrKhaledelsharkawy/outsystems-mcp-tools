/**
 * Per-call tracing for benchmark runs (`osgraph run --trace`, plan v3 section 9).
 *
 * The client records one `CallTrace` per logical servicestudio call: when it was queued (entered
 * `callTool`, before the token step and the FIFO), each time it held one of the read permits, each
 * HTTP attempt inside those admissions (a transient temp-OML retry is a second attempt), and when the
 * outermost promise settled. The run adds `GuiSpan`s for every osopener open/close. From those two
 * streams `summarizeTrace` derives the two pipeline mechanisms separately:
 *
 *  - read-slot filling: permit occupancy over the read window, and queue wait;
 *  - open/close hiding: how much GUI time overlapped at least one held permit, and how much was exposed.
 *
 * Times are `performance.now()` milliseconds (monotonic, one origin per process); `startedAtUtc`
 * anchors each call to wall time. No token, input or response text is recorded, only the tool name
 * and the module the call addressed.
 */

/** One permit held by a call: from admission (permit acquired) to release. */
export interface CallAdmission {
  admittedMs: number;
  releasedMs: number;
}

/** One HTTP attempt inside an admission. */
export interface CallAttempt {
  startMs: number;
  endMs: number;
  ok: boolean;
}

export interface CallTrace {
  id: number;
  tool: string;
  /** The `eSpaceName` the call addressed; null for module-less calls such as `listApps`. */
  module: string | null;
  startedAtUtc: string;
  queuedMs: number;
  /** Usually one; a token recovery re-enters the FIFO and adds a second. */
  admissions: CallAdmission[];
  attempts: CallAttempt[];
  settledMs: number;
  ok: boolean;
  errorCode?: string;
}

export type CallTraceSink = (trace: CallTrace) => void;

/** One osopener GUI action, as the run drove it. */
export interface GuiSpan {
  action: "open" | "close";
  module: string;
  startMs: number;
  endMs: number;
  ok: boolean;
}

export interface TraceSummary {
  calls: number;
  failedCalls: number;
  /** Calls with more than one HTTP attempt (transient retry) or more than one admission (token recovery). */
  retriedCalls: number;
  /** Read permits the client had (`maxConcurrent`): the denominator of `readSlotUtilization`. */
  readSlots: number;
  /** Most permits held at the same moment. */
  maxConcurrentObserved: number;
  /** First admission to last release, across all calls. */
  readWindowMs: number;
  /** Sum of every admission's held time. */
  permitBusyMs: number;
  /** `permitBusyMs / (readSlots * readWindowMs)`; 0 when there was no read window. */
  readSlotUtilization: number;
  /** Queued -> first admission, per call. */
  queueWaitMs: { total: number; p50: number; p95: number; max: number };
  /** Settled - queued, per call (what a caller waited, queue included). */
  callWallMs: { total: number; p50: number; p95: number; max: number };
  gui: {
    opens: number;
    closes: number;
    /** Sum of every GUI action's duration. */
    totalMs: number;
    /** GUI time during which at least one read permit was held: hidden behind reads. */
    overlappedMs: number;
    /** GUI time with no read in flight: still on the critical path of this run. */
    exposedMs: number;
  };
}

type Interval = [number, number];

/** Sorted, non-overlapping union of intervals. */
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Length of `[a, b)` covered by a sorted, non-overlapping union. */
function coveredLength(a: number, b: number, union: readonly Interval[]): number {
  let total = 0;
  for (const [x, y] of union) {
    if (y <= a) continue;
    if (x >= b) break;
    total += Math.min(b, y) - Math.max(a, x);
  }
  return total;
}

function stats(values: number[]): { total: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { total: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    total: round(sorted.reduce((s, v) => s + v, 0)),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] as number)
  };
}

/** Peak number of simultaneously held permits. */
function peakConcurrency(admissions: readonly CallAdmission[]): number {
  const points: Array<[number, number]> = [];
  for (const a of admissions) {
    points.push([a.admittedMs, 1], [a.releasedMs, -1]);
  }
  // Releases before admissions at the same instant: a handed-over permit is not two at once.
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of points) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

export function summarizeTrace(calls: readonly CallTrace[], gui: readonly GuiSpan[], readSlots: number): TraceSummary {
  const admissions = calls.flatMap((c) => c.admissions).filter((a) => a.releasedMs >= a.admittedMs);
  const busy = unionIntervals(admissions.map((a) => [a.admittedMs, a.releasedMs]));
  const windowStart = admissions.length > 0 ? Math.min(...admissions.map((a) => a.admittedMs)) : 0;
  const windowEnd = admissions.length > 0 ? Math.max(...admissions.map((a) => a.releasedMs)) : 0;
  const readWindowMs = windowEnd - windowStart;
  const permitBusyMs = admissions.reduce((s, a) => s + (a.releasedMs - a.admittedMs), 0);
  const guiTotal = gui.reduce((s, g) => s + Math.max(0, g.endMs - g.startMs), 0);
  const overlapped = gui.reduce((s, g) => s + coveredLength(g.startMs, g.endMs, busy), 0);
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    calls: calls.length,
    failedCalls: calls.filter((c) => !c.ok).length,
    retriedCalls: calls.filter((c) => c.attempts.length > 1 || c.admissions.length > 1).length,
    readSlots,
    maxConcurrentObserved: peakConcurrency(admissions),
    readWindowMs: round(readWindowMs),
    permitBusyMs: round(permitBusyMs),
    readSlotUtilization: readWindowMs > 0 ? Math.round((permitBusyMs / (readSlots * readWindowMs)) * 1000) / 1000 : 0,
    queueWaitMs: stats(calls.filter((c) => c.admissions.length > 0).map((c) => (c.admissions[0] as CallAdmission).admittedMs - c.queuedMs)),
    callWallMs: stats(calls.map((c) => c.settledMs - c.queuedMs)),
    gui: {
      opens: gui.filter((g) => g.action === "open").length,
      closes: gui.filter((g) => g.action === "close").length,
      totalMs: round(guiTotal),
      overlappedMs: round(overlapped),
      exposedMs: round(guiTotal - overlapped)
    }
  };
}
