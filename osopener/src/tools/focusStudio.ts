import { z } from "zod";
import { assertHelperOk, HelperError, type HelperResult } from "../helper.js";
import { locateStudioExe } from "../studio.js";
import type { FocusStudioResult, Step } from "../types.js";
import { defaultSleep, toOsopenerError, type OsopenerTool, type ToolContext } from "./tool.js";

export interface StudioState {
  running: boolean;
  studioLaunched: boolean;
  foreground: boolean;
  pid?: number;
  studioVersion?: string;
  exePath?: string;
  hwnd?: number;
  title?: string;
}

function stateFrom(info: HelperResult, launched: boolean): StudioState {
  return {
    running: info.running === true,
    studioLaunched: launched,
    foreground: info.foreground === true,
    pid: typeof info.pid === "number" ? info.pid : undefined,
    studioVersion: typeof info.fileVersion === "string" ? info.fileVersion : undefined,
    exePath: typeof info.exePath === "string" ? info.exePath : undefined,
    hwnd: typeof info.hwnd === "number" ? info.hwnd : undefined,
    title: typeof info.title === "string" ? info.title : undefined
  };
}

/** Records one step with its wall time; rethrows after logging a failed step. */
export async function timed<T>(steps: Step[], step: string, fn: () => Promise<T>, detail?: (r: T) => string | undefined): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const d = detail?.(r);
    steps.push({ step, ok: true, ms: Date.now() - t0, ...(d ? { detail: d } : {}) });
    return r;
  } catch (err) {
    steps.push({ step, ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Step 2 + 3 of OSG-014: find the Studio process (launch when absent), then bring its main window to front.
 * Never kills or closes Studio. Only the `focusStudio` tool does this now; openModule / closeModule use
 * {@link ensureStudioReady} so they never take the foreground from the user.
 */
export async function ensureStudioForeground(ctx: ToolContext, steps: Step[], launchTimeoutMs = 120_000): Promise<StudioState> {
  const ready = await ensureStudioRunning(ctx, steps, launchTimeoutMs);
  const focused = await timed(steps, "focus", () => ctx.helper.run("focus").then((r) => assertHelperOk(r, "focus")), (r) =>
    r.foreground === true ? "foreground" : "not foreground"
  );
  return stateFrom(focused, ready.studioLaunched);
}

/**
 * Background variant (2026-11-20): find or launch Studio and un-minimize it **without activating it**. The user keeps
 * the foreground, the keyboard and the cursor; every click osopener sends after this is a UIA pattern or a posted
 * window message.
 */
export async function ensureStudioReady(ctx: ToolContext, steps: Step[], launchTimeoutMs = 120_000): Promise<StudioState> {
  const ready = await ensureStudioRunning(ctx, steps, launchTimeoutMs);
  if (!ready.minimized) return ready;
  const restored = await timed(steps, "restore", () => ctx.helper.run("restore").then((r) => assertHelperOk(r, "restore")), () =>
    "un-minimized without activation"
  );
  return stateFrom(restored, ready.studioLaunched);
}

/**
 * The one step that still needs the keyboard: typing into Studio's CEF "Open from Environment" dialog. Chromium
 * ignores posted keystrokes unless it really has focus (live-disproved 2026-11-20), so `fn` runs with `hwnd` in the
 * foreground, and the user's window gets the foreground back right after — the whole window is about a second.
 */
export async function withBriefFocus<T>(
  ctx: ToolContext,
  steps: Step[],
  hwnd: number,
  fn: () => Promise<T>,
  state?: { userHwnd?: number }
): Promise<T> {
  // Windows refuses the switch while the user is busy in another window (live 2026-11-21: constant clicking in
  // another app wins every time). Retry briefly; if it never sticks, fail loudly rather than type into the wrong window.
  let focused!: HelperResult;
  for (let attempt = 1; attempt <= 3; attempt++) {
    focused = await timed<HelperResult>(steps, "brief-focus", () => ctx.helper.run("focus", { Hwnd: hwnd }).then((r) => assertHelperOk(r, "focus")), (r) =>
      `${r.targetForeground === true ? "took" : "FAILED to take"} foreground from hwnd ${String(r.previous ?? 0)}${r.previousIsStudio === true ? " (a Studio window)" : ""}`
    );
    if (focused.targetForeground !== false) break;
    if (attempt < 3) await (ctx.sleep ?? defaultSleep)(400);
  }
  if (focused.targetForeground === false) {
    throw new HelperError(
      "FOREGROUND_REQUIRED",
      "Windows would not give Service Studio the foreground (you are probably actively using another window). Nothing was typed. " +
        "Stop clicking for a few seconds and retry, or open this module by hand once so it is in the recent list."
    );
  }
  const previous = typeof focused.previous === "number" ? focused.previous : 0;
  // Remember the first non-Studio window we took the foreground from: that is the user's.
  if (state && !state.userHwnd && previous && focused.previousIsStudio !== true) state.userHwnd = previous;
  try {
    return await fn();
  } finally {
    if (previous && previous !== hwnd) {
      try {
        await timed(steps, "refocus", () => ctx.helper.run("refocus", { Hwnd: previous }), (r) =>
          r.restored === true ? `foreground returned to hwnd ${previous}` : `could not return foreground (${String(r.reason ?? "refused")})`
        );
      } catch {
        /* best effort: never turn a finished open into a failure */
      }
    }
  }
}

async function ensureStudioRunning(
  ctx: ToolContext,
  steps: Step[],
  launchTimeoutMs: number
): Promise<StudioState & { minimized: boolean }> {
  let info = await timed(steps, "find-window", () => ctx.helper.run("find-window"), (r) =>
    r.running ? `pid ${String(r.pid)} '${String(r.title ?? "")}'` : "not running"
  );
  let launched = false;
  if (info.running !== true || info.hasMainWindow !== true) {
    const exe = await timed(steps, "locate-exe", async () => {
      const found = (typeof info.exePath === "string" ? info.exePath : undefined) ?? (await locateStudioExe({ override: ctx.config.studioExe }));
      if (!found) {
        throw Object.assign(new Error("ServiceStudio.exe not found (set OSOPENER_STUDIO_EXE)"), { code: "STUDIO_NOT_FOUND" });
      }
      return found;
    }, (p) => p);
    info = await timed(
      steps,
      "launch",
      async () => {
        try {
          return assertHelperOk(await ctx.helper.run("launch", { ExePath: exe, TimeoutMs: launchTimeoutMs }, launchTimeoutMs + 5_000), "launch");
        } catch (e) {
          // Exhausting the launch deadline (helper-side or node-side kill) is a timeout, not a missing control.
          if (e instanceof HelperError && e.code === "HELPER_FAILED" && /exceeded .* ms/.test(e.message)) {
            throw new HelperError("OPEN_TIMEOUT", `launch: Studio main window did not appear within ${launchTimeoutMs} ms`);
          }
          throw e;
        }
      },
      (r) => `pid ${String(r.pid)} in ${String(r.ms ?? "?")} ms`
    );
    launched = info.launched === true;
  }
  return { ...stateFrom(info, launched), minimized: info.minimized === true };
}

export const focusStudio: OsopenerTool = {
  name: "focusStudio",
  description:
    "Launch Service Studio if it is not running, or bring its main window to the front (restoring it if minimized). " +
    "Never closes or kills Studio. studioLaunched=true means the session token must be re-approved (ADR-0004).",
  inputSchema: {},
  async handler(_args, ctx): Promise<FocusStudioResult> {
    const t0 = Date.now();
    const steps: Step[] = [];
    try {
      const s = await ensureStudioForeground(ctx, steps);
      return {
        running: s.running,
        studioLaunched: s.studioLaunched,
        foreground: s.foreground,
        ...(s.pid !== undefined ? { pid: s.pid } : {}),
        ...(s.studioVersion ? { studioVersion: s.studioVersion } : {}),
        ...(s.exePath ? { exePath: s.exePath } : {}),
        durationMs: Date.now() - t0,
        steps
      };
    } catch (err) {
      return { running: false, studioLaunched: false, foreground: false, durationMs: Date.now() - t0, steps, error: toOsopenerError(err) };
    }
  }
};

export const focusStudioInput = z.object({});
