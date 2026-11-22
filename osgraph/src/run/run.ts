/**
 * `osgraph run` (#48): build a scope's graph the way large scopes have to be built, and refresh one
 * module without re-reading the rest.
 *
 * **osgraph is not standalone, and this command least of all.** It opens and closes every module
 * through **osopener** (Service Studio has no API for opening one), and every read it makes needs the
 * human-approved session token the **token manager** keeps in `token.txt` (osgraph only reads it,
 * never creates it).
 *
 * Why it exists: "open every scope module, then `rebuild`" does not scale. Service Studio degrades
 * past roughly 30 open modules (extra top-level windows; its environment-list fetch grows from ~5 s
 * to over 45 s). The staged path (`stageModule`, ADR-0005) lets a caller run open -> stage -> close
 * one module at a time; this is that caller.
 *
 * Built only from existing pieces: the single-module staging (`stageModule`, which runs the #5
 * extraction primitive's walk and drains before it returns), the #6 osopener adapter (failure
 * classification, ownership), the #4 path resolver, the offline `reextractScope`, and osgraph's own
 * Service Studio client for `listApps` and `drain()`.
 *
 * Two rules it never breaks: it never closes a module with reads still queued (ADR-0013: the reader
 * is drained before every close), and it only ever closes tabs it opened itself — osopener refuses
 * to close a module with unsaved changes on top of that.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { resolveScopeArtifactPaths } from "../graph/io.js";
import type { LayerRules } from "../layers/rules.js";
import { describeOsopenerFailure, type OsopenerAdapter, type OsopenerFailure } from "../osopener/adapter.js";
import { writeTimings } from "../progress/timings.js";
import type { RunState } from "../progress/state.js";
import { reextractScope, type ReextractResult } from "../reextract.js";
import { listRawModules, rawManifestPath, type RawManifest } from "../rebuild/raw.js";
import type { ServiceStudioSession } from "../rebuild/reader.js";
import { finalizeStage, stageModule, type RebuildProgressEvent, type RebuildResult, type StageOutcome } from "../rebuild/rebuild.js";
import type { PrunableKind } from "../rebuild/readKinds.js";
import { readStage, stagePath } from "../rebuild/stage.js";
import type { ScopeDefinition } from "../scopes/store.js";
import { summarizeTrace, type CallTrace, type GuiSpan, type TraceSummary } from "../servicestudio/trace.js";
import { OsgraphToolError, type ServiceStudioApp } from "../servicestudio/types.js";
import { decideChange, readCaptureVersion, type ChangeReason } from "./changed.js";
import {
  defaultSleep,
  makeForegroundGate,
  makeOpenWithRetry,
  type OpenLoopOptions,
  type Sleep
} from "./opener.js";

/** Default cap on tabs open while the run makes room (Studio degrades past ~30). */
export const DEFAULT_MAX_OPEN = 12;
/** Default circuit breaker: this many modules failing to open in a row stops the run. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
/** Pause between a close/open and the next Studio action, so Studio settles. */
export const DEFAULT_GAP_MS = 1_500;

/** Errors that mean the session itself is gone: every later module would fail the same way. */
const SESSION_FATAL = new Set(["TOKEN_EXPIRED", "SERVICESTUDIO_UNREACHABLE", "CONFIG_MISSING", "CONFIG_INVALID"]);

export interface RunCommonOptions {
  scope: ScopeDefinition;
  /** Where `stage/`, `raw/`, `graph.json`, `flows.json` and the run directory live. */
  graphDir: string;
  rules: LayerRules;
  /** osgraph's own Service Studio sessions (one shared reader; see `createSharedSessionFactory`). */
  createSession: () => ServiceStudioSession;
  /** The #6 adapter; its `ui` probes drive the foreground gate, recovery and screenshots. */
  opener: OsopenerAdapter;
  /** The progress site's run state, when a site was raised. */
  state?: RunState;
  log?: (line: string) => void;
  fetchConcurrency?: number;
  /** Kinds not to read (#69). Passed through to every staged module read. */
  skipKinds?: readonly PrunableKind[];
  fetchReferencedElements?: boolean;
  now?: () => Date;
  sleep?: Sleep;
  /** Pause between Studio actions; default 1.5 s, tests pass 0. */
  gapMs?: number;
  /** Retry / gate tuning for opens (tests shrink every wait to zero). */
  openLoop?: Omit<OpenLoopOptions, "screenshotDir" | "sleep" | "now" | "source">;
  /** Element retry back-off forwarded to the walk; tests pass 0. */
  retryDelayMs?: number;
  /**
   * `--trace` (full runs): write every servicestudio call (queued / admitted / attempts / settled) and
   * every osopener open/close span to `<runDir>/calls.jsonl`, and put a `trace` summary (queue wait,
   * read-slot utilization, GUI time hidden behind reads vs exposed) into report.json and the result.
   * Off by default; when off, nothing about the run or its report changes.
   */
  trace?: boolean;
}

/** `RunScopeResult.trace`: the summary plus where the per-call stream was written. */
export interface RunTraceSummary extends TraceSummary {
  file: string;
  /** False when the reader had no `setCallTrace` (then only GUI spans were recorded). */
  callTracing: boolean;
}

export interface RunScopeOptions extends RunCommonOptions {
  /** Tabs open at once before the run closes its own staged ones; default 12, minimum 1. */
  maxOpen?: number;
  /** Consecutive open failures that stop the run; default 3, `0` disables. */
  maxConsecutiveFailures?: number;
  /**
   * Modules open and read at once. Default 1 = the sequential open -> stage -> close loop, untouched.
   * `>= 2` selects the opt-in pipeline (`runPipelined`): serialized opens/closes, overlapping reads.
   * `maxOpen` keeps its meaning: the ceiling on ALL open tabs.
   */
  pipelineDepth?: number;
  /**
   * Graceful cancellation (Ctrl+C). Once aborted the run opens nothing more, lets every module already
   * started finish its capture, drains it, closes the tabs it opened, records the rest as
   * `not-started`, and returns with `cancelled: true` and the previous graph untouched.
   */
  signal?: AbortSignal;
}

/** The `stoppedEarly` text of a cancelled run. */
export const RUN_CANCELLED_MESSAGE =
  "cancelled (Ctrl+C): no new module was opened; modules already started finished and were staged, and the " +
  "tabs this run opened were closed. Run the same command again to continue: staged modules are skipped.";

export interface RunModuleRow {
  module: string;
  /**
   * `skipped` = already staged before this run (resume). `not-started` = still queued when the run was
   * cancelled or stopped; not a failure, the next run reads it.
   */
  outcome: "staged" | "skipped" | "open-failed" | "stage-failed" | "not-started";
  openedHere?: boolean;
  closed?: boolean;
  closeError?: string;
  nodeCount?: number;
  edgeCount?: number;
  skippedCount?: number;
  durationMs?: number;
  finalized?: boolean;
  /** Code + message of a failure, untruncated. */
  error?: { code: string; message: string; kind?: string; failedStep?: string };
  attempts?: number;
  screenshotPath?: string;
}

export interface RunScopeResult {
  mode: "full";
  scope: string;
  total: number;
  /** Modules with a stage entry when the run started (skipped). */
  alreadyStaged: number;
  rows: RunModuleRow[];
  finalized: boolean;
  /** Present when the run finalized: the same result an all-at-once rebuild returns. */
  rebuild?: RebuildResult;
  /** Present when the run stopped early: the circuit breaker, or --max-open reached because closes failed. */
  stoppedEarly?: string;
  /** True when `signal` aborted the run (Ctrl+C); `stoppedEarly` then carries `RUN_CANCELLED_MESSAGE`. */
  cancelled?: boolean;
  /** Present with `trace: true`. */
  trace?: RunTraceSummary;
  /** Present for a pipelined run: whole-run and per-module wall-clock spans (never written to timings.json). */
  pipeline?: PipelineTimings;
  /** Present when nothing failed yet the stage is still incomplete (e.g. an unreadable stage entry). */
  incomplete?: string;
  failures: number;
  runDir: string;
  logPath: string;
  reportPath: string;
}

export interface RefreshModuleOptions extends RunCommonOptions {
  module: string;
}

export interface CaptureAge {
  module: string;
  capturedAt: string;
  ageMs: number;
}

export interface RefreshModuleResult {
  mode: "module";
  scope: string;
  module: string;
  openedHere: boolean;
  closed: boolean;
  staged: StageOutcome["staged"];
  /** True when staging M happened to complete a pending stage (the stage was then finalized and cleared). */
  stageFinalized: boolean;
  /** True when the transient stage entry this refresh wrote was removed again. */
  stageEntryRemoved: boolean;
  reextract: ReextractResult;
  /** Every OTHER scope module's capture time and age, oldest first: the rest of the graph is only this fresh. */
  otherCaptures: CaptureAge[];
  runDir: string;
  logPath: string;
}

/** `<graphDir>/<scope>/run` — logs, the report and give-up screenshots. Resolved through the #4 seam. */
export function runDirFor(graphDir: string, scope: string): string {
  return join(resolveScopeArtifactPaths(graphDir, scope).dir, "run");
}

const lower = (s: string): string => s.toLowerCase();

/** Scope modules, de-duplicated case-insensitively, in scope order. */
function uniqueModules(modules: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of modules) {
    if (seen.has(lower(m))) continue;
    seen.add(lower(m));
    out.push(m);
  }
  return out;
}

function errorOf(err: unknown): { code: string; message: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : "UNKNOWN",
    message: err instanceof Error ? err.message : String(err)
  };
}

function failureRow(failure: OsopenerFailure): NonNullable<RunModuleRow["error"]> {
  return {
    code: failure.code,
    message: failure.message,
    kind: failure.kind,
    ...(failure.failedStep !== undefined ? { failedStep: failure.failedStep.step } : {})
  };
}

/** Shared plumbing: the log file, the site, the session, the open loop and the drain-then-close. */
function setup(options: RunCommonOptions): {
  log: (line: string) => void;
  runDir: string;
  logPath: string;
  sleep: Sleep;
  now: () => Date;
  gapMs: number;
  session: ServiceStudioSession;
  waitForForeground: () => Promise<boolean>;
  openWithRetry: ReturnType<typeof makeOpenWithRetry>;
  onProgress: (event: RebuildProgressEvent) => void;
  listApps: () => Promise<ServiceStudioApp[]>;
  closeAfterDrain: (module: string) => Promise<{ ok: boolean; error?: string }>;
  /** Set by `--trace`: receives every open/close the run drives (drain waits excluded). */
  traceGui: ((span: GuiSpan) => void) | undefined;
} {
  const runDir = runDirFor(options.graphDir, options.scope.name);
  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, "run.log");
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const sink = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${now().toISOString()}] ${line}\n`);
    } catch {
      /* the log file is a convenience; the run goes on without it */
    }
    sink(line);
    // Run-level lines reach the site's log tail too, as `session` events (they change no module row).
    options.state?.handle({ type: "session", message: line.trim() });
  };
  const session = options.createSession();
  const waitForForeground = makeForegroundGate(options.opener.ui, log, { ...options.openLoop, sleep });
  const openWithRetry = makeOpenWithRetry(options.opener, log, waitForForeground, {
    ...options.openLoop,
    sleep,
    now,
    screenshotDir: join(runDir, "screenshots"),
    // Always Open from Environment: a recent-list open makes Studio list the module's version as "0",
    // which `--changed` cannot compare (it reads it as unknown, so the module is always re-read).
    source: "environment",
    // A confirmed Save prompt is dismissed via its exact Cancel button (never Save/Discard) and retried once.
    cancelSavePrompt: true
  });
  const onProgress = (event: RebuildProgressEvent): void => options.state?.handle(event);
  const listApps = (): Promise<ServiceStudioApp[]> => session.reader.listApps();

  /**
   * ADR-0013: never close a module whose reads are still queued. `stageModule` already drains before
   * it returns; draining again is free and keeps this rule local to the one place that closes.
   * Closing drives the tab's close button, so it needs the foreground just as opening does.
   */
  const closeAfterDrain = async (module: string): Promise<{ ok: boolean; error?: string }> => {
    await session.reader.drain?.();
    const t0 = performance.now();
    let ok = false;
    try {
      await waitForForeground();
      const closed = await options.opener.closeOwned(module);
      if (closed.ok) {
        ok = true;
        log(`   close ${module} ok`);
        return { ok: true };
      }
      const error = describeOsopenerFailure(closed.failure);
      log(`   close ${module} FAILED ${error}`);
      return { ok: false, error };
    } finally {
      plumbing.traceGui?.({ action: "close", module, startMs: t0, endMs: performance.now(), ok });
    }
  };

  const plumbing: ReturnType<typeof setup> = {
    log,
    runDir,
    logPath,
    sleep,
    now,
    gapMs: options.gapMs ?? DEFAULT_GAP_MS,
    session,
    waitForForeground,
    openWithRetry: async (module: string) => {
      const t0 = performance.now();
      let ok = false;
      try {
        const opened = await openWithRetry(module);
        ok = opened.ok;
        return opened;
      } finally {
        plumbing.traceGui?.({ action: "open", module, startMs: t0, endMs: performance.now(), ok });
      }
    },
    onProgress,
    listApps,
    closeAfterDrain,
    traceGui: undefined
  };
  return plumbing;
}

/**
 * `--trace`: one JSON line per servicestudio call and per GUI span in `<runDir>/calls.jsonl`, plus the
 * in-memory copy `finish()` summarizes. Detaches its sink on `finish()`.
 */
function startTrace(s: ReturnType<typeof setup>): { finish: () => RunTraceSummary } {
  const file = join(s.runDir, "calls.jsonl");
  const calls: CallTrace[] = [];
  const gui: GuiSpan[] = [];
  const append = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    } catch {
      /* the stream is a convenience; the in-memory copy still feeds the summary */
    }
  };
  const reader = s.session.reader;
  const callTracing = typeof reader.setCallTrace === "function";
  reader.setCallTrace?.((t) => {
    calls.push(t);
    append({ type: "call", ...t });
  });
  s.traceGui = (g) => {
    gui.push(g);
    append({ type: "gui", ...g });
  };
  return {
    finish: () => {
      reader.setCallTrace?.(undefined);
      s.traceGui = undefined;
      return { file, callTracing, ...summarizeTrace(calls, gui, reader.concurrency ?? 4) };
    }
  };
}

/** Removes every stage entry for `module` (case-insensitively). True when one was removed. */
function removeStageEntry(graphDir: string, scope: string, module: string): boolean {
  let removed = false;
  for (const e of readStage(graphDir, scope).entries) {
    if (lower(e.module) !== lower(module)) continue;
    const path = stagePath(graphDir, scope, e.module);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      removed = true;
    }
  }
  return removed;
}

function stagedNames(graphDir: string, scope: string): Set<string> {
  return new Set(readStage(graphDir, scope).entries.map((e) => lower(e.module)));
}

/**
 * Full staged build: every scope module without a stage entry goes through
 * make-room -> open -> stage -> drain -> close; the last one finalizes `graph.json` + `flows.json`
 * exactly as the staged `rebuild` does (it IS `stageModule`). Resumable: staged modules are skipped.
 *
 * Throws only for a session-level failure (expired token, unreachable Studio) — after closing the
 * tab it opened — because every later module would fail identically. Everything else is recorded
 * per module and the run continues, up to the circuit breaker.
 */
export async function runScope(options: RunScopeOptions): Promise<RunScopeResult> {
  const { scope, graphDir, opener } = options;
  const s = setup(options);
  const { log } = s;
  const maxOpen = Math.max(1, Math.trunc(options.maxOpen ?? DEFAULT_MAX_OPEN));
  const maxFailures = Math.max(0, Math.trunc(options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES));
  const pipelineDepth = Math.max(1, Math.trunc(options.pipelineDepth ?? 1));
  const modules = uniqueModules(scope.modules);
  const reportPath = join(s.runDir, "report.json");
  const snapshotPath = resolveScopeArtifactPaths(graphDir, scope.name).graph;

  const rows: RunModuleRow[] = [];
  let reportExtra: Record<string, unknown> = {};
  let traceSummary: RunTraceSummary | undefined;
  const writeReport = (): void => {
    try {
      const body = { scope: scope.name, ...reportExtra, ...(traceSummary !== undefined ? { trace: traceSummary } : {}), rows };
      writeFileSync(reportPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    } catch {
      /* the report is a convenience */
    }
  };
  const record = (row: RunModuleRow): void => {
    rows.push(row);
    options.state?.recordOutcome?.(row.module, row.outcome, {
      ...(row.openedHere !== undefined ? { openedHere: row.openedHere } : {}),
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      ...(row.nodeCount !== undefined ? { nodeCount: row.nodeCount } : {}),
      ...(row.edgeCount !== undefined ? { edgeCount: row.edgeCount } : {})
    });
    writeReport();
  };

  const initiallyStaged = stagedNames(graphDir, scope.name);
  const alreadyStaged = modules.filter((m) => initiallyStaged.has(lower(m))).length;
  options.state?.beginRun(scope.name, modules, {
    mode: pipelineDepth >= 2 ? "pipeline" : "full",
    pipelineDepth,
    readLimit: options.fetchConcurrency ?? s.session.reader.concurrency,
    traceEnabled: options.trace === true
  });
  s.session.reader.setPermitObserver?.((status) => options.state?.setWorkers?.(status));
  log(
    `run ${scope.name}: ${modules.length} scope module(s), ${alreadyStaged} already staged, max open ${maxOpen}` +
      (pipelineDepth >= 2 ? `, pipeline depth ${pipelineDepth}` : "")
  );

  let consecutiveOpenFailures = 0;
  let stoppedEarly: string | undefined;
  let finalized: RebuildResult | undefined;
  const stagedThisRun = new Set<string>();
  let pipeline: PipelineTimings | undefined;
  let pipelineIncomplete: string | undefined;
  const tracer = options.trace === true ? startTrace(s) : undefined;

  await s.session.acquire();
  try {
    if (pipelineDepth >= 2) {
      const outcome = await runPipelined({
        options,
        s,
        modules,
        initiallyStaged,
        depth: pipelineDepth,
        maxOpen,
        maxFailures,
        snapshotPath,
        rows,
        record,
        setReportExtra: (extra) => {
          reportExtra = { mode: "pipeline", pipelineDepth, ...extra };
          writeReport();
        }
      });
      stoppedEarly = outcome.stoppedEarly;
      finalized = outcome.finalized;
      pipelineIncomplete = outcome.incomplete;
      pipeline = outcome.timings;
    } else for (const [i, mod] of modules.entries()) {
      const tag = `[${i + 1}/${modules.length}] ${mod}`;
      // A finalize clears the stage, so what this run staged is remembered here as well; a module
      // after the finalizing one was by definition already staged (finalize needs every module).
      const staged = stagedNames(graphDir, scope.name);
      for (const m of stagedThisRun) staged.add(m);
      if (finalized !== undefined || staged.has(lower(mod))) {
        log(`${tag} already staged`);
        record({ module: mod, outcome: "skipped" });
        continue;
      }
      // Cancelled between modules: the previous module was already staged, drained and closed.
      if (options.signal?.aborted === true) {
        if (stoppedEarly === undefined) {
          stoppedEarly = RUN_CANCELLED_MESSAGE;
          log(`CANCELLED: ${stoppedEarly}`);
          options.state?.markCancelling?.();
        }
        record({ module: mod, outcome: "not-started" });
        continue;
      }

      // 1. Make room, then open it unless it is open already. A failure anywhere in this step
      // (listApps included) is a per-module open failure, unless it means the session is gone.
      let openedHere = false;
      let attempts: number | undefined;
      let stopForRoom = false;
      let openFailure: { error: NonNullable<RunModuleRow["error"]>; attempts?: number; screenshotPath?: string } | undefined;
      try {
        let apps = await s.listApps();
        const isOpen = (name: string): boolean => apps.some((a) => a.isOpen === true && lower(a.name) === lower(name));
        if (!isOpen(mod)) {
          // Only tabs THIS process opened, whose extraction is already on disk, and never the target.
          const closable = opener
            .ownedModules()
            .filter((o) => lower(o) !== lower(mod) && staged.has(lower(o)) && isOpen(o));
          while (apps.filter((a) => a.isOpen === true).length >= maxOpen && closable.length > 0) {
            const victim = closable.shift() as string;
            const closed = await s.closeAfterDrain(victim);
            // A refused close leaves that tab open; try the next one rather than giving up on room.
            if (!closed.ok) continue;
            await s.sleep(s.gapMs);
            apps = await s.listApps();
          }
          // --max-open bounds the tabs this process holds. If closes keep failing, stop rather than
          // open one more: that is exactly the >30-tab degradation this command exists to avoid.
          const ownedOpen = opener.ownedModules().filter((o) => isOpen(o));
          if (ownedOpen.length >= maxOpen) {
            stoppedEarly =
              `${ownedOpen.length} tab(s) this run opened could not be closed (${ownedOpen.join(", ")}) and ` +
              `--max-open is ${maxOpen}: opening ${mod} would exceed it. osopener's close is failing (a save ` +
              `prompt, or a tab-close step that no longer matches this Studio build). Close those tabs by ` +
              `hand, then run the same command again: staged modules are skipped, so it resumes.`;
            log(`STOPPED: ${stoppedEarly}`);
            stopForRoom = true;
          } else {
            options.state?.setModuleLifecycle?.(mod, "opening");
            const opened = await s.openWithRetry(mod);
            if (!opened.ok) {
              log(`${tag} open FAILED ${describeOsopenerFailure(opened.failure)}`);
              openFailure = {
                error: failureRow(opened.failure),
                attempts: opened.attempts,
                ...(opened.screenshotPath !== undefined ? { screenshotPath: opened.screenshotPath } : {})
              };
            } else {
              openedHere = opened.openedHere;
              attempts = opened.attempts;
              log(`   open ${mod} ok${opened.attempts > 1 ? ` after ${opened.attempts} attempts` : ""}`);
              await s.sleep(s.gapMs);
            }
          }
        }
      } catch (err) {
        const e = errorOf(err);
        log(`${tag} open FAILED ${e.code}: ${e.message}`);
        if (SESSION_FATAL.has(e.code)) {
          record({ module: mod, outcome: "open-failed", error: e });
          options.state?.failRun(e.code, e.message);
          throw err;
        }
        openFailure = { error: e };
      }
      if (stopForRoom) break;
      if (openFailure !== undefined) {
        record({
          module: mod,
          outcome: "open-failed",
          error: openFailure.error,
          ...(openFailure.attempts !== undefined ? { attempts: openFailure.attempts } : {}),
          ...(openFailure.screenshotPath !== undefined ? { screenshotPath: openFailure.screenshotPath } : {})
        });
        consecutiveOpenFailures++;
        // A real or suspected Save prompt is not an independent per-module failure. If the opt-in
        // Cancel-only recovery could not clear it, one failure is enough to stop safely.
        const blockedByDialog = openFailure.error.code === "UNSAVED_CHANGES_DIALOG";
        if (blockedByDialog || (maxFailures > 0 && consecutiveOpenFailures >= maxFailures)) {
          stoppedEarly = blockedByDialog
            ? `Cannot safely dismiss Service Studio's Save/unknown dialog while opening ${mod}: ${openFailure.error.message}. ` +
              `No Save/Discard action was taken. Inspect Studio and ${join(s.runDir, "screenshots")}, then rerun: staged modules resume.`
            : `${consecutiveOpenFailures} module(s) in a row failed to open (last: ${mod}, ${openFailure.error.code}). ` +
              `Service Studio itself is most likely stuck (a Progress window that never closes, a lost environment ` +
              `connection, or a modal). Look at Studio and the screenshots in ${join(s.runDir, "screenshots")}, fix ` +
              `or restart it, then run the same command again: staged modules are skipped, so it resumes.`;
          log(`STOPPED: ${stoppedEarly}`);
          break;
        }
        continue;
      }
      // The module is open (it already was, or this run opened it): earlier failures were not "in a row".
      consecutiveOpenFailures = 0;

      // 2. Stage it. `stageModule` drains the reader on every path out.
      options.state?.setModuleLifecycle?.(mod, "queued-for-read", { openedHere });
      let row: RunModuleRow;
      let fatal: unknown;
      try {
        const outcome = await stageModule({
          scope,
          module: mod,
          graphDir,
          snapshotPath,
          session: options.createSession(),
          rules: options.rules,
          now: s.now,
          onProgress: s.onProgress,
          ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {}),
          ...(options.skipKinds !== undefined ? { skipKinds: options.skipKinds } : {}),
          ...(options.fetchReferencedElements !== undefined ? { fetchReferencedElements: options.fetchReferencedElements } : {}),
          ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {})
        });
        stagedThisRun.add(lower(mod));
        row = {
          module: mod,
          outcome: "staged",
          openedHere,
          nodeCount: outcome.staged.nodeCount,
          edgeCount: outcome.staged.edgeCount,
          skippedCount: outcome.staged.skippedCount,
          durationMs: outcome.staged.durationMs,
          finalized: outcome.finalized,
          ...(attempts !== undefined ? { attempts } : {})
        };
        log(
          `${tag} staged in ${Math.round(outcome.staged.durationMs / 1000)}s: nodes=${outcome.staged.nodeCount} ` +
            `edges=${outcome.staged.edgeCount} skipped=${outcome.staged.skippedCount} ` +
            `still missing=${outcome.missingModules.length}${outcome.finalized ? " FINALIZED" : ""}`
        );
        if (outcome.finalized && outcome.outcome !== undefined) {
          finalized = outcome.outcome.result;
          options.state?.finishRun(finalized.perModule);
          writeTimings(graphDir, scope.name, finalized.perModule);
        }
      } catch (err) {
        const e = errorOf(err);
        row = { module: mod, outcome: "stage-failed", openedHere, error: e };
        log(`${tag} stage FAILED ${e.code}: ${e.message}`);
        if (SESSION_FATAL.has(e.code)) fatal = err;
      }

      // 3. Give the tab back if this process took it — after the drain, success or not.
      if (openedHere) {
        options.state?.setModuleLifecycle?.(mod, "closing", { openedHere });
        await s.sleep(s.gapMs);
        const closed = await s.closeAfterDrain(mod);
        row.closed = closed.ok;
        if (closed.error !== undefined) row.closeError = closed.error;
      }
      record(row);
      if (fatal !== undefined) {
        options.state?.failRun(errorOf(fatal).code, errorOf(fatal).message);
        throw fatal;
      }
    }
  } finally {
    await s.session.reader.drain?.();
    s.session.reader.setPermitObserver?.(undefined);
    s.session.release();
    if (tracer !== undefined) {
      traceSummary = tracer.finish();
      options.state?.setTraceSummary?.(traceSummary);
      writeReport();
      log(
        `trace: ${traceSummary.calls} call(s), read-slot utilization ${traceSummary.readSlotUtilization}, ` +
          `GUI ${Math.round(traceSummary.gui.totalMs / 1000)}s (${Math.round(traceSummary.gui.exposedMs / 1000)}s exposed) -> ${traceSummary.file}`
      );
    }
  }

  const failures = rows.filter((r) => r.outcome === "open-failed" || r.outcome === "stage-failed").length;

  // Resume wedge: every scope module has a stage entry but nothing finalized (a finalize that threw
  // after its entry was written, a kill between the two, or a scope that shrank after staging).
  // Finalize from the stage now, offline, exactly as `stageModule` would have.
  let incomplete: string | undefined = pipelineIncomplete;
  if (pipelineDepth < 2 && finalized === undefined && stoppedEarly === undefined && failures === 0) {
    let fin: ReturnType<typeof finalizeStage>;
    try {
      fin = finalizeStage({
        scope,
        graphDir,
        snapshotPath,
        rules: options.rules,
        now: s.now,
        ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {})
      });
    } catch (err) {
      const e = errorOf(err);
      log(`finalize FAILED ${e.code}: ${e.message}`);
      options.state?.failRun(e.code, e.message);
      throw err;
    }
    if (fin.outcome !== undefined) {
      finalized = fin.outcome.result;
      log("every scope module is staged: finalized from the stage");
      s.onProgress({ type: "done", durationMs: finalized.durationMs, snapshotPath });
      options.state?.finishRun(finalized.perModule);
      writeTimings(graphDir, scope.name, finalized.perModule);
    } else {
      incomplete =
        `stage incomplete although no module failed: missing ${fin.missingModules.join(", ")}` +
        (fin.unreadableStageFiles.length > 0 ? `; unreadable stage files: ${fin.unreadableStageFiles.join(", ")}` : "");
      log(incomplete);
      options.state?.failRun("RUN_INCOMPLETE", incomplete);
    }
  }

  const cancelled = options.signal?.aborted === true && stoppedEarly === RUN_CANCELLED_MESSAGE;
  if (stoppedEarly !== undefined) {
    options.state?.failRun(cancelled ? "RUN_CANCELLED" : "RUN_STOPPED", stoppedEarly);
  } else if (finalized === undefined && failures > 0) {
    options.state?.failRun("RUN_INCOMPLETE", `${failures} module(s) failed; run the same command again to retry them`);
  }
  const stagedNow = stagedNames(graphDir, scope.name).size;
  if (finalized !== undefined) {
    log(
      `snapshot written: ${finalized.nodeCount} nodes, ${finalized.edgeCount} edges, ` +
        `${finalized.violationCount} violation(s) -> ${finalized.snapshotPath}`
    );
  } else {
    log(
      `not finalized: ${stagedNow}/${modules.length} staged, ${failures} failure(s) this run. ` +
        `Run the same command again to continue; staged modules are skipped.`
    );
  }

  return {
    mode: "full",
    scope: scope.name,
    total: modules.length,
    alreadyStaged,
    rows,
    finalized: finalized !== undefined,
    ...(finalized !== undefined ? { rebuild: finalized } : {}),
    ...(stoppedEarly !== undefined ? { stoppedEarly } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    ...(traceSummary !== undefined ? { trace: traceSummary } : {}),
    ...(incomplete !== undefined ? { incomplete } : {}),
    ...(pipeline !== undefined ? { pipeline } : {}),
    failures,
    runDir: s.runDir,
    logPath: s.logPath,
    reportPath
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Pipelined full build (`--pipeline-depth` >= 2), plan v3 sections 3, 6 and 8                    */
/* -------------------------------------------------------------------------------------------- */

/** Whole-run and per-module wall-clock spans of a pipelined run. NOT written to `timings.json`. */
export interface PipelineTimings {
  mode: "pipeline";
  pipelineDepth: number;
  maxOpen: number;
  /** Wall clock of the whole run, finalize included. */
  wallMs: number;
  /** Spans overlap across modules, so they are wall-clock per module, never exclusive costs. */
  modules: Array<{ module: string; openMs?: number; captureMs?: number; closeMs?: number; totalMs?: number }>;
}

interface PipelineContext {
  options: RunScopeOptions;
  s: ReturnType<typeof setup>;
  modules: string[];
  initiallyStaged: Set<string>;
  depth: number;
  maxOpen: number;
  maxFailures: number;
  snapshotPath: string;
  rows: RunModuleRow[];
  record: (row: RunModuleRow) => void;
  /** Fields merged into report.json next to the rows (timings); rewrites the file. */
  setReportExtra: (extra: Record<string, unknown>) => void;
}

interface PipelineOutcome {
  stoppedEarly?: string;
  finalized?: RebuildResult;
  incomplete?: string;
  timings: PipelineTimings;
}

/**
 * The opt-in pipeline: ONE serialized GUI operator opens and closes, every open module is captured
 * (stage-only) at the same time over the one shared 4-wide client, and a module's tab is closed the
 * moment ITS reads have settled, without waiting for the others. `finalizeStage` runs once, last.
 *
 * - A module holds a depth slot from the moment it starts opening until its close is confirmed; a
 *   failed close keeps the slot. `gapMs` is a cooldown of the GUI operator only: it never holds a slot
 *   and never pauses reads of open modules.
 * - Tabs: at most `depth` modules are active, and no open is started while ALL open tabs (the user's
 *   included) are at `--max-open`. Only tabs this process opened are ever closed.
 * - A read failure stops new opens, lets started work settle and closes owned tabs; the previous graph
 *   is untouched (finalize is skipped). Open failures follow the circuit breaker. A session-fatal error
 *   does the same, then rethrows.
 */
async function runPipelined(c: PipelineContext): Promise<PipelineOutcome> {
  const { options, s, modules, depth, maxOpen, maxFailures, snapshotPath, rows, record } = c;
  const { opener } = options;
  const { log } = s;
  const reader = s.session.reader;
  if (typeof reader.drainModule !== "function") {
    throw new OsgraphToolError(
      "INTERNAL_ERROR",
      "--pipeline-depth >= 2 needs a Service Studio reader with drainModule(): closing one module's tab while " +
        "another still reads is only safe behind a module-scoped barrier, and a global drain would stall every module.",
      { scope: options.scope.name, pipelineDepth: depth }
    );
  }
  const drainModule = reader.drainModule.bind(reader);
  const runStart = Date.now();
  const spans = new Map<string, PipelineTimings["modules"][number]>();
  const spanOf = (m: string): PipelineTimings["modules"][number] => {
    let sp = spans.get(lower(m));
    if (sp === undefined) {
      sp = { module: m };
      spans.set(lower(m), sp);
    }
    return sp;
  };
  const timings = (): PipelineTimings => ({
    mode: "pipeline",
    pipelineDepth: depth,
    maxOpen,
    wallMs: Date.now() - runStart,
    modules: modules.filter((m) => spans.has(lower(m))).map((m) => spans.get(lower(m)) as PipelineTimings["modules"][number])
  });

  const indexOf = (m: string): number => modules.findIndex((x) => lower(x) === lower(m));
  const tagOf = (m: string): string => `[${indexOf(m) + 1}/${modules.length}] ${m}`;
  const queue: string[] = [];
  for (const mod of modules) {
    if (c.initiallyStaged.has(lower(mod))) {
      log(`${tagOf(mod)} already staged`);
      record({ module: mod, outcome: "skipped" });
    } else queue.push(mod);
  }

  // Slots held by modules from opening until their close is confirmed (or, for a tab that was already
  // open, until its capture has drained).
  const active = new Set<string>();
  const running = new Set<Promise<void>>();
  const waiters: Array<() => void> = [];
  const signal = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const nextEvent = (): Promise<void> => new Promise<void>((resolve) => waiters.push(resolve));

  let abort = false;
  let roomStop = false;
  let stoppedEarly: string | undefined;
  let fatal: unknown;
  let consecutiveOpenFailures = 0;

  // Ctrl+C: stop scheduling, let started modules finish and close, then report. The abort path below
  // already does exactly that; cancellation only has to flip it and wake the scheduler.
  let cancelled = false;
  const onCancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    abort = true;
    options.state?.markCancelling?.();
    log(`CANCELLING: opening nothing more; ${running.size} module(s) in flight will finish, drain and close`);
    signal();
  };
  options.signal?.addEventListener("abort", onCancel, { once: true });
  if (options.signal?.aborted === true) onCancel();

  // The one GUI operator: opens and closes never overlap, and `gapMs` is its cooldown between actions.
  let guiTail: Promise<unknown> = Promise.resolve();
  let lastGuiEnd: number | undefined;
  const gui = <T>(action: "open" | "close", module: string, fn: () => Promise<T>): Promise<T> => {
    const run = guiTail.then(async () => {
      if (lastGuiEnd !== undefined) {
        const wait = s.gapMs - (Date.now() - lastGuiEnd);
        if (wait > 0) await s.sleep(wait);
      }
      options.state?.setGuiState?.(action, module, true);
      try {
        return await fn();
      } finally {
        lastGuiEnd = Date.now();
        options.state?.setGuiState?.(action, module, false);
      }
    });
    guiTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  /** Only after the module's own barrier; a thrown close counts as "not closed". */
  const closeOwnedTab = (mod: string): Promise<{ ok: boolean; error?: string }> =>
    gui("close", mod, async () => {
      const t0 = performance.now();
      let ok = false;
      try {
        await s.waitForForeground();
        const closed = await opener.closeOwned(mod);
        if (closed.ok) {
          ok = true;
          log(`   close ${mod} ok`);
          return { ok: true };
        }
        const error = describeOsopenerFailure(closed.failure);
        log(`   close ${mod} FAILED ${error}`);
        return { ok: false, error };
      } catch (err) {
        const error = errorOf(err).message;
        log(`   close ${mod} FAILED ${error}`);
        return { ok: false, error };
      } finally {
        s.traceGui?.({ action: "close", module: mod, startMs: t0, endMs: performance.now(), ok });
      }
    });

  const noteFatal = (err: unknown): void => {
    fatal ??= err;
    abort = true;
  };

  const startTask = (mod: string, openedHere: boolean, attempts: number | undefined): void => {
    const task = (async () => {
      const t0 = Date.now();
      let row: RunModuleRow;
      try {
        const outcome = await stageModule({
          scope: options.scope,
          module: mod,
          graphDir: options.graphDir,
          snapshotPath,
          session: options.createSession(),
          rules: options.rules,
          now: s.now,
          onProgress: s.onProgress,
          finalize: false,
          ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {}),
          ...(options.skipKinds !== undefined ? { skipKinds: options.skipKinds } : {}),
          ...(options.fetchReferencedElements !== undefined ? { fetchReferencedElements: options.fetchReferencedElements } : {}),
          ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {})
        });
        row = {
          module: mod,
          outcome: "staged",
          openedHere,
          nodeCount: outcome.staged.nodeCount,
          edgeCount: outcome.staged.edgeCount,
          skippedCount: outcome.staged.skippedCount,
          durationMs: outcome.staged.durationMs,
          finalized: false,
          ...(attempts !== undefined ? { attempts } : {})
        };
        log(
          `${tagOf(mod)} staged in ${Math.round(outcome.staged.durationMs / 1000)}s: nodes=${outcome.staged.nodeCount} ` +
            `edges=${outcome.staged.edgeCount} skipped=${outcome.staged.skippedCount}`
        );
      } catch (err) {
        const e = errorOf(err);
        row = { module: mod, outcome: "stage-failed", openedHere, error: e };
        log(`${tagOf(mod)} stage FAILED ${e.code}: ${e.message}`);
        if (SESSION_FATAL.has(e.code)) noteFatal(err);
        else abort = true;
      }
      spanOf(mod).captureMs = Date.now() - t0;

      // Module-scoped barrier: every read, retry and parse of THIS module has settled; others go on.
      let drained = true;
      try {
        await drainModule(mod);
      } catch (err) {
        drained = false;
        log(`   drain ${mod} FAILED ${errorOf(err).message}`);
      }
      if (openedHere) {
        options.state?.setModuleLifecycle?.(mod, "closing", { openedHere });
        const c0 = Date.now();
        if (!drained) {
          row.closed = false;
          row.closeError = "module drain failed, so the tab was not closed";
        } else {
          const closed = await closeOwnedTab(mod);
          row.closed = closed.ok;
          if (closed.error !== undefined) row.closeError = closed.error;
          if (closed.ok) active.delete(lower(mod));
        }
        spanOf(mod).closeMs = Date.now() - c0;
      } else if (drained) {
        active.delete(lower(mod));
      }
      spanOf(mod).totalMs = Date.now() - t0 + (spanOf(mod).openMs ?? 0);
      record(row);
    })().catch((err: unknown) => {
      // Not reachable through the paths above; never let a bug leave the scheduler waiting forever.
      noteFatal(err);
    });
    running.add(task);
    void task.finally(() => {
      running.delete(task);
      signal();
    });
  };

  const openFailed = (mod: string, error: NonNullable<RunModuleRow["error"]>, extra: Partial<RunModuleRow> = {}): void => {
    record({ module: mod, outcome: "open-failed", error, ...extra });
    consecutiveOpenFailures++;
    const blockedByDialog = error.code === "UNSAVED_CHANGES_DIALOG";
    if (stoppedEarly === undefined && (blockedByDialog || (maxFailures > 0 && consecutiveOpenFailures >= maxFailures))) {
      stoppedEarly = blockedByDialog
        ? `Cannot safely dismiss Service Studio's Save/unknown dialog while opening ${mod}: ${error.message}. ` +
          `No Save/Discard action was taken. Inspect Studio and ${join(s.runDir, "screenshots")}, then rerun: staged modules resume.`
        : `${consecutiveOpenFailures} module(s) in a row failed to open (last: ${mod}, ${error.code}). ` +
          `Service Studio itself is most likely stuck (a Progress window that never closes, a lost environment ` +
          `connection, or a modal). Look at Studio and the screenshots in ${join(s.runDir, "screenshots")}, fix ` +
          `or restart it, then run the same command again: staged modules are skipped, so it resumes.`;
      log(`STOPPED: ${stoppedEarly}`);
      abort = true;
    }
  };

  // Scheduler: opens are decided here, one at a time, on a fresh listApps; reads run in the tasks.
  while (queue.length > 0 && !abort) {
    const mod = queue[0] as string;
    if (active.size >= depth) {
      if (running.size === 0) {
        const stuck = opener.ownedModules();
        stoppedEarly =
          `${active.size} module(s) hold every pipeline slot (--pipeline-depth ${depth}) and none can progress: ` +
          `${stuck.length > 0 ? `tab(s) this run opened could not be closed (${stuck.join(", ")}). ` : ""}` +
          `osopener's close is failing (a save prompt, or a tab-close step that no longer matches this Studio build). ` +
          `Close those tabs by hand, then run the same command again: staged modules are skipped, so it resumes.`;
        log(`STOPPED: ${stoppedEarly}`);
        roomStop = true;
        break;
      }
      await nextEvent();
      continue;
    }

    let apps: ServiceStudioApp[];
    try {
      apps = await s.listApps();
    } catch (err) {
      const e = errorOf(err);
      log(`${tagOf(mod)} open FAILED ${e.code}: ${e.message}`);
      queue.shift();
      if (SESSION_FATAL.has(e.code)) {
        record({ module: mod, outcome: "open-failed", error: e });
        noteFatal(err);
        break;
      }
      openFailed(mod, e);
      continue;
    }
    if (abort) break;
    const isOpen = (name: string): boolean => apps.some((a) => a.isOpen === true && lower(a.name) === lower(name));
    const already = isOpen(mod);
    const tabs = apps.filter((a) => a.isOpen === true).length;
    if (!already && tabs >= maxOpen) {
      // Counted over ALL open tabs, the user's included. Wait for one of ours to close; if nothing can,
      // stop rather than open one more (the >30-tab degradation this command exists to avoid).
      if (running.size === 0) {
        stoppedEarly =
          `${tabs} tab(s) are open in Service Studio (${opener.ownedModules().length} opened by this run) and --max-open ` +
          `is ${maxOpen}: opening ${mod} would exceed it and nothing this run holds can be closed. Close some tabs by ` +
          `hand or raise --max-open, then run the same command again: staged modules are skipped, so it resumes.`;
        log(`STOPPED: ${stoppedEarly}`);
        roomStop = true;
        break;
      }
      await nextEvent();
      continue;
    }

    queue.shift();
    active.add(lower(mod));
    if (already) {
      consecutiveOpenFailures = 0;
      options.state?.setModuleLifecycle?.(mod, "queued-for-read", { openedHere: false });
      startTask(mod, false, undefined);
      continue;
    }
    options.state?.setModuleLifecycle?.(mod, "opening");
    const o0 = Date.now();
    let opened: Awaited<ReturnType<typeof s.openWithRetry>>;
    try {
      opened = await gui("open", mod, () => s.openWithRetry(mod));
    } catch (err) {
      const e = errorOf(err);
      log(`${tagOf(mod)} open FAILED ${e.code}: ${e.message}`);
      active.delete(lower(mod));
      if (SESSION_FATAL.has(e.code)) {
        record({ module: mod, outcome: "open-failed", error: e });
        noteFatal(err);
      } else openFailed(mod, e);
      continue;
    }
    spanOf(mod).openMs = Date.now() - o0;
    if (!opened.ok) {
      log(`${tagOf(mod)} open FAILED ${describeOsopenerFailure(opened.failure)}`);
      // A failed open that nonetheless left a tab this process owns keeps its slot until closed.
      if (opener.owns(mod)) {
        const closed = await closeOwnedTab(mod);
        if (closed.ok) active.delete(lower(mod));
      } else active.delete(lower(mod));
      openFailed(mod, failureRow(opened.failure), {
        attempts: opened.attempts,
        ...(opened.screenshotPath !== undefined ? { screenshotPath: opened.screenshotPath } : {})
      });
      continue;
    }
    consecutiveOpenFailures = 0;
    log(`   open ${mod} ok${opened.attempts > 1 ? ` after ${opened.attempts} attempts` : ""}`);
    if (abort) {
      // Stopped (or cancelled) while this open was in progress: give the tab back unread instead of
      // spending a whole capture on it; the next run reads it.
      if (opened.openedHere) {
        const closed = await closeOwnedTab(mod);
        if (closed.ok) active.delete(lower(mod));
      } else active.delete(lower(mod));
      queue.unshift(mod);
      break;
    }
    options.state?.setModuleLifecycle?.(mod, "queued-for-read", { openedHere: opened.openedHere });
    startTask(mod, opened.openedHere, opened.attempts);
  }

  // Let everything already started settle (its capture, drain and close) before touching the result.
  while (running.size > 0) await Promise.all([...running]);
  options.signal?.removeEventListener("abort", onCancel);
  if (cancelled && stoppedEarly === undefined) {
    stoppedEarly = RUN_CANCELLED_MESSAGE;
    log(`CANCELLED: ${stoppedEarly}`);
  }

  // Aborted: close what this process still owns (a failed close earlier, a refused one now). Best
  // effort and visible; never a tab the process did not open (closeOwned refuses those).
  if (abort && !roomStop) {
    for (const owned of [...opener.ownedModules()]) {
      try {
        await drainModule(owned);
      } catch {
        continue;
      }
      const closed = await closeOwnedTab(owned);
      const row = rows.find((r) => lower(r.module) === lower(owned));
      if (row !== undefined) {
        row.closed = closed.ok;
        if (closed.error !== undefined) row.closeError = closed.error;
        else delete row.closeError;
      }
      if (closed.ok) active.delete(lower(owned));
    }
  }

  // Every scope module gets a row: what was still queued when the run stopped is `not-started`.
  for (const mod of queue) {
    if (!rows.some((r) => lower(r.module) === lower(mod))) record({ module: mod, outcome: "not-started" });
  }

  rows.sort((a, b) => indexOf(a.module) - indexOf(b.module));

  if (fatal !== undefined) {
    const e = errorOf(fatal);
    c.setReportExtra({ timings: timings() });
    options.state?.failRun(e.code, e.message);
    throw fatal;
  }

  const failures = rows.filter((r) => r.outcome === "open-failed" || r.outcome === "stage-failed").length;
  let finalized: RebuildResult | undefined;
  let incomplete: string | undefined;
  if (!abort && stoppedEarly === undefined && failures === 0 && queue.length === 0) {
    try {
      const fin = finalizeStage({
        scope: options.scope,
        graphDir: options.graphDir,
        snapshotPath,
        rules: options.rules,
        now: s.now,
        startedAt: runStart,
        ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {})
      });
      if (fin.outcome !== undefined) {
        finalized = fin.outcome.result;
        log("every scope module is staged: finalized from the stage");
        s.onProgress({ type: "done", durationMs: finalized.durationMs, snapshotPath });
        options.state?.finishRun(finalized.perModule);
        // Deliberately no writeTimings: overlapped wall-clock spans would corrupt the sequential ETA store.
      } else {
        incomplete =
          `stage incomplete although no module failed: missing ${fin.missingModules.join(", ")}` +
          (fin.unreadableStageFiles.length > 0 ? `; unreadable stage files: ${fin.unreadableStageFiles.join(", ")}` : "");
        log(incomplete);
        options.state?.failRun("RUN_INCOMPLETE", incomplete);
      }
    } catch (err) {
      const e = errorOf(err);
      log(`finalize FAILED ${e.code}: ${e.message}`);
      c.setReportExtra({ timings: timings() });
      options.state?.failRun(e.code, e.message);
      throw err;
    }
  }
  const finalTimings = timings();
  c.setReportExtra({ timings: finalTimings });
  return {
    ...(stoppedEarly !== undefined ? { stoppedEarly } : {}),
    ...(finalized !== undefined ? { finalized } : {}),
    ...(incomplete !== undefined ? { incomplete } : {}),
    timings: finalTimings
  };
}

/**
 * Every OTHER scope module's raw capture, by canonical name, with its capture time. Throws
 * `RUN_CAPTURES_MISSING` naming each one that has none, because the offline re-extract that follows
 * a one-module refresh would otherwise publish a graph with holes in it.
 */
export function requireOtherCaptures(graphDir: string, scope: ScopeDefinition, module: string, now: Date): CaptureAge[] {
  const byLower = new Map(listRawModules(graphDir, scope.name).map((m) => [lower(m), m]));
  const ages: CaptureAge[] = [];
  const missing: string[] = [];
  for (const m of uniqueModules(scope.modules)) {
    if (lower(m) === lower(module)) continue;
    const canonical = byLower.get(lower(m));
    let capturedAt: string | undefined;
    if (canonical !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(rawManifestPath(graphDir, scope.name, canonical), "utf8")) as RawManifest;
        if (typeof manifest.capturedAt === "string" && !Number.isNaN(Date.parse(manifest.capturedAt))) {
          capturedAt = manifest.capturedAt;
        }
      } catch {
        /* unreadable: counted as missing below */
      }
    }
    if (capturedAt === undefined) {
      missing.push(m);
      continue;
    }
    ages.push({ module: canonical as string, capturedAt, ageMs: Math.max(0, now.getTime() - Date.parse(capturedAt)) });
  }
  if (missing.length > 0) {
    throw new OsgraphToolError(
      "RUN_CAPTURES_MISSING",
      `scope '${scope.name}': a one-module refresh of '${module}' re-extracts the whole scope offline from raw/, ` +
        `but ${missing.length} other module(s) have no raw capture: ${missing.join(", ")}. ` +
        `Run a full 'osgraph run --scope ${scope.name}' first to capture them.`,
      { scope: scope.name, module, missing }
    );
  }
  return ages.sort((a, b) => b.ageMs - a.ageMs || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}

/**
 * One-module refresh: re-read only `module`, then re-extract the whole scope offline from `raw/`, so
 * `graph.json` and `flows.json` are byte-identical to `osgraph reextract` over the same captures.
 *
 * Preconditions are checked before Studio is touched: `module` must be in the scope, and every other
 * scope module must already have a raw capture (`RUN_CAPTURES_MISSING` otherwise).
 */
export async function refreshModule(options: RefreshModuleOptions): Promise<RefreshModuleResult> {
  const { scope, graphDir } = options;
  const inScope = scope.modules.find((m) => lower(m) === lower(options.module));
  if (inScope === undefined) {
    throw new OsgraphToolError(
      "SCOPE_INVALID",
      `module '${options.module}' is not in scope '${scope.name}'; a one-module refresh reads only scope modules.`,
      { scope: scope.name, module: options.module, modules: scope.modules }
    );
  }
  const now = options.now ?? (() => new Date());
  // Checked before anything opens: a refresh that cannot be re-extracted must cost nothing.
  requireOtherCaptures(graphDir, scope, inScope, now());

  const s = setup(options);
  const { log } = s;
  const snapshotPath = resolveScopeArtifactPaths(graphDir, scope.name).graph;
  options.state?.beginRun(scope.name, [inScope]);
  log(`run ${scope.name} --module ${inScope}: refreshing one module, then re-extracting the scope offline`);

  // A stage entry that existed before is real progress of an interrupted full run; only one this
  // refresh created is transient and removed again.
  const stagedBefore = stagedNames(graphDir, scope.name).has(lower(inScope));

  let openedHere = false;
  let closed = false;
  let stagedResult: StageOutcome | undefined;
  let stageEntryRemoved = false;
  await s.session.acquire();
  try {
    const apps = await s.listApps();
    if (!apps.some((a) => a.isOpen === true && lower(a.name) === lower(inScope))) {
      const opened = await s.openWithRetry(inScope);
      if (!opened.ok) {
        throw new OsgraphToolError(
          "MODULE_OPEN_FAILED",
          `could not open '${inScope}' after ${opened.attempts} attempt(s): ${describeOsopenerFailure(opened.failure)}` +
            (opened.screenshotPath !== undefined ? ` (screenshot: ${opened.screenshotPath})` : ""),
          { module: inScope, failure: opened.failure, screenshotPath: opened.screenshotPath }
        );
      }
      openedHere = opened.openedHere;
      log(`   open ${inScope} ok`);
      await s.sleep(s.gapMs);
    } else {
      log(`   ${inScope} is already open; it will be left open`);
    }

    try {
      stagedResult = await stageModule({
        scope,
        module: inScope,
        graphDir,
        snapshotPath,
        session: options.createSession(),
        rules: options.rules,
        now: s.now,
        onProgress: s.onProgress,
        ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {}),
        ...(options.skipKinds !== undefined ? { skipKinds: options.skipKinds } : {}),
        ...(options.fetchReferencedElements !== undefined ? { fetchReferencedElements: options.fetchReferencedElements } : {}),
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {})
      });
    } finally {
      if (openedHere) {
        await s.sleep(s.gapMs);
        closed = (await s.closeAfterDrain(inScope)).ok;
      }
    }
  } catch (err) {
    options.state?.failRun(errorOf(err).code, errorOf(err).message);
    throw err;
  } finally {
    await s.session.reader.drain?.();
    s.session.release();
    // The stage entry is transient: the refresh's product is raw/<module>/, not a stage. Removed on
    // every path out (also when staging threw after writing it, e.g. a finalize error) so a later
    // full run never mistakes it for progress of its own. A stage this call finalized is cleared.
    if (!stagedBefore && stagedResult?.finalized !== true) {
      stageEntryRemoved = removeStageEntry(graphDir, scope.name, inScope);
      if (stageEntryRemoved) log(`   removed the transient stage entry for ${inScope}`);
    }
  }
  const staged = stagedResult as StageOutcome;
  log(
    `   ${staged.staged.module} captured: nodes=${staged.staged.nodeCount} edges=${staged.staged.edgeCount} ` +
      `skipped=${staged.staged.skippedCount}`
  );

  const reextract = reextractScope({ scope, graphDir, snapshotPath, rules: options.rules, now: s.now, onProgress: log });
  options.state?.finishRun([]);
  // Re-read after the capture so the ages are measured against the same clock as the refresh.
  const otherCaptures = requireOtherCaptures(graphDir, scope, inScope, s.now());
  log(
    `re-extracted ${reextract.modules.length} module(s): ${reextract.nodeCount} nodes, ${reextract.edgeCount} edges -> ` +
      `${reextract.snapshotPath}`
  );
  for (const c of otherCaptures) log(`   ${c.module} captured ${c.capturedAt} (${formatAge(c.ageMs)} old)`);

  return {
    mode: "module",
    scope: scope.name,
    module: staged.staged.module,
    openedHere,
    closed,
    staged: staged.staged,
    stageFinalized: staged.finalized,
    stageEntryRemoved,
    reextract,
    otherCaptures,
    runDir: s.runDir,
    logPath: s.logPath
  };
}

export interface RefreshModulesOptions extends RunCommonOptions {
  /** `--modules a,b,c`: the scope modules to read (case-exact names). Omitted with `changed` = every scope module. */
  modules?: readonly string[];
  /** `--changed`: open each candidate, compare the listed version with the capture, re-read only the ones that differ. */
  changed?: boolean;
  maxOpen?: number;
  maxConsecutiveFailures?: number;
}

export interface RefreshModulesRow {
  module: string;
  /** Why this module was (not) read. `requested` = named by `--modules` without `--changed`. */
  reason: ChangeReason | "requested";
  detail: string;
  read: boolean;
  openedHere?: boolean;
  closed?: boolean;
  closeError?: string;
  nodeCount?: number;
  edgeCount?: number;
  durationMs?: number;
  /** Change detection versions for progress API v2. */
  moduleVersion?: string | null;
  previousCaptureVersion?: string | null;
  /** Set when the module could not be opened or read. */
  error?: { code: string; message: string };
}

export interface RefreshModulesResult {
  mode: "modules";
  scope: string;
  changedMode: boolean;
  rows: RefreshModulesRow[];
  readCount: number;
  failures: number;
  stoppedEarly?: string;
  /** Present when the single offline re-extract ran (skipped when any module failed). */
  reextract?: ReextractResult;
  runDir: string;
  logPath: string;
}

/**
 * `--modules` / `--changed` (#65): read only some scope modules, then ONE offline `reextractScope`.
 *
 * - `--modules a,b,c`: names are validated case-exactly against the scope; the others must already have
 *   a capture (else `RUN_CAPTURES_MISSING`, checked before Studio is touched). Every named module is read.
 * - `--changed`: each candidate is opened, its listed version compared with the capture manifest's
 *   `moduleVersion` through `decideChange`; only a differing, unknown or uncaptured module is read.
 *
 * The opener, `--max-open` and drain-before-close behaviour are `run`'s: a tab this process opens is
 * closed right after the module is decided/read, always after `drain()`.
 */
export async function refreshModules(options: RefreshModulesOptions): Promise<RefreshModulesResult> {
  const { scope, graphDir, opener } = options;
  const changedMode = options.changed === true;
  const all = uniqueModules(scope.modules);
  let candidates = all;
  if (options.modules !== undefined) {
    const unknown = options.modules.filter((m) => !scope.modules.includes(m));
    if (options.modules.length === 0 || unknown.length > 0) {
      throw new OsgraphToolError(
        "SCOPE_INVALID",
        options.modules.length === 0
          ? `--modules needs at least one module name from scope '${scope.name}'.`
          : `module(s) not in scope '${scope.name}' (names are case-exact): ${unknown.join(", ")}. Scope modules: ${scope.modules.join(", ")}.`,
        { scope: scope.name, unknown, modules: scope.modules }
      );
    }
    const wanted = new Set(options.modules);
    candidates = all.filter((m) => wanted.has(m));
    if (!changedMode) {
      // The re-extract needs every other module's capture; fail before anything opens.
      const have = new Set(listRawModules(graphDir, scope.name).map(lower));
      const missing = all.filter((m) => !wanted.has(m) && !have.has(lower(m)));
      if (missing.length > 0) {
        throw new OsgraphToolError(
          "RUN_CAPTURES_MISSING",
          `scope '${scope.name}': reading ${candidates.join(", ")} re-extracts the whole scope offline from raw/, but ` +
            `${missing.length} other module(s) have no raw capture: ${missing.join(", ")}. ` +
            `Run a full 'osgraph run --scope ${scope.name}' first to capture them.`,
          { scope: scope.name, missing }
        );
      }
    }
  }

  const s = setup(options);
  const { log } = s;
  const maxOpen = Math.max(1, Math.trunc(options.maxOpen ?? DEFAULT_MAX_OPEN));
  const maxFailures = Math.max(0, Math.trunc(options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES));
  const snapshotPath = resolveScopeArtifactPaths(graphDir, scope.name).graph;
  const reportPath = join(s.runDir, "report.json");
  const rows: RefreshModulesRow[] = [];
  const record = (row: RefreshModulesRow): void => {
    rows.push(row);
    const outcome = row.error !== undefined ? "stage-failed" : row.read ? "staged" : "reused";
    options.state?.recordOutcome?.(row.module, outcome, {
      versionReason: row.reason,
      ...(row.moduleVersion !== undefined ? { moduleVersion: row.moduleVersion } : {}),
      ...(row.previousCaptureVersion !== undefined ? { previousCaptureVersion: row.previousCaptureVersion } : {}),
      ...(row.openedHere !== undefined ? { openedHere: row.openedHere } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      ...(row.nodeCount !== undefined ? { nodeCount: row.nodeCount } : {}),
      ...(row.edgeCount !== undefined ? { edgeCount: row.edgeCount } : {}),
      ...(row.error !== undefined ? { error: row.error } : {})
    });
    try {
      writeFileSync(reportPath, `${JSON.stringify({ scope: scope.name, rows }, null, 2)}\n`, "utf8");
    } catch {
      /* the report is a convenience */
    }
  };
  options.state?.beginRun(scope.name, candidates, {
    mode: changedMode ? "changed" : "modules",
    readLimit: options.fetchConcurrency ?? s.session.reader.concurrency
  });
  s.session.reader.setPermitObserver?.((status) => options.state?.setWorkers?.(status));
  log(
    `run ${scope.name} ${changedMode ? "--changed" : "--modules"}: ${candidates.length} candidate module(s), ` +
      `then one offline re-extract`
  );

  let consecutiveOpenFailures = 0;
  let stoppedEarly: string | undefined;
  await s.session.acquire();
  try {
    for (const [i, mod] of candidates.entries()) {
      const tag = `[${i + 1}/${candidates.length}] ${mod}`;
      const capture = readCaptureVersion(graphDir, scope.name, mod);
      let openedHere = false;
      let apps: ServiceStudioApp[] = [];
      try {
        apps = await s.listApps();
        const isOpen = (name: string): boolean => apps.some((a) => a.isOpen === true && lower(a.name) === lower(name));
        if (!isOpen(mod)) {
          const ownedOpen = opener.ownedModules().filter((o) => isOpen(o));
          if (ownedOpen.length >= maxOpen) {
            stoppedEarly =
              `${ownedOpen.length} tab(s) this run opened could not be closed (${ownedOpen.join(", ")}) and ` +
              `--max-open is ${maxOpen}: opening ${mod} would exceed it. Close those tabs by hand, then run the same command again.`;
            log(`STOPPED: ${stoppedEarly}`);
            break;
          }
          options.state?.setModuleLifecycle?.(mod, "opening");
          const opened = await s.openWithRetry(mod);
          if (!opened.ok) {
            const msg = describeOsopenerFailure(opened.failure);
            log(`${tag} open FAILED ${msg}`);
            record({ module: mod, reason: "unknown", detail: "could not open", read: false, error: { code: opened.failure.code, message: msg } });
            consecutiveOpenFailures++;
            if (maxFailures > 0 && consecutiveOpenFailures >= maxFailures) {
              stoppedEarly = `${consecutiveOpenFailures} module(s) in a row failed to open (last: ${mod}). Look at Service Studio, then run the same command again.`;
              log(`STOPPED: ${stoppedEarly}`);
              break;
            }
            continue;
          }
          openedHere = opened.openedHere;
          log(`   open ${mod} ok`);
          await s.sleep(s.gapMs);
          if (changedMode) apps = await s.listApps();
        }
      } catch (err) {
        const e = errorOf(err);
        log(`${tag} open FAILED ${e.code}: ${e.message}`);
        record({ module: mod, reason: "unknown", detail: "could not open", read: false, error: e });
        if (SESSION_FATAL.has(e.code)) {
          options.state?.failRun(e.code, e.message);
          throw err;
        }
        consecutiveOpenFailures++;
        continue;
      }
      consecutiveOpenFailures = 0;

      const listed = apps.find((a) => a.isOpen === true && lower(a.name) === lower(mod))?.version;
      if (changedMode) {
        options.state?.setModuleLifecycle?.(mod, "version-check", {
          moduleVersion: listed ?? null,
          previousCaptureVersion: capture.version
        });
      }
      const decision: { read: boolean; reason: ChangeReason | "requested"; detail: string } = changedMode
        ? decideChange(capture, listed)
        : { read: true, reason: "requested", detail: "named by --modules" };
      log(`${tag} ${decision.reason}: ${decision.detail}`);

      const row: RefreshModulesRow = {
        module: mod, reason: decision.reason, detail: decision.detail, read: decision.read, openedHere,
        ...(changedMode ? { moduleVersion: listed ?? null, previousCaptureVersion: capture.version } : {})
      };
      let fatal: unknown;
      if (decision.read) {
        options.state?.setModuleLifecycle?.(mod, "queued-for-read", { openedHere, versionReason: decision.reason });
        const stagedBefore = stagedNames(graphDir, scope.name).has(lower(mod));
        let staged: StageOutcome | undefined;
        try {
          staged = await stageModule({
            scope,
            module: mod,
            graphDir,
            snapshotPath,
            session: options.createSession(),
            rules: options.rules,
            now: s.now,
            onProgress: s.onProgress,
            ...(options.fetchConcurrency !== undefined ? { fetchConcurrency: options.fetchConcurrency } : {}),
            ...(options.fetchReferencedElements !== undefined ? { fetchReferencedElements: options.fetchReferencedElements } : {}),
            ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {})
          });
          row.nodeCount = staged.staged.nodeCount;
          row.edgeCount = staged.staged.edgeCount;
          row.durationMs = staged.staged.durationMs;
          log(`   ${mod} captured: nodes=${staged.staged.nodeCount} edges=${staged.staged.edgeCount}`);
        } catch (err) {
          const e = errorOf(err);
          row.error = e;
          log(`${tag} stage FAILED ${e.code}: ${e.message}`);
          if (SESSION_FATAL.has(e.code)) fatal = err;
        } finally {
          // The stage entry is transient (the product is raw/<module>/), as in a one-module refresh.
          if (!stagedBefore && staged?.finalized !== true) {
            if (removeStageEntry(graphDir, scope.name, mod)) log(`   removed the transient stage entry for ${mod}`);
          }
        }
      }
      // Give the tab back if this process took it, after the drain.
      if (openedHere) {
        options.state?.setModuleLifecycle?.(mod, "closing", { openedHere });
        await s.sleep(s.gapMs);
        const closed = await s.closeAfterDrain(mod);
        row.closed = closed.ok;
        if (closed.error !== undefined) row.closeError = closed.error;
      }
      record(row);
      if (fatal !== undefined) {
        options.state?.failRun(errorOf(fatal).code, errorOf(fatal).message);
        throw fatal;
      }
    }
  } finally {
    await s.session.reader.drain?.();
    s.session.reader.setPermitObserver?.(undefined);
    s.session.release();
  }

  if (changedMode) {
    const unknownVersion = rows.filter((r) => r.reason === "unknown" && r.read).length;
    if (unknownVersion > 0) {
      log(`WARNING: ${unknownVersion} module(s) re-read because their version was unknown ("0", empty or missing)`);
    }
  }
  const failures = rows.filter((r) => r.error !== undefined).length;
  const readCount = rows.filter((r) => r.read && r.error === undefined).length;
  let reextract: ReextractResult | undefined;
  if (failures === 0 && stoppedEarly === undefined) {
    try {
      reextract = reextractScope({ scope, graphDir, snapshotPath, rules: options.rules, now: s.now, onProgress: log });
    } catch (err) {
      options.state?.failRun(errorOf(err).code, errorOf(err).message);
      throw err;
    }
    options.state?.finishRun([]);
    log(
      `re-extracted ${reextract.modules.length} module(s): ${reextract.nodeCount} nodes, ${reextract.edgeCount} edges -> ` +
        `${reextract.snapshotPath}`
    );
  } else {
    options.state?.failRun("RUN_INCOMPLETE", `${failures} module(s) failed${stoppedEarly !== undefined ? "; run stopped early" : ""}; no re-extract was done`);
    log("not re-extracted: fix the failures and run the same command again");
  }

  return {
    mode: "modules",
    scope: scope.name,
    changedMode,
    rows,
    readCount,
    failures,
    ...(stoppedEarly !== undefined ? { stoppedEarly } : {}),
    ...(reextract !== undefined ? { reextract } : {}),
    runDir: s.runDir,
    logPath: s.logPath
  };
}

/** `3d 4h`, `5h 12m`, `7m`, `42s`. */
export function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
