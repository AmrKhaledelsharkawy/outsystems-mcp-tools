import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractedModule } from "../src/extract/index.js";
import {
  atomicTempPath,
  buildSnapshot,
  canonicalJson,
  graphCompleteness,
  readGraphCompleteness,
  readMeta,
  readSnapshot,
  stripVolatile,
  writeSnapshot,
  type Snapshot
} from "../src/graph/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const layerAssign = (module: string): string => {
  const m = /_(LKP|CS|ST|IS|BL|SL|CW|UI)$/.exec(module);
  return m ? m[1] : "UNKNOWN";
};
const now = new Date("2026-10-30T10:00:00.000Z");

const ext = (id: string, kind: ExtractedModule["nodes"][number]["kind"], module: string, label: string) => ({
  id,
  label,
  kind,
  module,
  external: true as const
});
const e = (source: string, target: string, relation: "references" | "calls" | "embeds" | "requires_role") => ({
  source,
  target,
  relation,
  confidence: "EXTRACTED" as const,
  confidenceScore: 1.0 as const,
  sourceElement: source
});

/** UI module whose screen embeds a CW block (flow-qualified ref) and calls a BL action (flow-less ref). */
function uiModule(): ExtractedModule {
  return {
    module: "MOD_A_UI",
    nodes: [
      { id: "osgraph://MOD_A_UI/Screen/Main/Home", label: "Home", kind: "Screen", module: "MOD_A_UI", uiFlow: "Main" },
      ext("osgraph://MOD_B_CW/Block/Patterns/Card", "Block", "MOD_B_CW", "Card"),
      ext("osgraph://MOD_C_BL/ServerAction/BL_Do", "ServerAction", "MOD_C_BL", "BL_Do"),
      // flow-less external block ref (dependency-comment form `Module/Name`)
      ext("osgraph://MOD_B_CW/Block/Footer", "Block", "MOD_B_CW", "Footer"),
      ext("osgraph://MOD_B_CW/Block/Header", "Block", "MOD_B_CW", "Header"),
      { id: "osgraph://external/opaque*key", label: "opaque*key", kind: "Entity", external: true, globalKey: "opaque*key" }
    ],
    edges: [
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Block/Patterns/Card", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_C_BL/ServerAction/BL_Do", "calls"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Block/Footer", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Block/Header", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_A_UI/Role/Admin", "requires_role"),
      {
        ...e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://external/opaque*key", "references"),
        confidence: "AMBIGUOUS",
        confidenceScore: 0.5
      }
    ],
    skipped: [{ kind: "Block", name: "Accordion", reason: "DUPLICATE_NAME_UNRESOLVABLE" }]
  };
}

function cwModule(): ExtractedModule {
  return {
    module: "MOD_B_CW",
    nodes: [
      { id: "osgraph://MOD_B_CW/Block/Patterns/Card", label: "Card", kind: "Block", module: "MOD_B_CW", uiFlow: "Patterns" },
      { id: "osgraph://MOD_B_CW/Block/Layout/Footer", label: "Footer", kind: "Block", module: "MOD_B_CW", uiFlow: "Layout" },
      { id: "osgraph://MOD_B_CW/Block/Layout/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "Layout" },
      { id: "osgraph://MOD_B_CW/Block/Alt/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "Alt" }
    ],
    edges: [],
    skipped: []
  };
}

describe("buildSnapshot", () => {
  const { snapshot, meta } = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now });
  const byId = (id: string) => snapshot.nodes.find((n) => n.id === id);

  it("has the Graphify node-link shape (OSG-001/OSG-009)", () => {
    expect(snapshot.directed).toBe(true);
    expect(snapshot.multigraph).toBe(false);
    expect(snapshot.graph.schema_version).toBe("1.0");
    expect(snapshot.graph.graphify_version).toBe("0.9.91");
    for (const n of snapshot.nodes) {
      expect(n).toMatchObject({ file_type: "code" });
      expect(typeof n.label).toBe("string");
      expect(typeof n.source_file).toBe("string");
    }
    for (const l of snapshot.links) {
      expect(["EXTRACTED", "AMBIGUOUS"]).toContain(l.confidence);
      expect(typeof l.confidence_score).toBe("number");
      expect(typeof l.source_file).toBe("string");
    }
    expect(byId("osgraph://MOD_A_UI/Screen/Main/Home")).toMatchObject({
      source_file: "MOD_A_UI/Screen/Main/Home",
      kind: "Screen",
      uiFlow: "Main"
    });
    // the OSG-009 hand-built graph uses the same field set
    const osg009 = JSON.parse(readFileSync(join(fixtures, "synthetic", "graph-osg009.json"), "utf8")) as Snapshot;
    expect(Object.keys(osg009.nodes[0]).sort()).toEqual(["file_type", "id", "label", "source_file"]);
    for (const key of Object.keys(osg009.nodes[0])) expect(snapshot.nodes[0]).toHaveProperty(key);
    for (const key of Object.keys(osg009.links[0])) expect(snapshot.links[0]).toHaveProperty(key);
  });

  it("scope merge: an external node is replaced by the real node when its module is in scope", () => {
    const card = byId("osgraph://MOD_B_CW/Block/Patterns/Card");
    expect(card).toBeDefined();
    expect(card?.external).toBeUndefined();
    expect(snapshot.nodes.filter((n) => n.id === "osgraph://MOD_B_CW/Block/Patterns/Card").length).toBe(1);
  });

  it("scope merge: a flow-less external Screen/Block ref resolves by name to the unique in-scope node", () => {
    expect(byId("osgraph://MOD_B_CW/Block/Footer")).toBeUndefined();
    expect(
      snapshot.links.find((l) => l.source === "osgraph://MOD_A_UI/Screen/Main/Home" && l.target === "osgraph://MOD_B_CW/Block/Layout/Footer")
    ).toMatchObject({ relation: "embeds", confidence: "EXTRACTED" });
  });

  it("scope merge: a duplicate flow-less ref drops the edge and records DUPLICATE_NAME_UNRESOLVABLE", () => {
    expect(snapshot.links.find((l) => l.target.includes("/Header"))).toBeUndefined();
    expect(snapshot.graph.osgraph.skipped).toContainEqual({
      module: "MOD_A_UI",
      kind: "Block",
      name: "Header",
      reason: "DUPLICATE_NAME_UNRESOLVABLE"
    });
    expect(snapshot.graph.osgraph.skipped).toContainEqual({
      module: "MOD_A_UI",
      kind: "Block",
      name: "Accordion",
      reason: "DUPLICATE_NAME_UNRESOLVABLE"
    });
  });

  it("keeps out-of-scope externals, counts opaque targets, adds role placeholders", () => {
    expect(byId("osgraph://MOD_C_BL/ServerAction/BL_Do")).toMatchObject({ external: true, module: "MOD_C_BL" });
    expect(byId("osgraph://external/opaque*key")).toMatchObject({ external: true, globalKey: "opaque*key" });
    expect(snapshot.graph.osgraph.unresolvedExternalCount).toBe(1);
    expect(byId("osgraph://MOD_A_UI/Role/Admin")).toMatchObject({ kind: "Role", module: "MOD_A_UI", label: "Admin" });
    expect(byId("osgraph://MOD_A_UI/Role/Admin")?.external).toBeUndefined();
  });

  it("adds module nodes with layers and module→module references edges", () => {
    expect(byId("osgraph://MOD_A_UI")).toMatchObject({ kind: "module", layer: "UI", label: "MOD_A_UI", source_file: "MOD_A_UI" });
    expect(byId("osgraph://MOD_B_CW")).toMatchObject({ kind: "module", layer: "CW" });
    expect(byId("osgraph://MOD_C_BL")).toMatchObject({ kind: "module", layer: "BL" });
    const moduleLinks = snapshot.links.filter((l) => l.source === "osgraph://MOD_A_UI").map((l) => l.target);
    expect(moduleLinks).toEqual(["osgraph://MOD_B_CW", "osgraph://MOD_C_BL"]);
    expect(snapshot.links.filter((l) => l.source === "osgraph://MOD_A_UI" && l.target === "osgraph://MOD_B_CW").length).toBe(1);
    expect(snapshot.graph.osgraph.unknownModuleCount).toBe(0);
  });

  it("fills osgraph metadata and meta.rebuiltAt", () => {
    expect(snapshot.graph.osgraph.scope).toBe("demo");
    expect(snapshot.graph.osgraph.modules).toEqual(["MOD_A_UI", "MOD_B_CW"]);
    expect(snapshot.graph.osgraph.perModule).toEqual([
      { module: "MOD_A_UI", layer: "UI", nodeCount: 2, edgeCount: 5, skippedCount: 2 },
      { module: "MOD_B_CW", layer: "CW", nodeCount: 4, edgeCount: 0, skippedCount: 0 }
    ]);
    expect(meta).toEqual({ rebuiltAt: "2026-10-30T10:00:00.000Z", scope: "demo", skippedCount: 2 });
    expect(JSON.stringify(snapshot)).not.toContain("rebuiltAt");
  });

  it("is sorted and deterministic", () => {
    const ids = snapshot.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const again = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now: new Date(1) });
    expect(canonicalJson(again.snapshot)).toBe(canonicalJson(snapshot));
    expect(canonicalJson(stripVolatile(snapshot))).toBe(canonicalJson(snapshot));
  });
});

describe("writeSnapshot / readSnapshot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "osgraph-graph-"));
    dirs.push(d);
    return d;
  };

  it("writes byte-identical graph.json for two builds with identical inputs, and meta.json beside it", () => {
    const dir = tmp();
    const path = join(dir, "graph.json");
    const a = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now });
    writeSnapshot(path, a.snapshot, a.meta);
    const first = readFileSync(path, "utf8");
    const b = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now: new Date(5) });
    writeSnapshot(path, b.snapshot, b.meta);
    const second = readFileSync(path, "utf8");
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).not.toContain("\r");
    expect(first).not.toContain("rebuiltAt");
    expect(readMeta(path)).toEqual({ rebuiltAt: "1970-01-01T00:00:00.005Z", scope: "demo", skippedCount: 2 });
    expect(readSnapshot(path)).toEqual(JSON.parse(canonicalJson(a.snapshot)));
  });

  it("atomic write: no tmp file remains, target present, previous content replaced", () => {
    const dir = tmp();
    const path = join(dir, "graph.json");
    const a = buildSnapshot({ scopeName: "demo", modules: [uiModule()], layerAssign, now });
    writeSnapshot(path, a.snapshot, a.meta);
    const b = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now });
    writeSnapshot(path, b.snapshot, b.meta);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["graph.json", "meta.json"]);
    expect(readSnapshot(path).graph.osgraph.modules).toEqual(["MOD_A_UI", "MOD_B_CW"]);
  });

  it("graphCompleteness comes from meta.json; missing snapshot → {0, null}", () => {
    const dir = tmp();
    const path = join(dir, "graph.json");
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 0, lastRebuildAt: null });
    const a = buildSnapshot({ scopeName: "demo", modules: [uiModule(), cwModule()], layerAssign, now });
    writeSnapshot(path, a.snapshot, a.meta);
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 2, lastRebuildAt: "2026-10-30T10:00:00.000Z" });
    expect(graphCompleteness(a.snapshot, null)).toEqual({ skippedCount: 2, lastRebuildAt: null });
  });

  it("F7: a snapshot whose completeness is unreadable reports completenessUnknown, not {0,null}", () => {
    const dir = tmp();
    const path = join(dir, "graph.json");
    // legacy / hand-placed graph.json with no graph.osgraph.skipped and no meta.json
    writeFileSync(path, JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes: [], links: [] }));
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 0, lastRebuildAt: null, completenessUnknown: true });
    // corrupt JSON
    writeFileSync(path, "{not json");
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 0, lastRebuildAt: null, completenessUnknown: true });
    // a meta.json that is not a SnapshotMeta
    const a = buildSnapshot({ scopeName: "demo", modules: [uiModule()], layerAssign, now });
    writeSnapshot(path, a.snapshot, a.meta);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ scope: "demo" }));
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 0, lastRebuildAt: null, completenessUnknown: true });
    // no snapshot at all is still the plain "complete, never rebuilt" value — the two must differ
    expect(readGraphCompleteness(join(dir, "nope.json"))).toEqual({ skippedCount: 0, lastRebuildAt: null });
  });

  it("F11: meta.json is written before graph.json, so a crash between them is forward-stale", () => {
    const dir = tmp();
    const path = join(dir, "graph.json");
    mkdirSync(path, { recursive: true }); // make the graph.json write fail after the meta write
    const a = buildSnapshot({ scopeName: "demo", modules: [uiModule()], layerAssign, now });
    expect(() => writeSnapshot(path, a.snapshot, a.meta)).toThrow();
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(readMeta(join(dir, "graph.json"))?.scope).toBe("demo");
    // ...and a snapshot that is not there cannot be mistaken for a complete one
    rmSync(path, { recursive: true, force: true });
    expect(readGraphCompleteness(path)).toEqual({ skippedCount: 0, lastRebuildAt: null });
  });

  it("F1: the atomic-write temp name is call-scoped, not merely per-process", () => {
    const path = join(tmp(), "graph.json");
    const names = new Set([atomicTempPath(path), atomicTempPath(path), atomicTempPath(path)]);
    expect(names.size).toBe(3);
    for (const n of names) expect(n.startsWith(`${path}.tmp-${process.pid}-`)).toBe(true);
  });

  it("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe(
      '{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n'
    );
  });
});

describe("ADR-0009: skipped targets, placeholders, counts", () => {
  const home = "osgraph://MOD_A_UI/Screen/Main/Home";
  const skippedBlock = "osgraph://MOD_A_UI/Block/Main/Broken";
  const unreadScreen = "osgraph://MOD_A_UI/Screen/Main/Unread";
  const mod = (): ExtractedModule => ({
    module: "MOD_A_UI",
    nodes: [{ id: home, label: "Home", kind: "Screen", module: "MOD_A_UI", uiFlow: "Main" }],
    edges: [
      e(home, skippedBlock, "embeds"),
      e(home, unreadScreen, "references"),
      e(home, "osgraph://MOD_A_UI/Role/Admin", "requires_role")
    ],
    skipped: [{ kind: "Block", name: "Broken", reason: "PARSE_ERROR" }]
  });
  const result = buildSnapshot({ scopeName: "p", modules: [mod()], layerAssign, now });
  const { snapshot } = result;

  it("never stubs a skipped element: edge dropped, counted in droppedEdgeCount", () => {
    expect(snapshot.nodes.find((n) => n.id === skippedBlock)).toBeUndefined();
    expect(snapshot.links.find((l) => l.target === skippedBlock)).toBeUndefined();
    expect(snapshot.graph.osgraph.droppedEdgeCount).toBe(1);
    expect(result.droppedEdgeCount).toBe(1);
  });

  it("tags an unread in-scope target as placeholder with the kind from the reference site", () => {
    expect(snapshot.nodes.find((n) => n.id === unreadScreen)).toMatchObject({
      placeholder: true,
      kind: "Screen",
      module: "MOD_A_UI",
      uiFlow: "Main",
      label: "Unread"
    });
    expect(snapshot.links.find((l) => l.target === unreadScreen)).toBeDefined();
    expect(snapshot.graph.osgraph.placeholderCount).toBe(1);
    expect(result.placeholderCount).toBe(1);
    // Role placeholders are allowed by ADR-0006 and are not tagged/counted
    expect(snapshot.nodes.find((n) => n.id === "osgraph://MOD_A_UI/Role/Admin")?.placeholder).toBeUndefined();
    // Home + Role/Admin (role placeholders stay in nodeCount, ADR-0006); the tagged placeholder is excluded
    expect(snapshot.graph.osgraph.perModule[0].nodeCount).toBe(2);
  });

  it("opaque external targets carry the extractor's kind, never a fabricated default", () => {
    const m = mod();
    m.nodes.push({ id: "osgraph://external/k1", label: "k1", kind: "Structure", external: true, globalKey: "k1" });
    m.edges.push({ ...e(home, "osgraph://external/k1", "references"), confidence: "AMBIGUOUS", confidenceScore: 0.5 });
    m.edges.push({ ...e(home, "osgraph://external/k2", "references"), confidence: "AMBIGUOUS", confidenceScore: 0.5 });
    const s = buildSnapshot({ scopeName: "p", modules: [m], layerAssign, now }).snapshot;
    expect(s.nodes.find((n) => n.id === "osgraph://external/k1")).toMatchObject({
      kind: "Structure",
      external: true,
      globalKey: "k1"
    });
    expect(s.nodes.find((n) => n.id === "osgraph://external/k2")).toMatchObject({ kind: "unknown", external: true });
    expect(s.graph.osgraph.unresolvedExternalCount).toBe(2);
  });
});

/**
 * Final-audit MAJOR-1 (2026-10-30): Studio's dependency comment carries the CONSUMER's local name for
 * an imported UI flow (`MOD_DEMO_Profile_CW/MainFlow3/Profile_CW` for a block that lives in the
 * producer's `MainFlow`), and sometimes a historical element name. Live, 29 in-scope nodes stayed
 * `external` with 43 edges pointing at them, and every counter read 0.
 */
describe("buildSnapshot — in-scope refs with a consumer-local flow name (final-audit MAJOR-1)", () => {
  const consumer: ExtractedModule = {
    module: "MOD_A_UI",
    nodes: [
      { id: "osgraph://MOD_A_UI/Screen/Main/Profile", label: "Profile", kind: "Screen", module: "MOD_A_UI", uiFlow: "Main" },
      // comment flow `MainFlow3` ≠ producer flow `MainFlow`
      ext("osgraph://MOD_B_CW/Block/MainFlow3/Profile_CW", "Block", "MOD_B_CW", "Profile_CW"),
      // name exists twice in the producer → cannot pick one
      ext("osgraph://MOD_B_CW/Block/MainFlow9/Header", "Block", "MOD_B_CW", "Header"),
      // historical names: nothing in the producer carries them
      ext("osgraph://MOD_B_CW/Block/MainFlow4/OldBlock", "Block", "MOD_B_CW", "OldBlock"),
      ext("osgraph://MOD_B_CW/Structure/ST_RetiredStruct", "Structure", "MOD_B_CW", "ST_RetiredStruct"),
      // declared dependency only (no edge) on a historical name
      ext("osgraph://MOD_B_CW/Entity/Lkp_RetiredType", "Entity", "MOD_B_CW", "Lkp_RetiredType"),
      // out-of-scope module: untouched, stays external with its comment id
      ext("osgraph://MOD_Z_CW/Block/MainFlow7/Elsewhere", "Block", "MOD_Z_CW", "Elsewhere")
    ],
    edges: [
      e("osgraph://MOD_A_UI/Screen/Main/Profile", "osgraph://MOD_B_CW/Block/MainFlow3/Profile_CW", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Profile", "osgraph://MOD_B_CW/Block/MainFlow9/Header", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Profile", "osgraph://MOD_B_CW/Block/MainFlow4/OldBlock", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Profile", "osgraph://MOD_B_CW/Structure/ST_RetiredStruct", "references"),
      e("osgraph://MOD_A_UI/Screen/Main/Profile", "osgraph://MOD_Z_CW/Block/MainFlow7/Elsewhere", "embeds")
    ],
    skipped: []
  };
  const producer: ExtractedModule = {
    module: "MOD_B_CW",
    nodes: [
      { id: "osgraph://MOD_B_CW/Block/MainFlow/Profile_CW", label: "Profile_CW", kind: "Block", module: "MOD_B_CW", uiFlow: "MainFlow" },
      { id: "osgraph://MOD_B_CW/Block/Layout/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "Layout" },
      { id: "osgraph://MOD_B_CW/Block/Alt/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "Alt" },
      { id: "osgraph://MOD_B_CW/Structure/ST_Password", label: "ST_Password", kind: "Structure", module: "MOD_B_CW" }
    ],
    edges: [],
    skipped: []
  };
  const { snapshot } = buildSnapshot({ scopeName: "demo", modules: [consumer, producer], layerAssign, now });
  const byId = (id: string) => snapshot.nodes.find((n) => n.id === id);
  const from = "osgraph://MOD_A_UI/Screen/Main/Profile";

  it("resolves the consumer-local flow to the producer's real node by unique name", () => {
    expect(byId("osgraph://MOD_B_CW/Block/MainFlow3/Profile_CW")).toBeUndefined();
    expect(snapshot.links).toContainEqual(
      expect.objectContaining({ source: from, target: "osgraph://MOD_B_CW/Block/MainFlow/Profile_CW", relation: "embeds" })
    );
  });

  it("a duplicate name is skipped and counted, never attached to an arbitrary duplicate", () => {
    expect(snapshot.links.some((l) => l.source === from && l.target.endsWith("/Header"))).toBe(false);
    expect(byId("osgraph://MOD_B_CW/Block/MainFlow9/Header")).toBeUndefined();
    expect(snapshot.graph.osgraph.skipped).toContainEqual({
      module: "MOD_A_UI",
      kind: "Block",
      name: "Header",
      reason: "DUPLICATE_NAME_UNRESOLVABLE"
    });
  });

  it("a historical name in an in-scope module becomes a counted placeholder, not an external", () => {
    for (const id of [
      "osgraph://MOD_B_CW/Block/MainFlow4/OldBlock",
      "osgraph://MOD_B_CW/Structure/ST_RetiredStruct",
      "osgraph://MOD_B_CW/Entity/Lkp_RetiredType"
    ]) {
      const node = byId(id);
      expect(node).toMatchObject({ placeholder: true, module: "MOD_B_CW" });
      expect(node?.external).toBeUndefined();
    }
    expect(snapshot.graph.osgraph.placeholderCount).toBe(3);
  });

  it("no node of an in-scope module is ever tagged external", () => {
    const scope = new Set(snapshot.graph.osgraph.modules);
    expect(snapshot.nodes.filter((n) => n.external && n.module !== undefined && scope.has(n.module))).toEqual([]);
  });

  it("out-of-scope refs are untouched", () => {
    expect(byId("osgraph://MOD_Z_CW/Block/MainFlow7/Elsewhere")).toMatchObject({ external: true, module: "MOD_Z_CW" });
  });
});

/**
 * final-audit-2 MINOR-A (2026-10-30): a consumer that imports two elements with the same name keeps one under a
 * numbered local alias (`OutSystemsUI/Size` imported as `Size2`), and the dependency comment carries that alias.
 */
describe("buildSnapshot — consumer-side clash renames (Name2) (ADR-0008 Amendment 3)", () => {
  const consumer: ExtractedModule = {
    module: "MOD_A_UI",
    nodes: [
      { id: "osgraph://MOD_A_UI/Screen/Main/Home", label: "Home", kind: "Screen", module: "MOD_A_UI", uiFlow: "Main" },
      ext("osgraph://MOD_B_CW/Entity/Size2", "Entity", "MOD_B_CW", "Size2"),
      ext("osgraph://MOD_B_CW/Block/MainFlow3/Card2", "Block", "MOD_B_CW", "Card2"),
      ext("osgraph://MOD_B_CW/Block/MainFlow3/Header2", "Block", "MOD_B_CW", "Header2"),
      ext("osgraph://MOD_B_CW/Structure/ST_Main2", "Structure", "MOD_B_CW", "ST_Main2"),
      ext("osgraph://MOD_B_CW/Entity/Exact", "Entity", "MOD_B_CW", "Exact")
    ],
    edges: [
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Entity/Size2", "references"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Block/MainFlow3/Card2", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Block/MainFlow3/Header2", "embeds"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Structure/ST_Main2", "references"),
      e("osgraph://MOD_A_UI/Screen/Main/Home", "osgraph://MOD_B_CW/Entity/Exact", "references")
    ],
    skipped: []
  };
  const producer: ExtractedModule = {
    module: "MOD_B_CW",
    nodes: [
      { id: "osgraph://MOD_B_CW/Entity/Size", label: "Size", kind: "Entity", module: "MOD_B_CW" },
      { id: "osgraph://MOD_B_CW/Entity/Exact", label: "Exact", kind: "Entity", module: "MOD_B_CW" },
      { id: "osgraph://MOD_B_CW/Block/MainFlow/Card", label: "Card", kind: "Block", module: "MOD_B_CW", uiFlow: "MainFlow" },
      { id: "osgraph://MOD_B_CW/Block/A/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "A" },
      { id: "osgraph://MOD_B_CW/Block/B/Header", label: "Header", kind: "Block", module: "MOD_B_CW", uiFlow: "B" }
    ],
    edges: [],
    skipped: []
  };
  const { snapshot } = buildSnapshot({ scopeName: "demo", modules: [consumer, producer], layerAssign, now });
  const from = "osgraph://MOD_A_UI/Screen/Main/Home";
  const link = (t: string) => snapshot.links.find((l) => l.source === from && l.target === t);
  const byId = (id: string) => snapshot.nodes.find((n) => n.id === id);

  it("Size2 resolves to the producer's Size, marked AMBIGUOUS 0.5 (inferred, not read)", () => {
    expect(link("osgraph://MOD_B_CW/Entity/Size")).toMatchObject({ confidence: "AMBIGUOUS", confidence_score: 0.5 });
    expect(byId("osgraph://MOD_B_CW/Entity/Size2")).toBeUndefined();
  });

  it("works for flow-qualified kinds too: MainFlow3/Card2 → MainFlow/Card", () => {
    expect(link("osgraph://MOD_B_CW/Block/MainFlow/Card")).toMatchObject({ relation: "embeds", confidence: "AMBIGUOUS" });
  });

  it("an exact match is never downgraded", () => {
    expect(link("osgraph://MOD_B_CW/Entity/Exact")).toMatchObject({ confidence: "EXTRACTED", confidence_score: 1 });
  });

  it("an ambiguous base name (two Header blocks) is not guessed: counted placeholder", () => {
    expect(snapshot.links.some((l) => l.source === from && /\/Header$/.test(l.target))).toBe(false);
    expect(byId("osgraph://MOD_B_CW/Block/MainFlow3/Header2")).toMatchObject({ placeholder: true });
  });

  it("a numbered name whose base does not exist stays a counted placeholder", () => {
    expect(byId("osgraph://MOD_B_CW/Structure/ST_Main2")).toMatchObject({ placeholder: true });
    expect(snapshot.graph.osgraph.placeholderCount).toBe(2);
  });
});
