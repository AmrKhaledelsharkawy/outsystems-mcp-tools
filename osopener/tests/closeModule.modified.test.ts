import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsopenerConfig } from "../src/config.js";
import type { HelperResult, HelperRunner } from "../src/helper.js";
import type { ServiceStudioClient } from "../src/servicestudio.js";
import { closeModule, parseTabLabel } from "../src/tools/closeModule.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { CloseModuleResult } from "../src/types.js";

/**
 * closeModule and a module tab with unsaved changes. Service Studio prefixes a modified module's tab label with
 * `* ` (`* <Module> (<Application>)`). That tab must be recognised as the module's tab and refused with
 * UNSAVED_CHANGES_DIALOG without any close being clicked; an unmodified tab closes exactly as before. All names
 * here are synthetic.
 */

const MAIN_HWND = 1001;
const MODULE = "Demo_Orders_BL";
const APP = "Demo Orders";
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
    dataDir: mkdtempSync(join(tmpdir(), "osopener-close-")),
    helperScript: "unused.ps1",
    powershellExe: "powershell.exe"
  };
}

/** A fake Studio with the given open modules and tab labels; `tab-close` removes the matching module. */
function fakeStudio(openModules: string[], labels: string[]) {
  let open = [...openModules];
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const script: Record<string, (args: Record<string, string | number | boolean>) => HelperResult> = {
    "find-window": () => studioInfo,
    restore: () => ({ ok: true, restored: false }),
    focus: () => studioInfo,
    "enum-windows": () => ({ ok: true, windows: [{ nativeHwnd: MAIN_HWND }] }),
    "tab-list": () => ({ ok: true, tabs: labels.map((label) => ({ label, hasClose: true, offscreen: false })) }),
    "tab-close": (args) => {
      const re = new RegExp(String(args.Name));
      const hit = labels.find((l) => re.test(l));
      if (!hit) return { ok: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "no tab" } };
      open = open.filter((m) => m !== parseTabLabel(hit).module);
      return { ok: true, method: "Invoke" };
    }
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
      return [...open];
    }
  };
  const ctx: ToolContext = { config: config(), client, helper, sleep: async () => undefined };
  const commands = () => calls.map((c) => c.command);
  return { ctx, commands, open: () => open };
}

describe("parseTabLabel: modified marker", () => {
  it("strips a leading '* ' and reports modified", () => {
    expect(parseTabLabel(`* ${MODULE} (${APP})`)).toEqual({ module: MODULE, application: APP, modified: true });
    expect(parseTabLabel(`* ${MODULE}`)).toEqual({ module: MODULE, modified: true });
  });
  it("an unmodified label is unchanged and carries no modified flag", () => {
    expect(parseTabLabel(`${MODULE} (${APP})`)).toEqual({ module: MODULE, application: APP });
    expect(parseTabLabel(MODULE)).toEqual({ module: MODULE });
  });
});

describe("closeModule: modified tab", () => {
  it("a modified tab is refused with UNSAVED_CHANGES_DIALOG, nothing is clicked and the module stays open", async () => {
    const s = fakeStudio([MODULE], [`* ${MODULE} (${APP})`]);
    const res = (await closeModule.handler({ name: MODULE }, s.ctx)) as CloseModuleResult;
    expect(res.closed).toBe(false);
    expect(res.error?.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(res.error?.message).toMatch(/unsaved changes/i);
    expect(res.error?.message).toMatch(/left open/i);
    expect(s.commands()).not.toContain("tab-close");
    expect(s.commands()).not.toContain("dismiss");
    expect(s.commands()).not.toContain("send-keys");
    expect(s.open()).toEqual([MODULE]);
  });

  it("an unmodified tab closes as before", async () => {
    const s = fakeStudio([MODULE], [`${MODULE} (${APP})`]);
    const res = (await closeModule.handler({ name: MODULE }, s.ctx)) as CloseModuleResult;
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ closed: true, alreadyClosed: false });
    expect(s.commands()).toContain("tab-close");
    expect(s.open()).toEqual([]);
  });

  it("a module whose name merely starts with the same prefix is not matched (modified or not)", async () => {
    const s = fakeStudio([MODULE, `${MODULE}2`], [`* ${MODULE}2 (${APP})`, `${MODULE}2_X (${APP})`]);
    const res = (await closeModule.handler({ name: MODULE }, s.ctx)) as CloseModuleResult;
    expect(res.closed).toBe(false);
    expect(res.error?.code).toBe("UIA_ELEMENT_NOT_FOUND");
    expect(s.commands()).not.toContain("tab-close");
    expect(s.open()).toEqual([MODULE, `${MODULE}2`]);
  });
});
