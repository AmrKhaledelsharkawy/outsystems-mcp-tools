/**
 * The live progress site, exercised over real HTTP.
 *
 * The load-bearing tests here are the loopback guard and the rebuild/discovery interlock: the
 * site may be bound to the LAN, and those two are the only things stopping a device across the
 * network from driving someone's Service Studio or corrupting a running rebuild's reads.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Script } from "node:vm";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunState } from "../src/progress/state.js";
import { type DiscoveryRunner, type LiveSite, isLocal, lanAddresses, reachableUrls, siteBanner, startSite } from "../src/progress/server.js";
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
  const url = `http://127.0.0.1:${site.port}`;
  const csrfResponse = await fetch(`${url}/api/security/csrf`);
  const csrf = (await csrfResponse.json()) as { token: string };
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": url, "x-osgraph-csrf": csrf.token },
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

describe("dashboard script syntax", () => {
  it("parses every inline script without a browser (catch template literal regressions)", () => {
    const html = readFileSync(join(process.cwd(), "dashboard", "index.html"), "utf8");
    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1] ?? "")
      .filter((script) => script.trim().length > 0);
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const script of inlineScripts) expect(() => new Script(script)).not.toThrow();
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
    expect(body["scopes"]).toBeUndefined();
    expect(body["pid"]).toBeUndefined();
    expect(body["graphDir"]).toBeUndefined();
    expect(body["scopesDir"]).toBeUndefined();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
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

  it("serves bounded overview, one module and server search without sending the full graph", async () => {
    const site = await serve();
    mkdirSync(join(graphDir, SCOPE), { recursive: true });
    const nodes = [
      { id: "osgraph://MOD_A_BL", kind: "module", module: "MOD_A_BL", label: "MOD_A_BL" },
      { id: "osgraph://MOD_B_CW", kind: "module", module: "MOD_B_CW", label: "MOD_B_CW" },
      ...Array.from({ length: 800 }, (_, i) => ({
        id: `osgraph://MOD_A_BL/S${i}`, kind: "ServerAction", label: `ServerAction_${i}`, module: "MOD_A_BL"
      }))
    ];
    const graph = { nodes, links: [
      { source: "osgraph://MOD_A_BL", target: "osgraph://MOD_B_CW", relation: "uses" },
      { source: "osgraph://MOD_A_BL/S0", target: "osgraph://MOD_B_CW", relation: "uses" }
    ], graph: { osgraph: { modules: MODULES } } };
    writeFileSync(join(graphDir, SCOPE, "graph.json"), JSON.stringify(graph));
    const overview = JSON.parse((await get(site, "/api/graph/view?scope=demo&view=overview")).body) as {
      nodes: { id: string }[]; links: unknown[]; stats: { nodes: number; edges: number }
    };
    expect(overview.nodes).toHaveLength(2);
    expect(overview.stats.nodes).toBe(802);
    expect(overview.stats.edges).toBe(2);
    const module = JSON.parse((await get(site, "/api/graph/view?scope=demo&view=module&module=MOD_A_BL")).body) as {
      nodes: unknown[]; links: unknown[]; limited: boolean
    };
    expect(module.nodes.length).toBeLessThanOrEqual(900);
    expect(module.limited).toBe(true);
    const search = JSON.parse((await get(site, "/api/graph/view?scope=demo&view=search&q=ServerAction&limit=5")).body) as {
      results: { label: string }[]; count: number
    };
    expect(search.results).toHaveLength(5);
    expect(search.count).toBe(800);
    expect((await get(site, "/api/graph/view?scope=demo&view=not-a-view")).status).toBe(400);
  });

  it("labels prior graph as previous while a scope rebuild is active", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    const site = await serve({ state });
    mkdirSync(join(graphDir, SCOPE), { recursive: true });
    writeFileSync(join(graphDir, SCOPE, "graph.json"), JSON.stringify({ nodes: [], links: [], graph: { osgraph: { modules: MODULES } } }));
    const res = await get(site, "/api/graph/view?scope=demo&view=overview");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-graph-which")).toBe("previous");
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

describe("progress HTTP security", () => {
  const runner: DiscoveryRunner = {
    start: async () => ({ id: "job-1" }),
    cancel: () => undefined,
    status: () => ({ done: true }),
    knownModules: () => ["MOD_A_BL"],
    save: () => ({ saved: "x.json", count: 1 })
  };

  it("rejects cross-origin and DNS-rebound discovery POSTs even from loopback", async () => {
    const site = await serve({ discovery: runner });
    const base = `http://127.0.0.1:${site.port}`;
    const token = (await (await fetch(base + "/api/security/csrf")).json() as { token: string }).token;
    const hostileOrigin = await fetch(base + "/api/discover/start", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", "x-osgraph-csrf": token },
      body: JSON.stringify({ starters: ["MOD_A_BL"] })
    });
    expect(hostileOrigin.status).toBe(403);
    const badHost = await fetch(base + "/api/discover/start", {
      method: "POST", headers: { "content-type": "application/json", host: "evil.example", origin: "http://evil.example", "x-osgraph-csrf": token },
      body: JSON.stringify({ starters: ["MOD_A_BL"] })
    });
    expect(badHost.status).toBe(403);
  });

  it("refuses absent/mismatched CSRF and wrong content type", async () => {
    const site = await serve({ discovery: runner });
    const base = `http://127.0.0.1:${site.port}`;
    const common = { method: "POST", body: JSON.stringify({ starters: ["MOD_A_BL"] }) };
    expect((await fetch(base + "/api/discover/start", {
      ...common, headers: { "content-type": "application/json", origin: base }
    })).status).toBe(403);
    expect((await fetch(base + "/api/discover/start", {
      ...common, headers: { "content-type": "application/json", origin: base, "x-osgraph-csrf": "wrong" }
    })).status).toBe(403);
    const token = (await (await fetch(base + "/api/security/csrf")).json() as { token: string }).token;
    expect((await fetch(base + "/api/discover/start", {
      ...common, headers: { "content-type": "text/plain", origin: base, "x-osgraph-csrf": token }
    })).status).toBe(415);
  });

  it("rejects oversized byte bodies and invalid JSON without changing discovery state", async () => {
    const site = await serve({ discovery: runner });
    const base = `http://127.0.0.1:${site.port}`;
    const token = (await (await fetch(base + "/api/security/csrf")).json() as { token: string }).token;
    const headers = { "content-type": "application/json", origin: base, "x-osgraph-csrf": token };
    const tooLarge = await fetch(base + "/api/discover/start", { method: "POST", headers, body: JSON.stringify({ starters: "x".repeat(120_000) }) });
    expect(tooLarge.status).toBe(413);
    const invalid = await fetch(base + "/api/discover/start", { method: "POST", headers, body: "{ invalid json" });
    expect(invalid.status).toBe(400);
  });

  it("requires a strong viewer secret for opt-in LAN binding", async () => {
    await expect(startSite({
      graphDir, scopesDir, host: "0.0.0.0", port: 0, portScan: 1,
      state: new RunState({ graphDir }), dashboardDir
    })).rejects.toThrow(/VIEWER_PASSWORD/);
  });

  it("marks a still-existing graph as previous during a new rebuild", async () => {
    const state = new RunState({ graphDir });
    state.beginRun(SCOPE, MODULES);
    mkdirSync(join(graphDir, SCOPE), { recursive: true });
    writeFileSync(join(graphDir, SCOPE, "graph.json"), '{"nodes":[],"links":[]}');
    const site = await serve({ state });
    const r = await get(site, `/api/graph?scope=${SCOPE}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-graph-which")).toBe("previous");
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
    expect(siteBanner(site)).toContain("OSGRAPH_PROGRESS_HOST=0.0.0.0 and OSGRAPH_PROGRESS_VIEWER_PASSWORD");
  });

  // A laptop on Ethernet with WSL installed: the phone line must be the Ethernet address, never WSL's.
  const IFACES = {
    "vEthernet (WSL (Hyper-V firewall))": [{ address: "172.23.32.1", family: "IPv4", internal: false }],
    "Ethernet 3": [{ address: "192.168.1.18", family: "IPv4", internal: false }],
    "Wi-Fi 3": [{ address: "169.254.10.2", family: "IPv4", internal: false }],
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Ethernet 9": [{ address: "fe80::1", family: "IPv6", internal: false }]
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  it("lists real adapters before virtual ones, skipping loopback, link-local and IPv6", () => {
    expect(lanAddresses(IFACES)).toEqual([
      { address: "192.168.1.18", adapter: "Ethernet 3", virtual: false },
      { address: "172.23.32.1", adapter: "vEthernet (WSL (Hyper-V firewall))", virtual: true }
    ]);
    expect(reachableUrls("0.0.0.0", 7473, IFACES)).toEqual([
      "http://127.0.0.1:7473",
      "http://192.168.1.18:7473",
      "http://172.23.32.1:7473"
    ]);
  });

  it("the banner names the phone address first and marks virtual adapters", () => {
    const fake = { host: "0.0.0.0", port: 7473, urls: reachableUrls("0.0.0.0", 7473, IFACES) } as unknown as LiveSite;
    const banner = siteBanner(fake, IFACES);
    const lines = banner.split("\n");
    expect(lines[1]).toContain("phone / other PCs: http://192.168.1.18:7473");
    expect(lines[1]).toContain("Ethernet 3");
    expect(banner).toContain("this PC:           http://127.0.0.1:7473");
    expect(banner).toContain("172.23.32.1:7473   (vEthernet (WSL (Hyper-V firewall)), virtual: not for a phone)");
    expect(banner).toContain("from other devices only with the run password");
  });
});

describe("run control routes (/api/run/*)", () => {
  it("answer 409 when no run is attached, and status has no control", async () => {
    const site = await serve();
    expect((await post(site, "/api/run/start", {})).status).toBe(409);
    const status = JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body) as Record<string, unknown>;
    expect(status.control).toBeUndefined();
  });

  it("Start / Pause / Resume / Cancel drive the attached control; invalid actions are 409; GET is 405", async () => {
    const { RunControl } = await import("../src/run/control.js");
    const state = new RunState({ graphDir });
    const control = new RunControl({ waitForStart: true });
    state.beginRun(SCOPE, MODULES);
    state.attachControl(control);
    const site = await serve({ state });

    const status = JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body) as { control?: { state: string } };
    expect(status.control?.state).toBe("waiting");
    expect((await get(site, "/api/run/start")).status).toBe(405);
    expect((await post(site, "/api/run/pause", {})).status).toBe(409);

    const started = await post(site, "/api/run/start", {});
    expect(started.status).toBe(200);
    expect((started.json.control as { state: string }).state).toBe("running");
    expect((await post(site, "/api/run/pause", {})).status).toBe(200);
    expect(control.state).toBe("paused");
    expect((await post(site, "/api/run/resume", {})).status).toBe(200);
    expect((await post(site, "/api/run/cancel", {})).status).toBe(200);
    expect(control.signal.aborted).toBe(true);
    expect((await post(site, "/api/run/cancel", {})).status).toBe(409);
    expect((await post(site, "/api/run/bogus", {})).status).toBe(404);
    expect(JSON.parse((await get(site, "/api/run/control")).body).state).toBe("cancelling");
  });

  it("from this PC, need the same-origin CSRF token (a foreign page cannot start or cancel the run)", async () => {
    const { RunControl } = await import("../src/run/control.js");
    const state = new RunState({ graphDir });
    const control = new RunControl({ waitForStart: true });
    state.beginRun(SCOPE, MODULES);
    state.attachControl(control);
    const site = await serve({ state });
    const base = `http://127.0.0.1:${site.port}`;
    expect((await fetch(`${base}/api/run/start`, { method: "POST" })).status).toBe(403);
    const token = (await (await fetch(`${base}/api/security/csrf`)).json() as { token: string }).token;
    expect((await fetch(`${base}/api/run/start`, { method: "POST", headers: { origin: "http://evil.example", "x-osgraph-csrf": token } })).status).toBe(403);
    expect((await fetch(`${base}/api/run/start`, { method: "POST", headers: { origin: base, "x-osgraph-csrf": "wrong" } })).status).toBe(403);
    expect(control.state).toBe("waiting");
    expect((await fetch(`${base}/api/run/start`, { method: "POST", headers: { origin: base, "x-osgraph-csrf": token } })).status).toBe(200);
    expect(control.state).toBe("running");
  });
});

describe("run control from another device (password)", () => {
  const remoteSite = async (password: string | undefined) => {
    const { RunControl } = await import("../src/run/control.js");
    const state = new RunState({ graphDir });
    const control = new RunControl({ waitForStart: true });
    control.setRemotePassword(password);
    state.beginRun(SCOPE, MODULES);
    state.attachControl(control);
    // Every request is treated as coming from another device on the network.
    const site = await startSite({
      graphDir,
      scopesDir,
      host: "127.0.0.1",
      port: 0,
      portScan: 5,
      state,
      dashboardDir,
      isLocalPeer: () => false
    });
    sites.push(site);
    return { site, control };
  };
  const postPw = async (site: LiveSite, path: string, pw?: string) =>
    (
      await fetch(`http://127.0.0.1:${site.port}${path}`, {
        method: "POST",
        headers: pw !== undefined ? { "X-Osgraph-Password": pw } : {}
      })
    ).status;

  it("without a run password: watch only (403), status says controlAccess none", async () => {
    const { site, control } = await remoteSite(undefined);
    expect(await postPw(site, "/api/run/start", "anything")).toBe(403);
    expect(control.state).toBe("waiting");
    expect(JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body).controlAccess).toBe("none");
  });

  it("with a run password: right one acts, wrong one is 401, then 429 after repeated guesses", async () => {
    const { site, control } = await remoteSite("phone-pass");
    expect(JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body).controlAccess).toBe("password");
    expect(await postPw(site, "/api/run/start")).toBe(401);
    expect(await postPw(site, "/api/run/start", "nope")).toBe(401);
    expect(control.state).toBe("waiting");
    expect(await postPw(site, "/api/run/start", "phone-pass")).toBe(200);
    expect(control.state).toBe("running");
    expect(await postPw(site, "/api/run/pause", "phone-pass")).toBe(200);
    // Two wrong guesses so far (no password, "nope"); two more are 401, the fifth locks.
    for (let i = 0; i < 2; i++) expect(await postPw(site, "/api/run/resume", "nope")).toBe(401);
    expect(await postPw(site, "/api/run/resume", "nope")).toBe(429);
    expect(await postPw(site, "/api/run/resume", "phone-pass")).toBe(429);
    expect(control.state).toBe("paused");
  });

  it("this PC never needs the password", async () => {
    const { RunControl } = await import("../src/run/control.js");
    const state = new RunState({ graphDir });
    const control = new RunControl({ waitForStart: true });
    control.setRemotePassword("phone-pass");
    state.beginRun(SCOPE, MODULES);
    state.attachControl(control);
    const site = await serve({ state });
    expect((await post(site, "/api/run/start", {})).status).toBe(200);
    expect(JSON.parse((await get(site, `/api/status?scope=${SCOPE}`)).body).controlAccess).toBe("local");
  });
});
