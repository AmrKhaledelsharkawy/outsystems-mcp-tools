import { z } from "zod";
import { assertHelperOk, HelperError, type HelperResult } from "../helper.js";
import { locateStudioExe } from "../studio.js";
import type { FocusStudioResult, Step } from "../types.js";
import { toOsopenerError, type OsopenerTool, type ToolContext } from "./tool.js";

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
 * Never kills or closes Studio.
 */
export async function ensureStudioForeground(ctx: ToolContext, steps: Step[], launchTimeoutMs = 120_000): Promise<StudioState> {
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
  const focused = await timed(steps, "focus", () => ctx.helper.run("focus").then((r) => assertHelperOk(r, "focus")), (r) =>
    r.foreground === true ? "foreground" : "not foreground"
  );
  return stateFrom(focused, launched);
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
