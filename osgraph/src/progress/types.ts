/**
 * The `/api/status` contract the dashboard page consumes.
 *
 * This shape is inherited from osgraph-kit's file-polling dashboard server, and is kept
 * byte-compatible on purpose: `dashboard/index.html` was written against it, and keeping the
 * contract meant the page could move here unchanged while its *backing* changed completely.
 *
 * The kit reconstructed all of this from the outside — regex-matching `rebuild:` log lines,
 * counting `.txt` files under `raw/`, reading per-module stage JSONs, inferring run boundaries
 * from log timestamps — because it ran as a separate process from the rebuild. In osgraph the
 * server and the rebuild are the same process, so every field below comes from the authoritative
 * `RebuildProgressEvent` stream instead. Same JSON, no guessing: the parsing, the file counting
 * and the "is a rebuild running?" process scan all disappear.
 */

import type { RebuildPhase } from "../rebuild/rebuild.js";
import type { ModuleKindStats } from "../rebuild/readKinds.js";

/** A module's state in the run, as the page colours its row. */
export type ModuleState = "pending" | "running" | "done" | "failed";

/** Authoritative lifecycle; v1 `state` is a compatibility projection of these values. */
export type ModuleLifecycle =
  | "pending" | "opening" | "version-check" | "queued-for-read" | "reading"
  | "staging" | "closing" | "reused" | "completed" | "failed" | "cancelled" | "not-started";
export type CaptureOutcome = "new" | "reused" | "already-staged" | "none";
export type RunMode = "full" | "pipeline" | "changed" | "modules" | "module" | "reextract" | "idle";
export type RunLifecycle = "idle" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "stopped";

/** One row of the Modules table. */
export interface StatusModuleRow {
  /** 1-based position in the scope file — the order a rebuild walks them. */
  index: number;
  module: string;
  /** Layer suffix (`BL`, `CW`, …) or `other`. Drives the row's colour, never any logic. */
  layer: string;
  state: ModuleState;
  /** Additive v2 fields; consumers of v1 can keep reading `state`. */
  lifecycle?: ModuleLifecycle;
  captureOutcome?: CaptureOutcome;
  versionReason?: string | null;
  moduleVersion?: string | null;
  previousCaptureVersion?: string | null;
  openedHere?: boolean | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** What this run actually took; null until the module finishes. */
  actualMs: number | null;
  /** What it took last time, from the persisted timings; null on a first-ever run. */
  expectedMs: number | null;
  nodes: number | null;
  edges: number | null;
  skipped: number | null;
  /** ISO timestamp the module completed. Named `stagedAt` for page compatibility. */
  stagedAt: string | null;
  error: string | null;
  errorMessage: string | null;
}

/** The module being read right now, with its phase breakdown. */
export interface StatusCurrent {
  module: string;
  startedAt: number | null;
  elapsedMs: number | null;
  expectedMs: number | null;
  phase: RebuildPhase | null;
  /** Items the current phase announced — i.e. how many elements it will read. */
  phaseCount: number | null;
  phaseElapsedMs: number | null;
  phaseExpectedMs: number | null;
  /**
   * Elements of the current phase already answered. The kit counted files on disk; here it is a
   * count of `element` events, which is both cheaper and exact — including the ones a
   * concurrent walk returns out of order.
   */
  phaseItemsRead: number | null;
  /** Completed phases of this module -> their duration. */
  phasesDone: Partial<Record<RebuildPhase, number>>;
  /** Last run's phase spans for this module, when known. */
  phasesExpected: Partial<Record<RebuildPhase, number>> | null;
  /** 0..1 within this module. Null when there is nothing to base it on. */
  pct: number | null;
}

export interface StatusRun {
  /** Additive v2 metadata. */
  mode?: RunMode;
  status?: RunLifecycle;
  runId?: string | null;
  sequence?: number;
  pipelineDepth?: number;
  readLimit?: number;
  traceEnabled?: boolean;
  finishedAt?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt: number | null;
  elapsedMs: number | null;
  /** The walk finished. */
  complete: boolean;
  /** The snapshot was written — the run's result is on disk and readable. */
  finalized: boolean;
  /** No event for over 30 minutes. A fetch phase can be legitimately silent for 20+. */
  stalled: boolean;
  lastActivityAt: number | null;
  /** True before any run has been observed in this process. */
  noRunLog: boolean;
}

export interface StatusProgress {
  /** v2 counters. Done includes verified reuse and already-staged captures. */
  completed?: number;
  newlyCaptured?: number;
  reused?: number;
  alreadyStaged?: number;
  notStarted?: number;
  activeReading?: number;
  activeOpening?: number;
  activeClosing?: number;
  modulesDone: number;
  modulesTotal: number;
  modulesFailed: number;
  pctByModules: number;
  /** Weighted by expected duration, so one huge module cannot read as "1 of 30". */
  pctByTime: number;
  /** This run's actual/expected ratio over modules already re-read. Null without history. */
  pace: number | null;
  etaMs: number | null;
  etaAt: number | null;
}

export interface StatusSnapshot {
  exists: boolean;
  writtenAt: number | null;
  fromThisRun: boolean;
  hasPrevious: boolean;
  meta: unknown;
}

export interface StatusFlows {
  builtAt?: unknown;
  actions?: unknown;
  nodes?: unknown;
  bindings?: unknown;
  unknown?: unknown;
  parseErrors?: unknown;
  perModule: { module: unknown; actions: unknown; nodes: unknown; unknown: unknown }[];
}

export interface StatusLogLine {
  at: number | null;
  text: string;
}

/** `osgraph run`'s start gate / pause / cancel state (`RunControl.snapshot()`). */
export interface StatusControl {
  state: "waiting" | "running" | "paused" | "cancelling" | "done";
  since: string;
  can: { start: boolean; pause: boolean; resume: boolean; cancel: boolean };
}

/** What the site needs from a run's control object (kept structural: progress does not import run). */
export interface RunControlHandle {
  snapshot(): StatusControl;
  act(action: "start" | "pause" | "resume" | "cancel"): boolean;
  /** True when a remote-control password was set at the laptop. */
  readonly remoteEnabled?: boolean;
  /** Password check for a non-loopback request. */
  authorize?(password: string | undefined): "ok" | "denied" | "locked" | "disabled";
}

/**
 * Who may press the buttons, as seen by the requester: `local` (this PC), `password` (another device;
 * a remote password is set), `none` (another device; control is this PC only).
 */
export type StatusControlAccess = "local" | "password" | "none";

/** The whole `/api/status` body. */
export interface Status {
  /** Present while an `osgraph run` with a control object is attached to the site (active scope only). */
  control?: StatusControl;
  /** Present with `control`: whether THIS requester may act, and how. */
  controlAccess?: StatusControlAccess;
  /** Existing global MCP permit gate, never one pool per module. */
  workers?: { readLimit: number; readActive: number; readQueued: number; readSlotUtilization: number | null;
    queueWaitP95Ms: number | null; retriedCalls: number | null };
  /** The serialized GUI operator: no invented concurrency. */
  gui?: { active: boolean; action: "open" | "close" | null; module: string | null; lastAction: string | null };
  /** Additive v2 contract; status, snapshot and legacy keys remain supported. */
  schemaVersion?: 2;
  runId?: string | null;
  sequence?: number;
  serverNow?: number;
  now: number;
  scope: string;
  run: StatusRun;
  progress: StatusProgress;
  current: StatusCurrent | null;
  /** Every module running right now (a pipelined run reads several at once); absent when none runs. */
  activeModules?: StatusCurrent[];
  modules: StatusModuleRow[];
  snapshot: StatusSnapshot;
  flows: StatusFlows | null;
  logTail: StatusLogLine[];
}

/** One module's measured cost, persisted so the next run can predict it. */
export interface ModuleCost {
  ms: number;
  phases: Partial<Record<RebuildPhase, number>>;
  nodes?: number;
  edges?: number;
  /**
   * Per-kind read cost in this module (#69): call count, total and p50/p95 latency per kind read.
   * Latency here is one logical call, retry time included, so read it against the run's width.
   */
  kinds?: ModuleKindStats;
}

/** `<graphDir>/<scope>/timings.json`. */
export interface TimingsFile {
  schemaVersion: 1;
  writtenAt: string;
  /** Keyed by lower-cased module name: latency is a property of the module, not of the scope. */
  modules: Record<string, ModuleCost>;
}
