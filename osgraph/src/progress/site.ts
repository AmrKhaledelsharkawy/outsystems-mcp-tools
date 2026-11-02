/**
 * The process-wide live progress site: started on demand by the first `rebuild`/`reextract`, then
 * left serving for the life of the process.
 *
 * Lifetime is deliberate. The kit detached its dashboard so it outlived the run, at the cost of a
 * PID file, a `site --stop` command and the occasional orphaned node process holding a port nobody
 * remembers starting. Here the site is in-process: it lives as long as the osgraph MCP server —
 * i.e. your whole session — so a finished run is still readable long afterwards, and nothing is
 * left behind when the session ends.
 *
 * It is raised **before** the walk starts, so there is never a window in which work is happening
 * unobserved, and starting it can never fail a rebuild: if the port cannot be bound, that is
 * reported and the rebuild proceeds blind rather than not at all.
 */

import { SITE_PORT_SCAN, type OsgraphConfig } from "../config.js";
import { ChildProcessDiscovery, discoveryAvailable } from "./discovery.js";
import { type LiveSite, siteBanner, startSite } from "./server.js";
import { RunState } from "./state.js";

/** What a caller needs: somewhere to send events, and a URL to tell the human about. */
export interface SiteHandle {
  /** Always present — events are recorded even when the HTTP site could not start. */
  state: RunState;
  /** Null when the site is disabled or failed to bind. */
  site: LiveSite | null;
  /** Null when there is no site to link to. */
  url: string | null;
  /** Every reachable URL (loopback first, then LAN when bound wide). */
  urls: string[];
  /** Multi-line stderr banner, or a one-line reason there is no site. */
  banner: string;
  /** False when discovery is unavailable because osopener could not be loaded. */
  discoveryReady: boolean;
}

/** Process-wide, because the port and the run state are process-wide things. */
let handle: SiteHandle | null = null;
let starting: Promise<SiteHandle> | null = null;

/**
 * Starts the site if it is not already up, and returns the handle either way.
 *
 * Concurrent callers share one in-flight start: two tools racing to raise the site must not end up
 * binding two ports.
 *
 * Nothing is logged from here. The caller prints `handle.banner` itself, so the URL is repeated at
 * the start of every run rather than once per process — a URL you cannot scroll back to is a URL
 * you do not have.
 */
export async function ensureSite(
  config: Omit<OsgraphConfig, "site"> & { site?: OsgraphConfig["site"] }
): Promise<SiteHandle> {
  if (handle !== null) return handle;
  if (starting !== null) return starting;

  starting = (async (): Promise<SiteHandle> => {
    const state = new RunState({ graphDir: config.graphDir });

    // A config without a `site` block can only come from a hand-built `OsgraphConfig` — an
    // embedder or a test, never `loadConfig`. Treated as disabled rather than as a crash: this is
    // an observability add-on, and the one rule it must never break is that a rebuild still runs.
    const siteConfig = config.site;
    if (siteConfig === undefined || !siteConfig.enabled) {
      return (handle = {
        state,
        site: null,
        url: null,
        urls: [],
        banner:
          siteConfig === undefined
            ? "osgraph live progress site: not configured"
            : "osgraph live progress site: disabled (OSGRAPH_PROGRESS_SITE)",
        discoveryReady: false
      });
    }

    const discoveryReady = await discoveryAvailable(siteConfig.osopenerDist);
    const discovery = discoveryReady
      ? new ChildProcessDiscovery({
          stateDir: config.graphDir,
          scopesDir: config.scopesDir,
          graphDir: config.graphDir,
          env: process.env
        })
      : undefined;

    try {
      const site = await startSite({
        graphDir: config.graphDir,
        scopesDir: config.scopesDir,
        host: siteConfig.host,
        port: siteConfig.port,
        portScan: SITE_PORT_SCAN,
        state,
        discovery
      });
      const banner = [
        siteBanner(site),
        discoveryReady ? null : "  (module discovery unavailable: osopener not found — set OSGRAPH_OSOPENER_DIST)"
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return (handle = { state, site, url: site.url, urls: site.urls, banner, discoveryReady });
    } catch (err) {
      // Never fatal: a rebuild without a view of it still produces the snapshot.
      const reason = err instanceof Error ? err.message : String(err);
      return (handle = {
        state,
        site: null,
        url: null,
        urls: [],
        banner: `osgraph live progress site: could not start (${reason}); the rebuild continues without it`,
        discoveryReady
      });
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/** The site's own view of itself, inlined into a tool result so the agent can surface the URL. */
export interface SiteInfo {
  url: string | null;
  urls: string[];
  /** Present only when there is no site, explaining why. */
  note?: string;
}

export function siteInfo(site: SiteHandle): SiteInfo {
  if (site.url === null) return { url: null, urls: [], note: site.banner };
  return { url: site.url, urls: site.urls };
}

/** Shuts the site down. For tests and an orderly server exit. */
export async function closeSite(): Promise<void> {
  await handle?.site?.close();
  handle = null;
  starting = null;
}
