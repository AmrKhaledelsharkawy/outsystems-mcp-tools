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
import { resolveScopeArtifactPaths } from "../graph/io.js";
import { REBUILD_PHASES, type RebuildPerModule, type RebuildPhase, type RebuildProgressEvent, formatProgress } from "../rebuild/rebuild.js";
import { readAllTimings } from "./timings.js";
import type { CaptureOutcome, ModuleCost, ModuleLifecycle, RunLifecycle, RunMode, Status, StatusCurrent, StatusFlows, StatusLogLine, StatusModuleRow } from "./types.js";

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
  lifecycle: ModuleLifecycle;
  captureOutcome: CaptureOutcome;
  versionReason: string | null;
  moduleVersion: string | null;
  previousCaptureVersion: string | null;
  openedHere: boolean | null;
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
  const { graph, meta, flows } = resolveScopeArtifactPaths(graphDir, scope);
  return { graph, meta, flows };
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
  private runSerial = 0;
  private runId: string | null = null;
  private sequence = 0;
  private mode: RunMode = "idle";
  private lifecycle: RunLifecycle = "idle";
  private pipelineDepth = 1;
  private readLimit = 4;
  private traceEnabled = false;
  private workers = { active: 0, queued: 0, limit: 4 };
  private traceStats: { utilization: number; queueWaitP95: number; retried: number } | null = null;
  private guiState: { active: boolean; action: "open" | "close" | null; module: string | null; lastAction: string | null } = {
    active: false, action: null, module: null, lastAction: null
  };
  private runFinishedAt: number | null = null;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
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

  /** True for any unfinalized or failed run that still displays the last finalized graph. */
  snapshotIsPrevious(scope: string): boolean {
    return this.scope === scope && this.runStartedAt !== null && !this.finalized;
  }

  /**
   * Starts a run. `modules` is the resolved walk order, so every row exists as `pending` from the
   * first poll — the page shows the whole plan immediately rather than growing a list.
   */
  beginRun(
    scope: string,
    modules: readonly string[],
    config: { mode?: RunMode; pipelineDepth?: number; readLimit?: number; traceEnabled?: boolean } = {}
  ): void {
    this.scope = scope;
    this.runStartedAt = this.now();
    this.runId = `${this.runStartedAt}-${++this.runSerial}`;
    this.sequence = 1;
    this.mode = config.mode ?? "full";
    this.lifecycle = "running";
    this.pipelineDepth = Number.isInteger(config.pipelineDepth) && (config.pipelineDepth ?? 0) > 0 ? config.pipelineDepth! : 1;
    this.readLimit = Number.isInteger(config.readLimit) && (config.readLimit ?? 0) > 0 ? config.readLimit! : 4;
    this.traceEnabled = config.traceEnabled === true;
    this.workers = { active: 0, queued: 0, limit: this.readLimit };
    this.traceStats = null;
    this.guiState = { active: false, action: null, module: null, lastAction: null };
    this.runFinishedAt = null;
    this.errorCode = null;
    this.errorMessage = null;
    this.complete = false;
    this.finalized = false;
    this.lastActivityAt = this.runStartedAt;
    this.log = [];
    this.expected = readAllTimings(this.graphDir);
    this.modules = modules.map((module, i) => ({
      module,
      index: i + 1,
      state: "pending",
      lifecycle: "pending",
      captureOutcome: "none",
      versionReason: null,
      moduleVersion: null,
      previousCaptureVersion: null,
      openedHere: null,
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

  /** Coordinator-sourced transition; never infer GUI state from which row is pending. */
  setModuleLifecycle(
    module: string,
    lifecycle: ModuleLifecycle,
    detail: { openedHere?: boolean; versionReason?: string; moduleVersion?: string | null; previousCaptureVersion?: string | null } = {}
  ): void {
    if (this.runStartedAt === null) return;
    const m = this.ensure(module);
    const at = this.now();
    m.lifecycle = lifecycle;
    m.state = lifecycle === "completed" || lifecycle === "reused" ? "done"
      : lifecycle === "failed" ? "failed"
      : lifecycle === "pending" || lifecycle === "not-started" || lifecycle === "cancelled" ? "pending" : "running";
    if (m.startedAt === null && lifecycle !== "pending" && lifecycle !== "not-started") m.startedAt = at;
    if (detail.openedHere !== undefined) m.openedHere = detail.openedHere;
    if (detail.versionReason !== undefined) m.versionReason = detail.versionReason;
    if (detail.moduleVersion !== undefined) m.moduleVersion = detail.moduleVersion;
    if (detail.previousCaptureVersion !== undefined) m.previousCaptureVersion = detail.previousCaptureVersion;
    if (lifecycle === "completed" || lifecycle === "reused" || lifecycle === "failed" || lifecycle === "cancelled" || lifecycle === "not-started") {
      m.finishedAt = at;
      m.phase = null;
    }
    this.sequence++;
    this.lastActivityAt = at;
  }

  /** Final outcome only after the coordinator has committed or reused a valid capture. */
  recordOutcome(
    module: string,
    outcome: "staged" | "skipped" | "open-failed" | "stage-failed" | "not-started" | "reused",
    detail: {
      error?: { code: string; message: string };
      openedHere?: boolean;
      durationMs?: number;
      nodeCount?: number;
      edgeCount?: number;
      versionReason?: string;
      moduleVersion?: string | null;
      previousCaptureVersion?: string | null;
    } = {}
  ): void {
    const stage = outcome === "staged" ? "completed" : outcome === "skipped" || outcome === "reused" ? "reused"
      : outcome === "not-started" ? "not-started" : "failed";
    this.setModuleLifecycle(module, stage, detail);
    const m = this.byKey.get(module.toLowerCase());
    if (!m) return;
    m.captureOutcome = outcome === "staged" ? "new" : outcome === "skipped" ? "already-staged" : outcome === "reused" ? "reused" : "none";
    if (detail.durationMs !== undefined) m.actualMs = detail.durationMs;
    if (detail.nodeCount !== undefined) m.nodes = detail.nodeCount;
    if (detail.edgeCount !== undefined) m.edges = detail.edgeCount;
    if (detail.error) {
      m.error = detail.error.code;
      m.errorMessage = detail.error.message;
    }
    this.sequence++;
  }

  /** Read-only figures from the existing ServiceStudioClient global permit gate. */
  setWorkers(status: { limit: number; active: number; queued: number }): void {
    if (this.runStartedAt === null) return;
    const limit = Number.isInteger(status.limit) && status.limit > 0 ? status.limit : this.readLimit;
    const active = Number.isInteger(status.active) ? Math.max(0, Math.min(limit, status.active)) : 0;
    const queued = Number.isInteger(status.queued) ? Math.max(0, status.queued) : 0;
    if (this.workers.limit === limit && this.workers.active === active && this.workers.queued === queued) return;
    this.workers = { limit, active, queued };
    this.sequence++;
  }

  setTraceSummary(summary: { readSlotUtilization: number; queueWaitMs: { p95: number }; retriedCalls: number }): void {
    if (!this.traceEnabled) return;
    this.traceStats = {
      utilization: Number.isFinite(summary.readSlotUtilization) ? Math.max(0, Math.min(1, summary.readSlotUtilization)) : 0,
      queueWaitP95: Number.isFinite(summary.queueWaitMs.p95) ? Math.max(0, summary.queueWaitMs.p95) : 0,
      retried: Math.max(0, summary.retriedCalls)
    };
    this.sequence++;
  }

  setGuiState(action: "open" | "close", module: string, active: boolean): void {
    if (this.runStartedAt === null) return;
    this.guiState = { active, action: active ? action : null, module: active ? module : null, lastAction: `${action} ${module}` };
    this.sequence++;
  }

  markCancelling(): void {
    if (!this.complete && this.runStartedAt !== null) {
      this.lifecycle = "cancelling";
      this.sequence++;
    }
  }

  /** Feeds one progress event. Safe to call before `beginRun` (the line is still logged). */
  handle(event: RebuildProgressEvent): void {
    const at = this.now();
    this.lastActivityAt = at;
    this.sequence++;
    this.push({ at, text: formatProgress(event) });

    switch (event.type) {
      case "session":
        break;
      case "module-start": {
        const m = this.ensure(event.module, event.index);
        m.state = "running";
        m.lifecycle = "reading";
        m.startedAt ??= at;
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
        // A successful read is not yet a committed stage. Do not count it as done before the
        // coordinator has written the stage entry; a stage-write failure must stay visible.
        m.state = "running";
        m.lifecycle = "staging";
        m.finishedAt = null;
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
    this.lifecycle = "completed";
    this.runFinishedAt = this.now();
    this.lastActivityAt = this.runFinishedAt;
    this.sequence++;
    for (const row of perModule) {
      const m = this.byKey.get(row.module.toLowerCase()) ?? this.byKey.get((row.requestedAs ?? "").toLowerCase());
      if (!m) continue;
      m.state = "done";
      m.lifecycle = "completed";
      m.captureOutcome = m.captureOutcome === "none" ? "new" : m.captureOutcome;
      m.nodes = row.nodeCount;
      m.edges = row.edgeCount;
      m.skipped = row.skippedCount;
      m.actualMs = row.durationMs;
    }
  }

  /**
   * The run aborted. Every module that was running is marked failed so the page shows *where* it
   * died rather than silently freezing on "running". A sequential rebuild has exactly one such
   * module (it aborts the whole walk on a kind-level read failure, ADR-0011); a pipelined run
   * (`--pipeline-depth` >= 2) can have several in flight, and none may be left looking alive.
   */
  failRun(code: string, message: string): void {
    this.complete = true;
    this.finalized = false;
    this.lifecycle = code === "RUN_CANCELLED" ? "cancelled" : code === "RUN_STOPPED" ? "stopped" : "failed";
    this.errorCode = code;
    this.errorMessage = message;
    this.runFinishedAt = this.now();
    this.lastActivityAt = this.runFinishedAt;
    for (const row of this.modules) {
      if (row.lifecycle === "completed" || row.lifecycle === "reused" || row.lifecycle === "failed" || row.lifecycle === "not-started") continue;
      if (row.state === "running" || row.lifecycle === "staging" || row.lifecycle === "closing") {
        row.lifecycle = code === "RUN_CANCELLED" ? "cancelled" : "failed";
        row.state = code === "RUN_CANCELLED" ? "pending" : "failed";
        if (code !== "RUN_CANCELLED") {
          row.error = code;
          row.errorMessage = message;
        }
        row.phase = null;
        row.finishedAt = this.runFinishedAt;
      }
    }
    this.sequence++;
    this.push({ at: this.runFinishedAt, text: `rebuild: FAILED ${code}: ${message}` });
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
      lifecycle: "pending",
      captureOutcome: "none",
      versionReason: null,
      moduleVersion: null,
      previousCaptureVersion: null,
      openedHere: null,
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
        lifecycle: m?.lifecycle ?? "pending",
        captureOutcome: m?.captureOutcome ?? "none",
        versionReason: m?.versionReason ?? null,
        moduleVersion: m?.moduleVersion ?? null,
        previousCaptureVersion: m?.previousCaptureVersion ?? null,
        openedHere: m?.openedHere ?? null,
        startedAt: m?.startedAt ?? null,
        finishedAt: m?.finishedAt ?? null,
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
    // Pipelined runs read several modules at once; `current` stays the first for the legacy view.
    const runningNow = isActive
      ? this.modules.filter((x) => ["opening", "version-check", "queued-for-read", "reading", "staging", "closing"].includes(x.lifecycle))
      : [];
    const activeModules = runningNow.length > 0 ? runningNow.map((x) => this.infoOf(x, now, expected)) : undefined;

    // Weight by expected duration so one huge module cannot read as "1 of 30"; a module with no
    // history counts as the average known one.
    const known = rows.filter((r) => r.expectedMs !== null);
    const avgExp = known.length > 0 ? known.reduce((n, r) => n + (r.expectedMs ?? 0), 0) / known.length : 1;
    const weight = (r: StatusModuleRow): number => r.expectedMs ?? avgExp;
    const totalExp = rows.reduce((n, r) => n + weight(r), 0) || 1;
    const doneRows = rows.filter((r) => r.state === "done");
    const doneExp = doneRows.reduce((n, r) => n + weight(r), 0);
    // Each active module contributes its OWN partial progress, including concurrent waves.
    const currentByName = new Map((activeModules ?? []).map((m) => [m.module.toLowerCase(), m]));
    const activeDoneExp = rows.filter((r) => r.state === "running" && r.lifecycle === "reading")
      .reduce((sum, r) => {
        const fraction = currentByName.get(r.module.toLowerCase())?.pct;
        return sum + (fraction !== undefined && fraction !== null && Number.isFinite(fraction) ? weight(r) * Math.max(0, Math.min(0.99, fraction)) : 0);
      }, 0);
    const pctByTime = this.finalized && isActive ? 1 : Math.max(0, Math.min(0.999, (doneExp + activeDoneExp) / totalExp));
    const curRow = rows.find((r) => r.state === "running");
    const curDoneExp = curRow && current?.pct != null ? weight(curRow) * current.pct : 0;

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
    // Existing timing history was collected sequentially. It cannot predict rolling overlap or
    // version-aware reuse honestly; Ticket B will calibrate those modes from compatible traces.
    const etaMs =
      !isActive || (this.complete && !this.finalized && this.lifecycle !== "running") ? null
        : this.finalized || this.complete ? 0
          : this.mode !== "full" || this.pipelineDepth > 1 ? null
            : etaKnown ? Math.round(remainingExp * (pace ?? 1)) : null;

    const completed = doneRows.length;
    const activeReadCount = rows.filter((r) => r.lifecycle === "reading").length;
    const activeOpenCount = rows.filter((r) => r.lifecycle === "opening").length;
    const activeCloseCount = rows.filter((r) => r.lifecycle === "closing").length;
    return {
      workers: {
        readLimit: isActive ? this.workers.limit : this.readLimit,
        readActive: isActive && !this.complete ? this.workers.active : 0,
        readQueued: isActive && !this.complete ? this.workers.queued : 0,
        readSlotUtilization: isActive ? this.traceStats?.utilization ?? null : null,
        queueWaitP95Ms: isActive ? this.traceStats?.queueWaitP95 ?? null : null,
        retriedCalls: isActive ? this.traceStats?.retried ?? null : null
      },
      gui: isActive ? this.guiState : { active: false, action: null, module: null, lastAction: null },
      schemaVersion: 2,
      runId: isActive ? this.runId : null,
      sequence: isActive ? this.sequence : 0,
      serverNow: now,
      now,
      scope,
      run: {
        mode: isActive ? this.mode : "idle",
        status: isActive ? this.lifecycle : "idle",
        runId: isActive ? this.runId : null,
        sequence: isActive ? this.sequence : 0,
        pipelineDepth: isActive ? this.pipelineDepth : 1,
        readLimit: isActive ? this.readLimit : 4,
        traceEnabled: isActive && this.traceEnabled,
        finishedAt: isActive ? this.runFinishedAt : null,
        errorCode: isActive ? this.errorCode : null,
        errorMessage: isActive ? this.errorMessage : null,
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
        completed,
        newlyCaptured: rows.filter((r) => r.captureOutcome === "new").length,
        reused: rows.filter((r) => r.captureOutcome === "reused").length,
        alreadyStaged: rows.filter((r) => r.captureOutcome === "already-staged").length,
        notStarted: rows.filter((r) => r.lifecycle === "not-started" || r.lifecycle === "cancelled").length,
        activeReading: activeReadCount,
        activeOpening: activeOpenCount,
        activeClosing: activeCloseCount,
        modulesDone: doneRows.length,
        modulesTotal: rows.length,
        modulesFailed: rows.filter((r) => r.state === "failed").length,
        pctByModules: rows.length > 0 ? doneRows.length / rows.length : 0,
        pctByTime,
        pace,
        etaMs,
        etaAt: etaMs === null ? null : now + etaMs
      },
      current,
      ...(activeModules !== undefined ? { activeModules } : {}),
      modules: rows,
      snapshot: {
        exists: graphM !== null,
        writtenAt: graphM,
        fromThisRun: isActive && this.finalized,
        hasPrevious: graphM !== null && isActive && !this.finalized,
        meta
      },
      flows,
      logTail: isActive ? this.log.slice(-14) : []
    };
  }

  private currentInfo(now: number, expected: Map<string, ModuleCost>): StatusCurrent | null {
    const m = this.modules.find((x) => x.state === "running");
    return m ? this.infoOf(m, now, expected) : null;
  }

  private infoOf(m: LiveModule, now: number, expected: Map<string, ModuleCost>): StatusCurrent {
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
