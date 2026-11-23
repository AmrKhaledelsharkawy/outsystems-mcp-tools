import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsopenerConfig } from "../src/config.js";
import type { HelperResult, HelperRunner } from "../src/helper.js";
import type { ServiceStudioClient } from "../src/servicestudio.js";
import { openModule } from "../src/tools/openModule.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { OpenModuleResult } from "../src/types.js";

/**
 * openModule `source`: 'recent' (default) clicks a recent-list entry when there is one; 'environment' never looks at
 * the recent list and always goes through Open from Environment, because only that path makes servicestudio listApps
 * report the module's real server version. All names here are synthetic.
 */

const MAIN_HWND = 1001;
const DIALOG_HWND = 2002;
const SAVE_HWND = 4004;
const UNKNOWN_HWND = 5005;
const MODULE = "Demo_Orders_BL";
const RECENT_ITEM = "DemoOrders_BL@env.example"; // first `_` eaten as an Avalonia access-key mnemonic
const notFound: HelperResult = { ok: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "nope" } };
const studioInfo: HelperResult = {
  ok: true,
  running: true,
  hasMainWindow: true,
  pid: 4242,
  hwnd: MAIN_HWND,
  title: "Service Studio",
  exePath: "ServiceStudio.exe",
  fileVersion: "11.0.0.1",
  minimized: false,
  foreground: false
};

function config(): OsopenerConfig {
  return {
    serviceStudioUrl: "http://fake/mcp",
    tokenFile: "unused",
    studioExe: undefined,
    dataDir: mkdtempSync(join(tmpdir(), "osopener-source-")),
    helperScript: "unused.ps1",
    powershellExe: "powershell.exe"
  };
}

/**
 * Fake Studio of the live dropdown shape: the shell Toggle opens an in-window menu with "Open from Environment..."
 * and, optionally, a recent-list entry for MODULE; Open from Environment raises a UIA-blind (CEF) dialog.
 */
function fakeStudio(opts: { recent: boolean; alreadyOpen?: boolean; savePrompt?: boolean; unknownModal?: boolean; cancelOutcome?: "ok" | "fail"; recurringPrompt?: boolean }) {
  let menuOpen = false;
  let dialogOpen = false;
  let savePrompt = opts.savePrompt === true;
  let opened: string | undefined = opts.alreadyOpen ? MODULE : undefined;
  let typed = "";
  const menuItems = ["Open from Environment...", "Open Files...", ...(opts.recent ? [RECENT_ITEM] : [])];
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const script: Record<string, (args: Record<string, string | number | boolean>) => HelperResult> = {
    "find-window": () => studioInfo,
    focus: () => studioInfo,
    "foreground-title": () => ({ ok: true, title: "Editor", hwnd: 3003, isStudio: false }),
    refocus: () => ({ ok: true, restored: true }),
    "studio-dialog": () =>
      savePrompt
        ? { ok: true, title: "Save changes?", hwnd: SAVE_HWND, isStudio: true }
        : opts.unknownModal
          ? { ok: true, title: "Unexpected modal", hwnd: UNKNOWN_HWND, isStudio: true }
          : dialogOpen
            ? { ok: true, title: "Open from Environment", hwnd: DIALOG_HWND, isStudio: true }
            : { ok: true, title: "Service Studio", hwnd: MAIN_HWND, isStudio: true },
    "cancel-save-prompt": () => {
      if (!savePrompt) return { ok: false, error: { code: "UNSAVED_CHANGES_DIALOG", message: "no verified save prompt" } };
      if (opts.cancelOutcome === "fail") return { ok: false, error: { code: "UNSAVED_CHANGES_DIALOG", message: "Cancel button unavailable" } };
      savePrompt = opts.recurringPrompt === true;
      return { ok: true, method: "Cancel.Invoke" };
    },
    "uia-click": (args) => {
      if (args.AutomationId === "^Toggle$") {
        menuOpen = true;
        return { ok: true, method: "PostedClick" };
      }
      if (menuOpen && args.ControlType === "MenuItem" && typeof args.Name === "string") {
        const re = new RegExp(args.Name);
        const hit = menuItems.find((i) => re.test(i));
        if (!hit) return notFound;
        menuOpen = false;
        if (hit.startsWith("Open from Environment")) dialogOpen = true;
        else if (hit === RECENT_ITEM) opened = MODULE;
        return { ok: true, method: "PostedClick" };
      }
      return notFound;
    },
    "uia-find": (args) => {
      if (args.Hwnd === SAVE_HWND && args.ControlType === "Button") {
        return { ok: true, count: 1, matches: [{}] };
      }
      if (args.ControlType === "MenuItem" && !args.Hwnd) {
        const pool = menuOpen ? menuItems : [];
        const re = typeof args.Name === "string" ? new RegExp(args.Name) : undefined;
        const n = re ? pool.filter((i) => re.test(i)).length : pool.length;
        return { ok: true, count: n, matches: new Array<object>(n).fill({}) };
      }
      return { ok: true, count: 0, matches: [] };
    },
    "uia-settext": () => notFound,
    "send-keys": (args) => {
      if (typeof args.Keys === "string" && args.Keys !== "{ENTER}") typed = args.Keys;
      if ((args.Keys === "{ENTER}" || args.Then === "{ENTER}") && dialogOpen) {
        dialogOpen = false;
        opened = typed;
      }
      return { ok: true, keys: args.Keys, returned: true };
    },
    dismiss: () => {
      menuOpen = false;
      dialogOpen = false;
      return { ok: true, method: "dismissed" };
    },
    screenshot: (args) => ({ ok: true, path: args.Out })
  };
  const helper: HelperRunner = {
    async run(command: string, args: Record<string, string | number | boolean> = {}): Promise<HelperResult> {
      calls.push({ command, args });
      const fn = script[command];
      if (!fn) throw new Error(`unexpected helper command ${command}`);
      return fn(args);
    }
  };
  const client: ServiceStudioClient = {
    async listOpenModules() {
      return opened ? [opened] : [];
    }
  };
  const ctx: ToolContext = { config: config(), client, helper, sleep: async () => undefined };
  /** Every helper call that looked for or clicked the recent-list entry. */
  const recentTouches = () =>
    calls.filter(
      (c) =>
        (c.command === "uia-click" || c.command === "uia-find") &&
        c.args.ControlType === "MenuItem" &&
        typeof c.args.Name === "string" &&
        new RegExp(c.args.Name).test(RECENT_ITEM)
    );
  const keys = () =>
    calls.filter((c) => c.command === "send-keys").flatMap((c) => [String(c.args.Keys), ...(c.args.Then ? [String(c.args.Then)] : [])]);
  return { ctx, calls, recentTouches, keys, opened: () => opened, savePrompt: () => savePrompt };
}

const stepNames = (r: OpenModuleResult) => r.steps.map((s) => s.step);

describe("openModule source", () => {
  it("default (no source): a recent-list entry opens the module, nothing typed, no environment dialog", async () => {
    const s = fakeStudio({ recent: true });
    const res = (await openModule.handler({ name: MODULE }, s.ctx)) as OpenModuleResult;
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ opened: true, alreadyOpen: false });
    expect(stepNames(res)).toContain("menu:recent-module");
    expect(stepNames(res)).not.toContain("menu:open-from-environment");
    expect(res.steps.find((x) => x.step === "source")?.detail).toMatch(/^recent/);
    expect(s.keys()).toEqual([]);
    expect(s.opened()).toBe(MODULE);
  });

  it("source 'recent' explicitly behaves the same as the default", async () => {
    const s = fakeStudio({ recent: true });
    const res = (await openModule.handler({ name: MODULE, source: "recent" }, s.ctx)) as OpenModuleResult;
    expect(res.opened).toBe(true);
    expect(stepNames(res)).toContain("menu:recent-module");
    expect(s.keys()).toEqual([]);
  });

  it("source 'environment': never looks for or clicks the recent entry even when it exists; types into Open from Environment", async () => {
    const s = fakeStudio({ recent: true });
    const res = (await openModule.handler({ name: MODULE, source: "environment" }, s.ctx)) as OpenModuleResult;
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ opened: true, alreadyOpen: false });
    expect(s.recentTouches()).toEqual([]);
    expect(stepNames(res)).not.toContain("menu:recent-module");
    expect(stepNames(res)).toContain("menu:open-from-environment");
    expect(res.steps.find((x) => x.step === "source")).toMatchObject({ ok: true, detail: expect.stringMatching(/^environment/) });
    expect(s.keys()).toEqual([MODULE, "{ENTER}"]);
    expect(s.opened()).toBe(MODULE);
  });

  it("source 'environment' with focusPolicy 'never': FOREGROUND_REQUIRED, recent entry untouched, nothing typed", async () => {
    const s = fakeStudio({ recent: true });
    const res = (await openModule.handler({ name: MODULE, source: "environment", focusPolicy: "never" }, s.ctx)) as OpenModuleResult;
    expect(res.opened).toBe(false);
    expect(res.error?.code).toBe("FOREGROUND_REQUIRED");
    expect(s.recentTouches()).toEqual([]);
    expect(s.keys()).toEqual([]);
  });

  it("source 'environment' on an already open module: alreadyOpen, no UI at all", async () => {
    const s = fakeStudio({ recent: true, alreadyOpen: true });
    const res = (await openModule.handler({ name: MODULE, source: "environment" }, s.ctx)) as OpenModuleResult;
    expect(res).toMatchObject({ opened: true, alreadyOpen: true });
    expect(s.calls).toHaveLength(0);
    expect(stepNames(res)).toEqual(["listApps"]);
  });

  it("fails closed on a save prompt by default and never sends Cancel", async () => {
    const s = fakeStudio({ recent: true, savePrompt: true });
    const result = (await openModule.handler({ name: MODULE, source: "environment" }, s.ctx)) as OpenModuleResult;
    expect(result.error?.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(s.calls.some((c) => c.command === "cancel-save-prompt")).toBe(false);
    expect(s.keys()).toEqual([]);
    expect(s.savePrompt()).toBe(true);
  });

  it("opt-in cancels a verified prompt and retries exactly once without losing changes", async () => {
    const s = fakeStudio({ recent: true, savePrompt: true });
    const result = (await openModule.handler({ name: MODULE, source: "environment", cancelSavePrompt: true }, s.ctx)) as OpenModuleResult;
    expect(result).toMatchObject({ opened: true, alreadyOpen: false });
    expect(result.error).toBeUndefined();
    expect(s.calls.filter((c) => c.command === "cancel-save-prompt")).toHaveLength(1);
    expect(result.steps.find((st) => st.step === "cancel-save-prompt")).toMatchObject({ ok: true });
    expect(s.opened()).toBe(MODULE);
    expect(s.savePrompt()).toBe(false);
  });

  it("opt-in refuses an unknown Studio modal rather than closing it", async () => {
    const s = fakeStudio({ recent: true, unknownModal: true });
    const result = (await openModule.handler({ name: MODULE, cancelSavePrompt: true }, s.ctx)) as OpenModuleResult;
    expect(result.opened).toBe(false);
    expect(result.error?.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(result.error?.message).toContain("no verified save prompt");
    expect(s.calls.filter((c) => c.command === "cancel-save-prompt")).toHaveLength(1);
    expect(s.keys()).toEqual([]);
  });

  it("opt-in reports an unavailable Cancel action and does not retry the open", async () => {
    const s = fakeStudio({ recent: true, savePrompt: true, cancelOutcome: "fail" });
    const result = (await openModule.handler({ name: MODULE, cancelSavePrompt: true }, s.ctx)) as OpenModuleResult;
    expect(result.error?.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(result.error?.message).toContain("Cancel button unavailable");
    expect(s.calls.filter((c) => c.command === "cancel-save-prompt")).toHaveLength(1);
    expect(s.savePrompt()).toBe(true);
    expect(s.keys()).toEqual([]);
  });

  it("does not cancel a prompt twice when it reappears after the safe retry", async () => {
    const s = fakeStudio({ recent: true, savePrompt: true, recurringPrompt: true });
    const result = (await openModule.handler({ name: MODULE, cancelSavePrompt: true }, s.ctx)) as OpenModuleResult;
    expect(result.opened).toBe(false);
    expect(result.error?.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(s.calls.filter((c) => c.command === "cancel-save-prompt")).toHaveLength(1);
    expect(s.savePrompt()).toBe(true);
    expect(s.keys()).toEqual([]);
  });

  it("rejects an unknown source value", async () => {
    const s = fakeStudio({ recent: true });
    const res = (await openModule.handler({ name: MODULE, source: "mru" } as never, s.ctx)) as OpenModuleResult;
    expect(res.opened).toBe(false);
    expect(res.error?.message).toMatch(/invalid arguments/);
    expect(s.calls).toHaveLength(0);
  });
});
