/**
 * The open loop `osgraph run` drives osopener through (#48).
 *
 * osopener opens one module with real keystrokes; a large scope is hundreds of those, hours apart,
 * on a desktop a human may be using. Each guard below exists because a real 287-module run lost
 * hours without it:
 *
 *  - **Foreground gate.** osopener refuses to send input unless Service Studio owns the foreground.
 *    A browser brought to the front used to fail every open in under two seconds; waiting (with a
 *    periodic line naming the window in front) is strictly better than skipping, because a skipped
 *    module costs a whole second pass.
 *  - **Retry by failure kind** (the classification is the #6 adapter's): `foreground` waits and
 *    retries; `studio-busy` (only a transient Progress window, no dialog) waits for Studio to go idle;
 *    `open-dialog` closes the dialog — only after confirming it is up; `other` is not retried.
 *  - **Honest recovery.** "dismissed" is logged only when the dialog was present before and absent
 *    after. A run once logged it ~270 times for a dialog that had never appeared.
 *  - **Full diagnostics.** Every failed attempt logs code, kind, message and the failed step; giving
 *    up keeps that real error (never a generic one) and saves a screenshot.
 *
 * Nothing here closes a module; the run loop owns closes, because only it can drain the reader first.
 */
import { join } from "node:path";
import {
  describeOsopenerFailure,
  type OsopenerAdapter,
  type OsopenerFailure,
  type OpenSource,
  type StudioUi
} from "../osopener/adapter.js";

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface OpenLoopOptions {
  /** Attempts per module before giving up; default 4. */
  attempts?: number;
  /** Foreground gate: checks before giving up (default 240) and the gap between them (default 15 s). */
  foregroundTries?: number;
  foregroundGapMs?: number;
  /** Gap after a `foreground` failure before the next attempt; default 5 s. */
  foregroundRetryMs?: number;
  /** Longest wait for a busy Studio to go idle (default 5 min) and the poll gap (default 5 s). */
  idleMaxMs?: number;
  idleGapMs?: number;
  /** Gap after an `open-dialog` recovery; default 1.5 s. */
  dialogRetryMs?: number;
  /** Where a give-up screenshot goes; undefined takes none. */
  screenshotDir?: string;
  sleep?: Sleep;
  /** Clock for the screenshot file name; default `new Date()`. */
  now?: () => Date;
  /** osopener's `source` for every open; omitted = osopener's default (`recent`). */
  source?: OpenSource;
  /** Opt into the safe Cancel-only Save-dialog recovery for OSGraph runs. */
  cancelSavePrompt?: boolean;
}

/** Outcome of the honest dismiss: what was actually observed, never what was hoped. */
export type DismissOutcome = "absent" | "dismissed" | "still-up" | "error" | "unavailable";

export type OpenAttemptResult =
  | { ok: true; openedHere: boolean; alreadyOpen: boolean; attempts: number }
  | {
      ok: false;
      /** The last real osopener failure (or `FOREGROUND_TIMEOUT` when no attempt could even start). */
      failure: OsopenerFailure;
      attempts: number;
      screenshotPath?: string;
    };

const FOREGROUND_WARN_EVERY_MS = 60_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Waits until Service Studio owns the foreground, asking it to come forward on every check. True
 * once it does; false after `tries` checks. With no UI probes it answers true at once: the open
 * itself is then the only verdict.
 */
export function makeForegroundGate(
  ui: StudioUi | undefined,
  log: (line: string) => void,
  options: Pick<OpenLoopOptions, "foregroundTries" | "foregroundGapMs" | "sleep"> = {}
): () => Promise<boolean> {
  const tries = options.foregroundTries ?? 240;
  const gapMs = options.foregroundGapMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  const warnEvery = Math.max(1, Math.ceil(FOREGROUND_WARN_EVERY_MS / Math.max(1, gapMs)));

  const studioHasForeground = async (): Promise<boolean> => {
    try {
      return (await ui!.foreground()).isStudio;
    } catch {
      return false;
    }
  };

  return async () => {
    if (ui === undefined) return true;
    for (let i = 0; i < tries; i++) {
      try {
        await ui.focus();
      } catch {
        /* the check below is the real verdict */
      }
      if (await studioHasForeground()) {
        if (i > 0) log(`   foreground regained after ${Math.round((i * gapMs) / 1000)}s`);
        return true;
      }
      if (i % warnEvery === 0) {
        let who = "";
        try {
          who = ` (held by '${(await ui.foreground()).title.slice(0, 60)}')`;
        } catch {
          /* the title is a courtesy */
        }
        log(
          `   WAITING for Service Studio to be the foreground window${who} - leave Studio in front, ` +
            `or minimise what is over it`
        );
      }
      await sleep(gapMs);
    }
    log(`   Service Studio did not regain the foreground after ${Math.round((tries * gapMs) / 1000)}s`);
    return false;
  };
}

/**
 * Closes a stuck "Open from Environment" dialog, and reports only what it saw: the dialog is checked
 * FIRST (`absent` when it was never up — nothing is logged as dismissed), then after (`dismissed`
 * only when it is gone, `still-up` when it is not).
 */
export async function dismissOpenDialogHonestly(ui: StudioUi | undefined, log: (line: string) => void): Promise<DismissOutcome> {
  if (ui === undefined) {
    log("   recovery: no UI probes available - cannot check for an open dialog");
    return "unavailable";
  }
  try {
    if (!(await ui.openDialogPresent())) {
      log("   recovery: no Open from Environment dialog is up - nothing to dismiss");
      return "absent";
    }
    await ui.dismissOpenDialog();
    const gone = !(await ui.openDialogPresent());
    log(`   recovery: Open from Environment dialog ${gone ? "dismissed" : "STILL UP"}`);
    return gone ? "dismissed" : "still-up";
  } catch (err) {
    log(`   recovery: failed to dismiss the dialog - ${errText(err)}`);
    return "error";
  }
}

/**
 * Waits while a transient Studio window (a Progress window, or an untitled one) owns the foreground.
 * True once Studio is idle, false after `idleMaxMs`. A failed probe counts as idle: the next open
 * attempt is the real verdict.
 */
export async function waitForStudioIdle(
  ui: StudioUi | undefined,
  log: (line: string) => void,
  options: Pick<OpenLoopOptions, "idleMaxMs" | "idleGapMs" | "sleep"> = {}
): Promise<boolean> {
  if (ui === undefined) return true;
  const maxMs = options.idleMaxMs ?? 300_000;
  const gapMs = options.idleGapMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;
  let waited = 0;
  for (;;) {
    let title: string;
    try {
      title = (await ui.foreground()).title;
    } catch {
      return true;
    }
    if (!/^progress\b|^\s*$/i.test(title)) {
      if (waited > 0) log(`   Studio idle again after ${Math.round(waited / 1000)}s`);
      return true;
    }
    if (waited >= maxMs) {
      log(`   Studio still busy ('${title.trim() === "" ? "<untitled>" : title}') after ${Math.round(maxMs / 1000)}s`);
      return false;
    }
    await sleep(gapMs);
    waited += gapMs;
  }
}

/** A file-name-safe screenshot path under `dir`. */
export function screenshotPathFor(dir: string, module: string, at: Date): string {
  return join(dir, `${at.toISOString().replace(/[:.]/g, "-")}-${module.replace(/[^\w.-]/g, "_")}.png`);
}

/**
 * Builds `openWithRetry(module)`. Never throws: every outcome, including giving up, comes back as a
 * value carrying osopener's real failure.
 */
export function makeOpenWithRetry(
  opener: OsopenerAdapter,
  log: (line: string) => void,
  waitForForeground: () => Promise<boolean>,
  options: OpenLoopOptions = {}
): (module: string) => Promise<OpenAttemptResult> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const ui = opener.ui;

  return async (module) => {
    let last: OsopenerFailure | undefined;
    let made = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!(await waitForForeground())) {
        last = {
          code: "FOREGROUND_TIMEOUT",
          message: "Service Studio never regained the foreground, so no open could be attempted",
          steps: [],
          kind: "foreground"
        };
        break;
      }
      made = attempt;
      const openOptions = {
        ...(options.source !== undefined ? { source: options.source } : {}),
        ...(options.cancelSavePrompt === true ? { cancelSavePrompt: true } : {})
      };
      const outcome = Object.keys(openOptions).length > 0 ? await opener.open(module, openOptions) : await opener.open(module);
      if (outcome.ok) return { ok: true, openedHere: outcome.openedHere, alreadyOpen: outcome.alreadyOpen, attempts: attempt };
      last = outcome.failure;
      log(`   open ${module} attempt ${attempt}/${attempts} FAILED ${describeOsopenerFailure(last)}`);
      if (last.kind === "other" || attempt === attempts) break;
      if (last.kind === "foreground") {
        await sleep(options.foregroundRetryMs ?? 5_000);
      } else if (last.kind === "studio-busy") {
        // A dialog may still have come up late; close it only if it is really there.
        await dismissOpenDialogHonestly(ui, log);
        await waitForStudioIdle(ui, log, options);
      } else {
        await dismissOpenDialogHonestly(ui, log);
        await sleep(options.dialogRetryMs ?? 1_500);
      }
    }

    const failure = last as OsopenerFailure;
    let screenshotPath: string | undefined;
    if (options.screenshotDir !== undefined && ui !== undefined) {
      try {
        const taken = await ui.screenshot(screenshotPathFor(options.screenshotDir, module, now()));
        if (taken !== null) screenshotPath = taken;
      } catch (err) {
        log(`   screenshot failed: ${errText(err)}`);
      }
    }
    log(`   GAVE UP on ${module} after ${made} attempt(s): ${describeOsopenerFailure(failure)}`);
    if (screenshotPath !== undefined) log(`   screenshot: ${screenshotPath}`);
    return { ok: false, failure, attempts: made, ...(screenshotPath !== undefined ? { screenshotPath } : {}) };
  };
}
