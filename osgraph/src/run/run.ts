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
}

export interface RunScopeOptions extends RunCommonOptions {
  /** Tabs open at once before the run closes its own staged ones; default 12, minimum 1. */
  maxOpen?: number;
  /** Consecutive open failures that stop the run; default 3, `0` disables. */
  maxConsecutiveFailures?: number;
}

export interface RunModuleRow {
  module: string;
  /** `skipped` = already staged before this run (resume). */
  outcome: "staged" | "skipped" | "open-failed" | "stage-failed";
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
    source: "environment"
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
    await waitForForeground();
    const closed = await options.opener.closeOwned(module);
    if (closed.ok) {
      log(`   close ${module} ok`);
      return { ok: true };
    }
    const error = describeOsopenerFailure(closed.failure);
    log(`   close ${module} FAILED ${error}`);
    return { ok: false, error };
  };

  return {
    log,
    runDir,
    logPath,
    sleep,
    now,
    gapMs: options.gapMs ?? DEFAULT_GAP_MS,
    session,
    waitForForeground,
    openWithRetry,
    onProgress,
    listApps,
    closeAfterDrain
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
  const modules = uniqueModules(scope.modules);
  const reportPath = join(s.runDir, "report.json");
  const snapshotPath = resolveScopeArtifactPaths(graphDir, scope.name).graph;

  const rows: RunModuleRow[] = [];
  const record = (row: RunModuleRow): void => {
    rows.push(row);
    try {
      writeFileSync(reportPath, `${JSON.stringify({ scope: scope.name, rows }, null, 2)}\n`, "utf8");
    } catch {
      /* the report is a convenience */
    }
  };

  const initiallyStaged = stagedNames(graphDir, scope.name);
  const alreadyStaged = modules.filter((m) => initiallyStaged.has(lower(m))).length;
  options.state?.beginRun(scope.name, modules);
  log(`run ${scope.name}: ${modules.length} scope module(s), ${alreadyStaged} already staged, max open ${maxOpen}`);

  let consecutiveOpenFailures = 0;
  let stoppedEarly: string | undefined;
  let finalized: RebuildResult | undefined;
  const stagedThisRun = new Set<string>();

  await s.session.acquire();
  try {
    for (const [i, mod] of modules.entries()) {
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
        if (maxFailures > 0 && consecutiveOpenFailures >= maxFailures) {
          stoppedEarly =
            `${consecutiveOpenFailures} module(s) in a row failed to open (last: ${mod}, ${openFailure.error.code}). ` +
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
    s.session.release();
  }

  const failures = rows.filter((r) => r.outcome === "open-failed" || r.outcome === "stage-failed").length;

  // Resume wedge: every scope module has a stage entry but nothing finalized (a finalize that threw
  // after its entry was written, a kill between the two, or a scope that shrank after staging).
  // Finalize from the stage now, offline, exactly as `stageModule` would have.
  let incomplete: string | undefined;
  if (finalized === undefined && stoppedEarly === undefined && failures === 0) {
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

  if (stoppedEarly !== undefined) {
    options.state?.failRun("RUN_STOPPED", stoppedEarly);
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
    ...(incomplete !== undefined ? { incomplete } : {}),
    failures,
    runDir: s.runDir,
    logPath: s.logPath,
    reportPath
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
    try {
      writeFileSync(reportPath, `${JSON.stringify({ scope: scope.name, rows }, null, 2)}\n`, "utf8");
    } catch {
      /* the report is a convenience */
    }
  };
  options.state?.beginRun(scope.name, candidates);
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
      const decision: { read: boolean; reason: ChangeReason | "requested"; detail: string } = changedMode
        ? decideChange(capture, listed)
        : { read: true, reason: "requested", detail: "named by --modules" };
      log(`${tag} ${decision.reason}: ${decision.detail}`);

      const row: RefreshModulesRow = { module: mod, reason: decision.reason, detail: decision.detail, read: decision.read, openedHere };
      let fatal: unknown;
      if (decision.read) {
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
