/**
 * The server's side of discovery: spawns the job, tracks the one that is running, reads its
 * status back, and turns a finished job into a scope file.
 *
 * One job at a time, by construction. Not a policy choice — two concurrent discoveries would both
 * be opening and closing modules in the same single Service Studio instance, which is how you get
 * a close landing on a module another job is mid-query on.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineScope, SCOPE_NAME_RE } from "../scopes/store.js";
import type { DiscoveryRunner, DiscoveryStatus } from "./server.js";
import { loadOsopener, parseRequest } from "./discover.js";

export interface DiscoveryOptions {
  /** Where job directories and the reference cache live. */
  stateDir: string;
  scopesDir: string;
  graphDir: string;
  /** Environment handed to the child — it re-reads osgraph's own config from it. */
  env: NodeJS.ProcessEnv;
  /** Compiled `discover.js`. Defaults to this module's sibling. */
  jobScript?: string;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Is a usable osopener present? Checked once at startup so the site can tell the user *why*
 * discovery is unavailable instead of failing at the moment they press the button.
 */
export async function discoveryAvailable(osopenerDist: string): Promise<boolean> {
  if (!existsSync(osopenerDist)) return false;
  return (await loadOsopener(osopenerDist)) !== null;
}

export class ChildProcessDiscovery implements DiscoveryRunner {
  private readonly options: DiscoveryOptions;
  private readonly jobsDir: string;
  private readonly jobScript: string;
  private readonly spawnFn: typeof spawn;
  private job: { id: string; dir: string; child: ChildProcess } | null = null;

  constructor(options: DiscoveryOptions) {
    this.options = options;
    this.jobsDir = join(options.stateDir, "discover-jobs");
    this.jobScript = options.jobScript ?? join(dirname(fileURLToPath(import.meta.url)), "discover.js");
    this.spawnFn = options.spawnFn ?? spawn;
  }

  private get running(): boolean {
    return this.job !== null && this.job.child.exitCode === null && !this.job.child.killed;
  }

  async start(raw: unknown): Promise<{ id: string }> {
    if (this.running) throw new Error("A discovery is already running.");
    const request = parseRequest(raw);
    if (request.starters.length === 0) throw new Error("Give at least one starter module.");

    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(this.jobsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), `${JSON.stringify(request, null, 2)}\n`);

    // stdout/stderr go to a file, never to our own stdio: this process speaks MCP on stdout, and
    // one stray child write would corrupt the protocol stream.
    //
    // The fd is ours to close, and we must. `spawn` duplicates a numeric `stdio` entry for the
    // child — it does not take ownership — so leaving it open leaks one descriptor per discovery
    // job in this process. `uv_spawn` is synchronous, so by the time `spawn` returns the child
    // already holds its own copy and closing ours cannot affect it. Closing it in `finally` also
    // keeps a throwing `spawnFn` from leaking.
    //
    // Found by CI, on Windows only: an open handle there blocks `rmdir` on the enclosing directory
    // outright (`ENOTEMPTY`, un-retryable), while Linux unlinks a file with open descriptors
    // happily. The symptom was five `progress.discover` tests failing in teardown.
    const errFd = openSync(join(dir, "stderr.log"), "a");
    let child;
    try {
      child = this.spawnFn(process.execPath, [this.jobScript, dir], {
        stdio: ["ignore", "ignore", errFd],
        env: { ...this.options.env, OSGRAPH_DISCOVER_STATE_DIR: this.options.stateDir }
      });
    } finally {
      closeSync(errFd);
    }
    this.job = { id, dir, child };
    return { id };
  }

  cancel(): void {
    // SIGTERM, not SIGKILL: the job handles it by finishing its current module, writing a final
    // status and saving the cache, so a cancelled discovery still banks the answers it paid for.
    if (this.running) this.job?.child.kill("SIGTERM");
  }

  status(id: string | null): DiscoveryStatus {
    const dir = id !== null && id !== "" ? join(this.jobsDir, id.replace(/[^\w-]/g, "")) : (this.job?.dir ?? this.latestJobDir());
    if (dir === null) return { none: true };
    const status = readJson<Record<string, unknown>>(join(dir, "status.json"), { starting: true });
    status["id"] = basename(dir);
    status["running"] = this.job !== null && this.job.dir === dir && this.running;
    if (status["running"] !== true && status["done"] !== true && status["starting"] !== true) {
      status["stopped"] = status["stopped"] ?? "job process ended unexpectedly";
    }
    return status;
  }

  private latestJobDir(): string | null {
    try {
      const ids = readdirSync(this.jobsDir)
        .filter((d) => /^\d/.test(d))
        .sort();
      const last = ids.at(-1);
      return last === undefined ? null : join(this.jobsDir, last);
    } catch {
      return null;
    }
  }

  /**
   * Every module name we have any reason to believe exists: the scopes' own module lists, the
   * module nodes of their snapshots, and the reference cache. Feeds the page's autocomplete so a
   * starter module can be picked rather than typed from memory.
   */
  knownModules(): string[] {
    const names = new Set<string>();
    for (const scope of readScopes(this.options.scopesDir)) {
      for (const module of scope.modules) names.add(module);
      const graph = readJson<{ nodes?: { kind?: string; module?: string }[] }>(
        join(this.options.graphDir, scope.name, "graph.json"),
        {}
      );
      for (const node of graph.nodes ?? []) {
        if (node.kind === "module" && typeof node.module === "string") names.add(node.module);
      }
    }
    for (const key of Object.keys(readJson<Record<string, unknown>>(join(this.options.stateDir, "discover-cache.json"), {}))) {
      names.add(key);
    }
    return [...names].sort();
  }

  /**
   * Writes a finished discovery out as a scope file.
   *
   * Only modules a rebuild could actually open are kept: platform/Forge leaves and failed names
   * would make the scope permanently fail its `MODULES_NOT_OPEN` check.
   */
  save(input: { id?: unknown; name?: unknown; overwrite?: unknown }): { saved: string; count: number } {
    const name = String(input.name ?? "");
    if (!SCOPE_NAME_RE.test(name) || name.length > 64) {
      throw new Error("Scope name: letters, digits, '_', '.', '-' only.");
    }
    const status = this.status(typeof input.id === "string" ? input.id : null);
    if (status["done"] !== true) throw new Error("That discovery has not finished.");
    if (existsSync(join(this.options.scopesDir, `${name}.json`)) && input.overwrite !== true) {
      throw new Error(`Scope '${name}' already exists.`);
    }
    const rows = Array.isArray(status["modules"]) ? (status["modules"] as Record<string, unknown>[]) : [];
    const modules = rows
      .filter((r) => {
        const module = String(r["module"] ?? "");
        return /^MOD_/i.test(module) && r["state"] !== "failed" && r["source"] !== "not a MOD module";
      })
      .map((r) => String(r["module"]));
    const entry = defineScope(this.options.scopesDir, { name, modules });
    return { saved: join(this.options.scopesDir, `${name}.json`), count: entry.modules.length };
  }
}

/** Minimal scope read, kept local so `knownModules` never fails the whole route on one bad file. */
function readScopes(scopesDir: string): { name: string; modules: string[] }[] {
  let files: string[];
  try {
    files = readdirSync(scopesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((file) => {
    const name = file.slice(0, -5);
    const json = readJson<{ modules?: unknown }>(join(scopesDir, file), {});
    const modules = Array.isArray(json.modules) ? json.modules.filter((m): m is string => typeof m === "string") : [];
    return { name, modules };
  });
}
