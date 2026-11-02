/**
 * Live run state: consumes the rebuild's own `RebuildProgressEvent` stream and answers
 * `/api/status`.
 *
 * This is the replacement for the kit dashboard's reconstruction layer. The kit had to infer the
 * run from the outside — `RUN_START`/`RUN_DONE` regexes over a tailed log, `rebuild: module 1/1
 * 'X'` matches to find the current module, `countFilesSince()` over `raw/` to guess how far a
 * silent fetch phase had got, and a PowerShell `Win32_Process` scan to answer "is a rebuild
 * running?" (failing closed when it could not tell). Every one of those is an estimate of
 * something this class is simply *told*.
 *
 * Deliberate behavioural difference from the kit: module percentage weights a phase by its share
 * of the module's **summed phase spans**, not by `phaseSpan / totalMs`. At `concurrency > 1`
 * phases overlap and sum to more than the module's wall-clock duration, so the kit's divisor was
 * the wrong denominator and its result had to be clamped under 1 to stay sane. Normalising by the
 * sum makes the weights a real partition.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { REBUILD_PHASES, type RebuildPerModule, type RebuildPhase, type RebuildProgressEvent, formatProgress } from "../rebuild/rebuild.js";
import { readAllTimings } from "./timings.js";
import type { ModuleCost, Status, StatusCurrent, StatusFlows, StatusLogLine, StatusModuleRow } from "./types.js";

/** Silence longer than this reads as stalled. A fetch phase is legitimately quiet for 20+ minutes. */
export const STALL_AFTER_MS = 30 * 60_000;
/** Per-module cost a pending module is assumed to add beyond its read time (osopener open+close). */
export const OPEN_CLOSE_OVERHEAD_MS = 25_000;
/** Lines kept for the page's live log panel. */
const LOG_TAIL_LIMIT = 400;

const LAYER_RE = /_(LKP|CS|ST|IS|BL|SL|CW|UI|CNF|Lib)$/i;

/** Layer suffix for a module name, or `other`. Presentation only — never gates logic. */
export function layerOf(module: string): string {
  return LAYER_RE.exec(module)?.[1] ?? "other";
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Per-module live tracking for the active run. */
interface LiveModule {
  module: string;
  index: number;
  state: "pending" | "running" | "done" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  actualMs: number | null;
  nodes: number | null;
  edges: number | null;
  skipped: number | null;
  error: string | null;
  errorMessage: string | null;
  phase: RebuildPhase | null;
  phaseStartedAt: number | null;
  phaseCount: number | null;
  phaseItemsRead: number;
  phasesDone: Partial<Record<RebuildPhase, number>>;
}

export interface RunStateOptions {
  graphDir: string;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/** Reads the files a finished rebuild leaves behind, for the scope the page is looking at. */
export interface ScopeFiles {
  graph: string;
  meta: string;
  flows: string;
}

export function scopeFiles(graphDir: string, scope: string): ScopeFiles {
  const dir = join(graphDir, scope);
  return { graph: join(dir, "graph.json"), meta: join(dir, "meta.json"), flows: join(dir, "flows.json") };
}

export class RunState {
  private readonly graphDir: string;
  private readonly now: () => number;

  /** The scope being rebuilt, or null when no run has happened in this process. */
  private scope: string | null = null;
  private modules: LiveModule[] = [];
  private byKey = new Map<string, LiveModule>();
  private runStartedAt: number | null = null;
  private complete = false;
  private finalized = false;
  private lastActivityAt: number | null = null;
  private log: StatusLogLine[] = [];
  /** Cached history, re-read at the start of each run (not per request: it is a file scan). */
  private expected = new Map<string, ModuleCost>();

  constructor(options: RunStateOptions) {
    this.graphDir = options.graphDir;
    this.now = options.now ?? Date.now;
  }

  /** True while a rebuild is walking Service Studio — what the kit needed a process scan for. */
  get rebuildActive(): boolean {
    return this.runStartedAt !== null && !this.complete;
  }

  get activeScope(): string | null {
    return this.scope;
  }

  /**
   * Starts a run. `modules` is the resolved walk order, so every row exists as `pending` from the
   * first poll — the page shows the whole plan immediately rather than growing a list.
   */
  beginRun(scope: string, modules: readonly string[]): void {
    this.scope = scope;
    this.runStartedAt = this.now();
    this.complete = false;
    this.finalized = false;
    this.lastActivityAt = this.runStartedAt;
    this.log = [];
    this.expected = readAllTimings(this.graphDir);
    this.modules = modules.map((module, i) => ({
      module,
      index: i + 1,
      state: "pending",
      startedAt: null,
      finishedAt: null,
      actualMs: null,
      nodes: null,
      edges: null,
      skipped: null,
      error: null,
      errorMessage: null,
      phase: null,
      phaseStartedAt: null,
      phaseCount: null,
      phaseItemsRead: 0,
      phasesDone: {}
    }));
    this.byKey = new Map(this.modules.map((m) => [m.module.toLowerCase(), m]));
  }

  /** Feeds one progress event. Safe to call before `beginRun` (the line is still logged). */
  handle(event: RebuildProgressEvent): void {
    const at = this.now();
    this.lastActivityAt = at;
    this.push({ at, text: formatProgress(event) });

    switch (event.type) {
      case "session":
        break;
      case "module-start": {
        const m = this.ensure(event.module, event.index);
        m.state = "running";
        m.startedAt = at;
        m.phase = null;
        m.phaseStartedAt = null;
        m.phaseCount = null;
        m.phaseItemsRead = 0;
        m.phasesDone = {};
        break;
      }
      case "phase-start": {
        const m = this.ensure(event.module);
        m.phase = event.phase;
        m.phaseStartedAt = at;
        m.phaseCount = event.total ?? null;
        m.phaseItemsRead = 0;
        break;
      }
      case "element": {
        const m = this.ensure(event.module);
        // Counted rather than derived from `index`: element fetches run concurrently and arrive
        // out of order, so `index` is a label, not a counter (see RebuildProgressEvent's note).
        if (event.phase === m.phase) m.phaseItemsRead += 1;
        if (event.outcome === "failed") {
          m.error = "ELEMENT_READ_FAILED";
          m.errorMessage = `${event.kind} '${event.name}' failed`;
        }
        break;
      }
      case "phase-done": {
        const m = this.ensure(event.module);
        m.phasesDone[event.phase] = event.durationMs;
        if (m.phase === event.phase) {
          m.phase = null;
          m.phaseStartedAt = null;
          m.phaseCount = null;
          m.phaseItemsRead = 0;
        }
        break;
      }
      case "module-done": {
        const m = this.ensure(event.module);
        m.state = "done";
        m.finishedAt = at;
        m.actualMs = event.durationMs;
        m.skipped = event.skippedCount;
        m.phase = null;
        m.phaseStartedAt = null;
        m.phaseCount = null;
        break;
      }
      case "done":
        this.complete = true;
        break;
    }
  }

  /**
   * The run finished and its snapshot is on disk. `perModule` carries the authoritative node/edge
   * counts, which the event stream does not.
   */
  finishRun(perModule: readonly RebuildPerModule[]): void {
    this.complete = true;
    this.finalized = true;
    this.lastActivityAt = this.now();
    for (const row of perModule) {
      const m = this.byKey.get(row.module.toLowerCase()) ?? this.byKey.get((row.requestedAs ?? "").toLowerCase());
      if (!m) continue;
      m.state = "done";
      m.nodes = row.nodeCount;
      m.edges = row.edgeCount;
      m.skipped = row.skippedCount;
      m.actualMs = row.durationMs;
    }
  }

  /**
   * The run aborted. The module that was running is marked failed so the page shows *where* it
   * died rather than silently freezing on "running" — a rebuild aborts the whole walk on a
   * kind-level read failure (ADR-0011), so there is exactly one such module.
   */
  failRun(code: string, message: string): void {
    this.complete = true;
    this.finalized = false;
    this.lastActivityAt = this.now();
    const running = this.modules.find((m) => m.state === "running");
    if (running) {
      running.state = "failed";
      running.error = code;
      running.errorMessage = message;
      running.phase = null;
    }
    this.push({ at: this.now(), text: `rebuild: FAILED ${code}: ${message}` });
  }

  private ensure(module: string, index?: number): LiveModule {
    const key = module.toLowerCase();
    const found = this.byKey.get(key);
    if (found) return found;
    // A module the scope file spelled differently, or an event before beginRun: track it anyway
    // rather than dropping the only record of what is happening.
    const added: LiveModule = {
      module,
      index: index ?? this.modules.length + 1,
      state: "pending",
      startedAt: null,
      finishedAt: null,
      actualMs: null,
      nodes: null,
      edges: null,
      skipped: null,
      error: null,
      errorMessage: null,
      phase: null,
      phaseStartedAt: null,
      phaseCount: null,
      phaseItemsRead: 0,
      phasesDone: {}
    };
    this.modules.push(added);
    this.byKey.set(key, added);
    return added;
  }

  private push(line: StatusLogLine): void {
    this.log.push(line);
    if (this.log.length > LOG_TAIL_LIMIT) this.log.splice(0, this.log.length - LOG_TAIL_LIMIT);
  }

  /**
   * The `/api/status` body for `scope`.
   *
   * Works for any scope, not only the one being rebuilt: `scopeModules` supplies the row list so
   * a scope with no run in this process still renders its plan, its snapshot and its flows. Live
   * fields appear only when `scope` is the active one.
   */
  status(scope: string, scopeModules: readonly string[], flows: StatusFlows | null, meta: unknown): Status {
    const now = this.now();
    const isActive = this.scope === scope;
    const files = scopeFiles(this.graphDir, scope);
    const graphM = mtime(files.graph);
    const expected = isActive ? this.expected : readAllTimings(this.graphDir);

    const live = isActive ? this.modules : [];
    const liveByKey = new Map(live.map((m) => [m.module.toLowerCase(), m]));
    const names = live.length > 0 ? live.map((m) => m.module) : [...scopeModules];

    const rows: StatusModuleRow[] = names.map((module, i) => {
      const key = module.toLowerCase();
      const m = liveByKey.get(key);
      const exp = expected.get(key);
      return {
        index: m?.index ?? i + 1,
        module,
        layer: layerOf(module),
        state: m?.state ?? "pending",
        actualMs: m?.actualMs ?? null,
        expectedMs: exp?.ms ?? null,
        nodes: m?.nodes ?? null,
        edges: m?.edges ?? null,
        skipped: m?.skipped ?? null,
        stagedAt: m?.finishedAt === null || m?.finishedAt === undefined ? null : new Date(m.finishedAt).toISOString(),
        error: m?.error ?? null,
        errorMessage: m?.errorMessage ?? null
      };
    });

    const current = isActive ? this.currentInfo(now, expected) : null;

    // Weight by expected duration so one huge module cannot read as "1 of 30"; a module with no
    // history counts as the average known one.
    const known = rows.filter((r) => r.expectedMs !== null);
    const avgExp = known.length > 0 ? known.reduce((n, r) => n + (r.expectedMs ?? 0), 0) / known.length : 1;
    const weight = (r: StatusModuleRow): number => r.expectedMs ?? avgExp;
    const totalExp = rows.reduce((n, r) => n + weight(r), 0) || 1;
    const doneRows = rows.filter((r) => r.state === "done");
    const doneExp = doneRows.reduce((n, r) => n + weight(r), 0);
    const curRow = rows.find((r) => r.state === "running");
    const curDoneExp = curRow && current?.pct != null ? weight(curRow) * current.pct : 0;
    const pctByTime = this.finalized && isActive ? 1 : Math.min(0.999, (doneExp + curDoneExp) / totalExp);

    // Pace from THIS run only: old timings drift with Studio load, so a run that is uniformly
    // 1.4x slower than history should push the ETA out rather than keep promising the old figure.
    const paced = doneRows.filter((r) => r.actualMs !== null && r.expectedMs !== null);
    const pace =
      paced.length > 0
        ? paced.reduce((n, r) => n + (r.actualMs ?? 0), 0) / paced.reduce((n, r) => n + (r.expectedMs ?? 0), 0)
        : null;

    const pendingRows = rows.filter((r) => r.state === "pending" || r.state === "failed");
    const remainingExp =
      pendingRows.reduce((n, r) => n + (r.expectedMs ?? 0) + OPEN_CLOSE_OVERHEAD_MS, 0) +
      (curRow?.expectedMs != null ? Math.max(0, curRow.expectedMs - curDoneExp) : 0);
    // Only promise an ETA when every unfinished module has history: one unknown module can be
    // the one that takes 40 minutes, and a confidently wrong ETA is worse than none.
    const etaKnown = rows.filter((r) => r.state !== "done").every((r) => r.expectedMs !== null);
    const etaMs = !isActive ? null : this.finalized || this.complete ? 0 : etaKnown ? Math.round(remainingExp * (pace ?? 1)) : null;

    return {
      now,
      scope,
      run: {
        startedAt: isActive ? this.runStartedAt : null,
        elapsedMs: isActive && this.runStartedAt !== null ? now - this.runStartedAt : null,
        complete: isActive ? this.complete : false,
        finalized: isActive ? this.finalized : false,
        stalled:
          isActive && !this.complete && !this.finalized && this.lastActivityAt !== null && now - this.lastActivityAt > STALL_AFTER_MS,
        lastActivityAt: isActive ? this.lastActivityAt : null,
        noRunLog: !isActive || this.runStartedAt === null
      },
      progress: {
        modulesDone: doneRows.length,
        modulesTotal: rows.length,
        modulesFailed: rows.filter((r) => r.state === "failed").length,
        pctByModules: rows.length > 0 ? doneRows.length / rows.length : 0,
        pctByTime,
        pace,
        etaMs,
        etaAt: etaMs ? now + etaMs : null
      },
      current,
      modules: rows,
      snapshot: {
        exists: graphM !== null,
        writtenAt: graphM,
        fromThisRun: isActive && this.finalized,
        hasPrevious: false,
        meta
      },
      flows,
      logTail: isActive ? this.log.slice(-14) : []
    };
  }

  private currentInfo(now: number, expected: Map<string, ModuleCost>): StatusCurrent | null {
    const m = this.modules.find((x) => x.state === "running");
    if (!m) return null;
    const exp = expected.get(m.module.toLowerCase());
    const elapsed = m.startedAt === null ? null : now - m.startedAt;
    const phaseElapsed = m.phaseStartedAt === null ? null : now - m.phaseStartedAt;
    const phasesExpected = exp && Object.keys(exp.phases).length > 0 ? exp.phases : null;

    return {
      module: m.module,
      startedAt: m.startedAt,
      elapsedMs: elapsed,
      expectedMs: exp?.ms ?? null,
      phase: m.phase,
      phaseCount: m.phaseCount,
      phaseElapsedMs: phaseElapsed,
      phaseExpectedMs: m.phase && phasesExpected ? phasesExpected[m.phase] ?? null : null,
      phaseItemsRead: m.phase === null ? null : m.phaseItemsRead,
      phasesDone: m.phasesDone,
      phasesExpected,
      pct: modulePct(m, exp, phaseElapsed, elapsed)
    };
  }
}

/**
 * How far through the current module we are, 0..1.
 *
 * Three fallbacks, best first:
 *  1. phase weights from history — finished phases at their share of the module's summed spans,
 *     plus the running phase's elapsed share, capped so a slow phase cannot overrun its weight;
 *  2. total time from history — elapsed / expected;
 *  3. no history at all — elements read against the counts each phase announced, which is why the
 *     bar still moves on a brand-new workspace's first run.
 */
function modulePct(
  m: { phasesDone: Partial<Record<RebuildPhase, number>>; phase: RebuildPhase | null; phaseCount: number | null; phaseItemsRead: number },
  exp: ModuleCost | undefined,
  phaseElapsed: number | null,
  elapsed: number | null
): number | null {
  const phases = exp?.phases;
  const spanTotal = phases ? Object.values(phases).reduce((n, v) => n + (v ?? 0), 0) : 0;

  if (phases && spanTotal > 0) {
    let done = 0;
    for (const phase of REBUILD_PHASES) {
      if (m.phasesDone[phase] !== undefined) done += (phases[phase] ?? 0) / spanTotal;
    }
    let running = 0;
    if (m.phase && phaseElapsed !== null) {
      const share = (phases[m.phase] ?? 0) / spanTotal;
      const expectedPhaseMs = phases[m.phase] ?? 0;
      running = expectedPhaseMs > 0 ? Math.min(share * 0.95, (phaseElapsed / expectedPhaseMs) * share) : 0;
    }
    return Math.min(0.99, done + running);
  }

  if (exp?.ms && elapsed !== null) return Math.min(0.95, elapsed / exp.ms);

  if (m.phase !== null && m.phaseCount !== null && m.phaseCount > 0) {
    const within = Math.min(1, m.phaseItemsRead / m.phaseCount);
    const phaseIndex = REBUILD_PHASES.indexOf(m.phase);
    const base = phaseIndex < 0 ? 0 : phaseIndex / REBUILD_PHASES.length;
    return Math.min(0.95, base + within / REBUILD_PHASES.length);
  }

  const doneCount = Object.keys(m.phasesDone).length;
  return doneCount > 0 ? Math.min(0.95, doneCount / REBUILD_PHASES.length) : null;
}
