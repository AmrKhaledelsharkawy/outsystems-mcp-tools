/**
 * The live progress site, exercised over real HTTP.
 *
 * The load-bearing tests here are the loopback guard and the rebuild/discovery interlock: the
 * site may be bound to the LAN, and those two are the only things stopping a device across the
 * network from driving someone's Service Studio or corrupting a running rebuild's reads.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunState } from "../src/progress/state.js";
import { type DiscoveryRunner, type LiveSite, isLocal, reachableUrls, siteBanner, startSite } from "../src/progress/server.js";
import { defineScope } from "../src/scopes/store.js";

let graphDir: string;
let scopesDir: string;
let dashboardDir: string;
let sites: LiveSite[] = [];
/** Temp roots to remove after each test, so a long run does not fill the temp dir. */
let roots: string[] = [];

const SCOPE = "demo";
const MODULES = ["MOD_A_BL", "MOD_B_CW"];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "osgraph-site-"));
  roots.push(root);
  graphDir = join(root, "graph");
  scopesDir = join(root, "scopes");
  dashboardDir = join(root, "dashboard");
  mkdirSync(graphDir, { recursive: true });
  mkdirSync(scopesDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });
  writeFileSync(join(dashboardDir, "index.html"), "<!doctype html><title>osgraph — live progress</title>");
  defineScope(scopesDir, { name: SCOPE, modules: MODULES });
});

afterEach(async () => {
  for (const site of sites) await site.close();
  sites = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function serve(over: { state?: RunState; discovery?: DiscoveryRunner; host?: string } = {}): Promise<LiveSite> {
  const site = await startSite({
    graphDir,
    scopesDir,
    host: over.host ?? "127.0.0.1",
    port: 0, // ephemeral: a test must never fight the real default port
    portScan: 5,
    state: over.state ?? new RunState({ graphDir }),
    discovery: over.discovery,
    dashboardDir
  });
  sites.push(site);
  return site;
}

const get = async (site: LiveSite, path: string): Promise<{ status: number; body: string; headers: Headers }> => {
  const res = await fetch(`http://127.0.0.1:${site.port}${path}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

const post = async (site: LiveSite, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`http://127.0.0.1:${site.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("isLocal", () => {
  const req = (remoteAddress: string | undefined): IncomingMessage => ({ socket: { remoteAddress } }) as IncomingMessage;

  it("accepts the three loopback spellings", () => {
    expect(isLocal(req("127.0.0.1"))).toBe(true);
    expect(isLocal(req("::1"))).toBe(true);
    expect(isLocal(req("::ffff:127.0.0.1"))).toBe(true);
  });

  it("rejects LAN, public and unknown peers", () => {
    expect(isLocal(req("192.168.1.20"))).toBe(false);
    expect(isLocal(req("10.0.0.5"))).toBe(false);
    expect(isLocal(req("::ffff:192.168.1.20"))).toBe(false);
    expect(isLocal(req(undefined))).toBe(false);
  });

  it("is not fooled by a loopback-looking prefix", () => {
    // Guards against a `startsWith('127.0.0.1')`-style check.
    expect(isLocal(req("127.0.0.10"))).toBe(false);
    expect(isLocal(req("127.0.0.1.evil.example"))).toBe(false);
  });
});

describe("site routes", () => {
  it("serves the dashboard page at / and /index.html", async () => {
    const site = await serve();
    for (const path of ["/", "/index.html"]) {
      const res = await get(site, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.body).toContain("osgraph");
    }
  });

  it("answers /api/health before any run, so the port can be probed", async () => {
    const site = await serve();
    const res = await get(site, "/api/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["rebuildActive"]).toBe(false);
    expect(body["scopes"]).toEqual([SCOPE]);
  });

  it("lists scopes with their module counts", async () => {
    const site = await serve();
    const body = JSON.parse((await get(site, "/api/scopes")).body) as { scopes: { name: string; modules: number }[] };
    expect(body.scopes).toEqual([{ name: SCOPE, modules: 2, lastActivity: null }]);
  });

  it("serves the status contract for the live scope", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    state.handle({ type: "module-start", module: "MOD_A_BL", index: 1, total: 2, moduleType: "eSpace" });
    const site = await serve({ state });

    const status = JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body) as Record<string, Record<string, unknown>>;
    expect(status["scope"]).toBe(SCOPE);
    expect(status["current"]?.["module"]).toBe("MOD_A_BL");
    expect(status["progress"]?.["modulesTotal"]).toBe(2);
    expect(status["run"]?.["noRunLog"]).toBe(false);
  });

  it("falls back to a real scope when ?scope= is bogus or a traversal attempt", async () => {
    const site = await serve();
    for (const bad of ["..%2F..%2Fetc", "does-not-exist", "a/b"]) {
      const status = JSON.parse((await get(site, `/api/status?scope=${bad}`)).body) as { scope: string };
      expect(status.scope).toBe(SCOPE);
    }
  });

  it("404s /api/graph until a snapshot exists, then streams it", async () => {
    const site = await serve();
    expect((await get(site, `/api/graph?scope=${SCOPE}`)).status).toBe(404);

    mkdirSync(join(graphDir, SCOPE), { recursive: true });
    writeFileSync(join(graphDir, SCOPE, "graph.json"), '{"nodes":[],"edges":[]}');
    const res = await get(site, `/api/graph?scope=${SCOPE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-graph-which")).toBe("current");
    expect(JSON.parse(res.body)).toEqual({ nodes: [], edges: [] });
  });

  it("404s an unknown path", async () => {
    const site = await serve();
    expect((await get(site, "/nope")).status).toBe(404);
  });

  it("404s the graph library when it is not vendored, so the page can fall back", async () => {
    const site = await serve();
    expect((await get(site, "/vis-network.min.js")).status).toBe(404);
  });
});

describe("discovery routes", () => {
  const runner = (over: Partial<DiscoveryRunner> = {}): DiscoveryRunner => ({
    start: async () => ({ id: "job-1" }),
    cancel: () => undefined,
    status: () => ({ done: true }),
    knownModules: () => ["MOD_A_BL"],
    save: () => ({ saved: "x.json", count: 1 }),
    ...over
  });

  it("answers 503 with a fixable message when osopener is unavailable", async () => {
    const site = await serve();
    const res = await post(site, "/api/discover/start", { starters: ["MOD_A_BL"] });
    expect(res.status).toBe(503);
    expect(String(res.json["error"])).toContain("OSGRAPH_OSOPENER_DIST");
  });

  it("refuses to start while a rebuild is driving Service Studio", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    const site = await serve({ state, discovery: runner() });

    const res = await post(site, "/api/discover/start", { starters: ["MOD_A_BL"] });
    expect(res.status).toBe(409);
    expect(String(res.json["error"])).toContain("rebuild is reading from Service Studio");
  });

  it("allows a dry run during a rebuild, since it touches nothing", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    const site = await serve({ state, discovery: runner() });

    const res = await post(site, "/api/discover/start", { starters: ["MOD_A_BL"], dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json["id"]).toBe("job-1");
  });

  it("starts once the rebuild has finished", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    state.handle({ type: "done", durationMs: 1, snapshotPath: "x" });
    const site = await serve({ state, discovery: runner() });

    expect((await post(site, "/api/discover/start", { starters: ["MOD_A_BL"] })).status).toBe(200);
  });

  it("surfaces a refusal from the runner as 409 rather than a 500", async () => {
    const site = await serve({
      discovery: runner({
        start: () => {
          throw new Error("A discovery is already running.");
        }
      })
    });
    const res = await post(site, "/api/discover/start", { starters: ["MOD_A_BL"] });
    expect(res.status).toBe(409);
    expect(res.json["error"]).toBe("A discovery is already running.");
  });

  it("rejects GET on the mutating routes", async () => {
    const site = await serve({ discovery: runner() });
    const res = await get(site, "/api/discover/start");
    expect(res.status).toBe(405);
  });

  it("serves the read-only discovery routes", async () => {
    const site = await serve({ discovery: runner() });
    expect(JSON.parse((await get(site, "/api/discover/modules")).body)).toEqual(["MOD_A_BL"]);
    expect(JSON.parse((await get(site, "/api/discover/status")).body)).toEqual({ done: true });
  });

  it("reports a save failure as 400 with its reason", async () => {
    const site = await serve({
      discovery: runner({
        save: () => {
          throw new Error("That discovery has not finished.");
        }
      })
    });
    const res = await post(site, "/api/discover/save", { id: "job-1", name: "x" });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toBe("That discovery has not finished.");
  });
});

describe("binding", () => {
  it("steps past a busy port instead of failing the rebuild", async () => {
    const first = await startSite({
      graphDir,
      scopesDir,
      host: "127.0.0.1",
      port: 7599,
      portScan: 5,
      state: new RunState({ graphDir }),
      dashboardDir
    });
    sites.push(first);
    const second = await startSite({
      graphDir,
      scopesDir,
      host: "127.0.0.1",
      port: 7599,
      portScan: 5,
      state: new RunState({ graphDir }),
      dashboardDir
    });
    sites.push(second);

    expect(first.port).toBe(7599);
    expect(second.port).toBe(7600);
    expect((await get(second, "/api/health")).status).toBe(200);
  });

  it("reports only loopback when bound to loopback", () => {
    expect(reachableUrls("127.0.0.1", 7473)).toEqual(["http://127.0.0.1:7473"]);
  });

  it("never reports a link-local autoconfig address as reachable", () => {
    for (const url of reachableUrls("0.0.0.0", 7473)) expect(url).not.toContain("169.254.");
  });

  it("tells you how to open it up when bound to loopback", async () => {
    const site = await serve();
    expect(siteBanner(site)).toContain("OSGRAPH_PROGRESS_HOST=0.0.0.0");
  });
});
