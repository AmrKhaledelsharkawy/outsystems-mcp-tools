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
  MAX_DEPTH,
  discoveryLayerOf,
  parseReferences,
  parseRequest,
  runDiscovery
} from "../src/progress/discover.js";
import { ChildProcessDiscovery } from "../src/progress/discovery.js";

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
  // `maxRetries` is load-bearing on Windows, not defensive padding: the job directory is written
  // and re-read inside one test, and a recursive rmdir issued right after can still hit ENOTEMPTY
  // while Windows finishes releasing the directory entries. It fails only there, and only in
  // teardown — the assertions had already passed — so it surfaces as five unrelated test
  // failures. Node retries ENOTEMPTY/EBUSY/EPERM when told how many times to.
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
