/**
 * Depth-N module discovery: starter modules -> their references -> references of references.
 *
 * This is how a scope gets built without hand-listing 200 module names. It runs as a **child
 * process** of the osgraph server (`node dist/progress/discover.js <job-dir>`), reading
 * `<job-dir>/request.json` and writing `<job-dir>/status.json` (progress) then `result.json`.
 * A child, not an inline task, for three reasons: it is cancellable by signal, a crash in it
 * cannot take the MCP server down mid-rebuild, and its progress survives for the page to read.
 *
 * Why it is fast — this matters, because the naive version is unusable:
 *  1. ONE `runQuery` per module (`Root { References { Name } }`) returns the module's whole
 *     producer list. No element is read. The discarded alternative read every element at ~12.5 s.
 *  2. Cache first: a module a previous discovery already answered costs nothing.
 *  3. Already-open modules are queried first and never re-opened; a module this job opens is
 *     closed again right after its query, because Service Studio degrades past ~30 open tabs.
 *  4. Leaves are not expanded: non-MOD modules (platform, Forge) and — with `pruneByLayer` — LKP
 *     modules, which by the layer rules reference nothing MOD. Pruning skips their open+query but
 *     would also hide an LKP that breaks that rule, so it stays a visible option, not a silent one.
 *  5. Breadth-first with de-duplication: every module is expanded at most once, at its shallowest
 *     depth.
 *
 * Division of labour with osopener: `runQuery` and the open-module list come from osgraph's own
 * Service Studio client (so they reuse its token provider and error handling), and osopener is
 * loaded only for the two things nothing else can do — opening and closing a module in the live
 * Studio UI.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Hard bounds on a request. A depth-7 discovery of a large estate is a days-long accident. */
export const MAX_DEPTH = 6;
export const MAX_MODULES_CAP = 500;
export const DEFAULT_MAX_MODULES = 150;

/** Rough per-module costs, for the job's own ETA. Measured live: open 14-20 s, close ~4.5 s. */
export const COST = { cached: 0, alreadyOpen: 2_000, needsOpen: 25_000 } as const;

const LAYER_RE = /_(LKP|CS|CNF|ST|IS|BL|SL|CW|UI|Lib|Layouts|Theme|Th)$/i;

export interface DiscoverRequest {
  starters: string[];
  depth: number;
  pruneByLayer: boolean;
  useCache: boolean;
  maxModules: number;
  /** Cache only — never touches Service Studio. Safe to run during a rebuild. */
  dryRun: boolean;
}

export type DiscoverNodeState = "queued" | "expanded" | "leaf" | "listed" | "skipped" | "failed";

export interface DiscoverNode {
  module: string;
  level: number;
  layer: string;
  via: string | null;
  state: DiscoverNodeState;
  source: string | null;
  refs: string[] | null;
  ms: number | null;
  error: string | null;
  /** Set when this row's refs came from a live query, i.e. are worth caching. */
  cacheSource?: "live";
}

export interface DiscoverStatus {
  request: DiscoverRequest;
  startedAt: number;
  elapsedMs: number;
  done: boolean;
  stopped: string | null;
  current: { module: string; level: number; step: string } | null;
  counts: Record<string, number>;
  levels: number[];
  etaMs: number;
  etaNote: string;
  modules: DiscoverNode[];
  edges: { from: string; to: string }[];
}

/** One cached answer. Only live `runQuery` answers are ever stored — see `readCache`. */
export interface CacheEntry {
  refs: string[];
  at: string;
  source: string;
}

/** Normalises and clamps an untrusted request body. */
export function parseRequest(raw: unknown): DiscoverRequest {
  const body = (raw ?? {}) as Record<string, unknown>;
  const rawStarters = Array.isArray(body["starters"])
    ? body["starters"]
    : String(body["starters"] ?? "")
        .split(/[\s,;]+/)
        .filter(Boolean);
  const starters = [...new Set(rawStarters.map((s) => String(s).trim()).filter(Boolean))];
  const depth = Math.max(1, Math.min(MAX_DEPTH, Number(body["depth"]) || 1));
  const maxModules = Math.max(1, Math.min(MAX_MODULES_CAP, Number(body["maxModules"]) || DEFAULT_MAX_MODULES));
  return {
    starters,
    depth,
    pruneByLayer: body["pruneByLayer"] !== false,
    useCache: body["useCache"] !== false,
    maxModules,
    dryRun: body["dryRun"] === true
  };
}

/** Layer tag used for pruning and colouring. `UI/EXTERNAL` means "not ours". */
export function discoveryLayerOf(module: string): string {
  const m = LAYER_RE.exec(module);
  if (m?.[1]) return m[1].toUpperCase();
  return /^MOD_/i.test(module) ? "OTHER" : "UI/EXTERNAL";
}

/**
 * Collects every `Name` under a `References` key in `runQuery`'s answer.
 *
 * Tolerant by necessity: the tool returns JSON embedded in text, sometimes double-encoded (a JSON
 * string whose contents are themselves JSON), and the nesting depth of `References` is not
 * guaranteed. So this walks everything and recurses into any string that looks like JSON, rather
 * than asserting one shape and breaking on the next build.
 */
export function parseReferences(text: string): string[] {
  const names = new Set<string>();
  const walk = (value: unknown, underRefs: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, underRefs);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (underRefs && key === "Name" && typeof item === "string") names.add(item);
        walk(item, underRefs || key === "References");
      }
      return;
    }
    if (typeof value === "string" && /^\s*[{[]/.test(value)) {
      try {
        walk(JSON.parse(value), underRefs);
      } catch {
        /* not JSON after all */
      }
    }
  };

  const raw = String(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = /[{[][\s\S]*[}\]]/.exec(raw);
    parsed = match ? (JSON.parse(match[0]) as unknown) : null;
  }
  walk(parsed, false);
  // No names AND no sign of the key at all means the answer was not what we asked for — a silent
  // empty list here would be read as "this module references nothing", which is a wrong graph.
  if (names.size === 0 && !/References/.test(raw)) {
    throw new Error(`unexpected runQuery answer: ${raw.slice(0, 200)}`);
  }
  return [...names];
}

/** The live capabilities the job needs. Injected so the BFS is testable with no Studio at all. */
export interface DiscoverLive {
  /** Modules currently open, lower-cased. */
  openModules(): Promise<Set<string>>;
  /** `runQuery Root { References { Name } }` for one open module. */
  references(module: string): Promise<string[]>;
  open(module: string): Promise<void>;
  close(module: string): Promise<void>;
}

export interface DiscoverDeps {
  request: DiscoverRequest;
  /** Previously cached answers, keyed lower-case. */
  cache: Map<string, CacheEntry>;
  /** Scope-file spelling -> the name Studio will accept, when they differ. */
  aliases: Record<string, string>;
  /** Omitted for a dry run. */
  live?: DiscoverLive;
  /** Called after every state change so the page can poll. */
  report: (status: DiscoverStatus) => void;
  now?: () => number;
  /** Returns true to abort (cancellation). */
  cancelled?: () => boolean;
}

/**
 * Runs the breadth-first walk. Pure of process concerns: no argv, no files, no signals — those
 * belong to the entry point below, which is what makes this testable without Service Studio.
 */
export async function runDiscovery(deps: DiscoverDeps): Promise<DiscoverStatus> {
  const { request: opts, cache, aliases } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const nodes = new Map<string, DiscoverNode>();
  const edges: { from: string; to: string }[] = [];
  let current: DiscoverStatus["current"] = null;
  let stopped: string | null = null;
  let openNow = new Set<string>();

  const alias = (module: string): string => aliases[module] ?? module;
  const expandable = (module: string): boolean =>
    /^MOD_/i.test(module) || opts.starters.some((s) => s.toLowerCase() === module.toLowerCase());

  const add = (module: string, level: number, via: string | null): DiscoverNode => {
    const key = module.toLowerCase();
    const found = nodes.get(key);
    if (found) return found;
    const row: DiscoverNode = {
      module,
      level,
      layer: discoveryLayerOf(module),
      via,
      state: "queued",
      source: null,
      refs: null,
      ms: null,
      error: null
    };
    nodes.set(key, row);
    return row;
  };

  const estimate = (row: DiscoverNode): number => {
    if (!expandable(row.module) || row.level >= opts.depth || (opts.pruneByLayer && row.layer === "LKP")) return 0;
    if (opts.useCache && cache.has(row.module.toLowerCase())) return COST.cached;
    return openNow.has(alias(row.module).toLowerCase()) ? COST.alreadyOpen : COST.needsOpen;
  };

  const snapshot = (done = false): DiscoverStatus => {
    const rows = [...nodes.values()];
    return {
      request: opts,
      startedAt,
      elapsedMs: now() - startedAt,
      done,
      stopped,
      current,
      counts: rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.state] = (acc[r.state] ?? 0) + 1;
        return acc;
      }, {}),
      levels: Array.from({ length: opts.depth + 1 }, (_, d) => rows.filter((r) => r.level === d).length),
      etaMs: done ? 0 : rows.filter((r) => r.state === "queued").reduce((n, r) => n + estimate(r), 0),
      etaNote: "for modules already found; deeper levels add more",
      modules: rows,
      edges
    };
  };
  const report = (done = false): DiscoverStatus => {
    const status = snapshot(done);
    deps.report(status);
    return status;
  };

  for (const starter of opts.starters) add(starter, 0, null);

  if (!opts.dryRun) {
    if (!deps.live) {
      stopped = "no live connection available (osopener could not be loaded)";
      return report(true);
    }
    try {
      openNow = await deps.live.openModules();
    } catch (err) {
      stopped = `Studio unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return report(true);
    }
  }
  report();

  for (let level = 0; level < opts.depth && stopped === null; level++) {
    // Cheapest first: cached, then already open, then the ones needing an open. Front-loading the
    // free work means a cancelled job still leaves the maximum number of answers behind.
    const frontier = [...nodes.values()]
      .filter((r) => r.level === level && r.state === "queued")
      .sort((a, b) => estimate(a) - estimate(b) || a.module.localeCompare(b.module));

    for (const row of frontier) {
      if (stopped !== null) break;
      if (deps.cancelled?.()) {
        stopped = "cancelled";
        break;
      }
      const started = now();
      current = { module: row.module, level, step: "deciding" };

      if (!expandable(row.module)) {
        Object.assign(row, { state: "leaf", source: "not a MOD module", refs: [] });
        continue;
      }
      if (opts.pruneByLayer && row.layer === "LKP") {
        Object.assign(row, { state: "leaf", source: "LKP: references nothing MOD (layer rule, not read)", refs: [] });
        continue;
      }

      const cached = opts.useCache ? cache.get(row.module.toLowerCase()) : undefined;
      let refs: string[];

      if (cached) {
        refs = cached.refs;
        row.source = `cache (${cached.source}, ${cached.at?.slice(0, 16) ?? "?"})`;
      } else if (opts.dryRun) {
        Object.assign(row, { state: "skipped", source: "dry run: not cached", refs: [] });
        report();
        continue;
      } else {
        const live = deps.live;
        if (!live) {
          Object.assign(row, { state: "failed", error: "no live connection", refs: [] });
          report();
          continue;
        }
        const target = alias(row.module);
        let openedHere = false;
        try {
          if (!openNow.has(target.toLowerCase())) {
            current = { module: row.module, level, step: "opening in Service Studio" };
            report();
            await live.open(target);
            openedHere = true;
            openNow.add(target.toLowerCase());
          }
          current = { module: row.module, level, step: "runQuery References" };
          report();
          refs = await live.references(target);
          row.source = openedHere ? "live (opened + closed)" : "live (was open)";
          row.cacheSource = "live";
        } catch (err) {
          Object.assign(row, {
            state: "failed",
            error: err instanceof Error ? err.message : String(err),
            ms: now() - started,
            refs: []
          });
          refs = [];
        } finally {
          // Always close what this job opened, even on failure: leaking tabs is what makes
          // Service Studio crawl, and a failed query is no reason to leave one behind.
          if (openedHere) {
            current = { module: row.module, level, step: "closing" };
            report();
            try {
              await live.close(target);
              openNow.delete(target.toLowerCase());
            } catch {
              /* the tab stays open; the next open will find it already there */
            }
          }
        }
        if (row.state === "failed") {
          report();
          continue;
        }
      }

      row.refs = [...new Set(refs)].sort();
      row.state = "expanded";
      row.ms = now() - started;
      for (const ref of row.refs) {
        edges.push({ from: row.module, to: ref });
        if (!nodes.has(ref.toLowerCase())) {
          if (nodes.size >= opts.maxModules) {
            stopped = `stopped at the ${opts.maxModules}-module cap`;
            break;
          }
          add(ref, level + 1, row.module);
        }
      }
      report();
    }
  }

  // Modules at the last level are listed but deliberately not expanded.
  for (const row of nodes.values()) {
    if (row.state === "queued") {
      Object.assign(row, { state: "listed", source: row.level >= opts.depth ? "depth limit" : "not reached" });
    }
  }
  current = null;
  return report(true);
}

/* -------------------------------------------------------------------------------------------- */
/* Child-process entry point                                                                     */
/* -------------------------------------------------------------------------------------------- */

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic status write: the page polls this file, and must never read a half-written one. */
function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** Loads the two osopener tools. Returns null — never throws — when osopener is not built. */
export async function loadOsopener(osopenerDist: string): Promise<{
  open(module: string): Promise<void>;
  close(module: string): Promise<void>;
} | null> {
  interface ToolResult {
    opened?: boolean;
    closed?: boolean;
    error?: { code?: string; message?: string };
  }
  interface Tool {
    handler(input: Record<string, unknown>, ctx: unknown): Promise<ToolResult>;
  }
  const url = (file: string): string => pathToFileURL(join(osopenerDist, file)).href;
  try {
    // Untyped by nature: this crosses a package boundary at a path only known at runtime.
    const config = (await import(url("config.js"))) as {
      loadConfig(env: Record<string, string | undefined>, options: { packageRoot: string }): Record<string, unknown>;
    };
    const studio = (await import(url("servicestudio.js"))) as {
      HttpServiceStudioClient: new (options: { url: unknown; tokenFile: unknown }) => unknown;
    };
    const helperMod = (await import(url("helper.js"))) as {
      PowerShellHelper: new (options: { powershellExe: unknown; scriptPath: unknown }) => unknown;
    };
    const openMod = (await import(url("tools/openModule.js"))) as { openModule: Tool };
    const closeMod = (await import(url("tools/closeModule.js"))) as { closeModule: Tool };

    const cfg = config.loadConfig(process.env, { packageRoot: join(osopenerDist, "..") });
    const client = new studio.HttpServiceStudioClient({ url: cfg["serviceStudioUrl"], tokenFile: cfg["tokenFile"] });
    const ctx = {
      config: cfg,
      client,
      helper: new helperMod.PowerShellHelper({ powershellExe: cfg["powershellExe"], scriptPath: cfg["helperScript"] })
    };

    return {
      open: async (module) => {
        const result = await openMod.openModule.handler({ name: module, timeoutMs: 75_000 }, ctx);
        if (result.opened !== true) {
          throw new Error(`open failed: ${result.error?.code ?? "?"} ${result.error?.message?.slice(0, 160) ?? ""}`.trim());
        }
      },
      close: async (module) => {
        await closeMod.closeModule.handler({ name: module }, ctx);
      }
    };
  } catch {
    return null;
  }
}

/**
 * Runs as `node dist/progress/discover.js <job-dir>`.
 *
 * Everything it needs beyond the request comes from the environment the parent passed down, so
 * this entry point holds no configuration of its own.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const jobDir = argv[2];
  if (jobDir === undefined) {
    process.stderr.write("discover: usage: discover.js <job-dir>\n");
    return 2;
  }
  const stateDir = env["OSGRAPH_DISCOVER_STATE_DIR"] ?? jobDir;
  const cacheFile = join(stateDir, "discover-cache.json");
  const aliasFile = join(stateDir, "aliases.json");

  const request = parseRequest(readJson<unknown>(join(jobDir, "request.json"), {}));
  const cache = new Map<string, CacheEntry>();
  for (const [key, value] of Object.entries(readJson<Record<string, CacheEntry>>(cacheFile, {}))) {
    cache.set(key.toLowerCase(), value);
  }

  let cancelled = false;
  process.on("SIGTERM", () => {
    cancelled = true;
  });

  const statusFile = join(jobDir, "status.json");
  let last: DiscoverStatus | null = null;
  const report = (status: DiscoverStatus): void => {
    last = status;
    writeAtomic(statusFile, JSON.stringify(status));
  };

  let live: DiscoverLive | undefined;
  if (!request.dryRun) {
    const tools = await loadOsopener(env["OSGRAPH_OSOPENER_DIST"] ?? "");
    const studio = await loadOsgraphClient(env);
    if (tools && studio) {
      live = {
        openModules: studio.openModules,
        references: studio.references,
        open: tools.open,
        close: tools.close
      };
    }
  }

  const status = await runDiscovery({
    request,
    cache,
    aliases: readJson<Record<string, string>>(aliasFile, {}),
    live,
    report,
    cancelled: () => cancelled
  });

  // Persist the live answers so the next discovery of an overlapping estate is nearly free.
  try {
    const stored = readJson<Record<string, CacheEntry>>(cacheFile, {});
    for (const row of status.modules) {
      if (row.cacheSource === "live" && row.refs) {
        stored[row.module] = { refs: row.refs, at: new Date().toISOString(), source: "live runQuery" };
      }
    }
    writeAtomic(cacheFile, JSON.stringify(stored, null, 2));
  } catch {
    /* a lost cache only costs time next run */
  }

  writeAtomic(join(jobDir, "result.json"), JSON.stringify(last ?? status, null, 2));
  return status.stopped === null ? 0 : 1;
}

/** osgraph's own client, for `runQuery` and the open-module list. */
async function loadOsgraphClient(env: NodeJS.ProcessEnv): Promise<{
  openModules(): Promise<Set<string>>;
  references(module: string): Promise<string[]>;
} | null> {
  try {
    const { loadConfig } = await import("../config.js");
    const { createServiceStudioClient } = await import("../servicestudio/token.js");
    const config = loadConfig(env);
    const { client } = createServiceStudioClient(config);
    return {
      openModules: async () => new Set((await client.listApps()).map((app) => app.name.toLowerCase())),
      references: async (module) =>
        parseReferences(await client.callTool("runQuery", { eSpaceName: module, query: "Root { References { Name } }" }))
    };
  } catch {
    return null;
  }
}

// Executed only when this file is the process entry point, so importing it in tests is free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv, process.env)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`discover: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
