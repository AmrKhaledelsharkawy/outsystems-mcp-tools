/**
 * The one place osgraph loads osopener.
 *
 * osgraph is not standalone: `rebuild` reads only modules that are open in Service Studio, Studio
 * has no API to open one, and osopener is the only thing that can. osopener in turn needs the
 * human-approved session token the token manager keeps in `token.txt`. This adapter is where that
 * hard dependency becomes code, and every osgraph caller that opens or closes a module tab — the
 * discovery job today, the Studio worker later — goes through it.
 *
 * What it guarantees, and why each point exists:
 *
 *  1. **Load failures say what failed.** osopener absent at the configured location, a failed
 *     dynamic import, and osopener rejecting its own configuration are three different fixes for a
 *     human, so they are three different `cause`s, each with an actionable message — never one
 *     shared `null`.
 *  2. **Open failures keep osopener's whole error**: its code, its message, its `details`, the step
 *     that failed, and a classification (`foreground | studio-busy | open-dialog | other`) a retry loop can act
 *     on. A real 287-module run lost hours because a driver logged only the code and read
 *     "Studio produced only a transient Progress window" as "a dialog is stuck open".
 *  3. **Close propagates osopener's actual result.** osopener refuses to close a module with
 *     unsaved changes (and cancels any save prompt); that refusal reaches the caller as a failure,
 *     never as a success.
 *  4. **It records which modules this process opened**, so a caller can close only its own tabs
 *     and never one the user already had open. One adapter is loaded per process, so "this adapter
 *     instance" and "this process" are the same thing.
 *
 * Nothing under `osopener/` is imported at compile time: the path is only known at runtime, so the
 * shapes below mirror osopener's exported result types structurally.
 *
 * Callers must still `await reader.drain()` before closing a tab whose module has reads pending —
 * closing under queued reads is the one reproducible Service Studio failure (ADR-0013). The
 * adapter cannot see the reader, so that ordering stays the caller's job.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* -------------------------------------------------------------------------------------------- */
/* Load                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** Why osopener could not be loaded. */
export type OsopenerLoadCause =
  /** Nothing usable at the configured location: the directory or one of its entry files is missing. */
  | "absent"
  /** The files are there but a dynamic import threw, or did not export what osgraph needs. */
  | "import-failed"
  /** osopener loaded, then refused its own configuration (e.g. `CONFIG_MISSING`). */
  | "config-rejected";

export interface OsopenerLoadFailure {
  cause: OsopenerLoadCause;
  /** The osopener `dist` directory that was tried. */
  dist: string;
  /** One actionable line: what failed and what to do about it. */
  message: string;
  /** osopener's own error code, when it gave one (config rejection). */
  code?: string;
  /** The underlying error text, when there was one. */
  detail?: string;
}

export type OsopenerLoadResult = { ok: true; adapter: OsopenerAdapter } | { ok: false; failure: OsopenerLoadFailure };

/** The osopener files the adapter imports, relative to its `dist`. */
export const OSOPENER_ENTRY_FILES = [
  "config.js",
  "servicestudio.js",
  "helper.js",
  "tools/openModule.js",
  "tools/closeModule.js"
] as const;

/** Open timeout handed to osopener. Measured live: a cold open is 14-20 s; 75 s leaves room for a slow Studio. */
export const OPEN_TIMEOUT_MS = 75_000;

export interface LoadOsopenerOptions {
  /** Environment osopener reads its configuration from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable for tests: how a file URL is imported. Defaults to dynamic `import()`. */
  importModule?: (url: string) => Promise<unknown>;
  /** Injectable for tests: does a path exist. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Results                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a failed open means for whoever retries it:
 *  - `foreground`  : another window owns the foreground (`STUDIO_NOT_FOREGROUND`); wait for Studio and retry.
 *  - `studio-busy` : "Open from Environment" never produced a settled dialog, only Studio's
 *                    transient Progress window. Nothing is stuck open, so there is nothing to
 *                    dismiss; Studio has to finish (or be fixed) first.
 *  - `open-dialog` : any other failure naming the open dialog; it may genuinely be stuck open.
 *  - `other`       : not transient; give up on this module. This includes `UNSAVED_CHANGES_DIALOG`:
 *                    a save prompt only a human can clear, so retrying against it is pointless.
 */
export type OpenFailureKind = "foreground" | "studio-busy" | "open-dialog" | "other";

/** One osopener step, as it reports it. */
export interface OsopenerStep {
  step: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

/** A failed open or close, with nothing of osopener's report thrown away. */
export interface OsopenerFailure {
  /** osopener's error code (`UIA_ELEMENT_NOT_FOUND`, `UNSAVED_CHANGES_DIALOG`, …), or `HANDLER_THREW` / `NO_RESULT` when it gave none. */
  code: string;
  /** osopener's full error message, untruncated. */
  message: string;
  /** osopener's `error.details`, verbatim (e.g. `foregroundTitle`, or the `labels` it saw), when it gave any. */
  details?: unknown;
  /** The last step osopener marked as failed, if any. */
  failedStep?: { step: string; detail?: string };
  /** Every step osopener recorded. */
  steps: OsopenerStep[];
  /** Classification of `message`; meaningful for opens, `other` is the safe default for closes. */
  kind: OpenFailureKind;
  durationMs?: number;
  screenshotPath?: string;
}

export type OpenOutcome =
  | {
      ok: true;
      /** True when osopener found it already open and did nothing — this process does NOT own it. */
      alreadyOpen: boolean;
      /** True when this call opened the tab, i.e. it is now recorded as this process's own. */
      openedHere: boolean;
      durationMs?: number;
    }
  | { ok: false; failure: OsopenerFailure };

export type CloseOutcome =
  | {
      ok: true;
      /** True when the module was not open, so osopener did nothing. */
      alreadyClosed: boolean;
      durationMs?: number;
    }
  | { ok: false; failure: OsopenerFailure };

/**
 * How osopener opens a module that is not open yet (its `openModule` `source` input). `recent` (osopener's
 * default) clicks the recent-list entry when there is one; `environment` always uses Open from Environment.
 * Only an environment open makes Service Studio's listing report the module's real server version: a
 * recent-list open reports version "0".
 */
export type OpenSource = "recent" | "environment";

export interface OpenOptions {
  /** Omitted: osopener's own default (`recent`). */
  source?: OpenSource;
}

export interface OsopenerAdapter {
  /** The `dist` directory this adapter was loaded from. */
  readonly dist: string;
  /** Opens a module. Never throws: osopener's failure — or a thrown handler — comes back as `ok: false`. */
  open(module: string, options?: OpenOptions): Promise<OpenOutcome>;
  /**
   * Closes a module, reporting osopener's actual result: a refusal (unsaved changes, cancelled
   * save prompt, close not confirmed) is `ok: false`. Never throws. Closes regardless of ownership;
   * use `closeOwned` to close only what this process opened.
   */
  close(module: string): Promise<CloseOutcome>;
  /** Closes the module only if this process opened it; otherwise refuses without touching Studio (`NOT_OWNED`). */
  closeOwned(module: string): Promise<CloseOutcome>;
  /** True when this process opened the module and has not closed it since. */
  owns(module: string): boolean;
  /** Modules this process opened and has not yet closed, in the order they were opened. */
  ownedModules(): string[];
  /**
   * Read-mostly probes of Studio's UI (foreground, the open dialog, a screenshot), for a caller that
   * retries opens (#48 `osgraph run`). Absent when the adapter was built without osopener's helper.
   */
  readonly ui?: StudioUi;
}

/** What osopener's foreground probe reports. */
export interface StudioForeground {
  /** True when Service Studio's process owns the foreground window. */
  isStudio: boolean;
  /** Title of the foreground window, whoever owns it. */
  title: string;
}

/**
 * The few UI probes a retrying open loop needs, over osopener's UI helper. Each one is a single
 * helper step; none of them opens or closes a module. `dismissOpenDialog` is the only one that sends
 * input, it is scoped to the "Open from Environment" dialog by name, and it does NOT report whether
 * it worked: the caller must check `openDialogPresent()` before and after, so a "dismissed" log line
 * is never written for a dialog that was never up.
 */
export interface StudioUi {
  foreground(): Promise<StudioForeground>;
  /** Asks Studio to take the foreground. The next `foreground()` is the verdict, not this call. */
  focus(): Promise<void>;
  /** True when an "Open from Environment" window is up right now. */
  openDialogPresent(): Promise<boolean>;
  /** Clicks into the "Open from Environment" dialog, then sends Esc. Never touches a save prompt. */
  dismissOpenDialog(): Promise<void>;
  /** Captures the screen to `outPath`; resolves the written path, or null when no capture was taken. */
  screenshot(outPath: string): Promise<string | null>;
}

/** The title osopener's open step drives; the only dialog `dismissOpenDialog` may touch. */
export const OPEN_DIALOG_TITLE = "Open from Environment";

/** osopener's helper, structurally (`osopener/src/helper.ts` `HelperRunner`). */
export interface OsopenerHelper {
  run(command: string, args?: Record<string, string | number | boolean>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Thrown by the helper-backed UI when osopener's helper resolves `{ ok: false, error }` instead of throwing. */
export class StudioUiError extends Error {
  readonly code: string;
  readonly command: string;
  constructor(command: string, code: string, message: string) {
    super(`helper ${command} failed: ${code}: ${message}`);
    this.name = "StudioUiError";
    this.code = code;
    this.command = command;
  }
}

/**
 * Runs one helper command and throws when the helper reports failure. osopener's helper RESOLVES
 * `{ ok: false, error }` for most failures (Studio not found, UIA errors, not foreground, a save
 * prompt), so a probe that ignored `ok` would read a failed dump as "no dialog" and log a recovery
 * that never happened.
 */
async function runChecked(
  helper: OsopenerHelper,
  command: string,
  args?: Record<string, string | number | boolean>
): Promise<Record<string, unknown>> {
  const r = await helper.run(command, args);
  if (r["ok"] === false) {
    const error = (r["error"] ?? {}) as { code?: unknown; message?: unknown };
    throw new StudioUiError(
      command,
      typeof error.code === "string" && error.code.length > 0 ? error.code : "HELPER_FAILED",
      typeof error.message === "string" && error.message.length > 0 ? error.message : "helper reported ok:false"
    );
  }
  return r;
}

/**
 * Builds the UI probes over osopener's helper. Exported so the mapping is testable without Studio.
 * Every probe except `screenshot` throws `StudioUiError` on a helper `ok: false`; callers
 * (`dismissOpenDialogHonestly`, the foreground gate) already treat a throw as "not observed".
 */
export function createHelperStudioUi(helper: OsopenerHelper, sleep: (ms: number) => Promise<void> = defaultSleep): StudioUi {
  // UNVERIFIED LIVE (#48): osopener treats this dialog as its own foreground window, while this probe
  // searches a depth-2 dump rooted at Studio's main window. Whether the dialog appears in that tree
  // on the installed build is checked only by the human-attended live run; if it does not, this
  // always answers false and recovery reports `absent`.
  const present = async (): Promise<boolean> => {
    const dump = await runChecked(helper, "uia-dump", { Depth: 2 });
    return JSON.stringify(dump["nodes"] ?? []).includes(OPEN_DIALOG_TITLE);
  };
  return {
    async foreground() {
      const r = await runChecked(helper, "foreground-title");
      return { isStudio: r["isStudio"] === true, title: String(r["title"] ?? "") };
    },
    async focus() {
      await runChecked(helper, "focus");
    },
    openDialogPresent: present,
    async dismissOpenDialog() {
      // The dialog's content is a webview: Esc only lands once the dialog itself has been clicked.
      // A refused click throws here, so no Esc goes to whatever window does have focus.
      await runChecked(helper, "uia-click", { Name: `^${OPEN_DIALOG_TITLE}$`, Depth: 3 });
      await sleep(400);
      await runChecked(helper, "send-keys", { Keys: "{ESC}" });
      await sleep(1200);
    },
    async screenshot(outPath) {
      const r = await helper.run("screenshot", { Out: outPath });
      if (r["ok"] === false) return null;
      return typeof r["path"] === "string" ? r["path"] : outPath;
    }
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------------------------- */
/* Failure helpers                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Sorts an osopener failure into what a retry loop can do about it: by osopener's error code
 * first, and only when the code does not decide it, by the message.
 */
export function classifyOpenFailure(message: string | undefined, code?: string): OpenFailureKind {
  // A save prompt needs a human; its message also says "refusing to send input", so the code wins.
  if (code === "UNSAVED_CHANGES_DIALOG") return "other";
  if (code === "STUDIO_NOT_FOREGROUND") return "foreground";
  const text = message ?? "";
  if (/foreground window belongs to pid/i.test(text)) return "foreground";
  if (/did not produce a settled studio dialog|transient progress window/i.test(text)) return "studio-busy";
  if (/open from environment/i.test(text)) return "open-dialog";
  return "other";
}

/** One log-safe line for a failure: code, kind, message and the step that failed. */
export function describeOsopenerFailure(failure: OsopenerFailure): string {
  const message = failure.message.replace(/\s+/g, " ").trim();
  const step = failure.failedStep
    ? ` [step ${failure.failedStep.step}${failure.failedStep.detail ? `: ${failure.failedStep.detail.replace(/\s+/g, " ")}` : ""}]`
    : "";
  return `${failure.code} (${failure.kind}): ${message}${step}`;
}

/**
 * An `Error` carrying the structured failure, for callers whose contract is to throw. The full
 * failure stays on `.failure`; `maxMessageLength` only bounds the `message` text, for callers that
 * store it somewhere size matters.
 */
export class OsopenerOperationError extends Error {
  readonly failure: OsopenerFailure;
  constructor(prefix: string, failure: OsopenerFailure, maxMessageLength?: number) {
    const full = `${prefix}: ${describeOsopenerFailure(failure)}`;
    super(maxMessageLength !== undefined && full.length > maxMessageLength ? `${full.slice(0, maxMessageLength - 1)}…` : full);
    this.name = "OsopenerOperationError";
    this.failure = failure;
  }
}

/** Raw result shape shared by osopener's `openModule` and `closeModule` handlers. */
interface RawToolResult {
  opened?: boolean;
  alreadyOpen?: boolean;
  closed?: boolean;
  alreadyClosed?: boolean;
  durationMs?: number;
  steps?: unknown;
  screenshotPath?: string;
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function toSteps(raw: unknown): OsopenerStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((s) => ({
      step: String(s["step"] ?? "?"),
      ok: s["ok"] === true,
      ...(typeof s["ms"] === "number" ? { ms: s["ms"] } : {}),
      ...(s["detail"] !== undefined ? { detail: String(s["detail"]) } : {})
    }));
}

/** Builds the failure from an osopener result that did not succeed. */
export function failureFromResult(result: unknown): OsopenerFailure {
  if (result === null || typeof result !== "object") {
    return { code: "NO_RESULT", message: `osopener returned no result object (${String(result)})`, steps: [], kind: "other" };
  }
  const raw = result as RawToolResult;
  const steps = toSteps(raw.steps);
  const message =
    typeof raw.error?.message === "string" && raw.error.message.length > 0
      ? raw.error.message
      : "osopener reported failure without an error message";
  const failed = [...steps].reverse().find((s) => !s.ok);
  const code = typeof raw.error?.code === "string" && raw.error.code.length > 0 ? raw.error.code : "UNKNOWN";
  return {
    code,
    message,
    ...(raw.error?.details !== undefined ? { details: raw.error.details } : {}),
    ...(failed ? { failedStep: { step: failed.step, ...(failed.detail !== undefined ? { detail: failed.detail } : {}) } } : {}),
    steps,
    kind: classifyOpenFailure(message, code),
    ...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {}),
    ...(typeof raw.screenshotPath === "string" ? { screenshotPath: raw.screenshotPath } : {})
  };
}

function thrownFailure(err: unknown): OsopenerFailure {
  const message = err instanceof Error ? err.message : String(err);
  return { code: "HANDLER_THREW", message, steps: [], kind: classifyOpenFailure(message) };
}

/* -------------------------------------------------------------------------------------------- */
/* The adapter                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** The two osopener tool handlers, plus the context they run with. */
export interface OsopenerTools {
  open(input: Record<string, unknown>): Promise<unknown>;
  close(input: Record<string, unknown>): Promise<unknown>;
}

/** Wraps osopener's raw tool handlers. Exported so the result handling is testable on its own. */
export function createOsopenerAdapter(tools: OsopenerTools, dist: string, ui?: StudioUi): OsopenerAdapter {
  // Exact names, as osopener matches them (it compares against listApps verbatim).
  const owned = new Set<string>();

  const close = async (module: string): Promise<CloseOutcome> => {
    let result: unknown;
    try {
      result = await tools.close({ name: module });
    } catch (err) {
      return { ok: false, failure: thrownFailure(err) };
    }
    const raw = (result ?? {}) as RawToolResult;
    if (raw.closed === true && raw.error === undefined) {
      owned.delete(module);
      return {
        ok: true,
        alreadyClosed: raw.alreadyClosed === true,
        ...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {})
      };
    }
    // A refused close leaves the tab open — and still ours, if we opened it.
    const failure = failureFromResult(result);
    return { ok: false, failure: { ...failure, kind: "other" } };
  };

  return {
    dist,
    ...(ui !== undefined ? { ui } : {}),
    async open(module, options) {
      let result: unknown;
      try {
        result = await tools.open({
          name: module,
          timeoutMs: OPEN_TIMEOUT_MS,
          ...(options?.source !== undefined ? { source: options.source } : {})
        });
      } catch (err) {
        return { ok: false, failure: thrownFailure(err) };
      }
      const raw = (result ?? {}) as RawToolResult;
      if (raw.opened !== true || raw.error !== undefined) {
        return { ok: false, failure: failureFromResult(result) };
      }
      const alreadyOpen = raw.alreadyOpen === true;
      if (!alreadyOpen) owned.add(module);
      return {
        ok: true,
        alreadyOpen,
        openedHere: !alreadyOpen,
        ...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {})
      };
    },
    close,
    async closeOwned(module) {
      if (!owned.has(module)) {
        return {
          ok: false,
          failure: {
            code: "NOT_OWNED",
            message: `'${module}' was not opened by this process; refusing to close a tab someone else opened`,
            steps: [],
            kind: "other"
          }
        };
      }
      return close(module);
    },
    owns: (module) => owned.has(module),
    ownedModules: () => [...owned]
  };
}

interface OsopenerToolModule {
  handler(input: Record<string, unknown>, ctx: unknown): Promise<unknown>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads osopener from its built `dist` directory. Never throws: every failure comes back as a
 * typed `OsopenerLoadFailure` whose `cause` says which of the three things went wrong.
 */
export async function loadOsopenerAdapter(dist: string, options: LoadOsopenerOptions = {}): Promise<OsopenerLoadResult> {
  const env = options.env ?? process.env;
  const importModule = options.importModule ?? ((url: string) => import(url) as Promise<unknown>);
  const exists = options.exists ?? existsSync;
  const fail = (failure: Omit<OsopenerLoadFailure, "dist">): OsopenerLoadResult => ({
    ok: false,
    failure: { ...failure, dist }
  });

  // 1. Absent.
  if (dist.trim() === "") {
    return fail({
      cause: "absent",
      message: "no osopener location is configured. Set OSGRAPH_OSOPENER_DIST to a built osopener's dist directory."
    });
  }
  if (!exists(dist)) {
    return fail({
      cause: "absent",
      message: `osopener is not installed at ${dist}. Build it (npm ci && npm run build in the osopener package) or point OSGRAPH_OSOPENER_DIST at its dist directory.`
    });
  }
  const missing = OSOPENER_ENTRY_FILES.filter((file) => !exists(join(dist, file)));
  if (missing.length > 0) {
    return fail({
      cause: "absent",
      message: `${dist} is not a complete osopener build (missing ${missing.join(", ")}). Rebuild osopener (npm run build in the osopener package).`
    });
  }

  // 2. Import. Untyped by nature: this crosses a package boundary at a path only known at runtime.
  const url = (file: string): string => pathToFileURL(join(dist, file)).href;
  let config: { loadConfig(env: Record<string, string | undefined>, options: { packageRoot: string }): Record<string, unknown> };
  let studio: { HttpServiceStudioClient: new (options: { url: unknown; tokenFile: unknown }) => unknown };
  let helperMod: { PowerShellHelper: new (options: { powershellExe: unknown; scriptPath: unknown }) => unknown };
  let openTool: OsopenerToolModule;
  let closeTool: OsopenerToolModule;
  try {
    const [c, s, h, o, x] = await Promise.all(OSOPENER_ENTRY_FILES.map((file) => importModule(url(file))));
    config = c as typeof config;
    studio = s as typeof studio;
    helperMod = h as typeof helperMod;
    openTool = (o as { openModule?: OsopenerToolModule }).openModule as OsopenerToolModule;
    closeTool = (x as { closeModule?: OsopenerToolModule }).closeModule as OsopenerToolModule;
  } catch (err) {
    return fail({
      cause: "import-failed",
      message: `osopener at ${dist} could not be imported: ${errorText(err)}. Rebuild osopener; a partial or mismatched build is the usual cause.`,
      detail: errorText(err)
    });
  }
  const shapeProblems = [
    typeof config?.loadConfig === "function" ? null : "config.js: loadConfig",
    typeof studio?.HttpServiceStudioClient === "function" ? null : "servicestudio.js: HttpServiceStudioClient",
    typeof helperMod?.PowerShellHelper === "function" ? null : "helper.js: PowerShellHelper",
    typeof openTool?.handler === "function" ? null : "tools/openModule.js: openModule.handler",
    typeof closeTool?.handler === "function" ? null : "tools/closeModule.js: closeModule.handler"
  ].filter((p): p is string => p !== null);
  if (shapeProblems.length > 0) {
    return fail({
      cause: "import-failed",
      message: `osopener at ${dist} imported but does not export what osgraph needs (${shapeProblems.join("; ")}). The osopener build does not match this osgraph; rebuild both from one checkout.`
    });
  }

  // 3. Configuration.
  let cfg: Record<string, unknown>;
  try {
    cfg = config.loadConfig(env, { packageRoot: join(dist, "..") });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return fail({
      cause: "config-rejected",
      message: `osopener rejected its configuration: ${errorText(err)}`,
      ...(typeof code === "string" ? { code } : {}),
      detail: errorText(err)
    });
  }

  let ctx: { config: Record<string, unknown>; client: unknown; helper: unknown };
  try {
    ctx = {
      config: cfg,
      client: new studio.HttpServiceStudioClient({ url: cfg["serviceStudioUrl"], tokenFile: cfg["tokenFile"] }),
      helper: new helperMod.PowerShellHelper({ powershellExe: cfg["powershellExe"], scriptPath: cfg["helperScript"] })
    };
  } catch (err) {
    return fail({
      cause: "config-rejected",
      message: `osopener could not start with its configuration: ${errorText(err)}`,
      detail: errorText(err)
    });
  }

  return {
    ok: true,
    adapter: createOsopenerAdapter(
      {
        open: (input) => openTool.handler(input, ctx),
        close: (input) => closeTool.handler(input, ctx)
      },
      dist,
      createHelperStudioUi(ctx.helper as OsopenerHelper)
    )
  };
}

/** One line for a log or a banner. */
export function describeLoadFailure(failure: OsopenerLoadFailure): string {
  return `osopener unavailable (${failure.cause}): ${failure.message}`;
}
