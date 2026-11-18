/**
 * #48 `osgraph run`: the staged scope build and the one-module refresh, driven against a fake
 * osopener (the real #6 adapter over fake tool handlers and fake UI probes) and osgraph's fixture-
 * backed fake reader. No Service Studio, no osopener build, no token, no network: every module name
 * is synthetic.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveScopeArtifactPaths } from "../src/graph/io.js";
import { loadLayerRules } from "../src/layers/rules.js";
import {
  createHelperStudioUi,
  createOsopenerAdapter,
  type OsopenerAdapter,
  type StudioUi
} from "../src/osopener/adapter.js";
import type { RunState } from "../src/progress/state.js";
import { reextractScope } from "../src/reextract.js";
import type { ServiceStudioSession } from "../src/rebuild/reader.js";
import { stageModule } from "../src/rebuild/rebuild.js";
import { readStage } from "../src/rebuild/stage.js";
import {
  dismissOpenDialogHonestly,
  makeForegroundGate,
  makeOpenWithRetry,
  waitForStudioIdle
} from "../src/run/opener.js";
import { formatAge, refreshModule, requireOtherCaptures, runDirFor, runScope, type RunCommonOptions } from "../src/run/run.js";
import { OsgraphToolError, type ServiceStudioApp } from "../src/servicestudio/types.js";
import { FakeReader, syntheticWideModule, tokenExpiredError, type FakeModule } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-run-"));
  dirs.push(d);
  return d;
}

const T0 = new Date("2026-11-01T00:00:00.000Z");
const T1 = new Date("2026-11-03T06:00:00.000Z");
const noSleep = async (): Promise<void> => undefined;
const SCOPE = { name: "demo", modules: ["alpha", "beta", "gamma", "delta"] };
const mods = (...extra: FakeModule[]): FakeModule[] => [
  syntheticWideModule(2, "alpha"),
  syntheticWideModule(2, "beta"),
  syntheticWideModule(2, "gamma"),
  syntheticWideModule(2, "delta"),
  ...extra
];

/* -------------------------------------------------------------------------------------------- */
/* The fake Studio: open tabs, osopener's raw tool results, UI probes                            */
/* -------------------------------------------------------------------------------------------- */

type RawResult = Record<string, unknown>;

interface StudioOptions {
  /** Modules a human already has open (never to be closed by the run). */
  userOpen?: string[];
  /** Per module: raw osopener results to answer the next opens with, before succeeding. */
  openScript?: Record<string, RawResult[]>;
  /** Per module: raw osopener results to answer the next closes with, before succeeding. */
  closeScript?: Record<string, RawResult[]>;
  /** UI: answers of successive `foreground()` calls; once exhausted, Studio owns the foreground. */
  foreground?: Array<{ isStudio: boolean; title: string }>;
  /** UI: answers of successive `openDialogPresent()` calls; once exhausted, false. */
  dialog?: boolean[];
  /** No UI probes at all. */
  noUi?: boolean;
}

/** `listApps` reflects the fake Studio's open tabs, as the real one does. */
class StudioReader extends FakeReader {
  constructor(
    modules: FakeModule[],
    private readonly studio: { open: Set<string> },
    private readonly appsOf: ServiceStudioApp[]
  ) {
    super(modules);
  }
  override async listApps(): Promise<ServiceStudioApp[]> {
    await Promise.resolve();
    return this.appsOf.map((a) => ({ ...a, isOpen: this.studio.open.has(a.name) }));
  }
}

function fakeStudio(modules: FakeModule[], options: StudioOptions = {}) {
  const open = new Set<string>(options.userOpen ?? []);
  const studio = { open };
  const reader = new StudioReader(modules, studio, modules.map((m) => m.app));
  const events: string[] = [];
  /** `reader.inFlight` at every close: must always be 0 (ADR-0013 drain rule). */
  const inFlightAtClose: number[] = [];
  const openScript = new Map(Object.entries(options.openScript ?? {}).map(([k, v]) => [k, [...v]]));
  const closeScript = new Map(Object.entries(options.closeScript ?? {}).map(([k, v]) => [k, [...v]]));
  let maxRunOwned = 0;

  const tools = {
    async open(input: Record<string, unknown>): Promise<unknown> {
      const name = String(input.name);
      events.push(`open:${name}`);
      const scripted = openScript.get(name)?.shift();
      if (scripted !== undefined) return scripted;
      if (open.has(name)) return { opened: true, alreadyOpen: true, durationMs: 5 };
      open.add(name);
      return { opened: true, alreadyOpen: false, durationMs: 15_000 };
    },
    async close(input: Record<string, unknown>): Promise<unknown> {
      const name = String(input.name);
      events.push(`close:${name}`);
      inFlightAtClose.push(reader.inFlight);
      const scripted = closeScript.get(name)?.shift();
      if (scripted !== undefined) return scripted;
      if (!open.has(name)) return { closed: true, alreadyClosed: true };
      open.delete(name);
      return { closed: true, alreadyClosed: false, durationMs: 800 };
    }
  };

  const fg = [...(options.foreground ?? [])];
  const dialog = [...(options.dialog ?? [])];
  const screenshots: string[] = [];
  const ui: StudioUi = {
    async foreground() {
      events.push("ui:foreground");
      return fg.shift() ?? { isStudio: true, title: "Service Studio" };
    },
    async focus() {
      events.push("ui:focus");
    },
    async openDialogPresent() {
      events.push("ui:dialog?");
      return dialog.shift() ?? false;
    },
    async dismissOpenDialog() {
      events.push("ui:dismiss");
    },
    async screenshot(outPath) {
      screenshots.push(outPath);
      return outPath;
    }
  };

  const adapter = createOsopenerAdapter(tools, "fake-dist", options.noUi === true ? undefined : ui);
  // Track the most tabs this process ever owned at once.
  const opener: OsopenerAdapter = {
    ...adapter,
    open: async (m) => {
      const r = await adapter.open(m);
      maxRunOwned = Math.max(maxRunOwned, adapter.ownedModules().length);
      return r;
    },
    close: adapter.close,
    closeOwned: adapter.closeOwned,
    owns: adapter.owns,
    ownedModules: adapter.ownedModules
  };

  let sessions = 0;
  const createSession = (): ServiceStudioSession => {
    sessions++;
    return { reader, acquire: async () => "token", release: () => undefined };
  };

  return {
    studio,
    reader,
    events,
    inFlightAtClose,
    screenshots,
    opener,
    adapter,
    createSession,
    get maxRunOwned() {
      return maxRunOwned;
    },
    get sessions() {
      return sessions;
    }
  };
}

function common(graphDir: string, s: ReturnType<typeof fakeStudio>, logs: string[], now = T0): RunCommonOptions {
  return {
    scope: SCOPE,
    graphDir,
    rules,
    createSession: s.createSession,
    opener: s.opener,
    log: (line) => logs.push(line),
    now: () => now,
    sleep: noSleep,
    gapMs: 0,
    retryDelayMs: 0
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const OPEN_DIALOG_STUCK =
  "Open from Environment dialog did not close after selecting the module; refusing to continue";
const TRANSIENT_PROGRESS =
  "'Open from Environment' did not produce a settled Studio dialog: only the transient Progress window appeared";

/* -------------------------------------------------------------------------------------------- */
/* Full staged build                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe("runScope: open -> stage -> drain -> close for every unstaged module", () => {
  it("stages every module, closes each tab it opened after a drain, and finalizes like the staged path", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    const logs: string[] = [];
    const result = await runScope({ ...common(graphDir, s, logs), maxOpen: 2 });

    expect(result.finalized).toBe(true);
    expect(result.rows.map((r) => [r.module, r.outcome, r.closed])).toEqual([
      ["alpha", "staged", true],
      ["beta", "staged", true],
      ["gamma", "staged", true],
      ["delta", "staged", true]
    ]);
    // Opened, then closed, one at a time, in scope order.
    expect(s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"))).toEqual([
      "open:alpha", "close:alpha", "open:beta", "close:beta", "open:gamma", "close:gamma", "open:delta", "close:delta"
    ]);
    // ADR-0013: no read was in flight or queued when any tab closed.
    expect(s.inFlightAtClose.every((n) => n === 0)).toBe(true);
    expect(s.reader.drainCalls).toBeGreaterThanOrEqual(8);
    expect(s.maxRunOwned).toBeLessThanOrEqual(2);
    expect(s.studio.open.size).toBe(0);
    // A successful finalize clears the stage, exactly as the staged rebuild does.
    expect(readStage(graphDir, "demo").entries).toEqual([]);

    // The same modules staged by hand through stageModule produce byte-identical artifacts.
    const manualDir = tmp();
    const manual = fakeStudio(mods(), { userOpen: SCOPE.modules });
    for (const m of SCOPE.modules) {
      await stageModule({
        scope: SCOPE,
        module: m,
        graphDir: manualDir,
        snapshotPath: resolveScopeArtifactPaths(manualDir, "demo").graph,
        session: manual.createSession(),
        rules,
        now: () => T0,
        retryDelayMs: 0
      });
    }
    const ours = resolveScopeArtifactPaths(graphDir, "demo");
    const theirs = resolveScopeArtifactPaths(manualDir, "demo");
    expect(read(ours.graph)).toBe(read(theirs.graph));
    expect(read(ours.flows)).toBe(read(theirs.flows));
    expect(result.rebuild?.nodeCount).toBeGreaterThan(0);
    // Logs and the report land in the run directory.
    expect(existsSync(result.logPath)).toBe(true);
    expect(JSON.parse(read(result.reportPath)).rows).toHaveLength(4);
    expect(result.runDir).toBe(runDirFor(graphDir, "demo"));
  });

  it("stages a module the user already had open but never closes it", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods(), { userOpen: ["beta"] });
    const result = await runScope({ ...common(graphDir, s, []) });
    expect(result.finalized).toBe(true);
    expect(s.events).not.toContain("open:beta");
    expect(s.events).not.toContain("close:beta");
    expect(s.studio.open.has("beta")).toBe(true);
    expect(result.rows.find((r) => r.module === "beta")).toMatchObject({ outcome: "staged", openedHere: false });
  });

  it("makes room by closing only its own staged tabs, never a user's, within --max-open", async () => {
    const graphDir = tmp();
    // alpha's first close is refused (a save prompt), so its tab stays open and owned.
    const s = fakeStudio(mods(syntheticWideModule(1, "usertab")), {
      userOpen: ["usertab"],
      closeScript: {
        alpha: [{ closed: false, error: { code: "UNSAVED_CHANGES_DIALOG", message: "Closing 'alpha' raised 'Save changes?'" } }]
      }
    });
    const logs: string[] = [];
    const result = await runScope({ ...common(graphDir, s, logs), maxOpen: 2 });
    expect(result.finalized).toBe(true);
    expect(result.rows[0]).toMatchObject({ module: "alpha", closed: false });
    expect(result.rows[0].closeError).toContain("UNSAVED_CHANGES_DIALOG");
    // usertab + alpha = 2 open >= max 2: alpha (owned, staged) is closed before beta opens.
    const order = s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"));
    expect(order.slice(0, 4)).toEqual(["open:alpha", "close:alpha", "close:alpha", "open:beta"]);
    expect(s.events).not.toContain("close:usertab");
    expect(s.studio.open.has("usertab")).toBe(true);
    expect(s.maxRunOwned).toBeLessThanOrEqual(2);
  });
});

describe("runScope: resumable", () => {
  it("skips modules that already have a stage entry, so a re-run continues an interrupted one", async () => {
    const graphDir = tmp();
    // First run: gamma cannot be opened (not transient), so the run ends unfinalized.
    const first = fakeStudio(mods(), {
      openScript: { gamma: [{ opened: false, error: { code: "MODULE_NOT_FOUND", message: "no module named gamma in the environment" } }] }
    });
    const r1 = await runScope({ ...common(graphDir, first, []) });
    expect(r1.finalized).toBe(false);
    expect(r1.failures).toBe(1);
    expect(r1.rows.find((r) => r.module === "gamma")).toMatchObject({ outcome: "open-failed" });
    expect(readStage(graphDir, "demo").entries.map((e) => e.module)).toEqual(["alpha", "beta", "delta"]);

    // Second run: only gamma is opened; the rest are skipped and the scope finalizes.
    const second = fakeStudio(mods());
    const logs: string[] = [];
    const r2 = await runScope({ ...common(graphDir, second, logs) });
    expect(r2.alreadyStaged).toBe(3);
    expect(r2.rows.map((r) => [r.module, r.outcome])).toEqual([
      ["alpha", "skipped"],
      ["beta", "skipped"],
      ["gamma", "staged"],
      ["delta", "skipped"]
    ]);
    expect(second.events.filter((e) => e.startsWith("open:"))).toEqual(["open:gamma"]);
    expect(r2.finalized).toBe(true);
    expect(logs.some((l) => l.includes("alpha already staged"))).toBe(true);
  });
});

describe("runScope: circuit breaker", () => {
  const stuck = (): RawResult[] => [
    { opened: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "Studio window not found" } }
  ];

  it("stops after --max-consecutive-failures modules in a row fail to open, saying a re-run resumes", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods(), { openScript: { alpha: stuck(), beta: stuck(), gamma: stuck() } });
    const logs: string[] = [];
    const result = await runScope({ ...common(graphDir, s, logs), maxConsecutiveFailures: 3 });
    expect(result.stoppedEarly).toContain("3 module(s) in a row failed to open");
    expect(result.stoppedEarly).toContain("Service Studio itself is most likely stuck");
    expect(result.stoppedEarly).toContain("resumes");
    expect(s.events).not.toContain("open:delta");
    expect(result.rows).toHaveLength(3);
    expect(logs.some((l) => l.startsWith("STOPPED:"))).toBe(true);
  });

  it("a success resets the count, and 0 disables the breaker", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods(), { openScript: { alpha: stuck(), beta: stuck(), gamma: stuck() } });
    const result = await runScope({ ...common(graphDir, s, []), maxConsecutiveFailures: 0 });
    expect(result.stoppedEarly).toBeUndefined();
    expect(result.rows.map((r) => r.outcome)).toEqual(["open-failed", "open-failed", "open-failed", "staged"]);

    const s2 = fakeStudio(mods(), { openScript: { alpha: stuck(), gamma: stuck() } });
    const r2 = await runScope({ ...common(tmp(), s2, []), maxConsecutiveFailures: 2 });
    expect(r2.stoppedEarly).toBeUndefined();
    expect(r2.failures).toBe(2);
  });
});

describe("runScope: session-level failures abort the run", () => {
  it("closes the tab it opened after the drain, then rethrows TOKEN_EXPIRED", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    let n = 0;
    const createSession = (): ServiceStudioSession => {
      n++;
      return {
        reader: s.reader,
        acquire: async () => {
          if (n >= 3) throw tokenExpiredError();
          return "token";
        },
        release: () => undefined
      };
    };
    const failRuns: string[] = [];
    const state = { beginRun: () => undefined, handle: () => undefined, finishRun: () => undefined, failRun: (c: string) => failRuns.push(c) } as unknown as RunState;
    await expect(runScope({ ...common(graphDir, s, []), createSession, state })).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    // alpha staged (session 2), beta's stage failed on the token (session 3): beta's tab was still closed.
    expect(s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"))).toEqual([
      "open:alpha", "close:alpha", "open:beta", "close:beta"
    ]);
    expect(s.inFlightAtClose.every((x) => x === 0)).toBe(true);
    expect(failRuns).toEqual(["TOKEN_EXPIRED"]);
  });
});

describe("runScope: progress site", () => {
  it("begins the site's run before the first osopener call and forwards progress events", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    const calls: string[] = [];
    const state = {
      beginRun: (scope: string, modules: string[]) => calls.push(`begin:${scope}:${modules.join(",")}:${s.events.length}`),
      handle: (e: { type: string }) => calls.push(`event:${e.type}`),
      finishRun: () => calls.push("finish"),
      failRun: () => calls.push("fail")
    } as unknown as RunState;
    await runScope({ ...common(graphDir, s, []), state });
    expect(calls[0]).toBe("begin:demo:alpha,beta,gamma,delta:0");
    expect(calls).toContain("event:module-start");
    expect(calls).toContain("event:module-done");
    expect(calls).toContain("finish");
    expect(calls).not.toContain("fail");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The open loop: classification, honest recovery, diagnostics, screenshot                       */
/* -------------------------------------------------------------------------------------------- */

describe("open loop: retry by failure kind", () => {
  const runOpen = async (s: ReturnType<typeof fakeStudio>, attempts = 4) => {
    const logs: string[] = [];
    const gate = makeForegroundGate(s.adapter.ui, (l) => logs.push(l), { sleep: noSleep, foregroundGapMs: 0 });
    const open = makeOpenWithRetry(s.adapter, (l) => logs.push(l), gate, {
      attempts,
      sleep: noSleep,
      idleGapMs: 1,
      idleMaxMs: 10,
      screenshotDir: join("run", "screenshots"),
      now: () => T0
    });
    return { result: await open("alpha"), logs };
  };

  it("foreground: waits and retries", async () => {
    const s = fakeStudio(mods(), {
      openScript: {
        alpha: [{ opened: false, error: { code: "STUDIO_NOT_FOREGROUND", message: "Foreground window belongs to pid 42, not Service Studio; refusing to send input" } }]
      }
    });
    const { result, logs } = await runOpen(s);
    expect(result).toMatchObject({ ok: true, attempts: 2, openedHere: true });
    expect(logs[0]).toContain("attempt 1/4 FAILED STUDIO_NOT_FOREGROUND (foreground)");
  });

  it("studio-busy: checks for a dialog first (none: nothing 'dismissed'), then waits for Studio to go idle", async () => {
    const s = fakeStudio(mods(), {
      openScript: { alpha: [{ opened: false, error: { code: "OPEN_TIMEOUT", message: TRANSIENT_PROGRESS } }] },
      // gate (focus+check), then idle polling sees a Progress window once, then Studio.
      foreground: [{ isStudio: true, title: "Service Studio" }, { isStudio: true, title: "Progress" }],
      dialog: [false]
    });
    const { result, logs } = await runOpen(s);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(logs.some((l) => l.includes("(studio-busy)"))).toBe(true);
    expect(logs).toContain("   recovery: no Open from Environment dialog is up - nothing to dismiss");
    expect(logs.some((l) => /dismissed/.test(l))).toBe(false);
    expect(s.events).not.toContain("ui:dismiss");
    expect(logs.some((l) => l.includes("Studio idle again"))).toBe(true);
  });

  it("open-dialog: dismisses only a dialog that is present, and reports 'dismissed' only when it is gone", async () => {
    const s = fakeStudio(mods(), {
      openScript: { alpha: [{ opened: false, error: { code: "HELPER_FAILED", message: OPEN_DIALOG_STUCK } }] },
      dialog: [true, false]
    });
    const { result, logs } = await runOpen(s);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(s.events).toContain("ui:dismiss");
    expect(logs).toContain("   recovery: Open from Environment dialog dismissed");
  });

  it("other: not retried; giving up keeps the real error, logs the failed step and saves a screenshot", async () => {
    const s = fakeStudio(mods(), {
      openScript: {
        alpha: [
          {
            opened: false,
            error: { code: "UIA_ELEMENT_NOT_FOUND", message: "module row 'alpha' not found in the list" },
            steps: [
              { step: "focus", ok: true },
              { step: "select-module", ok: false, detail: "0 rows matched" }
            ]
          }
        ]
      }
    });
    const { result, logs } = await runOpen(s);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(1);
    expect(result.failure.code).toBe("UIA_ELEMENT_NOT_FOUND");
    expect(result.failure.message).toBe("module row 'alpha' not found in the list");
    expect(result.failure.failedStep).toEqual({ step: "select-module", detail: "0 rows matched" });
    expect(result.screenshotPath).toBe(join("run", "screenshots", "2026-11-01T00-00-00-000Z-alpha.png"));
    expect(s.screenshots).toHaveLength(1);
    expect(logs[0]).toContain("UIA_ELEMENT_NOT_FOUND (other): module row 'alpha' not found in the list [step select-module: 0 rows matched]");
    expect(logs.some((l) => l.includes("GAVE UP on alpha after 1 attempt(s): UIA_ELEMENT_NOT_FOUND"))).toBe(true);
  });

  it("gives up after the attempt budget with the LAST real error, not a generic one", async () => {
    const busy = { opened: false, error: { code: "OPEN_TIMEOUT", message: TRANSIENT_PROGRESS } };
    const s = fakeStudio(mods(), { openScript: { alpha: [busy, busy, busy] } });
    const { result } = await runOpen(s, 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(3);
    expect(result.failure).toMatchObject({ code: "OPEN_TIMEOUT", kind: "studio-busy", message: TRANSIENT_PROGRESS });
  });

  it("a give-up screenshot that fails is logged, never fatal; no UI probes means no screenshot", async () => {
    const s = fakeStudio(mods(), {
      noUi: true,
      openScript: { alpha: [{ opened: false, error: { code: "X", message: "boom" } }] }
    });
    const { result } = await runOpen(s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.screenshotPath).toBeUndefined();
  });
});

describe("honest recovery and the foreground gate", () => {
  it("dismiss: absent / dismissed / still-up / error / unavailable are reported as observed", async () => {
    const mk = (present: boolean[], throws = false): StudioUi => ({
      foreground: async () => ({ isStudio: true, title: "" }),
      focus: async () => undefined,
      openDialogPresent: async () => {
        if (throws) throw new Error("uia dump failed");
        return present.shift() ?? false;
      },
      dismissOpenDialog: async () => undefined,
      screenshot: async () => null
    });
    const logs: string[] = [];
    const log = (l: string): number => logs.push(l);
    expect(await dismissOpenDialogHonestly(mk([false]), log)).toBe("absent");
    expect(await dismissOpenDialogHonestly(mk([true, false]), log)).toBe("dismissed");
    expect(await dismissOpenDialogHonestly(mk([true, true]), log)).toBe("still-up");
    expect(await dismissOpenDialogHonestly(mk([], true), log)).toBe("error");
    expect(await dismissOpenDialogHonestly(undefined, log)).toBe("unavailable");
    expect(logs.filter((l) => l.includes("dismissed"))).toHaveLength(1);
    expect(logs).toContain("   recovery: Open from Environment dialog STILL UP");
  });

  it("waits while another window holds the foreground, naming it, then proceeds", async () => {
    const s = fakeStudio(mods(), {
      foreground: [
        { isStudio: false, title: "A browser window" },
        { isStudio: false, title: "A browser window" },
        { isStudio: false, title: "A browser window" }
      ]
    });
    const logs: string[] = [];
    const gate = makeForegroundGate(s.adapter.ui, (l) => logs.push(l), { sleep: noSleep, foregroundGapMs: 15_000 });
    expect(await gate()).toBe(true);
    expect(logs[0]).toContain("WAITING for Service Studio to be the foreground window (held by 'A browser window')");
    // Two checks saw another window (the title probe in between is a third answer): regained on the third check.
    expect(logs[logs.length - 1]).toContain("foreground regained after 30s");
  });

  it("an open whose gate never sees Studio gives up with FOREGROUND_TIMEOUT and makes no attempt", async () => {
    const away = Array.from({ length: 20 }, () => ({ isStudio: false, title: "Other" }));
    const s = fakeStudio(mods(), { foreground: away });
    const logs: string[] = [];
    const gate = makeForegroundGate(s.adapter.ui, (l) => logs.push(l), { sleep: noSleep, foregroundTries: 3, foregroundGapMs: 1 });
    const open = makeOpenWithRetry(s.adapter, (l) => logs.push(l), gate, { sleep: noSleep });
    const result = await open("alpha");
    expect(result).toMatchObject({ ok: false, attempts: 0, failure: { code: "FOREGROUND_TIMEOUT", kind: "foreground" } });
    expect(s.events).not.toContain("open:alpha");
  });

  it("idle wait gives up after its budget while a Progress window stays in front", async () => {
    const progress = Array.from({ length: 10 }, () => ({ isStudio: true, title: "Progress" }));
    const s = fakeStudio(mods(), { foreground: progress });
    const logs: string[] = [];
    expect(await waitForStudioIdle(s.adapter.ui, (l) => logs.push(l), { sleep: noSleep, idleGapMs: 5, idleMaxMs: 10 })).toBe(false);
    expect(logs[0]).toContain("Studio still busy ('Progress')");
  });

  it("the helper-backed UI maps osopener's helper commands and checks nothing it did not see", async () => {
    const calls: Array<[string, unknown]> = [];
    const ui = createHelperStudioUi(
      {
        run: async (command, args) => {
          calls.push([command, args]);
          if (command === "foreground-title") return { ok: true, isStudio: false, title: "Editor" };
          if (command === "uia-dump") return { ok: true, nodes: [{ name: "Open from Environment" }] };
          if (command === "screenshot") return { ok: true, path: "shot.png" };
          return { ok: true };
        }
      },
      noSleep
    );
    expect(await ui.foreground()).toEqual({ isStudio: false, title: "Editor" });
    expect(await ui.openDialogPresent()).toBe(true);
    await ui.dismissOpenDialog();
    expect(await ui.screenshot("x.png")).toBe("shot.png");
    expect(calls.map((c) => c[0])).toEqual(["foreground-title", "uia-dump", "uia-click", "send-keys", "screenshot"]);
    expect(calls[2][1]).toEqual({ Name: "^Open from Environment$", Depth: 3 });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* One-module refresh                                                                            */
/* -------------------------------------------------------------------------------------------- */

describe("refreshModule: --module M", () => {
  it("fails with RUN_CAPTURES_MISSING naming every other module without a capture, before touching Studio", async () => {
    const graphDir = tmp();
    const s = fakeStudio(mods());
    // Capture only alpha and beta.
    await runScope({ ...common(graphDir, s, []), scope: { name: "demo", modules: ["alpha", "beta"] } });
    const s2 = fakeStudio(mods());
    let caught: unknown;
    try {
      await refreshModule({ ...common(graphDir, s2, []), module: "alpha" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OsgraphToolError);
    expect((caught as OsgraphToolError).code).toBe("RUN_CAPTURES_MISSING");
    expect((caught as OsgraphToolError).message).toContain("gamma, delta");
    expect((caught as OsgraphToolError).message).toContain("osgraph run --scope demo");
    expect((caught as OsgraphToolError).details).toMatchObject({ missing: ["gamma", "delta"] });
    expect(s2.events).toEqual([]);
  });

  it("rejects a module outside the scope", async () => {
    const s = fakeStudio(mods());
    await expect(refreshModule({ ...common(tmp(), s, []), module: "nope" })).rejects.toMatchObject({ code: "SCOPE_INVALID" });
  });

  it("re-reads only M, closes the tab it opened, drops the transient stage entry, and matches a full re-extract byte for byte", async () => {
    const graphDir = tmp();
    await runScope({ ...common(graphDir, fakeStudio(mods()), []) });
    const paths = resolveScopeArtifactPaths(graphDir, "demo");
    const before = read(paths.graph);

    // beta changed in Studio: it now has three client actions.
    const changed = [
      syntheticWideModule(2, "alpha"),
      syntheticWideModule(3, "beta"),
      syntheticWideModule(2, "gamma"),
      syntheticWideModule(2, "delta")
    ];
    const s = fakeStudio(changed);
    const logs: string[] = [];
    const result = await refreshModule({ ...common(graphDir, s, logs, T1), module: "beta" });

    // Only beta was read.
    expect(new Set(s.reader.calls.filter((c) => c.module !== "*").map((c) => c.module))).toEqual(new Set(["beta"]));
    expect(s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"))).toEqual(["open:beta", "close:beta"]);
    expect(s.inFlightAtClose).toEqual([0]);
    expect(result).toMatchObject({ module: "beta", openedHere: true, closed: true, stageEntryRemoved: true, stageFinalized: false });
    expect(readStage(graphDir, "demo").entries).toEqual([]);

    const after = read(paths.graph);
    const flowsAfter = read(paths.flows);
    expect(after).not.toBe(before);
    expect(after).toContain("A_Act02");

    // A plain offline re-extract over the same captures writes the very same bytes.
    reextractScope({ scope: SCOPE, graphDir, snapshotPath: paths.graph, rules, now: () => T1 });
    expect(read(paths.graph)).toBe(after);
    expect(read(paths.flows)).toBe(flowsAfter);

    // Every other module's capture age is reported, measured from its own capture.
    expect(result.otherCaptures.map((c) => c.module).sort()).toEqual(["alpha", "delta", "gamma"]);
    for (const c of result.otherCaptures) {
      expect(c.capturedAt).toBe(T0.toISOString());
      expect(c.ageMs).toBe(T1.getTime() - T0.getTime());
    }
    expect(logs.some((l) => l.includes("alpha captured 2026-11-01T00:00:00.000Z (2d 6h old)"))).toBe(true);
  });

  it("leaves an already-open M open and keeps a stage entry that predates the refresh", async () => {
    const graphDir = tmp();
    await runScope({ ...common(graphDir, fakeStudio(mods()), []) });
    // An interrupted full run had staged beta.
    const pre = fakeStudio(mods(), { userOpen: ["beta"] });
    await stageModule({
      scope: SCOPE,
      module: "beta",
      graphDir,
      snapshotPath: resolveScopeArtifactPaths(graphDir, "demo").graph,
      session: pre.createSession(),
      rules,
      now: () => T0,
      retryDelayMs: 0
    });
    const s = fakeStudio(mods(), { userOpen: ["beta"] });
    const result = await refreshModule({ ...common(graphDir, s, [], T1), module: "beta" });
    expect(result).toMatchObject({ openedHere: false, closed: false, stageEntryRemoved: false });
    expect(s.events.filter((e) => e.startsWith("open:") || e.startsWith("close:"))).toEqual([]);
    expect(readStage(graphDir, "demo").entries.map((e) => e.module)).toEqual(["beta"]);
  });

  it("an open that fails surfaces MODULE_OPEN_FAILED with osopener's real error", async () => {
    const graphDir = tmp();
    await runScope({ ...common(graphDir, fakeStudio(mods()), []) });
    const s = fakeStudio(mods(), {
      openScript: { beta: [{ opened: false, error: { code: "UIA_ELEMENT_NOT_FOUND", message: "row not found" } }] }
    });
    await expect(refreshModule({ ...common(graphDir, s, [], T1), module: "beta" })).rejects.toMatchObject({
      code: "MODULE_OPEN_FAILED",
      message: expect.stringContaining("UIA_ELEMENT_NOT_FOUND (other): row not found")
    });
  });

  it("requireOtherCaptures sorts oldest first and formatAge is compact", () => {
    expect(formatAge(42_000)).toBe("42s");
    expect(formatAge(7 * 60_000)).toBe("7m");
    expect(formatAge(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatAge(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(() => requireOtherCaptures(tmp(), SCOPE, "alpha", T1)).toThrow(/3 other module\(s\) have no raw capture/);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The CLI: the site URL comes first                                                             */
/* -------------------------------------------------------------------------------------------- */

describe("osgraph run (CLI)", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const runCli = (args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("needs the Service Studio endpoint at start (#7)", async () => {
    const r = await runCli(["run", "--scope", "demo"], { OSGRAPH_SERVICESTUDIO_URL: "", OSGRAPH_PROGRESS_SITE: "off" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("CONFIG_MISSING");
  });

  it("prints the progress site's URL before it loads osopener, and fails clearly when osopener is absent", async () => {
    const root = tmp();
    const scopesDir = join(root, "scopes");
    mkdirSync(scopesDir, { recursive: true });
    writeFileSync(join(scopesDir, "demo.json"), JSON.stringify({ name: "demo", modules: ["alpha"] }));
    const r = await runCli(["run", "--scope", "demo"], {
      OSGRAPH_SERVICESTUDIO_URL: "http://127.0.0.1:9/mcp",
      OSGRAPH_SCOPES_DIR: scopesDir,
      OSGRAPH_GRAPH_DIR: join(root, "graphs"),
      OSGRAPH_OSOPENER_DIST: join(root, "no-osopener"),
      OSGRAPH_PROGRESS_HOST: "127.0.0.1",
      OSGRAPH_PROGRESS_PORT: String(20_000 + Math.floor(Math.random() * 20_000))
    });
    expect(r.code).toBe(1);
    const urlAt = r.stderr.search(/http:\/\/127\.0\.0\.1:\d+/);
    const failAt = r.stderr.indexOf("OSOPENER_UNAVAILABLE");
    expect(urlAt).toBeGreaterThanOrEqual(0);
    expect(failAt).toBeGreaterThan(urlAt);
    expect(r.stderr).toContain("osopener is not installed");
    // Nothing was staged or captured.
    expect(existsSync(join(root, "graphs", "demo", "stage"))).toBe(false);
  }, 30_000);

  it("rejects a bad --max-open as a usage error", async () => {
    const r = await runCli(["run", "--scope", "demo", "--max-open", "0"], {
      OSGRAPH_SERVICESTUDIO_URL: "http://127.0.0.1:9/mcp",
      OSGRAPH_PROGRESS_SITE: "off"
    });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("--max-open must be an integer >= 1");
  });
});
