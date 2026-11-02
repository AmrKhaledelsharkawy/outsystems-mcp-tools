import { z } from "zod";
import { assertHelperOk, HelperError } from "../helper.js";
import type { CloseModuleResult, ModuleTab, Step } from "../types.js";
import { ensureStudioForeground, timed } from "./focusStudio.js";
import { defaultSleep, toOsopenerError, type OsopenerTool, type ToolContext } from "./tool.js";

export const DEFAULT_CLOSE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const closeModuleShape = {
  name: z.string().min(1).describe("Module name exactly as servicestudio `listApps` reports it."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Deadline for the module to disappear from listApps (default ${DEFAULT_CLOSE_TIMEOUT_MS}).`)
};
const closeModuleInput = z.object(closeModuleShape);

/**
 * A module tab's UIA label is `<Module> (<Application>)` (live 2026-10-30). Matching on the module
 * part alone would make `MOD_EX_Demo_Portal_CW` also match a hypothetical `MOD_EX_Demo_Portal_CW2`, so
 * the regex anchors on the ` (` that starts the application name.
 */
export function tabLabelRegex(module: string): string {
  return `^${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`;
}

/** Splits `<Module> (<Application>)` into its parts; `application` is undefined when absent. */
export function parseTabLabel(label: string): { module: string; application?: string } {
  const m = /^(.+?) \((.+)\)\s*$/.exec(label);
  return m ? { module: m[1], application: m[2] } : { module: label };
}

/**
 * Every module tab across **every** Studio window. Live 2026-10-30: past ~30 open modules Service
 * Studio spreads them over several top-level `AggregatorWindow`s, so a single-window scan sees only
 * a fraction of them.
 */
export async function listModuleTabs(ctx: ToolContext): Promise<ModuleTab[]> {
  const enumerated = assertHelperOk(await ctx.helper.run("enum-windows"), "enum-windows");
  const windows = Array.isArray(enumerated.windows) ? (enumerated.windows as Array<{ nativeHwnd?: number }>) : [];
  const tabs: ModuleTab[] = [];
  for (const w of windows) {
    const hwnd = Number(w.nativeHwnd ?? 0);
    if (!hwnd) continue;
    let result;
    try {
      result = assertHelperOk(await ctx.helper.run("tab-list", { Hwnd: hwnd, Depth: 10 }), "tab-list");
    } catch {
      continue; // a window that vanished mid-scan is not an error
    }
    const found = Array.isArray(result.tabs) ? (result.tabs as Array<{ label?: string; hasClose?: boolean; offscreen?: boolean }>) : [];
    for (const t of found) {
      // `hasClose` separates module tabs from Studio's own Forge / environment tabs.
      if (t.hasClose !== true || typeof t.label !== "string") continue;
      const parsed = parseTabLabel(t.label);
      const tab: ModuleTab = { module: parsed.module, label: t.label, windowHwnd: hwnd, offscreen: t.offscreen === true };
      if (parsed.application !== undefined) tab.application = parsed.application;
      tabs.push(tab);
    }
  }
  return tabs;
}

export const closeModule: OsopenerTool<typeof closeModuleShape> = {
  name: "closeModule",
  description:
    "Close one module's tab in Service Studio, so a caller can run open -> rebuild({scope,module}) -> close and keep " +
    "Studio small (past ~30 open modules it splits across windows and slows sharply). " +
    "SAFETY, enforced in code and not negotiable: it never closes Service Studio, never closes a module with unsaved " +
    "changes, and never answers a save prompt — if one appears the close is cancelled with Esc, the module stays open " +
    "and the call fails with UNSAVED_CHANGES_DIALOG. WHICH module to close is the caller's decision, not osopener's: " +
    "use listOpenModules (it reports every open module, its application and which window holds it) and close only what " +
    "your task no longer needs. Returns alreadyClosed=true with no UI action when the module is not open. " +
    "Confirmation is servicestudio listApps, never the UI.",
  inputSchema: closeModuleShape,
  async handler(rawArgs, ctx): Promise<CloseModuleResult> {
    const t0 = Date.now();
    const steps: Step[] = [];
    const sleep = ctx.sleep ?? defaultSleep;

    const parsed = closeModuleInput.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        closed: false,
        alreadyClosed: false,
        durationMs: 0,
        steps,
        error: { code: "HELPER_FAILED", message: `invalid arguments: ${parsed.error.message}` }
      };
    }
    const { name } = parsed.data;
    const deadline = t0 + (parsed.data.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);

    try {
      const open = await timed(steps, "listApps", () => ctx.client.listOpenModules(), (m) => `${m.length} open`);
      if (!open.includes(name)) {
        return { closed: true, alreadyClosed: true, durationMs: Date.now() - t0, steps };
      }

      await ensureStudioForeground(ctx, steps, Math.max(10_000, deadline - Date.now()));

      const tabs = await timed(steps, "tab-list", () => listModuleTabs(ctx), (t) => `${t.length} module tab(s)`);
      const tab = tabs.find((t) => t.module === name);
      if (!tab) {
        throw new HelperError(
          "UIA_ELEMENT_NOT_FOUND",
          `module '${name}' is open per listApps but no tab is labelled '${name} (<application>)'; refusing to guess which tab to close`,
          { labels: tabs.map((t) => t.label) }
        );
      }

      await timed(
        steps,
        "tab-close",
        async () => {
          // The helper cancels a save prompt with Esc and fails UNSAVED_CHANGES_DIALOG; that error
          // is this tool's error, never something to retry past.
          const r = await ctx.helper.run("tab-close", { Name: tabLabelRegex(name), Hwnd: tab.windowHwnd, Depth: 10 });
          assertHelperOk(r, "tab-close");
          return String(r.method ?? "clicked");
        },
        (d) => d
      );

      const gone = await timed(
        steps,
        "poll-listApps",
        async () => {
          while (Date.now() < deadline) {
            const modules = await ctx.client.listOpenModules();
            if (!modules.includes(name)) return true;
            await sleep(POLL_INTERVAL_MS);
          }
          return false;
        },
        (r) => (r ? "module gone" : "timeout")
      );
      if (!gone) {
        throw new HelperError(
          "OPEN_TIMEOUT",
          `module '${name}' was still listed by listApps after the close was clicked; it has NOT been confirmed closed`
        );
      }
      return { closed: true, alreadyClosed: false, durationMs: Date.now() - t0, steps };
    } catch (e) {
      return { closed: false, alreadyClosed: false, durationMs: Date.now() - t0, steps, error: toOsopenerError(e) };
    }
  }
};
