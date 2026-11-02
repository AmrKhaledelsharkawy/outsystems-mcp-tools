/**
 * The live progress site: a read-only status server plus the graph explorer, served in-process
 * during (and after) a rebuild.
 *
 * Ported from osgraph-kit's `dashboard/server.mjs`, with the same HTTP contract so
 * `dashboard/index.html` works unchanged, but two deliberate differences:
 *
 *  - **Status comes from `RunState`, not from the filesystem.** The kit tailed logs and counted
 *    `raw/*.txt` files because it was a separate process; here the rebuild hands its own events
 *    over directly.
 *  - **`rebuildActive` is a fact, not a guess.** The kit shelled out to PowerShell
 *    (`Get-CimInstance Win32_Process`) to look for a running rebuild and failed closed when the
 *    scan errored. In-process we simply know, which also removes a Windows-only dependency from
 *    an otherwise platform-agnostic package.
 *
 * Security posture, unchanged from the kit and load-bearing: **every mutating route is
 * loopback-only.** Reading the page from a phone is a convenience; starting a job that drives
 * your Service Studio, or writing a scope file, is not something a device across the network gets
 * to do. The bind address additionally defaults to loopback (see `SiteConfig.host`).
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listScopes, readScope, SCOPE_NAME_RE } from "../scopes/store.js";
import { RunState, scopeFiles } from "./state.js";
import type { Status, StatusFlows } from "./types.js";

/** Largest JSON body accepted on a POST — the discovery request is a few hundred bytes. */
const MAX_BODY_BYTES = 100_000;

/** A running or finished discovery job, as the page polls it. */
export interface DiscoveryStatus {
  [key: string]: unknown;
}

/**
 * The discovery half, injected so the server can be tested without Service Studio — and so the
 * explorer still serves when discovery is unavailable (no osopener build present).
 */
export interface DiscoveryRunner {
  /** Starts a job; rejects when one is already running. */
  start(request: unknown): Promise<{ id: string }>;
  cancel(): void;
  status(id: string | null): DiscoveryStatus;
  /** Module names already known, to populate the page's datalist. */
  knownModules(): string[];
  /** Persists a finished job's modules as a scope file. */
  save(input: { id?: unknown; name?: unknown; overwrite?: unknown }): { saved: string; count: number };
}

export interface SiteOptions {
  graphDir: string;
  scopesDir: string;
  host: string;
  /** First port to try. */
  port: number;
  /** Consecutive ports attempted when one is in use. */
  portScan: number;
  state: RunState;
  /** Omitted -> the discovery routes answer 503 and the rest of the site works. */
  discovery?: DiscoveryRunner | undefined;
  /** Directory holding `index.html`. Defaults to the package's `dashboard/`. */
  dashboardDir?: string;
}

export interface LiveSite {
  server: Server;
  host: string;
  port: number;
  /** The URL to hand a human: loopback when bound to loopback, else the first real LAN address. */
  url: string;
  /** Every address this is genuinely reachable on. */
  urls: string[];
  close(): Promise<void>;
}

function defaultDashboardDir(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "dashboard");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Loopback check for mutating routes.
 *
 * Compares the peer address rather than any header: `X-Forwarded-For` and friends are attacker
 * controlled, and this gate is the only thing standing between a LAN-bound site and a stranger
 * driving your Service Studio.
 */
export function isLocal(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** `flows.json` is megabytes; summarised and cached by mtime so a 1s poll never re-parses it. */
class FlowsCache {
  private cache = new Map<string, { m: number; value: StatusFlows | null }>();

  get(file: string): StatusFlows | null {
    const m = mtime(file);
    if (m === null) return null;
    const hit = this.cache.get(file);
    if (hit && hit.m === m) return hit.value;
    const json = readJson<Record<string, unknown>>(file);
    const value: StatusFlows | null =
      json === null
        ? null
        : {
            builtAt: json["builtAt"],
            actions: json["flowActionCount"],
            nodes: json["flowNodeCount"],
            bindings: json["bindingCount"],
            unknown: json["unknownNodeCount"],
            parseErrors: json["parseErrorCount"],
            perModule: (Array.isArray(json["perModule"]) ? json["perModule"] : []).map((p) => {
              const row = p as Record<string, unknown>;
              return {
                module: row["module"],
                actions: row["flowActionCount"] ?? row["actions"],
                nodes: row["flowNodeCount"] ?? row["nodes"],
                unknown: row["unknownNodeCount"] ?? row["unknown"]
              };
            })
          };
    this.cache.set(file, { m, value });
    return value;
  }
}

/** Starts the site, stepping past busy ports. Resolves with the address it actually got. */
export async function startSite(options: SiteOptions): Promise<LiveSite> {
  const dashboardDir = options.dashboardDir ?? defaultDashboardDir();
  const flows = new FlowsCache();
  const startedAt = new Date().toISOString();

  const send = (res: ServerResponse, code: number, body: string | Buffer, type = "application/json; charset=utf-8"): void => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  const scopeNames = (): string[] => {
    try {
      return listScopes(options.scopesDir).map((s) => s.name);
    } catch {
      return [];
    }
  };

  /** `?scope=` only when it names a real scope — never a path, never a traversal. */
  const scopeOf = (url: URL): string => {
    const asked = url.searchParams.get("scope");
    if (asked !== null && SCOPE_NAME_RE.test(asked) && existsSync(join(options.scopesDir, `${asked}.json`))) return asked;
    const active = options.state.activeScope;
    if (active !== null) return active;
    return scopeNames()[0] ?? "default";
  };

  const modulesOf = (scope: string): string[] => {
    try {
      return readScope(options.scopesDir, scope).modules;
    } catch {
      return [];
    }
  };

  const statusFor = (scope: string): Status => {
    const files = scopeFiles(options.graphDir, scope);
    return options.state.status(scope, modulesOf(scope), flows.get(files.flows), readJson(files.meta));
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += String(chunk);
        if (body.length > MAX_BODY_BYTES) reject(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      req.on("error", reject);
    });

  const discoveryRoute = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const discovery = options.discovery;
    if (!discovery) {
      return send(
        res,
        503,
        JSON.stringify({
          error:
            "Discovery is unavailable: osgraph could not load osopener. Point OSGRAPH_OSOPENER_DIST at a built osopener (npm run build in the osopener package)."
        })
      );
    }
    if (url.pathname === "/api/discover/status") return send(res, 200, JSON.stringify(discovery.status(url.searchParams.get("id"))));
    if (url.pathname === "/api/discover/modules") return send(res, 200, JSON.stringify(discovery.knownModules()));

    if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "POST only" }));
    // The guard that makes a LAN-visible site safe: viewing is shared, acting is not.
    if (!isLocal(req)) {
      return send(
        res,
        403,
        JSON.stringify({ error: "Starting or changing a discovery is only allowed from the PC running the site." })
      );
    }

    const body = (await readBody(req)) as Record<string, unknown>;

    if (url.pathname === "/api/discover/start") {
      // A discovery drives Service Studio, and so does a rebuild. Studio serialises badly enough
      // that letting both run would corrupt the rebuild's reads (ADR-0007).
      if (options.state.rebuildActive && body["dryRun"] !== true) {
        return send(
          res,
          409,
          JSON.stringify({ error: "A rebuild is reading from Service Studio right now. Start the discovery when it finishes." })
        );
      }
      try {
        return send(res, 200, JSON.stringify(await discovery.start(body)));
      } catch (err) {
        return send(res, 409, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
    if (url.pathname === "/api/discover/cancel") {
      discovery.cancel();
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/api/discover/save") {
      try {
        return send(res, 200, JSON.stringify(discovery.save(body)));
      } catch (err) {
        return send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return send(res, 404, JSON.stringify({ error: "not found" }));
  };

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = join(dashboardDir, "index.html");
          if (!existsSync(file)) return send(res, 500, `dashboard/index.html not found at ${file}`, "text/plain; charset=utf-8");
          return send(res, 200, readFileSync(file), "text/html; charset=utf-8");
        }
        // Optional offline copy of the graph library: present -> the explorer never touches the
        // internet; absent -> 404 and the page falls back to its CDN, then to a plain message.
        if (url.pathname === "/vis-network.min.js") {
          const local = join(dashboardDir, "vis-network.min.js");
          if (!existsSync(local)) return send(res, 404, "not vendored", "text/plain; charset=utf-8");
          return send(res, 200, readFileSync(local), "text/javascript; charset=utf-8");
        }
        if (url.pathname === "/api/health") {
          return send(
            res,
            200,
            JSON.stringify({
              ok: true,
              server: "osgraph",
              pid: process.pid,
              scopesDir: options.scopesDir,
              graphDir: options.graphDir,
              host: options.host,
              port: (server.address() as { port?: number } | null)?.port ?? options.port,
              scopes: scopeNames(),
              rebuildActive: options.state.rebuildActive,
              activeScope: options.state.activeScope,
              startedAt
            })
          );
        }
        if (url.pathname === "/api/scopes") {
          let scopes: { name: string; modules: number; lastActivity: number | null }[] = [];
          try {
            scopes = listScopes(options.scopesDir).map((s) => {
              const files = scopeFiles(options.graphDir, s.name);
              return { name: s.name, modules: s.modules.length, lastActivity: mtime(files.graph) };
            });
          } catch {
            scopes = [];
          }
          return send(res, 200, JSON.stringify({ default: scopeOf(url), scopes }));
        }
        if (url.pathname === "/api/status") return send(res, 200, JSON.stringify(statusFor(scopeOf(url))));
        if (url.pathname.startsWith("/api/discover/")) return await discoveryRoute(req, res, url);
        if (url.pathname === "/api/graph") {
          const scope = scopeOf(url);
          const file = scopeFiles(options.graphDir, scope).graph;
          if (!existsSync(file)) return send(res, 404, JSON.stringify({ error: `no graph for scope '${scope}' yet` }));
          // Streamed: a large scope's graph.json is tens of MB and must not be buffered.
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-graph-which": "current" });
          createReadStream(file).pipe(res);
          return;
        }
        return send(res, 404, JSON.stringify({ error: "not found" }));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  const port = await listenWithScan(server, options.host, options.port, options.portScan);
  const urls = reachableUrls(options.host, port);
  return {
    server,
    host: options.host,
    port,
    url: urls[0] ?? `http://127.0.0.1:${port}`,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

/**
 * Binds the first free port in `[port, port + scan)` and returns the port actually bound.
 *
 * A busy port is stepped past rather than treated as fatal: two osgraph servers in two workspaces
 * is a normal thing to want, and failing a rebuild because an unrelated process holds 7473 would
 * be absurd.
 *
 * The bound port is read back from `server.address()` rather than assumed to be the candidate,
 * because `port: 0` means "any free port" — the kernel picks it, and reporting the requested 0
 * would hand out a URL ending in `:0`.
 */
export async function listenWithScan(server: Server, host: string, port: number, scan: number): Promise<number> {
  const span = port === 0 ? 1 : Math.max(1, scan);
  for (let candidate = port; candidate < port + span; candidate++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") return resolve(false);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, host);
    });
    if (!bound) continue;
    const address = server.address();
    if (address !== null && typeof address === "object" && typeof address.port === "number") return address.port;
    return candidate;
  }
  throw new Error(`no free port in [${port}, ${port + span}) on ${host}`);
}

/**
 * Every URL the site is genuinely reachable on, loopback first.
 *
 * Only adapters that are actually up are listed. The kit learned this the hard way: a page was
 * unreachable at a remembered 192.168.1.12 because that address belonged to a disconnected
 * adapter still holding a stale IP, while the live address was elsewhere. `networkInterfaces()`
 * reports only live adapters, so a banner built from it cannot name a dead address.
 */
export function reachableUrls(host: string, port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  if (host !== "0.0.0.0" && host !== "::") return urls;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      // IPv4, non-loopback, and not a 169.254.x link-local autoconfig address (no router, no peers).
      if (addr.family !== "IPv4" || addr.internal || addr.address.startsWith("169.254.")) continue;
      urls.push(`http://${addr.address}:${port}`);
    }
  }
  return urls;
}

/** The stderr banner. Names only addresses that work, and says so when the LAN has none. */
export function siteBanner(site: LiveSite): string {
  const lines = [`osgraph live progress site on ${site.host}:${site.port}`, `  local: ${site.urls[0] ?? "-"}`];
  if (site.host === "0.0.0.0" || site.host === "::") {
    const lan = site.urls.slice(1);
    if (lan.length === 0) lines.push("  LAN:   none — no connected non-loopback IPv4 interface");
    for (const url of lan) lines.push(`  LAN:   ${url}`);
  } else {
    lines.push(`  bound to ${site.host} only; set OSGRAPH_PROGRESS_HOST=0.0.0.0 to reach it from other devices`);
  }
  return lines.join("\n");
}
