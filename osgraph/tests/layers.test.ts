import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultLayerRulesPath,
  LayerRulesError,
  loadLayerRules,
  parseLayerRules
} from "../src/layers/rules.js";
import { assignLayer, isAllowed } from "../src/layers/assign.js";
import { listViolations, moduleOfNode, type SnapshotLike } from "../src/layers/violations.js";

const here = dirname(fileURLToPath(import.meta.url));
const rules = loadLayerRules();

/** OSG-003 allow map, transcribed literally from the ticket's schema block. */
const OSG003_ALLOW = {
  UI: ["UI", "CW", "SL"],
  CW: ["CW", "SL"],
  SL: ["SL", "BL"],
  BL: ["BL", "CS"],
  CS: ["CS"],
  LKP: ["LKP"]
};
const LAYERS = ["UI", "CW", "SL", "BL", "CS", "LKP"];

describe("loadLayerRules", () => {
  it("default path is the package-root layer-rules.json", () => {
    expect(defaultLayerRulesPath()).toBe(join(here, "..", "layer-rules.json"));
  });

  it("loads the shipped file and matches OSG-003 literally", () => {
    expect(rules.schemaVersion).toBe(1);
    expect(rules.source).toBe("MOD Code Review Template v1.0");
    expect(rules.layers).toEqual(LAYERS);
    expect(rules.layerSuffixPattern).toBe("_(UI|CW|SL|BL|CS|LKP)$");
    expect(rules.unknownLayerTag).toBe("UNKNOWN");
    expect(rules.allow).toEqual(OSG003_ALLOW);
  });

  it("accepts an explicit path argument", () => {
    expect(loadLayerRules(join(here, "..", "layer-rules.json")).allow).toEqual(OSG003_ALLOW);
  });

  it("throws LayerRulesError for a missing file", () => {
    expect(() => loadLayerRules(join(here, "does-not-exist.json"))).toThrow(LayerRulesError);
  });

  const valid = () => JSON.parse(readFileSync(defaultLayerRulesPath(), "utf8")) as Record<string, unknown>;

  it("rejects an allow key that is not a declared layer", () => {
    const bad = valid();
    (bad.allow as Record<string, string[]>).ST = ["LKP"];
    expect(() => parseLayerRules(bad)).toThrow(/allow key "ST" is not a declared layer/);
  });

  it("rejects an allowed target that is not a declared layer", () => {
    const bad = valid();
    (bad.allow as Record<string, string[]>).BL = ["BL", "CS", "IS"];
    expect(() => parseLayerRules(bad)).toThrow(/allowed target "IS" of "BL"/);
  });

  it("rejects unknown top-level keys (fail-closed)", () => {
    const bad = { ...valid(), deny: {} };
    expect(() => parseLayerRules(bad)).toThrow(LayerRulesError);
  });

  it("rejects a layer with no allow entry", () => {
    const bad = valid();
    delete (bad.allow as Record<string, string[]>).LKP;
    expect(() => parseLayerRules(bad)).toThrow(/"LKP" has no allow entry/);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(() => parseLayerRules({ ...valid(), schemaVersion: 2 })).toThrow(LayerRulesError);
  });
});

describe("assignLayer", () => {
  it.each([
    ["MOD_DEMO_Portal_CW", "CW"],
    ["MOD_DEMO_CommonLookups_LKP", "LKP"],
    ["MOD_DEMO_FileStore_CS", "CS"],
    ["MOD_DEMO_Portal_BL", "BL"],
    ["MOD_DEMO_Integration_SL", "SL"],
    ["MOD_DEMO_UI", "UI"],
    ["demoportal", "UNKNOWN"],
    ["OutSystemsUI", "UNKNOWN"],
    ["System", "UNKNOWN"],
    ["MOD_DEMO_DatePicker_Lib", "UNKNOWN"],
    ["MOD_DEMO_Layouts", "UNKNOWN"],
    ["MOD_X_IS", "UNKNOWN"],
    ["MOD_X_ST", "UNKNOWN"],
    ["MOD_X_cs", "UNKNOWN"],
    ["MOD_X_CS_", "UNKNOWN"],
    ["", "UNKNOWN"]
  ])("%s -> %s", (name, layer) => {
    expect(assignLayer(name, rules)).toBe(layer);
  });
});

describe("isAllowed", () => {
  it("every layer allows itself", () => {
    for (const layer of LAYERS) expect(isAllowed(layer, layer, rules)).toBe(true);
  });

  it.each([
    ["UI", "CW", true],
    ["UI", "SL", true],
    ["CW", "SL", true],
    ["SL", "BL", true],
    ["BL", "CS", true],
    ["UI", "BL", false],
    ["UI", "CS", false],
    ["UI", "LKP", false],
    ["CW", "UI", false],
    ["CW", "BL", false],
    ["SL", "CS", false],
    ["SL", "UI", false],
    ["BL", "CW", false],
    ["BL", "SL", false],
    ["BL", "UI", false],
    ["BL", "LKP", false],
    ["CS", "LKP", false],
    ["CS", "BL", false],
    ["LKP", "CS", false],
    ["LKP", "UI", false]
  ])("%s -> %s is %s", (s, t, expected) => {
    expect(isAllowed(s, t, rules)).toBe(expected);
  });

  it("is exempt when either side is UNKNOWN", () => {
    expect(isAllowed("UNKNOWN", "CS", rules)).toBe("exempt");
    expect(isAllowed("UI", "UNKNOWN", rules)).toBe("exempt");
    expect(isAllowed("UNKNOWN", "UNKNOWN", rules)).toBe("exempt");
  });

  it("is derived exhaustively from the allow map (fail-closed)", () => {
    for (const s of LAYERS) {
      for (const t of LAYERS) {
        const expected = OSG003_ALLOW[s as keyof typeof OSG003_ALLOW].includes(t);
        expect(isAllowed(s, t, rules), `${s}->${t}`).toBe(expected);
      }
    }
  });
});

describe("listViolations (synthetic fixture)", () => {
  const fixturePath = join(here, "fixtures", "synthetic", "violation-graph.json");
  const snapshot = JSON.parse(readFileSync(fixturePath, "utf8")) as SnapshotLike;

  it("reports exactly the two planted violations, sorted, and Foundation as UNKNOWN", () => {
    const report = listViolations(snapshot, rules);
    expect(report.violations).toEqual([
      {
        source: "osgraph://Demo_BL/ServerAction/BL_Do",
        target: "osgraph://Demo_CW/Block/Common/Header",
        sourceLayer: "BL",
        targetLayer: "CW",
        relation: "embeds",
        sourceModule: "Demo_BL",
        targetModule: "Demo_CW"
      },
      {
        source: "osgraph://Demo_UI/Screen/MainFlow/Home",
        target: "osgraph://Demo_CS/Entity/Customer",
        sourceLayer: "UI",
        targetLayer: "CS",
        relation: "references",
        sourceModule: "Demo_UI",
        targetModule: "Demo_CS"
      }
    ]);
    expect(report.unknownModules).toEqual(["Foundation"]);
  });

  it("is deterministic across runs", () => {
    expect(listViolations(snapshot, rules)).toEqual(listViolations(snapshot, rules));
  });
});

describe("listViolations (inline cases)", () => {
  const node = (id: string, module?: string) => (module === undefined ? { id } : { id, module });

  it("evaluates module-level edges and de-duplicates (source, target, relation)", () => {
    const snap: SnapshotLike = {
      nodes: [node("osgraph://A_UI"), node("osgraph://B_CS")],
      links: [
        { source: "osgraph://A_UI", target: "osgraph://B_CS", relation: "depends_on" },
        { source: "osgraph://A_UI", target: "osgraph://B_CS", relation: "depends_on" }
      ]
    };
    const report = listViolations(snap, rules);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      sourceModule: "A_UI",
      targetModule: "B_CS",
      sourceLayer: "UI",
      targetLayer: "CS"
    });
  });

  it("derives module from the id when `module` is absent, and skips same-module edges", () => {
    const snap: SnapshotLike = {
      nodes: [node("osgraph://X_BL/ServerAction/A"), node("osgraph://X_BL/Entity/E")],
      links: [{ source: "osgraph://X_BL/ServerAction/A", target: "osgraph://X_BL/Entity/E", relation: "references" }]
    };
    expect(listViolations(snap, rules)).toEqual({ violations: [], unknownModules: [] });
  });

  it("derives the module from the id (the contract) and the layer from the module name, not node.layer", () => {
    const snap: SnapshotLike = {
      nodes: [
        { id: "osgraph://Real_UI/Screen/F/S", module: "Real_UI", layer: "BL" },
        { id: "osgraph://Real_CS/Entity/E", module: "Real_CS", layer: "UI" }
      ],
      links: [{ source: "osgraph://Real_UI/Screen/F/S", target: "osgraph://Real_CS/Entity/E", relation: "references" }]
    };
    const [v] = listViolations(snap, rules).violations;
    expect(v).toMatchObject({ sourceModule: "Real_UI", targetModule: "Real_CS", sourceLayer: "UI", targetLayer: "CS" });
  });

  it("skips opaque external ids but evaluates dangling endpoints from their id (fail-closed)", () => {
    const snap: SnapshotLike = {
      nodes: [node("osgraph://A_UI/Screen/F/S"), node("osgraph://external/abc-123")],
      links: [
        { source: "osgraph://A_UI/Screen/F/S", target: "osgraph://external/abc-123", relation: "references" },
        { source: "osgraph://A_UI/Screen/F/S", target: "osgraph://Missing_CS/Entity/E", relation: "references" }
      ]
    };
    const report = listViolations(snap, rules);
    expect(report.unknownModules).toEqual([]);
    expect(report.violations.map((v) => v.targetModule)).toEqual(["Missing_CS"]);
  });

  it("sorts violations by (source, target, relation) and unknownModules alphabetically", () => {
    const snap: SnapshotLike = {
      nodes: [
        node("osgraph://Z_UI"), node("osgraph://A_CS"), node("osgraph://B_LKP"),
        node("osgraph://Zeta"), node("osgraph://Alpha")
      ],
      links: [
        { source: "osgraph://Z_UI", target: "osgraph://B_LKP", relation: "depends_on" },
        { source: "osgraph://Z_UI", target: "osgraph://A_CS", relation: "references" },
        { source: "osgraph://Z_UI", target: "osgraph://A_CS", relation: "depends_on" },
        { source: "osgraph://Z_UI", target: "osgraph://Zeta", relation: "depends_on" },
        { source: "osgraph://Alpha", target: "osgraph://A_CS", relation: "depends_on" }
      ]
    };
    const report = listViolations(snap, rules);
    expect(report.violations.map((v) => `${v.target} ${v.relation}`)).toEqual([
      "osgraph://A_CS depends_on",
      "osgraph://A_CS references",
      "osgraph://B_LKP depends_on"
    ]);
    expect(report.unknownModules).toEqual(["Alpha", "Zeta"]);
  });
});

describe("listViolations fail-closed (S5 audit notes 1-2)", () => {
  it("evaluates an edge whose target node is missing, from the id", () => {
    const rules = loadLayerRules();
    const report = listViolations(
      {
        nodes: [{ id: "osgraph://A_UI/Screen/F/Home" }],
        links: [{ source: "osgraph://A_UI/Screen/F/Home", target: "osgraph://B_CS/Entity/Customer", relation: "references" }]
      },
      rules
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.targetModule).toBe("B_CS");
  });
  it("prefers the id's module over a conflicting module attribute", () => {
    expect(moduleOfNode({ id: "osgraph://B_CS/Entity/X", module: "Other" })).toBe("B_CS");
  });
});
