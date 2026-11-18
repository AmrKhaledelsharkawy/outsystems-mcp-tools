/**
 * Depth-N discovery: the BFS, the runQuery answer parser, and the job runner.
 *
 * The BFS is tested against an injected `DiscoverLive`, so every open/close/query is observable
 * and no Service Studio is involved. The behaviours that matter most are the ones that protect
 * the user's Studio: never re-opening an already-open module, and always closing what the job
 * opened — including on failure, because leaked tabs are what make Studio crawl.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CacheEntry,
  type DiscoverLive,
  type DiscoverStatus,
  DEFAULT_MAX_MODULES,
  DISCOVERY_ERROR_MAX,
  MAX_DEPTH,
  discoveryLayerOf,
  discoveryOpener,
  parseReferences,
  parseRequest,
  runDiscovery
} from "../src/progress/discover.js";
import { ChildProcessDiscovery, discoveryAvailable, discoveryUnavailableReason } from "../src/progress/discovery.js";
import {
  classifyOpenFailure,
  createOsopenerAdapter,
  describeOsopenerFailure,
  loadOsopenerAdapter,
  OSOPENER_ENTRY_FILES,
  OsopenerOperationError,
  type OsopenerTools
} from "../src/osopener/adapter.js";

describe("parseRequest", () => {
  it("clamps depth and the module cap into sane bounds", () => {
    expect(parseRequest({ starters: ["A"], depth: 99 }).depth).toBe(MAX_DEPTH);
    expect(parseRequest({ starters: ["A"], depth: 0 }).depth).toBe(1);
    expect(parseRequest({ starters: ["A"], maxModules: 99_999 }).maxModules).toBe(500);
    expect(parseRequest({ starters: ["A"] }).maxModules).toBe(DEFAULT_MAX_MODULES);
  });

  it("accepts starters as an array or a delimited string, de-duplicated", () => {
    expect(parseRequest({ starters: "A, B; C  A" }).starters).toEqual(["A", "B", "C"]);
    expect(parseRequest({ starters: [" A ", "A", "B"] }).starters).toEqual(["A", "B"]);
  });

  it("defaults the two safety-ish switches on and dryRun off", () => {
    const r = parseRequest({ starters: ["A"] });
    expect(r.pruneByLayer).toBe(true);
    expect(r.useCache).toBe(true);
    expect(r.dryRun).toBe(false);
  });
});

describe("discoveryLayerOf", () => {
  it("reads MOD layer suffixes and marks foreign modules", () => {
    expect(discoveryLayerOf("MOD_X_BL")).toBe("BL");
    expect(discoveryLayerOf("MOD_X_LKP")).toBe("LKP");
    expect(discoveryLayerOf("MOD_Weird")).toBe("OTHER");
    expect(discoveryLayerOf("OutSystemsUI")).toBe("UI/EXTERNAL");
  });
});

describe("parseReferences", () => {
  it("collects names under References", () => {
    const text = JSON.stringify({ Root: { References: [{ Name: "MOD_A_BL" }, { Name: "MOD_B_CW" }] } });
    expect(parseReferences(text).sort()).toEqual(["MOD_A_BL", "MOD_B_CW"]);
  });

  it("digs the JSON out of surrounding prose", () => {
    const text = `Here you go:\n{"References":[{"Name":"MOD_A_BL"}]}\nhope that helps`;
    expect(parseReferences(text)).toEqual(["MOD_A_BL"]);
  });

  it("handles a double-encoded answer", () => {
    const inner = JSON.stringify({ References: [{ Name: "MOD_A_BL" }] });
    expect(parseReferences(JSON.stringify({ payload: inner }))).toEqual(["MOD_A_BL"]);
  });

  it("ignores Name fields that are not under References", () => {
    const text = JSON.stringify({ Name: "NotAReference", References: [{ Name: "MOD_A_BL" }] });
    expect(parseReferences(text)).toEqual(["MOD_A_BL"]);
  });

  it("returns empty for a module that genuinely references nothing", () => {
    expect(parseReferences(JSON.stringify({ References: [] }))).toEqual([]);
  });

  it("throws rather than inventing an empty graph when the answer is unrecognisable", () => {
    // The dangerous case: a silent [] here would be recorded as "references nothing".
    expect(() => parseReferences("ERROR: module not open")).toThrow(/unexpected runQuery answer/);
  });
});

describe("runDiscovery", () => {
  interface Calls {
    opened: string[];
    closed: string[];
    queried: string[];
  }

  function live(refs: Record<string, string[]>, open: string[] = [], failOn: string[] = []): { live: DiscoverLive; calls: Calls } {
    const calls: Calls = { opened: [], closed: [], queried: [] };
    return {
      calls,
      live: {
        openModules: async () => new Set(open.map((m) => m.toLowerCase())),
        references: async (module) => {
          calls.queried.push(module);
          if (failOn.includes(module)) throw new Error(`runQuery failed for ${module}`);
          return refs[module] ?? [];
        },
        open: async (module) => {
          calls.opened.push(module);
        },
        close: async (module) => {
          calls.closed.push(module);
        }
      }
    };
  }

  const run = async (
    request: Partial<Parameters<typeof parseRequest>[0]> & { starters: string[] },
    over: { live?: DiscoverLive; cache?: Map<string, CacheEntry>; aliases?: Record<string, string>; cancelled?: () => boolean } = {}
  ): Promise<DiscoverStatus> =>
    runDiscovery({
      request: parseRequest(request),
      cache: over.cache ?? new Map(),
      aliases: over.aliases ?? {},
      live: over.live,
      report: () => undefined,
      cancelled: over.cancelled
    });

  it("walks references breadth-first to the requested depth", async () => {
    const { live: l } = live({ MOD_A_BL: ["MOD_B_CW"], MOD_B_CW: ["MOD_C_SL"] });
    const status = await run({ starters: ["MOD_A_BL"], depth: 2 }, { live: l });

    const byName = new Map(status.modules.map((m) => [m.module, m]));
    expect(byName.get("MOD_A_BL")?.level).toBe(0);
    expect(byName.get("MOD_B_CW")?.level).toBe(1);
    expect(byName.get("MOD_C_SL")?.level).toBe(2);
    // Depth 2 expands levels 0 and 1; level 2 is listed but not expanded.
    expect(byName.get("MOD_C_SL")?.state).toBe("listed");
    expect(byName.get("MOD_C_SL")?.source).toBe("depth limit");
    expect(status.edges).toEqual([
      { from: "MOD_A_BL", to: "MOD_B_CW" },
      { from: "MOD_B_CW", to: "MOD_C_SL" }
    ]);
    expect(status.done).toBe(true);
  });

  it("never re-opens a module that is already open, and never closes it either", async () => {
    const { live: l, calls } = live({ MOD_A_BL: [] }, ["MOD_A_BL"]);
    await run({ starters: ["MOD_A_BL"] }, { live: l });

    expect(calls.opened).toEqual([]);
    expect(calls.closed).toEqual([]);
    expect(calls.queried).toEqual(["MOD_A_BL"]);
  });

  it("closes a module it opened itself", async () => {
    const { live: l, calls } = live({ MOD_A_BL: [] });
    await run({ starters: ["MOD_A_BL"] }, { live: l });

    expect(calls.opened).toEqual(["MOD_A_BL"]);
    expect(calls.closed).toEqual(["MOD_A_BL"]);
  });

  it("still closes the module when the query fails", async () => {
    const { live: l, calls } = live({}, [], ["MOD_A_BL"]);
    const status = await run({ starters: ["MOD_A_BL"] }, { live: l });

    expect(calls.opened).toEqual(["MOD_A_BL"]);
    // The leak this guards against is what makes Service Studio crawl past ~30 tabs.
    expect(calls.closed).toEqual(["MOD_A_BL"]);
    expect(status.modules[0]?.state).toBe("failed");
    expect(status.modules[0]?.error).toContain("runQuery failed");
  });

  it("opens the aliased name when the scope spells a module differently", async () => {
    const { live: l, calls } = live({ REAL_NAME: [] });
    await run({ starters: ["MOD_Alias_BL"] }, { live: l, aliases: { MOD_Alias_BL: "REAL_NAME" } });

    expect(calls.opened).toEqual(["REAL_NAME"]);
    expect(calls.queried).toEqual(["REAL_NAME"]);
    expect(calls.closed).toEqual(["REAL_NAME"]);
  });

  it("prunes LKP modules without opening them, and says so", async () => {
    const { live: l, calls } = live({ MOD_A_BL: ["MOD_L_LKP"] });
    const status = await run({ starters: ["MOD_A_BL"], depth: 2 }, { live: l });

    const lkp = status.modules.find((m) => m.module === "MOD_L_LKP");
    expect(lkp?.state).toBe("leaf");
    expect(lkp?.source).toContain("LKP");
    expect(calls.opened).not.toContain("MOD_L_LKP");
  });

  it("expands an LKP when pruning is turned off, because the rule can be broken", async () => {
    const { live: l, calls } = live({ MOD_A_BL: ["MOD_L_LKP"], MOD_L_LKP: ["MOD_Sneaky_BL"] });
    const status = await run({ starters: ["MOD_A_BL"], depth: 2, pruneByLayer: false }, { live: l });

    expect(calls.queried).toContain("MOD_L_LKP");
    expect(status.modules.some((m) => m.module === "MOD_Sneaky_BL")).toBe(true);
  });

  it("treats a non-MOD module as a leaf without touching Studio", async () => {
    const { live: l, calls } = live({ MOD_A_BL: ["OutSystemsUI"] });
    const status = await run({ starters: ["MOD_A_BL"], depth: 3 }, { live: l });

    const leaf = status.modules.find((m) => m.module === "OutSystemsUI");
    expect(leaf?.state).toBe("leaf");
    expect(leaf?.source).toBe("not a MOD module");
    expect(calls.opened).not.toContain("OutSystemsUI");
  });

  it("uses the cache instead of Studio, and marks the row's source", async () => {
    const cache = new Map<string, CacheEntry>([
      ["mod_a_bl", { refs: ["MOD_B_CW"], at: "2026-11-02T10:00:00.000Z", source: "live runQuery" }]
    ]);
    const { live: l, calls } = live({});
    // Depth 1 so only the cached module is expanded — isolating "the cache replaced the query".
    const status = await run({ starters: ["MOD_A_BL"], depth: 1 }, { live: l, cache });

    expect(calls.opened).toEqual([]);
    expect(calls.queried).toEqual([]);
    expect(status.modules[0]?.source).toContain("cache");
    // Its references still feed the walk; they are just listed rather than expanded at depth 1.
    expect(status.modules.some((m) => m.module === "MOD_B_CW")).toBe(true);
  });

  it("marks live answers for caching but not cached ones", async () => {
    const { live: l } = live({ MOD_A_BL: [] });
    const status = await run({ starters: ["MOD_A_BL"] }, { live: l });
    expect(status.modules[0]?.cacheSource).toBe("live");
  });

  it("a dry run touches Studio for nothing and skips the uncached", async () => {
    const status = await run({ starters: ["MOD_A_BL"], dryRun: true });
    expect(status.modules[0]?.state).toBe("skipped");
    expect(status.modules[0]?.source).toBe("dry run: not cached");
    expect(status.stopped).toBeNull();
  });

  it("stops at the module cap rather than walking an entire estate", async () => {
    const { live: l } = live({ MOD_A_BL: ["MOD_B_CW", "MOD_C_SL", "MOD_D_UI"] });
    const status = await run({ starters: ["MOD_A_BL"], depth: 3, maxModules: 2 }, { live: l });

    expect(status.stopped).toContain("2-module cap");
    expect(status.modules.length).toBeLessThanOrEqual(3);
  });

  it("reports Studio being unreachable instead of hanging", async () => {
    const status = await run(
      { starters: ["MOD_A_BL"] },
      {
        live: {
          openModules: async () => {
            throw new Error("ECONNREFUSED");
          },
          references: async () => [],
          open: async () => undefined,
          close: async () => undefined
        }
      }
    );
    expect(status.stopped).toContain("Studio unreachable");
    expect(status.done).toBe(true);
  });

  it("reports when there is no live connection at all", async () => {
    const status = await run({ starters: ["MOD_A_BL"] });
    expect(status.stopped).toContain("osopener could not be loaded");
  });

  it("stops promptly when cancelled, keeping what it already found", async () => {
    const { live: l } = live({ MOD_A_BL: ["MOD_B_CW"], MOD_B_CW: [] });
    let calls = 0;
    const status = await run({ starters: ["MOD_A_BL"], depth: 2 }, { live: l, cancelled: () => ++calls > 1 });
    expect(status.stopped).toBe("cancelled");
    expect(status.done).toBe(true);
  });

  it("expands each module once even when several modules reference it", async () => {
    const { live: l, calls } = live({
      MOD_A_BL: ["MOD_Shared_CS"],
      MOD_B_CW: ["MOD_Shared_CS"],
      MOD_Shared_CS: []
    });
    await run({ starters: ["MOD_A_BL", "MOD_B_CW"], depth: 3 }, { live: l });

    expect(calls.queried.filter((m) => m === "MOD_Shared_CS")).toHaveLength(1);
  });

  it("reports an ETA for the frontier it knows about", async () => {
    const { live: l } = live({ MOD_A_BL: [] });
    const seen: DiscoverStatus[] = [];
    await runDiscovery({
      request: parseRequest({ starters: ["MOD_A_BL"], depth: 2 }),
      cache: new Map(),
      aliases: {},
      live: l,
      report: (s) => seen.push(structuredClone(s))
    });
    // The first report, before any work: one queued module needing an open.
    expect(seen[0]?.etaMs).toBeGreaterThan(0);
    expect(seen.at(-1)?.etaMs).toBe(0);
  });
});

describe("ChildProcessDiscovery", () => {
  let root: string;
  let runner: ChildProcessDiscovery;
  const spawned: { args: readonly string[] }[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osgraph-disc-"));
    mkdirSync(join(root, "scopes"), { recursive: true });
    mkdirSync(join(root, "graph"), { recursive: true });
    spawned.length = 0;
    runner = new ChildProcessDiscovery({
      stateDir: join(root, "state"),
      scopesDir: join(root, "scopes"),
      graphDir: join(root, "graph"),
      env: {},
      jobScript: "discover.js",
      spawnFn: ((_cmd: string, args: readonly string[]) => {
        spawned.push({ args });
        return { exitCode: null, killed: false, kill: vi.fn() } as never;
      }) as never
    });
  });
  // This teardown is a Windows canary, so do not soften it. An ENOTEMPTY here means something
  // under `root` still holds an open handle — on Windows that blocks rmdir outright, and no number
  // of retries clears it (CI proved that: 10 retries, still ENOTEMPTY, 2.8 s per test). It caught a
  // real descriptor leak in `ChildProcessDiscovery`, which `spawnFn` being a fake made visible:
  // the real `spawn` duplicates the stderr fd, so the leak was ours to close either way.
  // `maxRetries` stays only for genuinely transient AV/indexer interference, which is a different
  // failure from a held handle.
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it("writes the normalised request and spawns the job", async () => {
    const { id } = await runner.start({ starters: ["MOD_A_BL"], depth: 2 });
    expect(id).toMatch(/^\d{4}-/);
    const jobDir = spawned[0]?.args[1] as string;
    const request = JSON.parse(readFileSync(join(jobDir, "request.json"), "utf8")) as Record<string, unknown>;
    expect(request["starters"]).toEqual(["MOD_A_BL"]);
    expect(request["depth"]).toBe(2);
  });

  it("refuses a second concurrent job", async () => {
    await runner.start({ starters: ["MOD_A_BL"] });
    await expect(runner.start({ starters: ["MOD_B_CW"] })).rejects.toThrow(/already running/);
  });

  it("refuses a request with no starters", async () => {
    await expect(runner.start({ starters: [] })).rejects.toThrow(/at least one starter/);
  });

  it("reports none when no job has ever run", () => {
    expect(runner.status(null)).toEqual({ none: true });
  });

  it("refuses to save a scope from an unfinished job", async () => {
    await runner.start({ starters: ["MOD_A_BL"] });
    expect(() => runner.save({ name: "newscope" })).toThrow(/has not finished/);
  });

  it("rejects an unsafe scope name before touching disk", () => {
    for (const name of ["../escape", "with space", "", "a/b"]) {
      expect(() => runner.save({ name })).toThrow(/Scope name/);
    }
  });

  it("saves a finished job as a scope, keeping only openable MOD modules", async () => {
    const { id } = await runner.start({ starters: ["MOD_A_BL"] });
    const jobDir = spawned[0]?.args[1] as string;
    writeFileSync(
      join(jobDir, "status.json"),
      JSON.stringify({
        done: true,
        modules: [
          { module: "MOD_A_BL", state: "expanded" },
          { module: "MOD_B_CW", state: "expanded" },
          { module: "OutSystemsUI", state: "leaf", source: "not a MOD module" },
          { module: "MOD_Broken_BL", state: "failed" }
        ]
      })
    );

    const saved = runner.save({ id, name: "newscope" });
    expect(saved.count).toBe(2);
    const scope = JSON.parse(readFileSync(join(root, "scopes", "newscope.json"), "utf8")) as { modules: string[] };
    expect(scope.modules).toEqual(["MOD_A_BL", "MOD_B_CW"]);
  });

  it("refuses to overwrite an existing scope unless told to", async () => {
    const { id } = await runner.start({ starters: ["MOD_A_BL"] });
    const jobDir = spawned[0]?.args[1] as string;
    writeFileSync(join(jobDir, "status.json"), JSON.stringify({ done: true, modules: [{ module: "MOD_A_BL", state: "expanded" }] }));

    runner.save({ id, name: "dup" });
    expect(() => runner.save({ id, name: "dup" })).toThrow(/already exists/);
    expect(runner.save({ id, name: "dup", overwrite: true }).count).toBe(1);
  });

  it("collects known module names from scopes, snapshots and the cache", () => {
    writeFileSync(join(root, "scopes", "one.json"), JSON.stringify({ name: "one", modules: ["MOD_FromScope_BL"] }));
    mkdirSync(join(root, "graph", "one"), { recursive: true });
    writeFileSync(
      join(root, "graph", "one", "graph.json"),
      JSON.stringify({ nodes: [{ kind: "module", module: "MOD_FromGraph_CW" }, { kind: "entity", module: "ignored" }] })
    );
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "discover-cache.json"), JSON.stringify({ MOD_FromCache_SL: { refs: [] } }));

    expect(runner.knownModules()).toEqual(["MOD_FromCache_SL", "MOD_FromGraph_CW", "MOD_FromScope_BL"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The shared osopener adapter (issue #6). Lives in this published file because discovery is its */
/* first caller; every input below is synthetic and nothing touches Service Studio or osopener.  */
/* -------------------------------------------------------------------------------------------- */

/** osopener's real wording for the failure that cost a 287-module run 5.5 h. */
const STUDIO_BUSY_MESSAGE =
  "'Open from Environment' did not produce a settled Studio dialog window (only a transient Progress window was seen)";

function scriptedTools(script: { open?: unknown[]; close?: unknown[] }): OsopenerTools & {
  calls: { open: Record<string, unknown>[]; close: Record<string, unknown>[] };
} {
  const calls = { open: [] as Record<string, unknown>[], close: [] as Record<string, unknown>[] };
  const next = async (queue: unknown[] | undefined): Promise<unknown> => {
    const item = queue?.shift();
    if (item instanceof Error) throw item;
    return item;
  };
  return {
    calls,
    open: async (input) => {
      calls.open.push(input);
      return next(script.open);
    },
    close: async (input) => {
      calls.close.push(input);
      return next(script.close);
    }
  };
}

const OPENED = { opened: true, alreadyOpen: false, studioLaunched: false, durationMs: 15_000, steps: [] };
const ALREADY_OPEN = { opened: true, alreadyOpen: true, studioLaunched: false, durationMs: 20, steps: [] };
const CLOSED = { closed: true, alreadyClosed: false, durationMs: 4_500, steps: [] };
const UNSAVED_REFUSAL = {
  closed: false,
  alreadyClosed: false,
  durationMs: 900,
  steps: [
    { step: "listApps", ok: true, ms: 10 },
    { step: "tab-close", ok: false, ms: 800, detail: "save prompt cancelled with Esc" }
  ],
  error: {
    code: "UNSAVED_CHANGES_DIALOG",
    message: "module has unsaved changes; the close was cancelled and the module stays open"
  }
};

describe("classifyOpenFailure", () => {
  it("reads the transient-Progress-window failure as studio-busy, not as a stuck dialog", () => {
    expect(classifyOpenFailure(STUDIO_BUSY_MESSAGE)).toBe("studio-busy");
  });

  it("sorts foreground, open-dialog and everything else", () => {
    expect(classifyOpenFailure("foreground window belongs to pid 4242")).toBe("foreground");
    expect(classifyOpenFailure("'Open from Environment' list never showed the module")).toBe("open-dialog");
    expect(classifyOpenFailure("module 'MOD_Demo_X_BL' not found in the environment")).toBe("other");
    expect(classifyOpenFailure(undefined)).toBe("other");
  });
});

describe("classifyOpenFailure: osopener's real refusals", () => {
  // osopener's two refusals (osopener/scripts/studio-ui.ps1) both end "refusing to send input".
  const UNSAVED = "Foreground window title matches /save|unsaved/i; refusing to send input.";
  const NOT_FOREGROUND = "Foreground window belongs to pid 4242, not Service Studio; refusing to send input.";

  it("never reads a save prompt as a transient foreground problem", () => {
    expect(classifyOpenFailure(UNSAVED, "UNSAVED_CHANGES_DIALOG")).toBe("other");
    expect(classifyOpenFailure(UNSAVED)).toBe("other");
  });

  it("reads STUDIO_NOT_FOREGROUND as foreground", () => {
    expect(classifyOpenFailure(NOT_FOREGROUND, "STUDIO_NOT_FOREGROUND")).toBe("foreground");
    expect(classifyOpenFailure(NOT_FOREGROUND)).toBe("foreground");
  });

  it("classifies a failed open by osopener's code", async () => {
    const adapter = createOsopenerAdapter(
      scriptedTools({
        open: [
          { opened: false, steps: [], error: { code: "UNSAVED_CHANGES_DIALOG", message: UNSAVED, details: { foregroundTitle: "Save changes?" } } }
        ]
      }),
      "/fake/dist"
    );
    expect(await adapter.open("MOD_Demo_X_BL")).toMatchObject({
      ok: false,
      failure: { code: "UNSAVED_CHANGES_DIALOG", kind: "other", details: { foregroundTitle: "Save changes?" } }
    });
  });
});

describe("osopener adapter: open", () => {
  it("keeps osopener's full error — code, untruncated message, failed step — plus a classification", async () => {
    const longTail = " x".repeat(200);
    const tools = scriptedTools({
      open: [
        {
          opened: false,
          alreadyOpen: false,
          studioLaunched: false,
          durationMs: 76_000,
          steps: [
            { step: "focus", ok: true, ms: 5 },
            { step: "open-dialog", ok: false, ms: 75_000, detail: "only a Progress window" }
          ],
          screenshotPath: "C:/tmp/shot.png",
          error: {
            code: "UIA_ELEMENT_NOT_FOUND",
            message: STUDIO_BUSY_MESSAGE + longTail,
            details: { labels: ["Progress"] }
          }
        }
      ]
    });
    const adapter = createOsopenerAdapter(tools, "/fake/dist");
    const outcome = await adapter.open("MOD_Demo_X_BL");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("UIA_ELEMENT_NOT_FOUND");
    expect(outcome.failure.message).toBe(STUDIO_BUSY_MESSAGE + longTail);
    expect(outcome.failure.failedStep).toEqual({ step: "open-dialog", detail: "only a Progress window" });
    expect(outcome.failure.kind).toBe("studio-busy");
    expect(outcome.failure.steps).toHaveLength(2);
    expect(outcome.failure.screenshotPath).toBe("C:/tmp/shot.png");
    expect(outcome.failure.details).toEqual({ labels: ["Progress"] });
    expect(describeOsopenerFailure(outcome.failure)).toMatch(
      /^UIA_ELEMENT_NOT_FOUND \(studio-busy\): 'Open from Environment' did not produce .* \[step open-dialog: only a Progress window\]$/
    );
    expect(adapter.ownedModules()).toEqual([]);
  });

  it("turns a thrown handler into a failure instead of throwing", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [new Error("helper crashed")] }), "/fake/dist");
    expect(await adapter.open("MOD_Demo_X_BL")).toMatchObject({
      ok: false,
      failure: { code: "HANDLER_THREW", message: "helper crashed", kind: "other" }
    });
  });

  it("never reads a result as success unless osopener said opened: true", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [undefined, { opened: false }] }), "/fake/dist");
    expect(await adapter.open("MOD_Demo_X_BL")).toMatchObject({ ok: false, failure: { code: "NO_RESULT" } });
    expect(await adapter.open("MOD_Demo_X_BL")).toMatchObject({ ok: false, failure: { code: "UNKNOWN" } });
  });

  it("passes the module name and a timeout through to osopener", async () => {
    const tools = scriptedTools({ open: [OPENED] });
    await createOsopenerAdapter(tools, "/fake/dist").open("MOD_Demo_X_BL");
    expect(tools.calls.open[0]).toMatchObject({ name: "MOD_Demo_X_BL" });
    expect(typeof tools.calls.open[0]?.["timeoutMs"]).toBe("number");
  });
});

describe("osopener adapter: ownership and close", () => {
  it("owns what it opened, never what was already open", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [OPENED, ALREADY_OPEN] }), "/fake/dist");
    expect(await adapter.open("MOD_Demo_A_BL")).toMatchObject({ ok: true, openedHere: true, alreadyOpen: false });
    expect(await adapter.open("MOD_Demo_B_BL")).toMatchObject({ ok: true, openedHere: false, alreadyOpen: true });
    expect(adapter.owns("MOD_Demo_A_BL")).toBe(true);
    expect(adapter.owns("MOD_Demo_B_BL")).toBe(false);
    expect(adapter.ownedModules()).toEqual(["MOD_Demo_A_BL"]);
  });

  it("closeOwned refuses a module this process did not open, without calling osopener", async () => {
    const tools = scriptedTools({ open: [ALREADY_OPEN], close: [CLOSED] });
    const adapter = createOsopenerAdapter(tools, "/fake/dist");
    await adapter.open("MOD_Demo_B_BL");
    expect(await adapter.closeOwned("MOD_Demo_B_BL")).toMatchObject({ ok: false, failure: { code: "NOT_OWNED" } });
    expect(tools.calls.close).toEqual([]);
  });

  it("a successful close releases ownership", async () => {
    const tools = scriptedTools({ open: [OPENED], close: [CLOSED] });
    const adapter = createOsopenerAdapter(tools, "/fake/dist");
    await adapter.open("MOD_Demo_A_BL");
    expect(await adapter.closeOwned("MOD_Demo_A_BL")).toEqual({ ok: true, alreadyClosed: false, durationMs: 4_500 });
    expect(adapter.ownedModules()).toEqual([]);
    expect(tools.calls.close).toEqual([{ name: "MOD_Demo_A_BL" }]);
  });

  it("propagates osopener's refusal to close (unsaved changes) and keeps the tab as still owned", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [OPENED], close: [UNSAVED_REFUSAL] }), "/fake/dist");
    await adapter.open("MOD_Demo_A_BL");
    const outcome = await adapter.closeOwned("MOD_Demo_A_BL");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("UNSAVED_CHANGES_DIALOG");
    expect(outcome.failure.message).toContain("unsaved changes");
    expect(outcome.failure.failedStep).toEqual({ step: "tab-close", detail: "save prompt cancelled with Esc" });
    expect(adapter.owns("MOD_Demo_A_BL")).toBe(true);
  });

  it("reports alreadyClosed, and a thrown close as a failure", async () => {
    const adapter = createOsopenerAdapter(
      scriptedTools({ close: [{ closed: true, alreadyClosed: true, durationMs: 3, steps: [] }, new Error("boom")] }),
      "/fake/dist"
    );
    expect(await adapter.close("MOD_Demo_A_BL")).toMatchObject({ ok: true, alreadyClosed: true });
    expect(await adapter.close("MOD_Demo_A_BL")).toMatchObject({ ok: false, failure: { code: "HANDLER_THREW" } });
  });
});

describe("discoveryOpener", () => {
  it("throws osopener's code and message on a failed open", async () => {
    const adapter = createOsopenerAdapter(
      scriptedTools({
        open: [{ opened: false, steps: [], error: { code: "UIA_ELEMENT_NOT_FOUND", message: STUDIO_BUSY_MESSAGE } }]
      }),
      "/fake/dist"
    );
    await expect(discoveryOpener(adapter).open("MOD_Demo_A_BL")).rejects.toThrow(
      /^open failed: UIA_ELEMENT_NOT_FOUND \(studio-busy\): 'Open from Environment' did not produce/
    );
  });

  it("throws when osopener refuses the close", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [OPENED], close: [UNSAVED_REFUSAL] }), "/fake/dist");
    const live = discoveryOpener(adapter);
    await live.open("MOD_Demo_A_BL");
    await expect(live.close("MOD_Demo_A_BL")).rejects.toThrow(/close refused: UNSAVED_CHANGES_DIALOG/);
  });

  it("leaves a module osopener found already open alone when discovery asks to close it", async () => {
    const tools = scriptedTools({ open: [ALREADY_OPEN], close: [CLOSED] });
    const live = discoveryOpener(createOsopenerAdapter(tools, "/fake/dist"));
    await live.open("MOD_Demo_B_BL");
    await live.close("MOD_Demo_B_BL");
    expect(tools.calls.close).toEqual([]);
  });

  it("bounds the error text a discovery row stores, keeping the full failure on the error", async () => {
    const longMessage = STUDIO_BUSY_MESSAGE + " x".repeat(400);
    const adapter = createOsopenerAdapter(
      scriptedTools({ open: [{ opened: false, steps: [], error: { code: "UIA_ELEMENT_NOT_FOUND", message: longMessage } }] }),
      "/fake/dist"
    );
    const err = await discoveryOpener(adapter)
      .open("MOD_Demo_A_BL")
      .then(() => null, (e: unknown) => e as OsopenerOperationError);
    expect(err).toBeInstanceOf(OsopenerOperationError);
    expect(err?.message.length).toBeLessThanOrEqual(DISCOVERY_ERROR_MAX);
    expect(err?.failure.message).toBe(longMessage);
  });

  it("a module osopener found already open is reported as was-open and never closed", async () => {
    const tools = scriptedTools({ open: [ALREADY_OPEN], close: [CLOSED] });
    const status = await runDiscovery({
      request: parseRequest({ starters: ["MOD_Demo_A_BL"], depth: 1 }),
      cache: new Map(),
      aliases: {},
      live: {
        openModules: async () => new Set<string>(),
        references: async () => ["MOD_Demo_B_ST"],
        ...discoveryOpener(createOsopenerAdapter(tools, "/fake/dist"))
      },
      report: () => undefined
    });
    expect(status.modules.find((m) => m.module === "MOD_Demo_A_BL")?.source).toBe("live (was open)");
    expect(tools.calls.close).toEqual([]);
  });

  it("a refused close does not fail the walk, and the tab stays recorded as this process's", async () => {
    const adapter = createOsopenerAdapter(scriptedTools({ open: [OPENED], close: [UNSAVED_REFUSAL] }), "/fake/dist");
    const status = await runDiscovery({
      request: parseRequest({ starters: ["MOD_Demo_A_BL"], depth: 1 }),
      cache: new Map(),
      aliases: {},
      live: {
        openModules: async () => new Set<string>(),
        references: async () => ["MOD_Demo_B_ST"],
        ...discoveryOpener(adapter)
      },
      report: () => undefined
    });
    expect(status.stopped).toBeNull();
    expect(status.modules.find((m) => m.module === "MOD_Demo_A_BL")?.state).toBe("expanded");
    expect(adapter.owns("MOD_Demo_A_BL")).toBe(true);
  });
});

describe("loadOsopenerAdapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osgraph-osopener-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A synthetic osopener dist: real files, real dynamic import, scripted behaviour. */
  function writeFakeDist(overrides: Partial<Record<(typeof OSOPENER_ENTRY_FILES)[number], string>> = {}): string {
    const dist = join(dir, "dist");
    const files: Record<string, string> = {
      "config.js": [
        "export function loadConfig(env, options) {",
        "  if (!env.FAKE_OSOPENER_URL) {",
        '    const e = new Error("FAKE_OSOPENER_URL is not set.");',
        '    e.code = "CONFIG_MISSING";',
        "    throw e;",
        "  }",
        '  return { serviceStudioUrl: env.FAKE_OSOPENER_URL, powershellExe: "pwsh", helperScript: options.packageRoot };',
        "}"
      ].join("\n"),
      "servicestudio.js": "export class HttpServiceStudioClient { constructor(o) { this.o = o; } }",
      "helper.js": "export class PowerShellHelper { constructor(o) { this.o = o; } }",
      "tools/openModule.js": [
        "export const openModule = { async handler(input, ctx) {",
        "  if (!ctx.config.serviceStudioUrl) throw new Error('no config in ctx');",
        "  return { opened: true, alreadyOpen: false, studioLaunched: false, durationMs: 1, steps: [] };",
        "} };"
      ].join("\n"),
      "tools/closeModule.js": [
        "export const closeModule = { async handler() {",
        '  return { closed: false, alreadyClosed: false, durationMs: 1, steps: [], error: { code: "UNSAVED_CHANGES_DIALOG", message: "unsaved" } };',
        "} };"
      ].join("\n"),
      ...overrides
    };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(dist, file, ".."), { recursive: true });
      writeFileSync(join(dist, file), body);
    }
    return dist;
  }

  const ENV = { FAKE_OSOPENER_URL: "http://127.0.0.1:1/mcp" };

  it("absent: no location configured", async () => {
    const result = await loadOsopenerAdapter("", { env: {} });
    expect(result).toMatchObject({ ok: false, failure: { cause: "absent" } });
    if (!result.ok) expect(result.failure.message).toContain("OSGRAPH_OSOPENER_DIST");
  });

  it("absent: nothing at the configured location", async () => {
    const result = await loadOsopenerAdapter(join(dir, "nowhere"), { env: {} });
    expect(result).toMatchObject({ ok: false, failure: { cause: "absent" } });
    if (!result.ok) expect(result.failure.message).toMatch(/not installed at .*npm run build/);
  });

  it("absent: an incomplete build names the missing files", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "config.js"), "export function loadConfig() { return {}; }");
    const result = await loadOsopenerAdapter(join(dir, "dist"), { env: {} });
    expect(result).toMatchObject({ ok: false, failure: { cause: "absent" } });
    if (!result.ok) expect(result.failure.message).toContain("tools/openModule.js");
  });

  it("import-failed: a file that does not parse", async () => {
    const dist = writeFakeDist({ "helper.js": "export const = ;" });
    const result = await loadOsopenerAdapter(dist, { env: ENV });
    expect(result).toMatchObject({ ok: false, failure: { cause: "import-failed" } });
    if (!result.ok) expect(result.failure.detail).toBeTruthy();
  });

  it("import-failed: a build that does not export what osgraph needs", async () => {
    const dist = writeFakeDist({ "tools/closeModule.js": "export const somethingElse = 1;" });
    const result = await loadOsopenerAdapter(dist, { env: ENV });
    expect(result).toMatchObject({ ok: false, failure: { cause: "import-failed" } });
    if (!result.ok) expect(result.failure.message).toContain("closeModule.handler");
  });

  it("import-failed: an import that throws", async () => {
    const dist = writeFakeDist();
    const result = await loadOsopenerAdapter(dist, {
      env: ENV,
      importModule: async () => {
        throw new Error("ERR_MODULE_NOT_FOUND: zod");
      }
    });
    expect(result).toMatchObject({ ok: false, failure: { cause: "import-failed", detail: "ERR_MODULE_NOT_FOUND: zod" } });
  });

  it("config-rejected: keeps osopener's error code and message", async () => {
    const dist = writeFakeDist();
    const result = await loadOsopenerAdapter(dist, { env: {} });
    expect(result).toMatchObject({ ok: false, failure: { cause: "config-rejected", code: "CONFIG_MISSING" } });
    if (!result.ok) expect(result.failure.message).toContain("FAKE_OSOPENER_URL is not set");
  });

  it("loads a complete build, and its results flow through the adapter", async () => {
    const dist = writeFakeDist();
    const result = await loadOsopenerAdapter(dist, { env: ENV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.adapter.open("MOD_Demo_A_BL")).toMatchObject({ ok: true, openedHere: true });
    expect(result.adapter.ownedModules()).toEqual(["MOD_Demo_A_BL"]);
    expect(await result.adapter.closeOwned("MOD_Demo_A_BL")).toMatchObject({
      ok: false,
      failure: { code: "UNSAVED_CHANGES_DIALOG" }
    });
    expect(result.adapter.owns("MOD_Demo_A_BL")).toBe(true);
  });

  it("discoveryAvailable keeps its old answer: false when osopener is absent", async () => {
    expect(await discoveryAvailable(join(dir, "nowhere"))).toBe(false);
    expect(await discoveryUnavailableReason(join(dir, "nowhere"))).toMatchObject({ cause: "absent" });
  });
});
