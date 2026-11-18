/**
 * Rebuild orchestration (OSG-004 all-or-nothing, OSG-011 skip-and-continue, ADR-0005/0007/0008)
 * against a fixture-backed fake reader.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLayerRules } from "../src/layers/rules.js";
import { rebuildScope, resolveScopeModules, formatProgress, stageModule, type RebuildProgressEvent } from "../src/rebuild/rebuild.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";
import { readMeta, readSnapshot } from "../src/graph/index.js";
import {
  app,
  demoPortalModule,
  demoServicesModule,
  fakeSession,
  syntheticWideModule,
  syntheticXModule,
  tokenExpiredError,
  type FakeModule
} from "./rebuild.fake.js";
import { flowsPath } from "../src/flows/index.js";
import { reextractScope } from "../src/reextract.js";

const rules = loadLayerRules();
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-rebuild-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scope = { name: "demo", modules: ["demoportal", "x"] };
const fixedNow = () => new Date("2026-10-30T12:00:00.000Z");

/**
 * How many listing entries a module marks `IsReferenced: true`, counted off the fixture itself so a
 * referenced-only assertion is derived from the listing rather than copied from a previous run.
 */
function referencedIn(m: FakeModule): number {
  return [...m.screens, ...m.blocks, ...m.clientActions, ...m.serverActions, ...(m.serviceActions ?? [])].filter(
    (e) => e.IsReferenced === true
  ).length;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<OsgraphToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OsgraphToolError);
    expect((err as OsgraphToolError).code).toBe(code);
    return err as OsgraphToolError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe("resolveScopeModules", () => {
  it("matches exactly, then case-insensitively, and reports missing/closed modules", () => {
    const apps = [app("demoportal"), app("MOD_B_CW"), app("Closed", { isOpen: false })];
    const ok = resolveScopeModules({ name: "s", modules: ["DemoPortal", "MOD_B_CW"] }, apps);
    expect(ok.map((r) => [r.requested, r.app.name])).toEqual([
      ["DemoPortal", "demoportal"],
      ["MOD_B_CW", "MOD_B_CW"]
    ]);
    let caught: OsgraphToolError | undefined;
    try {
      resolveScopeModules({ name: "s", modules: ["demoportal", "Closed", "Missing"] }, apps);
    } catch (err) {
      caught = err as OsgraphToolError;
    }
    expect(caught?.code).toBe("MODULES_NOT_OPEN");
    expect(caught?.details).toEqual({ scope: "s", missing: ["Closed", "Missing"], open: ["MOD_B_CW", "demoportal"] });
  });

  it("F8: two case-variant spellings of one module collapse to one entry, reported via requestedAs", () => {
    const apps = [app("demoportal")];
    for (const modules of [["demoportal", "DEMOPORTAL"], ["DEMOPORTAL", "demoportal"]]) {
      const out = resolveScopeModules({ name: "s", modules }, apps);
      expect(out, modules.join("+")).toHaveLength(1);
      expect(out[0]?.app.name).toBe("demoportal");
      // whichever order the scope used, the differing spelling is the one reported
      expect(out[0]?.requested).toBe("DEMOPORTAL");
    }
  });
});

describe("rebuildScope", () => {
  it("happy path over two modules: writes graph.json + meta.json, result counts match the snapshot", async () => {
    const snapshotPath = join(tmp(), "graphs", "demo", "graph.json");
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const events: RebuildProgressEvent[] = [];
    // fetchConcurrency 1 keeps this the serial baseline the rest of the file was written against
    // (OSG-016: `OSGRAPH_MAX_CONCURRENCY=1` must reproduce the pre-OSG-016 walk exactly).
    const out = await rebuildScope({ scope, snapshotPath, session, rules, now: fixedNow, retryDelayMs: 0, fetchConcurrency: 1, onProgress: (e) => events.push(e) });

    expect(session.acquired).toBe(1);
    expect(session.released).toBe(1);
    expect(session.reader.maxInFlight).toBe(1);
    expect(out.result.fetchConcurrency).toBe(1);
    for (const pm of out.result.perModule) expect(pm.concurrency).toBe(1);
    // §B1: the rebuild does not return until the client has nothing in flight
    expect(session.reader.drainCalls).toBe(1);
    expect(session.reader.inFlight).toBe(0);
    expect(session.reader.calls[0]).toEqual({ tool: "listApps", module: "*" });

    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = readSnapshot(snapshotPath);
    const meta = readMeta(snapshotPath);
    expect(meta).toEqual({ rebuiltAt: "2026-10-30T12:00:00.000Z", scope: "demo", skippedCount: snapshot.graph.osgraph.skipped.length });

    const r = out.result;
    expect(r.snapshotPath).toBe(snapshotPath);
    expect(r.nodeCount).toBe(snapshot.nodes.length);
    expect(r.edgeCount).toBe(snapshot.links.length);
    expect(r.nodeCount).toBeGreaterThan(10);
    expect(r.edgeCount).toBeGreaterThan(5);
    expect(r.unknownModuleCount).toBe(snapshot.graph.osgraph.unknownModuleCount);
    expect(r.unresolvedExternalCount).toBe(snapshot.graph.osgraph.unresolvedExternalCount);
    expect(r.unresolvedExternalCount).toBeGreaterThanOrEqual(1); // synthetic/entities.txt opaque AddDependency
    expect(typeof r.violationCount).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.perModule.map((m) => m.module)).toEqual(["demoportal", "x"]);
    for (const pm of r.perModule) {
      expect(pm.layer).toBe("UNKNOWN");
      expect(pm.requestedAs).toBeUndefined();
      expect(pm.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(pm.phaseDurationsMs).sort()).toEqual(
        ["blocks", "clientActions", "dataModel", "extract", "listing", "screens", "serverActions", "structures"]
      );
    }
    expect(r.skippedElements).toEqual(snapshot.graph.osgraph.skipped);
    expect(out.graphCompleteness).toEqual({ skippedCount: r.skippedElements.length, lastRebuildAt: "2026-10-30T12:00:00.000Z" });
    // ADR-0009/F16: the snapshot's own counts reach the caller (and the check is not vacuous)
    expect(r.placeholderCount).toBe(snapshot.graph.osgraph.placeholderCount);
    expect(r.placeholderCount).toBeGreaterThan(0);
    expect(r.droppedEdgeCount).toBe(snapshot.graph.osgraph.droppedEdgeCount);
    expect(typeof r.droppedEdgeCount).toBe("number");
    // F3: the synthetic listing marks 3 of 8 blocks (`Card` ×2, `OtpPanel`) and 1 of 6 server
    // actions (`CNF_ExternalPage`) `IsReferenced: true`; `x` marks nothing.
    expect(r.referencedOnlyCount).toBe(referencedIn(demoPortalModule()));
    expect(r.referencedOnlyCount).toBe(4);
    expect(r.perModule.find((m) => m.module === "demoportal")?.referencedOnlyCount).toBe(4);
    expect(r.perModule.find((m) => m.module === "x")?.referencedOnlyCount).toBe(0);

    // ids from both modules are present; the x module's local server action resolved
    const ids = snapshot.nodes.map((n) => n.id);
    expect(ids).toContain("osgraph://demoportal/Screen/MainFlow/Catalog");
    expect(ids).toContain("osgraph://x/ServerAction/BL_IsCodePatternValid");
    expect(ids).toContain("osgraph://demoportal");
    expect(ids).toContain("osgraph://x");

    // F3: exactly the blocks NOT marked `IsReferenced: true` are fetched, in listing order — and none
    // of the referenced-only ones, duplicate included
    expect(session.reader.calls.filter((c) => c.tool === "getWebBlock").map((c) => c.name)).toEqual([
      "Banner",
      "Footer",
      "Header",
      "Sidebar",
      "Tile"
    ]);
    // uiFlow comes from the names listing (ADR-0008)
    expect(snapshot.nodes.find((n) => n.id === "osgraph://demoportal/Screen/SignIn/SignIn")?.uiFlow).toBe("SignIn");

    // progress stream shape
    expect(events[0]).toEqual({ type: "session", message: "acquiring session token" });
    expect(events.filter((e) => e.type === "module-start")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("done");
    for (const e of events) expect(typeof formatProgress(e)).toBe("string");
  });

  it("is byte-identical across two rebuilds (graph.json), meta differs only by timestamp", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    await rebuildScope({ scope, snapshotPath, session: fakeSession([demoPortalModule(), syntheticXModule()]), rules, now: () => new Date(1), retryDelayMs: 0 });
    const first = readFileSync(snapshotPath, "utf8");
    await rebuildScope({ scope, snapshotPath, session: fakeSession([demoPortalModule(), syntheticXModule()]), rules, now: () => new Date(2), retryDelayMs: 0 });
    const second = readFileSync(snapshotPath, "utf8");
    expect(second).toBe(first);
    expect(first).not.toContain("rebuiltAt");
    expect(readMeta(snapshotPath)?.rebuiltAt).toBe(new Date(2).toISOString());
  });

  it("MODULES_NOT_OPEN leaves a previous snapshot untouched and releases the token", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, "SENTINEL");
    const session = fakeSession([demoPortalModule()], { apps: [app("demoportal"), app("x", { isOpen: false })] });
    const err = await expectCode(rebuildScope({ scope, snapshotPath, session, rules, retryDelayMs: 0 }), "MODULES_NOT_OPEN");
    expect(err.details).toEqual({ scope: "demo", missing: ["x"], open: ["demoportal"] });
    expect(readFileSync(snapshotPath, "utf8")).toBe("SENTINEL");
    expect(session.released).toBe(1);
    expect(session.reader.calls.filter((c) => c.tool !== "listApps")).toHaveLength(0);
  });

  it("TOKEN_EXPIRED from acquire() propagates with the exact message; nothing is read", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const session = fakeSession([demoPortalModule(), syntheticXModule()], { acquireError: tokenExpiredError() });
    const err = await expectCode(rebuildScope({ scope, snapshotPath, session, rules, retryDelayMs: 0 }), "TOKEN_EXPIRED");
    expect(err.message).toBe("session token invalid; a human must approve a new one in Service Studio");
    expect(existsSync(snapshotPath)).toBe(false);
    expect(session.reader.calls).toHaveLength(0);
    expect(session.released).toBe(1);
  });

  it("a session-level error mid-walk aborts all-or-nothing (previous snapshot kept)", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, "SENTINEL");
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const original = session.reader.getScreen.bind(session.reader);
    let n = 0;
    session.reader.getScreen = async (m, name) => {
      if (++n === 2) throw new OsgraphToolError("SERVICESTUDIO_UNREACHABLE", "servicestudio MCP at http://x is unreachable: ECONNREFUSED");
      return original(m, name);
    };
    const err = await expectCode(rebuildScope({ scope, snapshotPath, session, rules, retryDelayMs: 0 }), "SERVICESTUDIO_UNREACHABLE");
    expect(err.message).toContain("ECONNREFUSED");
    expect(readFileSync(snapshotPath, "utf8")).toBe("SENTINEL");
  });

  it("one failing element is retried once, then skipped as TOOL_ERROR and counted in graphCompleteness", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const session = fakeSession([syntheticXModule()], { failures: { "getServerAction:x:BL_IsCodePatternValid": Infinity } });
    const out = await rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
    expect(session.reader.calls.filter((c) => c.tool === "getServerAction" && c.name === "BL_IsCodePatternValid")).toHaveLength(2);
    expect(out.result.skippedElements).toEqual([{ module: "x", kind: "ServerAction", name: "BL_IsCodePatternValid", reason: "TOOL_ERROR" }]);
    expect(out.graphCompleteness.skippedCount).toBe(1);
    expect(out.result.perModule[0]?.skippedCount).toBe(1);
    expect(readMeta(snapshotPath)?.skippedCount).toBe(1);
    // OSG-011: the element is omitted, not stubbed, and the edge its caller would have had is not created
    const snap = readSnapshot(snapshotPath);
    expect(snap.nodes.find((n) => n.id === "osgraph://x/ServerAction/BL_IsCodePatternValid")).toBeUndefined();
    expect(snap.links.find((l) => l.target === "osgraph://x/ServerAction/BL_IsCodePatternValid")).toBeUndefined();
    expect(snap.nodes.map((n) => n.id)).toContain("osgraph://x/ClientAction/OSM004ToggleFlag");
  });

  it("a transient failure that succeeds on the retry produces no skip", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const session = fakeSession([syntheticXModule()], { failures: { "getClientAction:x:OSM004ToggleFlag": 1 } });
    const out = await rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
    expect(out.result.skippedElements).toEqual([]);
    expect(session.reader.calls.filter((c) => c.tool === "getClientAction")).toHaveLength(2);
  });

  /**
   * ADR-0011 replaces the previous "a failing names listing is skipped as `<Kind> *`" test, which
   * locked in the behaviour the S6 audit (F4) rejected: the whole kind vanished and the much thinner
   * snapshot atomically replaced the good one, reporting `skippedCount: 1`. The element-level test
   * above (`one failing element is retried once...`) is the contrast case and stays unchanged.
   */
  describe("ADR-0011 — a kind-level read failure aborts the rebuild", () => {
    /** The six kind-level calls of a Reactive module, each the sole source of truth for one kind. */
    const kindLevelCalls: Array<{ failure: string; call: string; kind: string; phase: string }> = [
      { failure: "getScreenNames:x:", call: "getScreenNames", kind: "Screen", phase: "listing" },
      { failure: "getWebBlockNames:x:", call: "getWebBlockNames", kind: "Block", phase: "listing" },
      { failure: "getActionNames:x:client", call: "getActionNames(client)", kind: "ClientAction", phase: "listing" },
      { failure: "getActionNames:x:server", call: "getActionNames(server)", kind: "ServerAction", phase: "listing" },
      { failure: "getDataModel:x:", call: "getDataModel", kind: "Entity", phase: "dataModel" },
      { failure: "getStructures:x:", call: "getStructures", kind: "Structure", phase: "structures" }
    ];

    for (const { failure, call, kind, phase } of kindLevelCalls) {
      it(`${call} failing twice aborts with KIND_READ_FAILED and writes no snapshot`, async () => {
        const snapshotPath = join(tmp(), "demo", "graph.json");
        mkdirSync(dirname(snapshotPath), { recursive: true });
        writeFileSync(snapshotPath, "SENTINEL");
        const session = fakeSession([syntheticXModule()], { failures: { [failure]: Infinity } });
        const events: RebuildProgressEvent[] = [];
        const err = await expectCode(
          rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0, onProgress: (e) => events.push(e) }),
          "KIND_READ_FAILED"
        );
        // the previous snapshot survives byte-for-byte and no meta.json was written beside it
        expect(readFileSync(snapshotPath, "utf8")).toBe("SENTINEL");
        expect(existsSync(join(dirname(snapshotPath), "meta.json"))).toBe(false);
        expect(err.details).toMatchObject({ scope: "demo", module: "x", kind, call, phase, attempts: 2 });
        expect(err.message).toContain("previous");
        // exactly two attempts at the failing call (OSG-011's single retry), and no element text after
        const [tool, , objectType] = failure.split(":") as [string, string, string];
        expect(
          session.reader.calls.filter((c) => c.tool === tool && (objectType === "" || c.name === objectType))
        ).toHaveLength(2);
        for (const elementTool of ["getScreen", "getWebBlock", "getClientAction", "getServerAction"]) {
          expect(session.reader.calls.filter((c) => c.tool === elementTool), elementTool).toHaveLength(0);
        }
        expect(session.released).toBe(1);
        // the `element` progress event reports the outcome ADR-0011 added
        const failed = events.filter((e) => e.type === "element" && e.outcome === "failed");
        expect(failed).toHaveLength(1);
        expect(formatProgress(failed[0]!)).toContain("failed");
      });
    }

    it("a kind-level call that succeeds on its retry produces no skip and no abort", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const session = fakeSession([syntheticXModule()], { failures: { "getWebBlockNames:x:": 1 } });
      const out = await rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
      expect(session.reader.calls.filter((c) => c.tool === "getWebBlockNames")).toHaveLength(2);
      expect(out.result.skippedElements).toEqual([]);
      expect(out.graphCompleteness.skippedCount).toBe(0);
      expect(existsSync(snapshotPath)).toBe(true);
    });

    it("a legitimately empty listing is not a failure (module `x` has no screens and no blocks)", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const session = fakeSession([syntheticXModule()]);
      const out = await rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
      expect(out.result.skippedElements).toEqual([]);
      expect(session.reader.calls.filter((c) => c.tool === "getScreenNames")).toHaveLength(1);
      expect(session.reader.calls.filter((c) => c.tool === "getScreen")).toHaveLength(0);
      expect(existsSync(snapshotPath)).toBe(true);
      expect(readSnapshot(snapshotPath).nodes.map((n) => n.id)).toContain("osgraph://x/ServerAction/BL_IsCodePatternValid");
    });

    it("no skip entry ever carries the deleted `*` sentinel or an empty name", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      // every element call fails, so every possible element-level skip is produced at once
      const portal = demoPortalModule({ referencedOnly: false });
      const failures: Record<string, number> = { "getClientAction:x:OSM004ToggleFlag": Infinity };
      const kinds: Array<[string, { Name?: unknown }[]]> = [
        ["getScreen", portal.screens],
        ["getWebBlock", portal.blocks],
        ["getClientAction", portal.clientActions],
        ["getServerAction", portal.serverActions]
      ];
      for (const [tool, entries] of kinds) for (const e of entries) failures[`${tool}:demoportal:${String(e.Name)}`] = Infinity;
      const session = fakeSession([portal, syntheticXModule()], { failures });
      const out = await rebuildScope({ scope, snapshotPath, session, rules, retryDelayMs: 0 });
      // one skip per failed FETCH: the duplicate `Card` is one fetch, so the 24 listing entries of
      // demoportal (5 + 8 + 5 + 6) give 23 skips, plus x's one client action
      expect(out.result.skippedElements).toHaveLength(23 + 1);
      expect(out.graphCompleteness.skippedCount).toBe(out.result.skippedElements.length);
      for (const s of out.result.skippedElements) {
        expect(s.name, JSON.stringify(s)).not.toBe("*");
        expect(s.name, JSON.stringify(s)).not.toBe("");
      }
      for (const s of readSnapshot(snapshotPath).graph.osgraph.skipped) {
        expect(s.name).not.toBe("*");
        expect(s.name).not.toBe("");
      }
    });
  });

  describe("S6 audit F3 — referenced-only listing entries are counted, never fetched", () => {
    it("IsReferenced:true entries cost zero element fetches, zero skips, and a written snapshot", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const session = fakeSession([demoPortalModule()]);
      const out = await rebuildScope({ scope: { name: "demo", modules: ["demoportal"] }, snapshotPath, session, rules, retryDelayMs: 0 });
      // 3 blocks + 1 server action are referenced-only in the synthetic listing
      expect(out.result.referencedOnlyCount).toBe(4);
      const fetched = (tool: string): unknown[] => session.reader.calls.filter((c) => c.tool === tool).map((c) => c.name);
      for (const name of ["Card", "OtpPanel"]) expect(fetched("getWebBlock")).not.toContain(name);
      expect(fetched("getWebBlock")).toHaveLength(5);
      expect(fetched("getServerAction")).toEqual(["GetCatalog", "LogVisit", "OnSignInReady", "SaveContact", "SendMail"]);
      // ADR-0011: not a skip, and not a kind-level failure either — the listings all succeeded
      expect(out.result.skippedElements).toEqual([]);
      expect(out.graphCompleteness.skippedCount).toBe(0);
      expect(out.result.perModule[0]?.skippedCount).toBe(0);
      expect(existsSync(snapshotPath)).toBe(true);
      expect(readMeta(snapshotPath)?.skippedCount).toBe(0);
    });

    it("the escape hatch fetches them anyway, and then ADR-0008's duplicate-name rule applies", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const session = fakeSession([demoPortalModule()]);
      const out = await rebuildScope({
        scope: { name: "demo", modules: ["demoportal"] },
        snapshotPath,
        session,
        rules,
        retryDelayMs: 0,
        fetchReferencedElements: true
      });
      expect(out.result.referencedOnlyCount).toBe(0);
      // the duplicate `Card` is fetched once for both listing entries (ADR-0008)
      expect(session.reader.calls.filter((c) => c.tool === "getWebBlock" && c.name === "Card")).toHaveLength(1);
      expect(session.reader.calls.filter((c) => c.tool === "getWebBlock" && c.name === "OtpPanel")).toHaveLength(1);
      expect(session.reader.calls.filter((c) => c.tool === "getServerAction" && c.name === "CNF_ExternalPage")).toHaveLength(1);
      expect(out.result.skippedElements).toEqual([
        { module: "demoportal", kind: "Block", name: "Card", reason: "DUPLICATE_NAME_UNRESOLVABLE" }
      ]);
    });

    it("a Service module whose service actions are all referenced-only costs no action fetch at all", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const services = demoServicesModule();
      const session = fakeSession([services]);
      const out = await rebuildScope({ scope: { name: "demo", modules: ["demoservices"] }, snapshotPath, session, rules, retryDelayMs: 0 });
      // the service listing was asked for, and every entry it returned was counted, not fetched
      expect(session.reader.calls.filter((c) => c.tool === "getActionNames" && c.name === "service")).toHaveLength(1);
      expect(out.result.referencedOnlyCount).toBe(referencedIn(services));
      expect(out.result.referencedOnlyCount).toBe(services.serviceActions?.length);
      expect(out.result.referencedOnlyCount).toBeGreaterThan(0);
      for (const tool of ["getServiceAction", "getServerAction"]) {
        expect(session.reader.calls.filter((c) => c.tool === tool), tool).toHaveLength(0);
      }
      expect(out.result.skippedElements).toEqual([]);
      // nothing fetched means nothing of that kind in the graph — not a stub, not a skip
      expect(readSnapshot(snapshotPath).nodes.filter((n) => n.id.startsWith("osgraph://demoservices/ServerAction/"))).toEqual([]);
    });

    it("the escape hatch reads a Service module's service actions through getServiceAction", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const services = demoServicesModule();
      const session = fakeSession([services]);
      const out = await rebuildScope({
        scope: { name: "demo", modules: ["demoservices"] },
        snapshotPath,
        session,
        rules,
        retryDelayMs: 0,
        fetchReferencedElements: true
      });
      const names = (services.serviceActions ?? []).map((e) => e.Name);
      expect(session.reader.calls.filter((c) => c.tool === "getServiceAction").map((c) => c.name)).toEqual(names);
      expect(session.reader.calls.filter((c) => c.tool === "getServerAction")).toHaveLength(0);
      expect(out.result.referencedOnlyCount).toBe(0);
      const ids = readSnapshot(snapshotPath).nodes.map((n) => n.id);
      for (const name of names) expect(ids).toContain(`osgraph://demoservices/ServerAction/${String(name)}`);
    });

    it("an entry with no IsReferenced field is still fetched (`=== true`, never `!== false`)", async () => {
      const snapshotPath = join(tmp(), "demo", "graph.json");
      const mod = syntheticXModule();
      mod.serverActions = [{ Name: "BL_IsCodePatternValid" }]; // a Studio build that omits the field
      const session = fakeSession([mod]);
      const out = await rebuildScope({ scope: { name: "demo", modules: ["x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
      expect(session.reader.calls.filter((c) => c.tool === "getServerAction")).toHaveLength(1);
      expect(out.result.referencedOnlyCount).toBe(0);
    });
  });

  it("a scope listing two case-variants of one module walks it once (F8)", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const session = fakeSession([syntheticXModule()]);
    const out = await rebuildScope({ scope: { name: "demo", modules: ["X", "x"] }, snapshotPath, session, rules, retryDelayMs: 0 });
    expect(out.result.perModule.map((m) => m.module)).toEqual(["x"]);
    expect(out.result.perModule[0]?.requestedAs).toBe("X");
    expect(session.reader.calls.filter((c) => c.tool === "getDataModel")).toHaveLength(1);
    expect(readSnapshot(snapshotPath).graph.osgraph.modules).toEqual(["x"]);
  });

  it("Traditional modules use the *Traditional tools; canonical module name is reported with requestedAs", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const mod = syntheticXModule();
    mod.app = app("x", { moduleType: "Traditional" });
    mod.screens = [{ Name: "Home", UIFlow: "MainFlow" }];
    mod.texts["Screen/Home"] = "/*** creating IWebScreen 'Home' ***/\nvar home = mainFlow.Nodes.OfType<IWebScreen>().Named(\"Home\");\n";
    const session = fakeSession([mod]);
    const out = await rebuildScope({ scope: { name: "demo", modules: ["X"] }, snapshotPath, session, rules, retryDelayMs: 0 });
    const tools = new Set(session.reader.calls.map((c) => c.tool));
    expect(tools.has("getScreenNamesTraditional")).toBe(true);
    expect(tools.has("getWebBlockNamesTraditional")).toBe(true);
    expect(tools.has("getScreenTraditional")).toBe(true);
    expect(tools.has("getScreenNames")).toBe(false);
    expect(out.result.perModule[0]).toMatchObject({ module: "x", requestedAs: "X" });
  });
});

/**
 * ADR-0005 staged fallback (built 2026-10-30). The contract that matters: staging module by module
 * must produce exactly the `graph.json` the all-at-once call would have written, and only the module
 * being staged needs to be open.
 */
/**
 * OSG-016 — the width-4 element fan-out. Determinism is the whole risk: the walk now has a
 * completion order, and not one byte of any output is allowed to depend on it. Every test here
 * compares a concurrent run against the serial one rather than against a recorded expectation, so
 * "deterministic" means the only thing it can usefully mean — same bytes at any width.
 */
describe("OSG-016 — concurrent element fetches", () => {
  const wideScope = { name: "demo", modules: ["wide"] };
  /**
   * Shuffles completion order against dispatch order: the names are zero-padded and ascending, and
   * the delay DESCENDS with the trailing digit, so within every batch the pool pulls the last item
   * answers first. The point is only that completion order is provably not dispatch order.
   */
  const descendingDelay = (call: { name?: string }): number => {
    const last = call.name?.slice(-1) ?? "";
    return /[0-9]/.test(last) ? (9 - Number(last)) * 6 : 0;
  };
  /** Holds one specific element back long enough that items dispatched after it answer first. */
  const slowOne = (slow: string) => (call: { name?: string }): number => (call.name === slow ? 60 : 2);

  async function run(options: {
    graphDir: string;
    fetchConcurrency: number;
    delayMs?: (call: { tool: string; module: string; name?: string }) => number;
    modules?: FakeModule[];
    failures?: Record<string, number>;
  }): Promise<{ snapshotPath: string; session: ReturnType<typeof fakeSession> }> {
    const snapshotPath = join(options.graphDir, "demo", "graph.json");
    const session = fakeSession(options.modules ?? [syntheticWideModule(10)], {
      ...(options.delayMs ? { delayMs: options.delayMs } : {}),
      ...(options.failures ? { failures: options.failures } : {})
    });
    await rebuildScope({
      scope: wideScope,
      snapshotPath,
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      fetchConcurrency: options.fetchConcurrency,
      rawGraphDir: options.graphDir
    });
    return { snapshotPath, session };
  }

  const manifest = (graphDir: string, module: string): { texts: { file: string }[]; skipped: unknown[] } =>
    JSON.parse(readFileSync(join(graphDir, "demo", "raw", module, "manifest.json"), "utf8")) as {
      texts: { file: string }[];
      skipped: unknown[];
    };

  it("A6.1: a shuffled completion order produces byte-identical output to the serial run", async () => {
    const serialDir = join(tmp(), "serial");
    const serial = await run({ graphDir: serialDir, fetchConcurrency: 1 });
    const concurrentDir = join(tmp(), "concurrent");
    const concurrent = await run({ graphDir: concurrentDir, fetchConcurrency: 4, delayMs: descendingDelay });

    // The premise of the test: the fake really did answer in a different order than it was asked.
    const asked = concurrent.session.reader.calls.filter((c) => c.tool === "getClientAction").map((c) => c.name);
    const answered = concurrent.session.reader.completions
      .filter((c) => c.tool === "getClientAction")
      .map((c) => c.name);
    expect(answered).not.toEqual(asked);
    expect([...answered].sort()).toEqual([...asked].sort());

    // ...and not one byte of any artifact moved with it.
    expect(readFileSync(concurrent.snapshotPath, "utf8")).toBe(readFileSync(serial.snapshotPath, "utf8"));
    expect(readFileSync(flowsPath(concurrent.snapshotPath), "utf8")).toBe(
      readFileSync(flowsPath(serial.snapshotPath), "utf8")
    );
    expect(manifest(concurrentDir, "wide")).toEqual(manifest(serialDir, "wide"));
    // The raw manifest's `texts` order is the listing order, in both runs.
    expect(manifest(concurrentDir, "wide").texts.map((t) => t.file)).toEqual([
      "module/dataModel.txt",
      "module/structures.txt",
      ...Array.from({ length: 10 }, (_, i) => `ClientAction/A_Act${String(i).padStart(2, "0")}.txt`)
    ]);
  });

  it("A6.2: the pool is respected and fully used — maxInFlight equals fetchConcurrency, never exceeds it", async () => {
    for (const width of [1, 2, 4, 8]) {
      const { session } = await run({
        graphDir: join(tmp(), `w${width}`),
        fetchConcurrency: width,
        delayMs: () => 2
      });
      // 10 client actions and a 4-call listing wave: there is always enough work to fill the pool.
      expect(session.reader.maxInFlight).toBe(Math.min(width, 10));
    }
  });

  // "A6.2b: the 4 listings are one wave and the two module texts are another" is NOT here. It is the
  // documented pre-existing failure, kept verbatim and local-only in `rebuild.wave-order.test.ts` so
  // the published set neither carries it nor weakens it (see PROVENANCE.md, "The known failure").

  it("A6.2c: the synthetic module has enough of every kind to fill the width-4 pool, element phase included", async () => {
    const session = fakeSession([demoPortalModule()], { delayMs: () => 2 });
    const out = await rebuildScope({
      scope: { name: "demo", modules: ["demoportal"] },
      snapshotPath: join(tmp(), "demo", "graph.json"),
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      fetchConcurrency: 4
    });
    expect(session.reader.maxInFlight).toBe(4);
    // ...and it is the ELEMENT phase that fills it, not just the listing wave: each fetched kind has
    // more than four entries, so for every one of them there is a moment four of its texts are out.
    const fetched = (tool: string): number => session.reader.calls.filter((c) => c.tool === tool).length;
    for (const tool of ["getScreen", "getWebBlock", "getClientAction", "getServerAction"]) {
      expect(fetched(tool), tool).toBeGreaterThan(4);
    }
    expect(out.result.perModule[0]?.concurrency).toBe(4);
  });

  it("A6.3: a duplicate listing name costs exactly one fetch, and still yields two elements and two raw files", async () => {
    const graphDir = tmp();
    const snapshotPath = join(graphDir, "demo", "graph.json");
    // The synthetic `Card` block appears twice, in two different UI flows (ADR-0008).
    const session = fakeSession([demoPortalModule({ referencedOnly: false })], { delayMs: () => 2 });
    const out = await rebuildScope({
      scope: { name: "demo", modules: ["demoportal"] },
      snapshotPath,
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      fetchConcurrency: 4,
      rawGraphDir: graphDir
    });
    // §A2: de-duplicated BEFORE dispatch, so the pool cannot issue it twice.
    expect(session.reader.calls.filter((c) => c.tool === "getWebBlock" && c.name === "Card")).toHaveLength(1);
    // ...and both listing entries still became an element and a file of their own.
    const files = manifest(graphDir, "demoportal")
      .texts.map((t) => t.file)
      .filter((f) => f.includes("Card"));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    expect(out.result.skippedElements).toContainEqual({
      module: "demoportal",
      kind: "Block",
      name: "Card",
      reason: "DUPLICATE_NAME_UNRESOLVABLE"
    });
  });

  it("A6.4: skips land at their LISTING position, not their completion position", async () => {
    // Two of ten elements fail, and the fake answers in reverse — so completion order would put the
    // later one first. `skipped` must not notice.
    const failures = {
      "getClientAction:wide:A_Act02": Infinity,
      "getClientAction:wide:A_Act07": Infinity
    };
    const serial = await run({ graphDir: tmp(), fetchConcurrency: 1, failures: { ...failures } });
    const concurrent = await run({
      graphDir: tmp(),
      fetchConcurrency: 4,
      delayMs: slowOne("A_Act02"),
      failures: { ...failures }
    });
    const names = (path: string): string[] =>
      readSnapshot(path)
        .graph.osgraph.skipped.filter((sk) => sk.reason === "TOOL_ERROR")
        .map((sk) => sk.name);
    expect(names(concurrent.snapshotPath)).toEqual(["A_Act02", "A_Act07"]);
    expect(names(concurrent.snapshotPath)).toEqual(names(serial.snapshotPath));
    // The fake proves the reversal really happened: A_Act07 answered before A_Act02.
    const answered = concurrent.session.reader.completions
      .filter((c) => c.tool === "getClientAction")
      .map((c) => c.name);
    expect(answered.indexOf("A_Act07")).toBeLessThan(answered.indexOf("A_Act02"));
  });

  it("A6.5: a kind-level failure aborts naming the FIRST failure in listing order, not in time", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    // Screens and server actions both fail; the screens listing is deliberately the SLOW one, so the
    // server-action failure happens first in time. ADR-0011's abort must still name screens.
    const session = fakeSession([syntheticWideModule(4)], {
      failures: { "getScreenNames:wide:": Infinity, "getActionNames:wide:server": Infinity },
      delayMs: (c) => (c.tool === "getScreenNames" ? 20 : 0)
    });
    const err = await expectCode(
      rebuildScope({ scope: wideScope, snapshotPath, session, rules, retryDelayMs: 0, fetchConcurrency: 4 }),
      "KIND_READ_FAILED"
    );
    expect(err.details).toMatchObject({ module: "wide", kind: "Screen", call: "getScreenNames" });
    expect(err.message).toContain("getScreenNames");
    // Both really did fail, and the server one really did fail first in time.
    const failedFirst = session.reader.completions.find(
      (c) => c.tool === "getActionNames" || c.tool === "getScreenNames"
    );
    expect(failedFirst?.tool).toBe("getActionNames");
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("A6.6: reextract is byte-identical from raw files produced by a concurrent walk", async () => {
    const graphDir = tmp();
    const { snapshotPath } = await run({ graphDir, fetchConcurrency: 4, delayMs: descendingDelay });
    const graph = readFileSync(snapshotPath, "utf8");
    const flows = readFileSync(flowsPath(snapshotPath), "utf8");
    reextractScope({ scope: wideScope, graphDir, snapshotPath, rules, now: fixedNow });
    expect(readFileSync(snapshotPath, "utf8")).toBe(graph);
    expect(readFileSync(flowsPath(snapshotPath), "utf8")).toBe(flows);
  });

  it("A6.7: the width is reported, and `fetchConcurrency` is clamped to [1, 8]", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const widths: [number | undefined, number][] = [
      [undefined, 4],
      [0, 1],
      [-5, 1],
      [3, 3],
      [99, 8],
      [Number.NaN, 4]
    ];
    for (const [asked, expected] of widths) {
      const session = fakeSession([syntheticWideModule(2)]);
      const out = await rebuildScope({
        scope: wideScope,
        snapshotPath,
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0,
        ...(asked === undefined ? {} : { fetchConcurrency: asked })
      });
      expect(out.result.fetchConcurrency).toBe(expected);
      expect(out.result.perModule[0]?.concurrency).toBe(expected);
      expect(session.reader.maxInFlight).toBeLessThanOrEqual(expected);
    }
  });

  it("A6.8: the drain barrier is awaited before the rebuild returns, on the abort path too", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    const session = fakeSession([syntheticWideModule(6)], {
      failures: { "getScreenNames:wide:": Infinity },
      delayMs: () => 2
    });
    await expectCode(
      rebuildScope({ scope: wideScope, snapshotPath, session, rules, retryDelayMs: 0, fetchConcurrency: 4 }),
      "KIND_READ_FAILED"
    );
    expect(session.reader.drainCalls).toBe(1);
    expect(session.reader.inFlight).toBe(0);
  });
});

describe("stageModule — staged rebuild (ADR-0005)", () => {
  const graphDir = (): string => join(tmp(), "graphs");
  const stagePathOf = (dir: string, module: string): string => join(dir, "demo", "stage", `${module}.json`);

  it("produces a byte-identical graph.json to the all-at-once rebuild", async () => {
    const allAtOnceDir = tmp();
    const allAtOncePath = join(allAtOnceDir, "demo", "graph.json");
    await rebuildScope({
      scope,
      snapshotPath: allAtOncePath,
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });

    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    const first = await stageModule({
      scope,
      module: "demoportal",
      graphDir: dir,
      snapshotPath: stagedPath,
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(first.finalized).toBe(false);
    expect(first.missingModules).toEqual(["x"]);
    expect(existsSync(stagedPath)).toBe(false); // nothing is published until the scope is complete
    expect(existsSync(stagePathOf(dir, "demoportal"))).toBe(true);

    const second = await stageModule({
      scope,
      module: "x",
      graphDir: dir,
      snapshotPath: stagedPath,
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(second.finalized).toBe(true);
    expect(second.missingModules).toEqual([]);
    expect(readFileSync(stagedPath, "utf8")).toBe(readFileSync(allAtOncePath, "utf8"));
    expect(second.outcome?.result.nodeCount).toBeGreaterThan(0);
    expect(existsSync(join(dir, "demo", "stage"))).toBe(false); // cleared after a successful finalize
  });

  it("needs only the staged module open — a scope module that is closed is not an error", async () => {
    const dir = graphDir();
    const out = await stageModule({
      scope,
      module: "demoportal",
      graphDir: dir,
      snapshotPath: join(dir, "demo", "graph.json"),
      // `x` is in the scope but NOT open: the all-at-once path fails MODULES_NOT_OPEN here.
      session: fakeSession([demoPortalModule()], { apps: [app("demoportal"), app("x", { isOpen: false })] }),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(out.staged.module).toBe("demoportal");
    expect(out.missingModules).toEqual(["x"]);
    expect(out.finalized).toBe(false);
  });

  it("a module that is not in the scope is SCOPE_INVALID, and nothing is read", async () => {
    const dir = graphDir();
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    await expectCode(
      stageModule({
        scope,
        module: "SomeOtherModule",
        graphDir: dir,
        snapshotPath: join(dir, "demo", "graph.json"),
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0
      }),
      "SCOPE_INVALID"
    );
    expect(session.acquired).toBe(0);
    expect(session.reader.calls).toEqual([]);
  });

  it("re-staging a module overwrites its entry and does not duplicate it", async () => {
    const dir = graphDir();
    const opts = {
      scope,
      module: "demoportal",
      graphDir: dir,
      snapshotPath: join(dir, "demo", "graph.json"),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    };
    await stageModule({ ...opts, session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    const again = await stageModule({ ...opts, session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    expect(again.stagedModules).toEqual(["demoportal"]);
    expect(again.missingModules).toEqual(["x"]);
  });

  it("a corrupt stage entry counts as not staged, so finalize cannot publish a hole", async () => {
    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    await stageModule({
      scope,
      module: "demoportal",
      graphDir: dir,
      snapshotPath: stagedPath,
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    writeFileSync(stagePathOf(dir, "demoportal"), "{ not json");
    const out = await stageModule({
      scope,
      module: "x",
      graphDir: dir,
      snapshotPath: stagedPath,
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(out.finalized).toBe(false);
    expect(out.missingModules).toEqual(["demoportal"]);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("re-staging one module and re-finalizing reproduces graph.json byte for byte", async () => {
    // This is the determinism check the live run can afford: a full 38-module re-read costs hours,
    // so the live script re-stages ONE module and finalizes from the untouched entries of the rest.
    // It proves the snapshot is reproducible from the same extractions — not that a fresh read of
    // every module would be identical, which is a different (and much more expensive) claim.
    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    const opts = { scope, graphDir: dir, snapshotPath: stagedPath, rules, now: fixedNow, retryDelayMs: 0 };
    await stageModule({ ...opts, module: "demoportal", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    const finalized = await stageModule({ ...opts, module: "x", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    expect(finalized.finalized).toBe(true);
    const first = readFileSync(stagedPath, "utf8");

    // The stage was cleared by the finalize, so both modules have to be staged again.
    await stageModule({ ...opts, module: "demoportal", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    const again = await stageModule({
      ...opts,
      module: "x",
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      now: () => new Date("2027-01-01T00:00:00.000Z") // a different clock must not change the graph
    });
    expect(again.finalized).toBe(true);
    expect(readFileSync(stagedPath, "utf8")).toBe(first);
    // rebuiltAt lives in meta.json, so only that moves.
    expect(readMeta(stagedPath)?.rebuiltAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("MAJOR-1: an entry from a different schema version is not staged, and is NAMED", async () => {
    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    const opts = { scope, graphDir: dir, snapshotPath: stagedPath, rules, now: fixedNow, retryDelayMs: 0 };
    await stageModule({ ...opts, module: "demoportal", session: fakeSession([demoPortalModule(), syntheticXModule()]) });

    // Exactly the pre-fix wedge: parses, has `extracted.nodes`, but no `skipped` array.
    const entryPath = join(dir, "demo", "stage", "demoportal.json");
    const good = JSON.parse(readFileSync(entryPath, "utf8")) as { schemaVersion?: number; extracted: Record<string, unknown> };
    expect(good.schemaVersion).toBe(1);
    writeFileSync(entryPath, JSON.stringify({ ...good, schemaVersion: 99, extracted: { ...good.extracted, skipped: undefined } }));

    const out = await stageModule({ ...opts, module: "x", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    expect(out.finalized).toBe(false);
    expect(out.missingModules).toEqual(["demoportal"]);
    expect(out.unreadableStageFiles).toEqual(["demoportal.json"]); // named, not silently absent
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("MAJOR-1: an entry written before the version field existed is still accepted", async () => {
    const dir = graphDir();
    const opts = { scope, graphDir: dir, snapshotPath: join(dir, "demo", "graph.json"), rules, now: fixedNow, retryDelayMs: 0 };
    await stageModule({ ...opts, module: "demoportal", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    const entryPath = join(dir, "demo", "stage", "demoportal.json");
    const legacy = JSON.parse(readFileSync(entryPath, "utf8")) as Record<string, unknown>;
    delete legacy.schemaVersion; // what the previous build wrote — must not force a re-read
    writeFileSync(entryPath, JSON.stringify(legacy));

    const out = await stageModule({ ...opts, module: "x", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    expect(out.unreadableStageFiles).toEqual([]);
    expect(out.finalized).toBe(true);
  });

  it("MAJOR-2: a finalize records how old the staged data really is, in the response and in meta.json", async () => {
    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    const opts = { scope, graphDir: dir, snapshotPath: stagedPath, rules, retryDelayMs: 0 };
    // Two modules staged three days apart, then finalized "now".
    await stageModule({
      ...opts,
      module: "demoportal",
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      now: () => new Date("2026-10-27T09:00:00.000Z")
    });
    const out = await stageModule({
      ...opts,
      module: "x",
      session: fakeSession([demoPortalModule(), syntheticXModule()]),
      now: () => new Date("2026-10-30T09:00:00.000Z")
    });
    expect(out.finalized).toBe(true);
    expect(out.stageAge).toEqual({
      oldest: "2026-10-27T09:00:00.000Z",
      newest: "2026-10-30T09:00:00.000Z",
      spanMs: 3 * 24 * 60 * 60 * 1000
    });
    const meta = readMeta(stagedPath);
    // rebuiltAt alone would claim this three-day-old graph was built just now.
    expect(meta?.rebuiltAt).toBe("2026-10-30T09:00:00.000Z");
    expect(meta?.stagedFrom).toBe("2026-10-27T09:00:00.000Z");
    expect(meta?.stagedTo).toBe("2026-10-30T09:00:00.000Z");
  });

  it("MAJOR-2: an all-at-once rebuild carries no staged-age fields (they would be meaningless)", async () => {
    const snapshotPath = join(tmp(), "demo", "graph.json");
    await rebuildScope({ scope, snapshotPath, session: fakeSession([demoPortalModule(), syntheticXModule()]), rules, now: fixedNow, retryDelayMs: 0 });
    const meta = readMeta(snapshotPath);
    expect(meta?.stagedFrom).toBeUndefined();
    expect(meta?.stagedTo).toBeUndefined();
  });

  it("a stage that cannot be cleared does not turn a published snapshot into a failure", async () => {
    const dir = graphDir();
    const stagedPath = join(dir, "demo", "graph.json");
    const opts = { scope, graphDir: dir, snapshotPath: stagedPath, rules, now: fixedNow, retryDelayMs: 0 };
    await stageModule({ ...opts, module: "demoportal", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    const out = await stageModule({ ...opts, module: "x", session: fakeSession([demoPortalModule(), syntheticXModule()]) });
    expect(out.finalized).toBe(true);
    expect(existsSync(stagedPath)).toBe(true);
  });

  it("the session is released even when the staged read fails", async () => {
    const dir = graphDir();
    const session = fakeSession([demoPortalModule()], { acquireError: tokenExpiredError() });
    await expectCode(
      stageModule({
        scope,
        module: "demoportal",
        graphDir: dir,
        snapshotPath: join(dir, "demo", "graph.json"),
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0
      }),
      "TOKEN_EXPIRED"
    );
    expect(session.released).toBe(1);
  });
});
