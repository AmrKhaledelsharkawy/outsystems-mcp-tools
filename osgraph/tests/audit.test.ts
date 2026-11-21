/**
 * #67: the accuracy audit's sampler, automatic check and report, over a synthetic scope built in
 * memory (arbitrary module names, no captures). A snapshot is extracted from one set of texts and
 * audited against a *changed* set, so the false and missing edges are planted, not assumed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractModule, type ModuleInput } from "../src/extract/index.js";
import { buildSnapshot } from "../src/graph/index.js";
import { assignLayer } from "../src/layers/assign.js";
import { loadLayerRules } from "../src/layers/rules.js";
import {
  auditSnapshot,
  formatReport,
  rawTextSource,
  sampleSnapshot,
  textReferences,
  type AuditPair,
  type TextSource
} from "../src/audit/index.js";
import { RAW_SCHEMA_VERSION, rawManifestPath, rawModuleDir, type RawModuleCapture } from "../src/rebuild/raw.js";
import { parseArgs, REQUIRES_SERVICESTUDIO_AT_START, USAGE } from "../src/cli/args.js";

const rules = loadLayerRules();
const CW = "MOD_DEMO_Feat_CW";
const BL = "MOD_DEMO_Feat_BL";

function blAction(name: string): string {
  return `\`\`\`csharp
(OutSystems.Model.IESpace eSpace) => {
    /*** creating IServerAction '${name}' ***/
    var x = eSpace.CreateServerAction("${name}");
}
\`\`\``;
}

/** A CW server action calling the given BL actions through a module reference. */
function cwAction(name: string, calls: string[]): string {
  const body = calls
    .map(
      (c, i) => `    var ${c.toLowerCase()}Ref = refBl.ServerActions.Named("${c}");
    var node${i} = x.CreateNode<OutSystems.Model.Logic.Nodes.IExecuteServerActionNode>("${c}");
    node${i}.Action = ${c.toLowerCase()}Ref;`
    )
    .join("\n");
  return `\`\`\`csharp
(OutSystems.Model.IESpace eSpace) => {
    /*** creating IServerAction '${name}' ***/
    var x = eSpace.CreateServerAction("${name}");
    var refBl = eSpace.References.Named("${BL}");
${body}
}
\`\`\``;
}

function moduleInput(module: string, actions: Record<string, string>): ModuleInput {
  return {
    module,
    moduleType: "Reactive",
    texts: {
      dataModel: "",
      structures: "",
      screens: [],
      blocks: [],
      clientActions: [],
      serverActions: Object.entries(actions).map(([name, text]) => ({ name, text }))
    }
  };
}

/** Texts the snapshot is built from. */
const builtFrom: Record<string, string> = {
  [`${BL}|BL_A`]: blAction("BL_A"),
  [`${BL}|BL_B`]: blAction("BL_B"),
  [`${BL}|BL_C`]: blAction("BL_C"),
  [`${CW}|CW_Run`]: cwAction("CW_Run", ["BL_A", "BL_B"]),
  [`${CW}|CW_Other`]: cwAction("CW_Other", ["BL_A"])
};

function buildSynthetic() {
  const bl = moduleInput(BL, {
    BL_A: builtFrom[`${BL}|BL_A`],
    BL_B: builtFrom[`${BL}|BL_B`],
    BL_C: builtFrom[`${BL}|BL_C`]
  });
  const cw = moduleInput(CW, {
    CW_Run: builtFrom[`${CW}|CW_Run`],
    CW_Other: builtFrom[`${CW}|CW_Other`]
  });
  return buildSnapshot({
    scopeName: "synthetic",
    modules: [extractModule(bl), extractModule(cw)],
    layerAssign: (m) => assignLayer(m, rules),
    now: new Date("2026-11-01T00:00:00.000Z")
  }).snapshot;
}

function textSource(texts: Record<string, string>): TextSource {
  return (id) => {
    const [, rest] = id.split("osgraph://");
    const [module, , name] = rest.split("/");
    return texts[`${module}|${name}`];
  };
}

describe("synthetic snapshot sanity", () => {
  it("has the edges the planted scenario relies on", () => {
    const snap = buildSynthetic();
    const pairs = snap.links
      .filter((l) => l.source.includes("/ServerAction/"))
      .map((l) => `${l.source.split("/").pop()}>${l.target.split("/").pop()}`).sort();
    expect(pairs).toEqual(["CW_Other>BL_A", "CW_Run>BL_A", "CW_Run>BL_B"]);
  });
});

describe("sampler", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const snap = buildSynthetic();
    const a = sampleSnapshot(snap, { k: 1, seed: "s1" });
    const b = sampleSnapshot(snap, { k: 1, seed: "s1" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const others = ["s2", "s3", "s4", "s5", "s6"].map((s) => JSON.stringify(sampleSnapshot(snap, { k: 1, seed: s })));
    expect(new Set([JSON.stringify(a), ...others]).size).toBeGreaterThan(1);
  });

  it("draws at most K edges and K distinct absent pairs per layer and kind, none of them real edges", () => {
    const snap = buildSynthetic();
    const sample = sampleSnapshot(snap, { k: 2, seed: "x" });
    const real = new Set(snap.links.map((l) => `${l.source}>${l.target}`));
    expect(sample.strata.length).toBeGreaterThan(0);
    for (const s of sample.strata) {
      expect(s.edges.length).toBeLessThanOrEqual(2);
      expect(s.absent.length).toBeLessThanOrEqual(2);
      const keys = s.absent.map((p) => `${p.consumer}>${p.producer}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(real.has(k)).toBe(false);
      for (const p of s.edges) expect(real.has(`${p.consumer}>${p.producer}`)).toBe(true);
      for (const p of [...s.edges, ...s.absent]) {
        expect(p.layer).toBe(s.layer);
        expect(p.kind).toBe(s.kind);
        expect(p.consumer).not.toBe(p.producer);
      }
    }
  });

  it("takes every edge when the stratum holds fewer than K", () => {
    const snap = buildSynthetic();
    const sample = sampleSnapshot(snap, { k: 50, seed: "x" });
    const cwToBl = sample.strata.find((s) => s.layer === "CW" && s.kind === "ServerAction");
    expect(cwToBl?.edgePopulation).toBe(3);
    expect(cwToBl?.edges).toHaveLength(3);
  });

  it("never lets one stratum's population change another's draw", () => {
    const snap = buildSynthetic();
    const full = sampleSnapshot(snap, { k: 1, seed: "iso" });
    const again = sampleSnapshot({ ...snap, links: [...snap.links] }, { k: 1, seed: "iso" });
    expect(again.strata.map((s) => s.edges.map((e) => e.producer))).toEqual(full.strata.map((s) => s.edges.map((e) => e.producer)));
  });

  it("counts, and never samples, edges whose target is an opaque external", () => {
    const snap = buildSynthetic();
    const withOpaque = {
      ...snap,
      links: [
        ...snap.links,
        {
          source: snap.links[0].source,
          target: "osgraph://external/abc",
          relation: "calls" as const,
          confidence: "AMBIGUOUS" as const,
          confidence_score: 0.5,
          source_file: "x"
        }
      ]
    };
    const sample = sampleSnapshot(withOpaque, { k: 50, seed: "x" });
    expect(sample.opaqueEdgesExcluded).toBe(1);
    for (const s of sample.strata) for (const p of s.edges) expect(p.producer).not.toContain("external/");
  });
});

describe("automatic check", () => {
  const pair = (producerName: string, producerModule = BL): AuditPair => ({
    consumer: `osgraph://${CW}/ServerAction/CW_Run`,
    producer: `osgraph://${producerModule}/ServerAction/${producerName}`,
    consumerModule: CW,
    producerModule,
    consumerKind: "ServerAction",
    kind: "ServerAction",
    layer: "CW"
  });

  it("finds a cross-module reference only when the producer module is opened too", () => {
    const text = cwAction("CW_Run", ["BL_A"]);
    expect(textReferences(text, pair("BL_A")).found).toBe(true);
    expect(textReferences(text, pair("BL_B")).found).toBe(false);
    expect(textReferences(text, pair("BL_A", "MOD_DEMO_Other_BL")).found).toBe(false);
  });

  it("accepts the clash-renamed local name and a dependency comment", () => {
    expect(textReferences('var r = eSpace.References.Named("' + BL + '");\nvar a = r.ServerActions.Named("BL_A2");', pair("BL_A")).found).toBe(true);
    const sig = `// IServerActionSignature ${BL}/BL_A\nvar a = (X.IServerActionSignature)eSpace.AddDependency(Services.ModelServices.ParseGlobalKey("k"));`;
    expect(textReferences(sig, pair("BL_A"))).toEqual({ found: true, how: "signature" });
  });

  it("reports planted false edges and missing edges with the reason", () => {
    const snap = buildSynthetic();
    // The module changed after the snapshot: CW_Run no longer calls BL_B (a false edge) and now
    // calls BL_C (a missing edge).
    const changed = { ...builtFrom, [`${CW}|CW_Run`]: cwAction("CW_Run", ["BL_A", "BL_C"]) };
    const report = auditSnapshot({ scope: "synthetic", snapshot: snap, textOf: textSource(changed), k: 50, seed: "p" });

    const falseEdge = report.disagreements.find((d) => d.type === "edge-not-in-text");
    expect(falseEdge?.consumer).toContain("CW_Run");
    expect(falseEdge?.producer).toContain("BL_B");
    expect(falseEdge?.reason).toMatch(/false edge/);
    const missing = report.disagreements.find((d) => d.type === "absent-in-text");
    expect(missing?.producer).toContain("BL_C");
    expect(missing?.reason).toMatch(/missing edge/);
    expect(report.disagreements).toHaveLength(2);

    // 2 of 3 edges confirmed; 2 confirmed edges + 1 missing edge.
    expect(report.totals.edges).toMatchObject({ sampled: 3, confirmed: 2, disagreements: 1 });
    expect(report.totals.precision).toBeCloseTo(2 / 3);
    expect(report.totals.recall).toBeCloseTo(2 / 3);
  });

  it("reports 100% and no disagreements when the texts match the snapshot", () => {
    const snap = buildSynthetic();
    const report = auditSnapshot({ scope: "synthetic", snapshot: snap, textOf: textSource(builtFrom), k: 50, seed: "p" });
    expect(report.disagreements).toEqual([]);
    expect(report.totals.precision).toBe(1);
    expect(report.totals.recall).toBe(1);
    expect(report.totals.absent.disagreements).toBe(0);
  });

  it("lists pairs with no captured text as unverifiable and keeps them out of the ratios", () => {
    const snap = buildSynthetic();
    const partial = { ...builtFrom };
    delete partial[`${CW}|CW_Other`];
    const report = auditSnapshot({ scope: "synthetic", snapshot: snap, textOf: textSource(partial), k: 50, seed: "p" });
    expect(report.totals.edges.unverifiable).toBe(1);
    expect(report.unverifiable.some((u) => u.consumer.endsWith("CW_Other") && u.side === "edge")).toBe(true);
    expect(report.totals.precision).toBe(1);
  });

  it("gives precision null, not 0, when nothing could be checked", () => {
    const snap = buildSynthetic();
    const report = auditSnapshot({ scope: "synthetic", snapshot: snap, textOf: () => undefined, k: 5, seed: "p" });
    expect(report.totals.precision).toBeNull();
    expect(report.totals.recall).toBeNull();
  });
});

describe("report", () => {
  it("renders counts, every disagreement and the Studio worksheet", () => {
    const snap = buildSynthetic();
    const changed = { ...builtFrom, [`${CW}|CW_Run`]: cwAction("CW_Run", ["BL_A", "BL_C"]) };
    const report = auditSnapshot({ scope: "synthetic", snapshot: snap, textOf: textSource(changed), k: 50, seed: "p" });
    const text = formatReport(report);
    expect(text).toContain("precision 66.7%");
    expect(text).toContain("recall    66.7%");
    expect(text).toContain("[edge-not-in-text]");
    expect(text).toContain("[absent-in-text]");
    expect(text).toContain("## Studio worksheet");
    // The CW -> BL pair has sampled edges; the BL -> CW pair is reached only by absent pairs.
    expect(report.studioWorksheet).toEqual([
      { consumerModule: BL, producerModule: CW, layer: "BL", graphSays: "not listed" },
      { consumerModule: CW, producerModule: BL, layer: "CW", graphSays: "listed" }
    ]);
  });
});

describe("raw text source", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("serves captured texts by element id and remembers modules with no capture", () => {
    const graphDir = mkdtempSync(join(tmpdir(), "osgraph-audit-"));
    dirs.push(graphDir);
    const dir = rawModuleDir(graphDir, "s", CW);
    mkdirSync(join(dir, "ServerAction"), { recursive: true });
    writeFileSync(join(dir, "ServerAction", "CW_Run.txt"), "hello");
    writeFileSync(
      rawManifestPath(graphDir, "s", CW),
      JSON.stringify({
        schemaVersion: RAW_SCHEMA_VERSION,
        module: CW,
        texts: [{ kind: "ServerAction", call: "getServerAction", name: "CW_Run", file: "ServerAction/CW_Run.txt", bytes: 5 }],
        skipped: []
      })
    );
    const read = (gd: string, scope: string, module: string): RawModuleCapture => {
      if (module !== CW) throw new Error("none");
      return {
        manifest: { schemaVersion: RAW_SCHEMA_VERSION } as RawModuleCapture["manifest"],
        texts: [{ kind: "ServerAction", call: "getServerAction", name: "CW_Run", file: "x", bytes: 5, text: "hello" }]
      };
    };
    const src = rawTextSource(graphDir, "s", read);
    expect(src.textOf(`osgraph://${CW}/ServerAction/CW_Run`)).toBe("hello");
    expect(src.textOf(`osgraph://${CW}/ServerAction/Nope`)).toBeUndefined();
    expect(src.textOf(`osgraph://${BL}/ServerAction/BL_A`)).toBeUndefined();
    expect(src.missing()).toEqual([BL]);
  });
});

describe("cli wiring", () => {
  it("parses audit flags, needs no Service Studio and is in the usage text", () => {
    expect(parseArgs(["audit", "--scope", "s", "--k", "5", "--seed", "abc"])).toEqual({
      command: "audit",
      options: { scope: "s", k: "5", seed: "abc" }
    });
    expect(REQUIRES_SERVICESTUDIO_AT_START.audit).toBe(false);
    expect(USAGE).toContain("osgraph audit --scope");
  });
});
