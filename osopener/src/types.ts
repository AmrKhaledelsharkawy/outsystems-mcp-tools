/**
 * Shared types for the osopener MCP tools (OSG-014 "Resolution (2026-10-30)").
 */

/** Error codes a tool response may carry (OSG-014 §4, §5, §6 + S9 brief). */
export type OsopenerErrorCode =
  | "CONFIG_MISSING"
  | "TOKEN_EXPIRED"
  | "SERVICESTUDIO_UNREACHABLE"
  | "STUDIO_NOT_FOUND"
  | "MODULE_NOT_FOUND"
  | "UIA_ELEMENT_NOT_FOUND"
  | "UNSAVED_CHANGES_DIALOG"
  | "OPEN_TIMEOUT"
  | "HELPER_FAILED";

export interface OsopenerError {
  code: OsopenerErrorCode;
  message: string;
  details?: unknown;
}

/** One logged UI/automation step (OSG-014 §6: every UI step is recorded). */
export interface Step {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface FocusStudioResult {
  running: boolean;
  studioLaunched: boolean;
  foreground: boolean;
  pid?: number;
  studioVersion?: string;
  exePath?: string;
  durationMs: number;
  steps: Step[];
  error?: OsopenerError;
}

export interface ListOpenModulesResult {
  modules: string[];
  /**
   * One row per module tab, across every Studio window. Present when the UI could be read; the
   * caller uses it to decide what is safe to close (OSG-014 close policy, 2026-10-30: osopener
   * enforces the safety gate, the caller chooses the victim).
   */
  tabs?: ModuleTab[];
  error?: OsopenerError;
}

/** A module tab as Service Studio labels it: `<Module> (<Application>)`. */
export interface ModuleTab {
  module: string;
  /** The application the module belongs to; absent when the label has no `(...)` part. */
  application?: string;
  label: string;
  /** Which top-level Studio window holds it — past ~30 modules Studio uses several. */
  windowHwnd: number;
  offscreen: boolean;
}

export interface CloseModuleResult {
  closed: boolean;
  alreadyClosed: boolean;
  durationMs: number;
  steps: Step[];
  error?: OsopenerError;
}

export interface OpenModuleResult {
  opened: boolean;
  alreadyOpen: boolean;
  studioLaunched: boolean;
  durationMs: number;
  steps: Step[];
  screenshotPath?: string;
  error?: OsopenerError;
}

/** Recorded replay track for one Studio file version (OSG-014 §7). */
export interface Track {
  studioVersion: string;
  exePath?: string;
  recordedAt: string;
  /** How the open-module UI was reached on the last successful run. */
  openDialog: {
    strategy: "uia" | "ctrl-o";
    name?: string;
    automationId?: string;
    controlType?: string;
  };
  /** How the module name was entered. */
  search: {
    strategy: "uia-edit" | "type";
    automationId?: string;
    name?: string;
  };
  /** Wait timings (ms) that worked. */
  timings: {
    afterFocusMs: number;
    afterOpenDialogMs: number;
    afterTypeMs: number;
    /** Wall time from Enter to the module appearing in listApps. */
    listAppsAppearMs: number;
  };
  lastDurationMs: number;
}
