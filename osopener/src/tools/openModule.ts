import { z } from "zod";
import { join } from "node:path";
import { assertHelperOk, HelperError, type HelperResult } from "../helper.js";
import { readTrack, writeTrack } from "../track.js";
import type { OpenModuleResult, Step, Track } from "../types.js";
import { ensureStudioForeground, timed } from "./focusStudio.js";
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
    .describe(`Overall deadline for the module to appear in listApps (default ${DEFAULT_TIMEOUT_MS}).`)
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
    if (track.openDialog.strategy === "uia") {
      list.push({ kind: "uia", label: "track", automationId: track.openDialog.automationId, controlType: track.openDialog.controlType });
    } else {
      list.push({ kind: "ctrl-o", label: "track" });
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

async function foregroundTitle(ctx: ToolContext): Promise<Foreground> {
  const r = assertHelperOk(await ctx.helper.run("foreground-title"), "foreground-title");
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
    "servicestudio listApps already lists it; otherwise launches/focuses Studio, drives the open-module UI " +
    "(UI Automation first, keyboard second), and polls listApps until the module appears or timeoutMs elapses. " +
    "Never closes Studio or discards changes; aborts with UNSAVED_CHANGES_DIALOG when a save prompt is up.",
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
    const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = t0 + timeoutMs;
    const sendKeys = async (keys: string, step: string): Promise<void> => {
      assertHelperOk(await ctx.helper.run("send-keys", { Keys: keys }), step);
    };
    /** True once a dropdown or dialog we opened is on screen; drives the single cleanup Esc on failure. */
    let uiOpen = false;
    const escapeDialog = (label: string) => {
      uiOpen = false;
      return timed(steps, label, () => ctx.helper.run("send-keys", { Keys: "{ESC}" }), (r) => (r.ok ? "esc sent" : String(r.error?.code)));
    };

    const settle = (ss: Step[], mainHwnd: number | undefined, dl: number, sl: (ms: number) => Promise<void>) =>
      timed(ss, "settle", () => waitForStudioIdle(ctx, mainHwnd, Math.min(dl, Date.now() + 60_000), sl), (r) => r.title);

    try {
      // (1) Source of truth first: no UI touch when already open.
      const open = await timed(steps, "listApps", () => ctx.client.listOpenModules(), (m) => `${m.length} open`);
      if (open.includes(name)) {
        return { opened: true, alreadyOpen: true, studioLaunched, durationMs: Date.now() - t0, steps };
      }

      // (2)+(3) Process + foreground.
      const studio = await ensureStudioForeground(ctx, steps, Math.max(10_000, deadline - Date.now()));
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
        const result = await timed(
          steps,
          `open-dialog:${strategy.label}`,
          async (): Promise<Foreground | "menu" | undefined> => {
            if (strategy.kind === "uia") {
              const args: Record<string, string | number> = { Depth: 10 };
              if (strategy.name) args.Name = strategy.name;
              if (strategy.automationId) args.AutomationId = strategy.automationId;
              if (strategy.controlType) args.ControlType = strategy.controlType;
              const r = await ctx.helper.run("uia-click", args);
              if (!r.ok) {
                // Audit item 6: a save prompt seen by the helper is the tool's error, never a reason to try the next strategy.
                if (r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-click");
                return undefined;
              }
            } else {
              await sendKeys("^o", "send-keys ctrl+o");
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
      if (viaMenu) {
        const mruRe = mnemonicNameRegex(name);
        const mruHit = (await uiaCount(ctx, { Name: mruRe, ControlType: "MenuItem" })) > 0;
        if (mruHit) {
          const clicked = await timed(
            steps,
            "menu:recent-module",
            async () => {
              const r = await ctx.helper.run("uia-click", { Name: mruRe, ControlType: "MenuItem", Depth: 12 });
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
              return { opened: true, alreadyOpen: false, studioLaunched, durationMs: Date.now() - t0, steps };
            }
          }
          // Fall through to the environment browser; the menu may already be gone, so re-open it below.
          steps.push({ step: "menu:recent-module", ok: false, ms: 0, detail: "recent entry did not open the module; using Open from Environment" });
          if ((await uiaCount(ctx, { ControlType: "MenuItem" })) === 0) {
            assertHelperOk(await ctx.helper.run("uia-click", { AutomationId: "^Toggle$", ControlType: "Button", Depth: 10 }), "uia-click");
            await sleep(track?.timings.afterOpenDialogMs ?? 800);
          }
        }
        dialog = await timed(
          steps,
          "menu:open-from-environment",
          async (): Promise<Foreground> => {
            assertHelperOk(
              await ctx.helper.run("uia-click", { Name: OPEN_FROM_ENVIRONMENT_RE, ControlType: "MenuItem", Depth: 12 }),
              "uia-click"
            );
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

      // (5b) Enter the module name: UIA Edit under the dialog first, raw typing second.
      let searchStrategy: Track["search"]["strategy"] = "type";
      let searchId: string | undefined;
      await timed(
        steps,
        "enter-name",
        async () => {
          const r: HelperResult = await ctx.helper.run("uia-settext", { Text: name, First: true, ControlType: "Edit", Depth: 12, Hwnd: dlg.hwnd });
          if (r.ok) {
            searchStrategy = "uia-edit";
            searchId = (r.element as { automationId?: string } | undefined)?.automationId;
            return `uia ${String(r.method)}`;
          }
          if (r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-settext");
          await sendKeys(escapeSendKeys(name), "send-keys name");
          return "typed";
        },
        (d) => d
      );
      await sleep(track?.timings.afterTypeMs ?? 700);

      // (5c) Audit item 1: when the dialog exposes a UIA list, an absent match is MODULE_NOT_FOUND. A UIA-blind
      // (CEF-rendered) dialog exposes nothing, so only OPEN_TIMEOUT is reachable there.
      const nameRe = `^${escapeRegex(name)}$`;
      const listExposed = (await uiaCount(ctx, { ControlType: "List", Hwnd: dlg.hwnd })) > 0 ||
        (await uiaCount(ctx, { ControlType: "ListItem", Hwnd: dlg.hwnd })) > 0 ||
        (await uiaCount(ctx, { ControlType: "DataGrid", Hwnd: dlg.hwnd })) > 0;
      const matches = listExposed ? await uiaCount(ctx, { Name: nameRe, Hwnd: dlg.hwnd }) : 0;
      steps.push({
        step: "result-list",
        ok: true,
        ms: 0,
        detail: listExposed ? `UIA list exposed, ${matches} item(s) named '${name}'` : "dialog is UIA-blind (no list exposed)"
      });
      if (listExposed && matches === 0) {
        await escapeDialog("dismiss-dialog");
        throw err("MODULE_NOT_FOUND", `no item named '${name}' in the open-module dialog; dialog closed, Studio left usable`);
      }

      // (5d) Select the match: UIA item named exactly `name` + Enter, else Enter.
      await timed(
        steps,
        "select-match",
        async () => {
          if (matches > 0) {
            const r = await ctx.helper.run("uia-click", { Name: nameRe, Depth: 12, Hwnd: dlg.hwnd });
            if (!r.ok && r.error?.code === "UNSAVED_CHANGES_DIALOG") assertHelperOk(r, "uia-click");
            if (r.ok) {
              await sleep(200);
              await sendKeys("{ENTER}", "send-keys enter");
              return `uia ${String(r.method)} + enter`;
            }
          }
          await sendKeys("{ENTER}", "send-keys enter");
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
        screenshotPath = await captureScreenshot(ctx, steps);
        // Leave Studio usable: one Esc closes a still-open dialog; never Alt+F4, never a Close button.
        await escapeDialog("dismiss-dialog");
        const blind = listExposed
          ? ""
          : " The open-module dialog is UIA-blind (CEF web view), so osopener cannot tell an unknown module name from a slow load: an unknown name also ends here, never as MODULE_NOT_FOUND.";
        throw err("OPEN_TIMEOUT", `module '${name}' did not appear in listApps within ${timeoutMs} ms.${blind}`, { screenshotPath, listExposed });
      }

      // (6b) OSG-014 §8(d): listApps answers before Studio has finished loading, so settle before returning —
      // otherwise the caller's next openModule starts while a `Progress` window owns the foreground.
      await settle(steps, mainHwnd, deadline, sleep);

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
      // Leave Studio usable: close a dropdown/dialog we opened. Never on UNSAVED_CHANGES_DIALOG — that prompt is the
      // user's to answer, and OSG-014 §6 requires leaving it untouched.
      if (uiOpen && failure.code !== "UNSAVED_CHANGES_DIALOG") {
        try {
          await escapeDialog("dismiss-on-failure");
        } catch {
          /* best effort only */
        }
      }
      return {
        opened: false,
        alreadyOpen: false,
        studioLaunched,
        durationMs: Date.now() - t0,
        steps,
        ...(screenshotPath ? { screenshotPath } : {}),
        error: failure
      };
    }
  }
};

async function captureScreenshot(ctx: ToolContext, steps: Step[]): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(ctx.config.dataDir, "screenshots", `${stamp}.png`);
  try {
    const r = await timed(steps, "screenshot", () => ctx.helper.run("screenshot", { Out: out }), (r) => String(r.path ?? out));
    return r.ok ? String(r.path ?? out) : undefined;
  } catch {
    return undefined;
  }
}
