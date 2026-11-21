import { z } from "zod";
import { join } from "node:path";
import { assertHelperOk, HelperError, type HelperResult } from "../helper.js";
import { readTrack, writeTrack } from "../track.js";
import type { OpenModuleResult, Step, Track } from "../types.js";
import { ensureStudioReady, timed, withBriefFocus } from "./focusStudio.js";
import { defaultSleep, toOsopenerError, type OsopenerTool, type ToolContext } from "./tool.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 500;
/** OSG-014 §6: a foreground title matching this means a save prompt is up; abort before any keystroke. */
export const UNSAVED_TITLE_RE = /save|unsaved/i;
/** Buttons whose presence in a Studio dialog marks it as a save prompt (audit item 5). */
export const UNSAVED_BUTTON_RE = "(?i)^save|don.?t save";

const openModuleShape = {
  name: z.string().min(1).describe("Module name exactly as Service Studio lists it (e.g. MyApp_Core_BL)."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Overall deadline for the module to appear in listApps (default ${DEFAULT_TIMEOUT_MS}).`),
  focusPolicy: z
    .enum(["brief", "never"])
    .optional()
    .describe(
      "Whether osopener may take the foreground. Everything except typing a name into the CEF 'Open from Environment' " +
        "dialog runs in the background (no cursor, no focus change). 'brief' (default): for that one step Studio takes " +
        "the foreground for about a second and then gives it back. 'never': fail with FOREGROUND_REQUIRED instead."
    ),
  source: z
    .enum(["recent", "environment"])
    .optional()
    .describe(
      "How to open a module that is not open yet. 'recent' (default): click its entry in Studio's recent list when " +
        "there is one (no keyboard), else Open from Environment. 'environment': always go through Open from Environment " +
        "(name typed into the CEF dialog; needs a brief focus). Only an environment open makes servicestudio listApps " +
        "report the module's real server version; a recent-list open reports version '0'."
    ),
  cancelSavePrompt: z
    .boolean()
    .optional()
    .describe(
      "Opt-in for OSGraph run: on UNSAVED_CHANGES_DIALOG, cancel exactly one confirmed Save dialog using its " +
        "Cancel button and retry this module once. Never Save, Don't Save, Discard, or close a modified tab. " +
        "Unknown dialogs and failed cancellation remain errors. Default false."
    )
};
const openModuleInput = z.object(openModuleShape);

/** SendKeys syntax: brace every special character so a module name is typed literally. */
export function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}[\]])/g, "{$1}");
}

/** Pure check used by step 4 (and tested without a desktop). */
export function isUnsavedDialogTitle(title: string | undefined): boolean {
  return typeof title === "string" && UNSAVED_TITLE_RE.test(title);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function err(code: HelperError["code"], message: string, details?: unknown): HelperError {
  return new HelperError(code, message, details);
}

/**
 * Live 2026-10-30: Avalonia consumes the **first** `_` of a `MenuItem` header as its access-key mnemonic, so the
 * recent-modules entry for `MOD_EX_Demo_Portal_CW` is exposed to UI Automation as `MODEX_Demo_Portal_CW@<environment>`.
 * Matching a module name against a menu item must therefore make that first underscore optional and tolerate the
 * `@<environment>` suffix. See `.scratch/osgraph/live-evidence.md` §S3 and docs/uia-dump-2026-10-30-toggled.txt.
 */
export function mnemonicNameRegex(name: string): string {
  const escaped = escapeRegex(name);
  const relaxed = escaped.replace("_", "_?");
  return `^${relaxed}(@[^@]+)?$`;
}

/** The dropdown entry that opens the environment module browser (live-discovered). */
export const OPEN_FROM_ENVIRONMENT_RE = "^Open from Environment";

export interface DialogStrategy {
  kind: "uia" | "ctrl-o";
  label: string;
  name?: string;
  automationId?: string;
  controlType?: string;
}

/**
 * Audit item 2: a replayed track may only drive controls on this allow-list. Anything else (a tampered or stale
 * track pointing at, say, a Close button) is ignored with a "track rejected" step.
 */
export function isAllowedTrackStrategy(openDialog: Track["openDialog"] | undefined): boolean {
  if (!openDialog) return false;
  if (openDialog.strategy === "ctrl-o") return !openDialog.name && !openDialog.automationId && !openDialog.controlType;
  return (
    openDialog.strategy === "uia" &&
    openDialog.automationId === "^Toggle$" &&
    openDialog.controlType === "Button" &&
    openDialog.name === undefined
  );
}

/**
 * Strategy order for reaching the open-module UI (OSG-014 §proposed 3-4, S9 brief step 5):
 * recorded track → UIA /open/i → live-discovered shell ToggleButton (`AutomationId=Toggle`, the control beside the
 * module tab in this Studio build; see docs/uia-dump-2026-10-30.txt) → Ctrl+O.
 */
export function dialogStrategies(track: Track | undefined): DialogStrategy[] {
  const list: DialogStrategy[] = [];
  if (track && isAllowedTrackStrategy(track.openDialog)) {
    // A recorded Ctrl+O is NOT promoted to the front (2026-11-20): it needs the foreground, and one run that fell
    // back to it must not make every later open steal focus. It stays where it always is — last.
    if (track.openDialog.strategy === "uia") {
      list.push({ kind: "uia", label: "track", automationId: track.openDialog.automationId, controlType: track.openDialog.controlType });
    }
  }
  // Tightened 2026-10-30 against the live tree: the previous `(?i)^open( module)?\b|open module` name pattern also
  // matches Studio's big blue **"Open in browser"** button (`^open` + a word boundary), and `(?i)open` matches any
  // AutomationId merely containing "open". As the first strategies tried, they could have launched a web browser
  // instead of the module picker. Both are now anchored to the control we actually want.
  list.push({ kind: "uia", label: "uia:'Open Module' name", name: "(?i)^open module\\b" });
  list.push({ kind: "uia", label: "uia:open automationId", automationId: "(?i)^open(module)?$" });
  list.push({ kind: "uia", label: "uia:Toggle (shell dropdown beside module tab)", automationId: "^Toggle$", controlType: "Button" });
  list.push({ kind: "ctrl-o", label: "ctrl-o" });
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = JSON.stringify({ ...s, label: undefined });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Foreground {
  title: string;
  hwnd: number;
  isStudio: boolean;
}

/**
 * The topmost Studio dialog window, else the main window (helper `studio-dialog`). Found by enumerating Studio's own
 * windows, so it does not depend on — or change — which window the user has in the foreground (2026-11-20).
 */
async function foregroundTitle(ctx: ToolContext): Promise<Foreground> {
  const r = assertHelperOk(await ctx.helper.run("studio-dialog"), "studio-dialog");
  return { title: String(r.title ?? ""), hwnd: Number(r.hwnd ?? 0), isStudio: r.isStudio === true };
}

/** `uia-find` count under `hwnd`; 0 on any failure. */
async function uiaCount(ctx: ToolContext, args: Record<string, string | number>): Promise<number> {
  try {
    const r = await ctx.helper.run("uia-find", { Depth: 12, ...args });
    return r.ok && typeof r.count === "number" ? r.count : 0;
  } catch {
    return 0;
  }
}

/**
 * Live 2026-10-30: clicking `Open from Environment...` first raises a **transient `Progress` window** while Studio
 * fetches the environment's module list, and only then the real dialog. Taking the first non-main window as "the
 * dialog" captured that `Progress` hwnd, which was already destroyed by the time anything was typed into it —
 * `AutomationElement.FromHandle` then threw `Unrecognized error` and `openModule` died with `HELPER_FAILED`.
 */
export const TRANSIENT_DIALOG_TITLE_RE = /^progress\b|^\s*$/i;

/** Polls the foreground until a Studio dialog that is not a transient progress window is up. */
async function waitForDialog(
  ctx: ToolContext,
  mainHwnd: number | undefined,
  deadline: number,
  sleep: (ms: number) => Promise<void>
): Promise<Foreground | undefined> {
  let last: Foreground | undefined;
  while (Date.now() < deadline) {
    const fg = await foregroundTitle(ctx);
    if (isUnsavedDialogTitle(fg.title)) {
      throw err("UNSAVED_CHANGES_DIALOG", `a save prompt appeared ('${fg.title}'); aborting`, { foregroundTitle: fg.title });
    }
    if (isStudioDialog(fg, mainHwnd) && !TRANSIENT_DIALOG_TITLE_RE.test(fg.title)) {
      // Require the same window twice: a dialog that is about to be replaced is never acted on.
      if (last && last.hwnd === fg.hwnd) return fg;
      last = fg;
    } else {
      last = undefined;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

/**
 * OSG-014 §8(d), answered live on 2026-10-30: `listApps` lists a module **before** Studio has finished loading it, and
 * while it loads a `Progress` window owns the foreground. Back-to-back `openModule` calls therefore tripped the
 * unknown-dialog guard (`UNSAVED_CHANGES_DIALOG`) or typed into a window that was about to be destroyed. Both ends of
 * a call now wait for Studio to go idle: no transient window in the foreground.
 */
async function waitForStudioIdle(
  ctx: ToolContext,
  mainHwnd: number | undefined,
  deadline: number,
  sleep: (ms: number) => Promise<void>
): Promise<Foreground> {
  let fg = await foregroundTitle(ctx);
  while (Date.now() < deadline && isStudioDialog(fg, mainHwnd) && TRANSIENT_DIALOG_TITLE_RE.test(fg.title)) {
    await sleep(POLL_INTERVAL_MS);
    fg = await foregroundTitle(ctx);
  }
  return fg;
}

/** Done-detection (OSG-014 §6): only `listApps` counts. Shared by the recent-entry and the dialog path. */
async function pollForModule(
  ctx: ToolContext,
  name: string,
  deadline: number,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  while (Date.now() < deadline) {
    const modules = await ctx.client.listOpenModules();
    if (modules.includes(name)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** A Studio-owned foreground window that is not the main window = a popup/dialog (audit items 4, 5). */
function isStudioDialog(fg: Foreground, mainHwnd: number | undefined): boolean {
  return fg.isStudio && fg.hwnd !== 0 && fg.hwnd !== (mainHwnd ?? 0);
}

/**
 * Step 4 (OSG-014 §6 + audit item 5): abort when a save prompt is in the foreground. Three signals: the title regex,
 * any non-main Studio window already in front before we opened anything, or a Save / Don't save button under it.
 */
async function assertNoUnsavedDialog(
  ctx: ToolContext,
  steps: Step[],
  mainHwnd: number | undefined,
  deadline: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  // Wait out a `Progress` window first: it is Studio loading the module the previous call opened, not an unknown
  // dialog, and aborting on it made every back-to-back open fail (live 2026-10-30).
  const fg = await timed(
    steps,
    "foreground-title",
    () => waitForStudioIdle(ctx, mainHwnd, Math.min(deadline, Date.now() + 60_000), sleep),
    (r) => r.title
  );
  let reason: string | undefined;
  if (isUnsavedDialogTitle(fg.title)) reason = `foreground title '${fg.title}' matches /save|unsaved/i`;
  else if (isStudioDialog(fg, mainHwnd)) {
    const saveButtons = await uiaCount(ctx, { Name: UNSAVED_BUTTON_RE, ControlType: "Button", Hwnd: fg.hwnd });
    reason =
      saveButtons > 0
        ? `a Studio dialog ('${fg.title}') with a Save / Don't save button is in the foreground`
        : `a non-main Studio window ('${fg.title}') is already in the foreground; refusing to drive an unknown dialog`;
  }
  if (reason) {
    steps.push({ step: "unsaved-check", ok: false, ms: 0, detail: reason });
    throw err("UNSAVED_CHANGES_DIALOG", `${reason}; aborting without touching it`, { foregroundTitle: fg.title, foregroundHwnd: fg.hwnd });
  }
  steps.push({ step: "unsaved-check", ok: true, ms: 0 });
}

export const openModule: OsopenerTool<typeof openModuleShape> = {
  name: "openModule",
  description:
    "Open a named OutSystems 11 module in the running Service Studio. Returns alreadyOpen=true with no UI action when " +
    "servicestudio listApps already lists it; otherwise launches Studio if needed and drives the open-module UI in the " +
    "BACKGROUND (UI Automation patterns and posted clicks: the user's cursor never moves and their window keeps the " +
    "foreground), and polls listApps until the module appears or timeoutMs elapses. A module in Studio's recent list " +
    "opens with no keyboard at all; any other needs its name typed into a CEF dialog, which takes the foreground for " +
    "about a second (focusPolicy 'brief', default) or fails FOREGROUND_REQUIRED (focusPolicy 'never'). " +
    "source 'environment' skips the recent list and always uses Open from Environment, so listApps reports the " +
    "module's real server version (a recent-list open reports '0'). " +
    "Never closes Studio or discards changes. By default a Save prompt fails with UNSAVED_CHANGES_DIALOG; " +
    "cancelSavePrompt=true allows one verified Cancel-only recovery and one retry, without saving or discarding edits.",
  inputSchema: openModuleShape,
  async handler(rawArgs, ctx): Promise<OpenModuleResult> {
    const t0 = Date.now();
    const steps: Step[] = [];
    const sleep = ctx.sleep ?? defaultSleep;
    let studioLaunched = false;
    let screenshotPath: string | undefined;

    const parsed = openModuleInput.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        opened: false,
        alreadyOpen: false,
        studioLaunched,
        durationMs: 0,
        steps,
        error: { code: "HELPER_FAILED", message: `invalid arguments: ${parsed.error.message}` }
      };
    }
    const { name } = parsed.data;
    const focusPolicy = parsed.data.focusPolicy ?? "brief";
    const source = parsed.data.source ?? "recent";
    const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = t0 + timeoutMs;
    const sendKeys = async (keys: string, step: string): Promise<void> => {
      assertHelperOk(await ctx.helper.run("send-keys", { Keys: keys }), step);
    };
    /** True once a dropdown or dialog we opened is on screen; drives the single cleanup Esc on failure. */
    let uiOpen = false;
    /** The user's window, captured the first time this call takes the foreground; given back when the call ends. */
    const focusState: { userHwnd?: number } = {};
    const brief = <T>(hwnd: number, fn: () => Promise<T>) => withBriefFocus(ctx, steps, hwnd, fn, focusState);
    /**
     * Live 2026-11-20: once osopener has typed into Studio, Windows lets Studio re-activate itself when the module
     * finishes loading — seconds after the brief focus ended. So the call ends by handing the foreground back once
     * more, but only if a Studio window holds it (never pulling the user out of another app they switched to).
     */
    const giveBackForeground = async () => {
      if (!focusState.userHwnd) return;
      try {
        await timed(steps, "return-foreground", () => ctx.helper.run("refocus", { Hwnd: focusState.userHwnd!, IfStudio: true }), (r) =>
          r.restored === true ? `foreground returned to hwnd ${focusState.userHwnd}` : String(r.reason ?? "left as is")
        );
      } catch {
        /* best effort */
      }
    };
    /** Hwnd of the dialog we opened, when it is a window (the dropdown menu lives inside the main window). */
    let openDialogHwnd: number | undefined;
    // Dismissed without a keystroke: WindowPattern.Close on our dialog, or a posted click on the dropdown's Toggle.
    const escapeDialog = (label: string) => {
      uiOpen = false;
      const args: Record<string, number> = openDialogHwnd ? { Hwnd: openDialogHwnd } : {};
      return timed(steps, label, () => ctx.helper.run("dismiss", args), (r) => (r.ok ? String(r.method ?? "dismissed") : String(r.error?.code)));
    };

    const settle = (ss: Step[], mainHwnd: number | undefined, dl: number, sl: (ms: number) => Promise<void>) =>
      timed(ss, "settle", () => waitForStudioIdle(ctx, mainHwnd, Math.min(dl, Date.now() + 60_000), sl), (r) => r.title);

    try {
      // (1) Source of truth first: no UI touch when already open.
      const open = await timed(steps, "listApps", () => ctx.client.listOpenModules(), (m) => `${m.length} open`);
      if (open.includes(name)) {
        return { opened: true, alreadyOpen: true, studioLaunched, durationMs: Date.now() - t0, steps };
      }
      steps.push({
        step: "source",
        ok: true,
        ms: 0,
        detail: source === "environment" ? "environment: recent list not consulted" : "recent: recent-list entry first, else Open from Environment"
      });

      // (2)+(3) Process only — no foreground (2026-11-20): the user keeps their window, keyboard and cursor.
      const studio = await ensureStudioReady(ctx, steps, Math.max(10_000, deadline - Date.now()));
      // Remember whose window has the foreground now: Studio re-activates itself for a moment when a module finishes
      // loading (live 2026-11-21), and the call ends by handing the foreground back (only from a Studio window).
      try {
        const r = await ctx.helper.run("foreground-title");
        if (r.ok && r.isStudio !== true && typeof r.hwnd === "number" && r.hwnd !== 0) focusState.userHwnd = r.hwnd;
      } catch {
        /* best effort */
      }
      studioLaunched = studio.studioLaunched;
      const version = studio.studioVersion;
      const mainHwnd = studio.hwnd;

      // (4) Never type into a save prompt or an unknown dialog.
      await assertNoUnsavedDialog(ctx, steps, mainHwnd, deadline, sleep);

      // (5a) Reach the open-module UI.
      let track = version ? await readTrack(ctx.config.dataDir, version) : undefined;
      if (track && !isAllowedTrackStrategy(track.openDialog)) {
        steps.push({ step: "track", ok: false, ms: 0, detail: `track rejected: tracks/${version}.json openDialog is not on the allow-list` });
        track = undefined;
      } else if (track) {
        steps.push({ step: "track", ok: true, ms: 0, detail: `replaying tracks/${version}.json` });
      }
      let used: DialogStrategy | undefined;
      let dialog: Foreground | undefined;
      let viaMenu = false;
      for (const strategy of dialogStrategies(track)) {
        if (Date.now() > deadline) break;
        // Ctrl+O is a keystroke: it needs the foreground, so it is only tried when a brief focus is allowed.
        if (strategy.kind === "ctrl-o" && focusPolicy === "never") continue;
        const result = await timed(
          steps,
          `open-dialog:${strategy.label}`,
          async (): Promise<Foreground | "menu" | undefined> => {
            if (strategy.kind === "uia") {
              const args: Record<string, string | number | boolean> = { Depth: 10 };
              if (strategy.name) args.Name = strategy.name;
              if (strategy.automationId) args.AutomationId = strategy.automationId;
              if (strategy.controlType) args.ControlType = strategy.controlType;
              // Live 2026-11-20: the shell Toggle's TogglePattern flips its state without opening the dropdown while
              // Studio is in the background; a posted click opens it every time.
              if (strategy.automationId === "^Toggle$") args.Post = true;
              const r = await ctx.helper.run("uia-click", args);
              if (!r.ok) {
                // Audit item 6: a save prompt seen by the helper is the tool's error, never a reason to try the next strategy.
                if (r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-click");
                return undefined;
              }
            } else {
              await brief(mainHwnd ?? 0, () => sendKeys("^o", "send-keys ctrl+o"));
            }
            await sleep(track?.timings.afterOpenDialogMs ?? 800);
            const fg = await foregroundTitle(ctx);
            if (isUnsavedDialogTitle(fg.title)) {
              throw err("UNSAVED_CHANGES_DIALOG", `a save prompt appeared ('${fg.title}'); aborting`, { foregroundTitle: fg.title });
            }
            // Audit item 4: a Studio-owned non-main foreground window counts as "dialog open"...
            if (isStudioDialog(fg, mainHwnd)) {
              // ...but never a transient `Progress` window (see TRANSIENT_DIALOG_TITLE_RE).
              if (!TRANSIENT_DIALOG_TITLE_RE.test(fg.title)) return fg;
              return await waitForDialog(ctx, mainHwnd, Math.min(deadline, Date.now() + 60_000), sleep);
            }
            // ...and so does an in-window dropdown. Live 2026-10-30: the shell `Toggle` control opens a UIA
            // `ContextMenu` *inside* the main window (hwnd 0), never a top-level window, so requiring a new window
            // here made every strategy look failed and openModule always returned UIA_ELEMENT_NOT_FOUND.
            if ((await uiaCount(ctx, { ControlType: "MenuItem" })) > 0) return "menu";
            if (strategy.kind === "ctrl-o") await escapeDialog("dismiss-after-ctrl-o");
            return undefined;
          },
          (r) => (r === "menu" ? "dropdown menu opened" : r ? `dialog '${r.title}' hwnd ${r.hwnd}` : "no dialog")
        );
        if (result === "menu") {
          used = strategy;
          viaMenu = true;
          uiOpen = true;
          break;
        }
        if (result) {
          used = strategy;
          dialog = result;
          uiOpen = true;
          break;
        }
      }
      if (!used) {
        throw err(
          "UIA_ELEMENT_NOT_FOUND",
          "could not reach the open-module UI: no UIA control matched and Ctrl+O produced no Studio dialog window"
        );
      }

      // (5a-ii) The dropdown is a menu, not the module browser. Two ways on from here (live 2026-10-30):
      //   - a recent-modules entry `<Module>@<environment>` opens the module directly (no typing, no browser);
      //   - otherwise `Open from Environment...` opens the real dialog window.
      // source 'environment' never looks at the recent list: only an environment open makes listApps report the
      // module's real server version (live 2026-11-21: a recent-list open reports version "0").
      if (viaMenu) {
        const mruRe = mnemonicNameRegex(name);
        const mruHit = source === "recent" && (await uiaCount(ctx, { Name: mruRe, ControlType: "MenuItem" })) > 0;
        if (mruHit) {
          const clicked = await timed(
            steps,
            "menu:recent-module",
            async () => {
              // Avalonia MenuItems expose no Invoke pattern: a posted click, never the real mouse.
              const r = await ctx.helper.run("uia-click", { Name: mruRe, ControlType: "MenuItem", Depth: 12, Post: true });
              if (!r.ok && r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-click");
              return r.ok;
            },
            (ok) => (ok ? "clicked recent entry" : "recent entry click failed")
          );
          if (clicked) {
            const appearedFromMru = await timed(
              steps,
              "poll-listApps:recent",
              () => pollForModule(ctx, name, deadline, sleep),
              (r) => (r ? "module listed" : "timeout")
            );
            if (appearedFromMru) {
              await settle(steps, mainHwnd, deadline, sleep);
              await giveBackForeground();
              return { opened: true, alreadyOpen: false, studioLaunched, durationMs: Date.now() - t0, steps };
            }
          }
          // Fall through to the environment browser; the menu may already be gone, so re-open it below.
          steps.push({ step: "menu:recent-module", ok: false, ms: 0, detail: "recent entry did not open the module; using Open from Environment" });
          if ((await uiaCount(ctx, { ControlType: "MenuItem" })) === 0) {
            assertHelperOk(await ctx.helper.run("uia-click", { AutomationId: "^Toggle$", ControlType: "Button", Depth: 10, Post: true }), "uia-click");
            await sleep(track?.timings.afterOpenDialogMs ?? 800);
          }
        }
        dialog = await timed(
          steps,
          "menu:open-from-environment",
          async (): Promise<Foreground> => {
            // Live 2026-11-21: the item can be missing for a moment right after the dropdown opens (or the popup can
            // close under us). Retry a few times, re-opening the dropdown when it is gone.
            let clickedOfe: HelperResult | undefined;
            for (let attempt = 0; attempt < 4; attempt++) {
              clickedOfe = await ctx.helper.run("uia-click", { Name: OPEN_FROM_ENVIRONMENT_RE, ControlType: "MenuItem", Depth: 12, Post: true });
              if (clickedOfe.ok || clickedOfe.error?.code !== "UIA_ELEMENT_NOT_FOUND") break;
              await sleep(700);
              if ((await uiaCount(ctx, { ControlType: "MenuItem" })) === 0) {
                await ctx.helper.run("uia-click", { AutomationId: "^Toggle$", ControlType: "Button", Depth: 10, Post: true });
                await sleep(track?.timings.afterOpenDialogMs ?? 800);
              }
            }
            assertHelperOk(clickedOfe!, "uia-click");
            await sleep(track?.timings.afterOpenDialogMs ?? 800);
            const fg = await waitForDialog(ctx, mainHwnd, Math.min(deadline, Date.now() + 60_000), sleep);
            if (!fg) {
              throw err(
                "UIA_ELEMENT_NOT_FOUND",
                "'Open from Environment' did not produce a settled Studio dialog window (only a transient Progress window was seen)"
              );
            }
            return fg;
          },
          (r) => `dialog '${r.title}' hwnd ${r.hwnd}`
        );
      }
      if (!dialog) {
        throw err("UIA_ELEMENT_NOT_FOUND", "could not reach the open-module dialog");
      }
      const dlg: Foreground = dialog;
      uiOpen = true;
      openDialogHwnd = dlg.hwnd;

      /**
       * Runs `fn` — a keystroke into the dialog — with the dialog briefly in the foreground, or refuses under
       * focusPolicy "never" (closing the dialog first so Studio is left usable).
       */
      const withKeyboard = async <T>(why: string, fn: () => Promise<T>): Promise<T> => {
        if (focusPolicy === "never") {
          await escapeDialog("dismiss-dialog");
          throw err(
            "FOREGROUND_REQUIRED",
            `${why} needs the keyboard, and focusPolicy is 'never'. Open the module once by hand (it then appears in ` +
              "Studio's recent list, which osopener opens in the background) or call again with focusPolicy 'brief'."
          );
        }
        return brief(dlg.hwnd, fn);
      };

      // (5b) Enter the module name: UIA Edit under the dialog first (no focus needed), typing second.
      let searchStrategy: Track["search"]["strategy"] = "type";
      let searchId: string | undefined;
      const nameRe = `^${escapeRegex(name)}$`;
      const viaUia = await timed(
        steps,
        "enter-name",
        async (): Promise<string | undefined> => {
          const r: HelperResult = await ctx.helper.run("uia-settext", { Text: name, First: true, ControlType: "Edit", Depth: 12, Hwnd: dlg.hwnd });
          if (r.ok) {
            searchStrategy = "uia-edit";
            searchId = (r.element as { automationId?: string } | undefined)?.automationId;
            return `uia ${String(r.method)}`;
          }
          if (r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-settext");
          return undefined;
        },
        (d) => d ?? "no UIA Edit: the name must be typed"
      );

      // (5c) Audit item 1: when the dialog exposes a UIA list, an absent match is MODULE_NOT_FOUND. A UIA-blind
      // (CEF-rendered) dialog exposes nothing, so only OPEN_TIMEOUT is reachable there.
      if (viaUia) await sleep(track?.timings.afterTypeMs ?? 700);
      const listExposed = (await uiaCount(ctx, { ControlType: "List", Hwnd: dlg.hwnd })) > 0 ||
        (await uiaCount(ctx, { ControlType: "ListItem", Hwnd: dlg.hwnd })) > 0 ||
        (await uiaCount(ctx, { ControlType: "DataGrid", Hwnd: dlg.hwnd })) > 0;
      const matches = listExposed && viaUia ? await uiaCount(ctx, { Name: nameRe, Hwnd: dlg.hwnd }) : 0;
      steps.push({
        step: "result-list",
        ok: true,
        ms: 0,
        detail: listExposed ? `UIA list exposed, ${matches} item(s) named '${name}'` : "dialog is UIA-blind (no list exposed)"
      });
      if (viaUia && listExposed && matches === 0) {
        await escapeDialog("dismiss-dialog");
        throw err("MODULE_NOT_FOUND", `no item named '${name}' in the open-module dialog; dialog closed, Studio left usable`);
      }

      // (5d) Select the match and confirm. Selecting is a UIA pattern; the confirming Enter (and, for a CEF dialog,
      // the typed name) is the only keyboard input osopener still sends — inside one brief focus window.
      await timed(
        steps,
        "select-match",
        async () => {
          if (!viaUia) {
            if (focusPolicy === "never") await withKeyboard("typing the module name into the CEF 'Open from Environment' dialog", async () => undefined);
            // One helper call: take the foreground, type the name, wait for the list to filter, press Enter, give the
            // foreground back. The guard inside refuses to type if the user's window wins the race.
            const r = await ctx.helper.run(
              "send-keys",
              { Keys: escapeSendKeys(name), Then: "{ENTER}", ThenDelayMs: track?.timings.afterTypeMs ?? 700, TakeFocus: true, Hwnd: dlg.hwnd },
              30_000
            );
            if (!r.ok && r.error?.code === "STUDIO_NOT_FOREGROUND") {
              throw err(
                "FOREGROUND_REQUIRED",
                "Windows would not keep Service Studio in the foreground long enough to type (you are probably actively using another window). " +
                  "Nothing was typed into it. Stop clicking for a few seconds and retry, or open this module by hand once so it is in the recent list."
              );
            }
            assertHelperOk(r, "send-keys name");
            if (typeof r.previous === "number" && r.previous && !focusState.userHwnd) focusState.userHwnd = r.previous;
            steps.push({ step: "typed-in-one-call", ok: true, ms: 0, detail: r.returned === true ? "foreground returned to your window" : "foreground not returned" });
            return "typed + enter";
          }
          if (matches > 0) {
            const r = await ctx.helper.run("uia-click", { Name: nameRe, Depth: 12, Hwnd: dlg.hwnd });
            if (!r.ok && r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-click");
            if (r.ok) {
              await sleep(200);
              await withKeyboard("confirming the selected module", () => sendKeys("{ENTER}", "send-keys enter"));
              return `uia ${String(r.method)} + enter`;
            }
          }
          await withKeyboard("confirming the open-module dialog", () => sendKeys("{ENTER}", "send-keys enter"));
          return "enter";
        },
        (d) => d
      );

      // (6) Done-detection: only listApps counts.
      const tEnter = Date.now();
      const appeared = await timed(
        steps,
        "poll-listApps",
        () => pollForModule(ctx, name, deadline, sleep),
        (r) => (r ? "module listed" : "timeout")
      );
      if (!appeared) {
        screenshotPath = await captureScreenshot(ctx, steps, dlg.hwnd);
        // Leave Studio usable: close a still-open dialog through UIA; never Alt+F4, never a keystroke.
        await escapeDialog("dismiss-dialog");
        const blind = listExposed
          ? ""
          : " The open-module dialog is UIA-blind (CEF web view), so osopener cannot tell an unknown module name from a slow load: an unknown name also ends here, never as MODULE_NOT_FOUND.";
        throw err("OPEN_TIMEOUT", `module '${name}' did not appear in listApps within ${timeoutMs} ms.${blind}`, { screenshotPath, listExposed });
      }

      // (6b) OSG-014 §8(d): listApps answers before Studio has finished loading, so settle before returning —
      // otherwise the caller's next openModule starts while a `Progress` window owns the foreground.
      await settle(steps, mainHwnd, deadline, sleep);
      await giveBackForeground();

      // (7) Record / refresh the track (only when the Studio version is known: never tracks/unknown.json).
      const durationMs = Date.now() - t0;
      if (version) {
        const newTrack: Track = {
          studioVersion: version,
          exePath: studio.exePath,
          recordedAt: new Date().toISOString(),
          openDialog:
            used.kind === "uia"
              ? { strategy: "uia", automationId: used.automationId, controlType: used.controlType }
              : { strategy: "ctrl-o" },
          search: { strategy: searchStrategy, automationId: searchId },
          timings: {
            afterFocusMs: track?.timings.afterFocusMs ?? 300,
            afterOpenDialogMs: track?.timings.afterOpenDialogMs ?? 800,
            afterTypeMs: track?.timings.afterTypeMs ?? 700,
            listAppsAppearMs: Date.now() - tEnter
          },
          lastDurationMs: durationMs
        };
        if (isAllowedTrackStrategy(newTrack.openDialog)) {
          await timed(steps, "write-track", () => writeTrack(ctx.config.dataDir, newTrack), (p) => p);
        } else {
          steps.push({ step: "write-track", ok: false, ms: 0, detail: `strategy '${used.label}' is not replayable; track not written` });
        }
      } else {
        steps.push({ step: "write-track", ok: false, ms: 0, detail: "Studio file version unknown; track not written" });
      }
      return { opened: true, alreadyOpen: false, studioLaunched, durationMs, steps };
    } catch (e) {
      const failure = toOsopenerError(e);
      let cancelFailure: string | undefined;
      // OSGraph full runs may explicitly opt into Cancel-only recovery. A generic/unknown Studio modal was also
      // classified as UNSAVED_CHANGES_DIALOG, so the helper must independently confirm a real Save dialog.
      // The retry disables this flag: a recurring prompt stops, never loops or guesses a destructive button.
      if (failure.code === "UNSAVED_CHANGES_DIALOG" && parsed.data.cancelSavePrompt === true) {
        try {
          const startCancel = Date.now();
          const cancelled = await ctx.helper.run("cancel-save-prompt");
          steps.push({
            step: "cancel-save-prompt",
            ok: cancelled.ok === true,
            ms: Date.now() - startCancel,
            detail: cancelled.ok ? String(cancelled.method ?? "Cancel invoked") : String(cancelled.error?.message ?? "could not confirm Cancel")
          });
          if (cancelled.ok) {
            // If this call opened its own dropdown or module dialog before the prompt appeared, clear that UI too.
            // The standard dismiss still refuses to touch a new Save dialog.
            if (uiOpen) {
              const cleaned = await escapeDialog("dismiss-own-ui-after-cancel");
              if (!cleaned.ok) {
                cancelFailure = String(cleaned.error?.message ?? "could not clean up the previously opened UI");
              }
            }
            if (cancelFailure === undefined) {
              await giveBackForeground();
              const retried = (await openModule.handler({ ...parsed.data, cancelSavePrompt: false }, ctx)) as OpenModuleResult;
              return {
                ...retried,
                studioLaunched: studioLaunched || retried.studioLaunched,
                durationMs: Date.now() - t0,
                steps: [...steps, ...retried.steps]
              };
            }
          } else {
            cancelFailure = String(cancelled.error?.message ?? "the save prompt was not verified or did not close");
          }
        } catch (cancelErr) {
          cancelFailure = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
        }
      }
      const reportedFailure =
        cancelFailure === undefined ? failure : { ...failure, message: `${failure.message}; safe Cancel recovery failed: ${cancelFailure}` };
      // Leave Studio usable: close a dropdown/dialog we opened. Never on UNSAVED_CHANGES_DIALOG — that prompt is the
      // user's to answer, and OSG-014 §6 requires leaving it untouched.
      if (uiOpen && failure.code !== "UNSAVED_CHANGES_DIALOG") {
        try {
          await escapeDialog("dismiss-on-failure");
        } catch {
          /* best effort only */
        }
      }
      await giveBackForeground();
      return {
        opened: false,
        alreadyOpen: false,
        studioLaunched,
        durationMs: Date.now() - t0,
        steps,
        ...(screenshotPath ? { screenshotPath } : {}),
        error: reportedFailure
      };
    }
  }
};

async function captureScreenshot(ctx: ToolContext, steps: Step[], hwnd?: number): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(ctx.config.dataDir, "screenshots", `${stamp}.png`);
  try {
    const r = await timed(steps, "screenshot", () => ctx.helper.run("screenshot", hwnd ? { Out: out, Hwnd: hwnd } : { Out: out }), (r) => String(r.path ?? out));
    return r.ok ? String(r.path ?? out) : undefined;
  } catch {
    return undefined;
  }
}
