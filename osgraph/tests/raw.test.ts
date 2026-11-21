/**
 * F0 raw-text persistence (goal-osgraph-flows.md Design 1).
 *
 * The property the flow parser rests on is byte-equality: `raw/` must hold exactly the strings the
 * extractor was handed, or "flow extraction is a pure function over `raw/`" is false and an offline
 * `reextract` can disagree with a live rebuild without anybody noticing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayerRules } from "../src/layers/rules.js";
import { rebuildScope, stageModule } from "../src/rebuild/rebuild.js";
import {
  IDENTITY_UNKNOWN_NOT_LISTED,
  IDENTITY_UNKNOWN_OLD_SCHEMA,
  RAW_SCHEMA_VERSION,
  RawCaptureError,
  RawModuleWriter,
  encodeSegment,
  listRawModules,
  rawManifestPath,
  rawModuleDir,
  rawRelativeFile,
  readRawModule,
  recoverRawDir,
  type RawManifest
} from "../src/rebuild/raw.js";
import { demoPortalModule, fakeSession, syntheticXModule } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-raw-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scope = { name: "demo", modules: ["demoportal", "x"] };
const fixedNow = (): Date => new Date("2026-10-30T12:00:00.000Z");

describe("raw path encoding", () => {
  it("escapes every separator, wildcard and dot a name could carry", () => {
    expect(encodeSegment("Login")).toBe("Login");
    expect(encodeSegment("a/b")).toBe("a%2Fb");
    expect(encodeSegment("a\\b")).toBe("a%5Cb");
    expect(encodeSegment("C:name")).toBe("C%3Aname");
    // `*` and `?` survive encodeURIComponent but are illegal on Windows; `.` would allow traversal.
    expect(encodeSegment("a*b?c")).toBe("a%2Ab%3Fc");
    expect(encodeSegment("..")).toBe("%2E%2E");
    expect(encodeSegment("")).toBe("_");
    for (const value of ["Login", "a/b", "..", "a*b?c", "Flow Name", "ü"]) {
      expect(decodeURIComponent(encodeSegment(value))).toBe(value);
    }
  });

  it("puts screens and blocks under their UI flow (ADR-0008) and actions directly under the kind", () => {
    expect(rawRelativeFile("dataModel", "", undefined)).toBe("module/dataModel.txt");
    expect(rawRelativeFile("structures", "", undefined)).toBe("module/structures.txt");
    expect(rawRelativeFile("Screen", "Login", "MainFlow")).toBe("Screen/MainFlow/Login.txt");
    expect(rawRelativeFile("Block", "Accordion", "Common")).toBe("Block/Common/Accordion.txt");
    expect(rawRelativeFile("Screen", "Login", "")).toBe("Screen/_NOFLOW/Login.txt");
    expect(rawRelativeFile("ClientAction", "DoThing", undefined)).toBe("ClientAction/DoThing.txt");
    expect(rawRelativeFile("ServerAction", "BL_Check", undefined)).toBe("ServerAction/BL_Check.txt");
  });
});

describe("RawModuleWriter", () => {
  it("writes the given bytes verbatim and reads them back through the manifest", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "MOD_A_CW");
    // CRLF, no trailing newline, a BOM-ish leading char: none of it may be normalized.
    const text = "﻿var a = 1;\r\n  var b = 2;";
    w.add({ kind: "Screen", manifestKind: "Screen", call: "getScreen", name: "Login", uiFlow: "MainFlow", text });
    w.add({ kind: "dataModel", manifestKind: "Entity", call: "getDataModel", text: "entities" });
    w.writeManifest({ moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 3, skipped: [] });

    const onDisk = readFileSync(join(rawModuleDir(dir, "s", "MOD_A_CW"), "Screen", "MainFlow", "Login.txt"), "utf8");
    expect(onDisk).toBe(text);

    const capture = readRawModule(dir, "s", "MOD_A_CW");
    expect(capture.manifest.schemaVersion).toBe(RAW_SCHEMA_VERSION);
    expect(capture.manifest.module).toBe("MOD_A_CW");
    expect(capture.manifest.referencedOnlyCount).toBe(3);
    expect(capture.texts.map((t) => [t.kind, t.name, t.uiFlow, t.file])).toEqual([
      ["Screen", "Login", "MainFlow", "Screen/MainFlow/Login.txt"],
      ["Entity", undefined, undefined, "module/dataModel.txt"]
    ]);
    expect(capture.texts[0].text).toBe(text);
    expect(capture.texts[0].bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("gives colliding encoded names separate files rather than overwriting one with the other", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "M");
    // A UI flow literally named `_NOFLOW` encodes to the same segment as "no flow at all".
    w.add({ kind: "Screen", manifestKind: "Screen", call: "getScreen", name: "S", uiFlow: "", text: "noflow" });
    w.add({ kind: "Screen", manifestKind: "Screen", call: "getScreen", name: "S", uiFlow: "_NOFLOW", text: "realflow" });
    w.writeManifest({ moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] });
    const capture = readRawModule(dir, "s", "M");
    expect(capture.texts.map((t) => t.file)).toEqual(["Screen/_NOFLOW/S.txt", "Screen/_NOFLOW/S~2.txt"]);
    expect(capture.texts.map((t) => t.text)).toEqual(["noflow", "realflow"]);
  });

  it("replaces, not duplicates, when the same element is captured twice (a retry that succeeded)", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "M");
    w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name: "A", text: "first" });
    w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name: "A", text: "second" });
    w.writeManifest({ moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] });
    const capture = readRawModule(dir, "s", "M");
    expect(capture.texts).toHaveLength(1);
    expect(capture.texts[0].text).toBe("second");
  });

  it("records requestedAs only when the scope spelled the module differently", () => {
    const dir = tmp();
    for (const [requestedAs, expected] of [
      ["MOD_A_CW", undefined],
      ["mod_a_cw", "mod_a_cw"]
    ] as const) {
      const w = new RawModuleWriter(dir, "s", "MOD_A_CW");
      w.writeManifest({ requestedAs, moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] });
      expect(readRawModule(dir, "s", "MOD_A_CW").manifest.requestedAs).toBe(expected);
    }
  });
});

describe("readRawModule failure modes", () => {
  it("treats a never-finished capture as no capture: texts live in a staging directory, not in raw/<module>", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "M");
    w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name: "A", text: "x" });
    // No writeManifest: exactly the state an aborted rebuild leaves behind.
    expect(existsSync(rawModuleDir(dir, "s", "M"))).toBe(false);
    expect(() => readRawModule(dir, "s", "M")).toThrowError(RawCaptureError);
    try {
      readRawModule(dir, "s", "M");
    } catch (err) {
      expect((err as RawCaptureError).code).toBe("RAW_NOT_CAPTURED");
    }
    expect(listRawModules(dir, "s")).toEqual([]);
  });

  it("refuses a manifest of another schema version instead of guessing at its shape", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "M");
    w.writeManifest({ moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] });
    const path = rawManifestPath(dir, "s", "M");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as RawManifest;
    writeFileSync(path, JSON.stringify({ ...manifest, schemaVersion: 99 }), "utf8");
    try {
      readRawModule(dir, "s", "M");
      throw new Error("expected RAW_SCHEMA_MISMATCH");
    } catch (err) {
      expect((err as RawCaptureError).code).toBe("RAW_SCHEMA_MISMATCH");
    }
  });

  it("reports a listed file that has gone missing instead of silently dropping the text", () => {
    const dir = tmp();
    const w = new RawModuleWriter(dir, "s", "M");
    w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name: "A", text: "x" });
    w.writeManifest({ moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] });
    rmSync(join(rawModuleDir(dir, "s", "M"), "ServerAction", "A.txt"));
    try {
      readRawModule(dir, "s", "M");
      throw new Error("expected RAW_FILE_MISSING");
    } catch (err) {
      expect((err as RawCaptureError).code).toBe("RAW_FILE_MISSING");
    }
  });
});

describe("rebuild captures raw texts", () => {
  it("writes one file per fetched text, byte-equal to what the reader returned", async () => {
    const graphDir = join(tmp(), "graphs");
    const portal = demoPortalModule({ referencedOnly: false });
    const x = syntheticXModule();
    const session = fakeSession([portal, x]);
    await rebuildScope({
      scope,
      snapshotPath: join(graphDir, "demo", "graph.json"),
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      rawGraphDir: graphDir
    });

    expect(listRawModules(graphDir, "demo")).toEqual(["demoportal", "x"]);

    // Every text the fake served must be on disk with exactly those bytes.
    const capture = readRawModule(graphDir, "demo", "demoportal");
    expect(capture.manifest.moduleType).toBe("Reactive");
    expect(capture.manifest.capturedAt).toBe(fixedNow().toISOString());
    const byKindName = new Map(capture.texts.map((t) => [`${t.kind}/${t.name ?? ""}`, t]));
    for (const [key, expected] of Object.entries(portal.texts)) {
      const got = byKindName.get(key);
      expect(got, `missing raw text for ${key}`).toBeDefined();
      expect(got?.text).toBe(expected);
    }
    expect(byKindName.get("Entity/")?.text).toBe(portal.dataModel);
    expect(byKindName.get("Structure/")?.text).toBe(portal.structures);

    const xCapture = readRawModule(graphDir, "demo", "x");
    expect(xCapture.texts.find((t) => t.name === "BL_IsCodePatternValid")?.text).toBe(x.texts["ServerAction/BL_IsCodePatternValid"]);
    expect(xCapture.manifest.skipped).toEqual([]);
  });

  it("captures nothing when rawGraphDir is not given", async () => {
    const graphDir = join(tmp(), "graphs");
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    await rebuildScope({
      scope,
      snapshotPath: join(graphDir, "demo", "graph.json"),
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(existsSync(join(graphDir, "demo", "raw"))).toBe(false);
  });

  it("names a skipped element in the manifest, with no file for it", async () => {
    const graphDir = join(tmp(), "graphs");
    const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()], {
      failures: { "getScreen:demoportal:SignIn": Infinity }
    });
    await rebuildScope({
      scope,
      snapshotPath: join(graphDir, "demo", "graph.json"),
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0,
      rawGraphDir: graphDir
    });
    const capture = readRawModule(graphDir, "demo", "demoportal");
    expect(capture.manifest.skipped).toEqual([{ kind: "Screen", name: "SignIn", reason: "TOOL_ERROR" }]);
    expect(capture.texts.some((t) => t.name === "SignIn")).toBe(false);
    // every other screen of the listing is still captured
    expect(capture.texts.filter((t) => t.kind === "Screen").map((t) => t.name)).toEqual(["Home", "Catalog", "Contact", "Help"]);
  });

  it("captures on the staged path too, without being asked, since that is where re-reading hurts most", async () => {
    const graphDir = join(tmp(), "graphs");
    const session = fakeSession([demoPortalModule({ referencedOnly: false })]);
    await stageModule({
      scope,
      module: "demoportal",
      graphDir,
      snapshotPath: join(graphDir, "demo", "graph.json"),
      session,
      rules,
      now: fixedNow,
      retryDelayMs: 0
    });
    expect(listRawModules(graphDir, "demo")).toEqual(["demoportal"]);
    expect(statSync(rawManifestPath(graphDir, "demo", "demoportal")).isFile()).toBe(true);
  });

  it("a failed walk aborts its raw writer, so the same module can be staged again in this process", async () => {
    const graphDir = join(tmp(), "graphs");
    const stage = (session: ReturnType<typeof fakeSession>) =>
      stageModule({
        scope,
        module: "demoportal",
        graphDir,
        snapshotPath: join(graphDir, "demo", "graph.json"),
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0
      });
    const failing = fakeSession([demoPortalModule({ referencedOnly: false })], { failures: { "getScreenNames:demoportal:": Infinity } });
    await expect(stage(failing)).rejects.toThrow();
    const parent = join(graphDir, "demo", "raw");
    expect(existsSync(parent) ? readdirSync(parent).filter((n) => n.startsWith("%tmp-")) : []).toEqual([]);
    // No RAW_CAPTURE_ACTIVE: the aborted writer released the module.
    await stage(fakeSession([demoPortalModule({ referencedOnly: false })]));
    expect(listRawModules(graphDir, "demo")).toEqual(["demoportal"]);
  });

  it("is deterministic: two rebuilds produce byte-identical raw files and manifests", async () => {
    const run = async (): Promise<Record<string, string>> => {
      const graphDir = join(tmp(), "graphs");
      const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()]);
      await rebuildScope({
        scope,
        snapshotPath: join(graphDir, "demo", "graph.json"),
        session,
        rules,
        now: fixedNow,
        retryDelayMs: 0,
        rawGraphDir: graphDir
      });
      const out: Record<string, string> = {};
      for (const module of listRawModules(graphDir, "demo")) {
        out[`${module}/manifest.json`] = readFileSync(rawManifestPath(graphDir, "demo", module), "utf8");
        for (const t of readRawModule(graphDir, "demo", module).texts) out[`${module}/${t.file}`] = t.text;
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});

describe("module identity in the manifest (#61)", () => {
  const base = { moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] };

  it("round-trips the key and version exactly as given, under schema 2", () => {
    const dir = tmp();
    new RawModuleWriter(dir, "s", "M").writeManifest({ ...base, moduleKey: "k-123", moduleVersion: "7.4" });
    const { manifest } = readRawModule(dir, "s", "M");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.moduleKey).toBe("k-123");
    expect(manifest.moduleVersion).toBe("7.4");
    expect(manifest.moduleIdentityReason).toBeNull();
  });

  it("stores null plus a reason, and does not fail, when the listing lacked them", () => {
    const dir = tmp();
    new RawModuleWriter(dir, "s", "M").writeManifest({ ...base, moduleKey: "", moduleVersion: undefined });
    const { manifest } = readRawModule(dir, "s", "M");
    expect(manifest.moduleKey).toBeNull();
    expect(manifest.moduleVersion).toBeNull();
    expect(manifest.moduleIdentityReason).toBe(IDENTITY_UNKNOWN_NOT_LISTED);
  });

  it("reads a schema-1 manifest as explicit unknown, leaving the file untouched", () => {
    const dir = tmp();
    new RawModuleWriter(dir, "s", "M").writeManifest({ ...base, moduleKey: "k", moduleVersion: "1" });
    const path = rawManifestPath(dir, "s", "M");
    const m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete m.moduleKey;
    delete m.moduleVersion;
    delete m.moduleIdentityReason;
    const old = JSON.stringify({ ...m, schemaVersion: 1 });
    writeFileSync(path, old, "utf8");
    const { manifest } = readRawModule(dir, "s", "M");
    expect(manifest.moduleKey).toBeNull();
    expect(manifest.moduleVersion).toBeNull();
    expect(manifest.moduleIdentityReason).toBe(IDENTITY_UNKNOWN_OLD_SCHEMA);
    expect(readFileSync(path, "utf8")).toBe(old);
  });

  it("a full rebuild persists the listing's key and version for every module", async () => {
    const dir = tmp();
    const session = fakeSession([demoPortalModule({ referencedOnly: false }), syntheticXModule()]);
    await rebuildScope({
      scope: { name: "demo", modules: ["demoportal", "x"] },
      snapshotPath: join(dir, "demo", "graph.json"),
      session,
      rules,
      retryDelayMs: 0,
      rawGraphDir: dir
    });
    for (const name of listRawModules(dir, "demo")) {
      const { manifest } = readRawModule(dir, "demo", name);
      expect(manifest.moduleKey).toBe(`key-${name}`);
      expect(manifest.moduleVersion).toBe("1.0");
      expect(manifest.moduleIdentityReason).toBeNull();
    }
  });
});

/** Every file under `dir` (relative path -> bytes), for byte-identity assertions. */
function snapshotDir(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, snapshotDir(join(dir, entry.name), `${rel}/`));
    else out[rel] = readFileSync(join(dir, entry.name), "utf8");
  }
  return out;
}

const meta = { moduleType: "Reactive", capturedAt: "2026-10-30T12:00:00.000Z", referencedOnlyCount: 0, skipped: [] };

function capture(dir: string, texts: Record<string, string>, finish = true): RawModuleWriter {
  const w = new RawModuleWriter(dir, "s", "M");
  for (const [name, text] of Object.entries(texts)) {
    w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name, text });
  }
  if (finish) w.writeManifest(meta);
  return w;
}

describe("atomic per-module capture (ADR-0015)", () => {
  it("a successful capture fully replaces the previous one", () => {
    const dir = tmp();
    capture(dir, { A: "old-a", B: "old-b" });
    capture(dir, { A: "new-a", C: "new-c" });
    const read = readRawModule(dir, "s", "M");
    expect(read.texts.map((t) => [t.name, t.text]).sort()).toEqual([["A", "new-a"], ["C", "new-c"]]);
    // No staging or aside directory is left beside the capture.
    expect(readdirSync(join(rawModuleDir(dir, "s", "M"), ".."))).toEqual(["M"]);
    expect(snapshotDir(rawModuleDir(dir, "s", "M"))["ServerAction/B.txt"]).toBeUndefined();
  });

  it("records a sha256 and byte length per text", () => {
    const dir = tmp();
    capture(dir, { A: "héllo" });
    const entry = readRawModule(dir, "s", "M").manifest.texts[0];
    expect(entry?.bytes).toBe(Buffer.byteLength("héllo", "utf8"));
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an abort mid-capture leaves the previous capture byte-identical and readable", () => {
    const dir = tmp();
    capture(dir, { A: "old-a", B: "old-b" });
    const before = snapshotDir(rawModuleDir(dir, "s", "M"));
    // Texts arrive, then the process "dies": the writer is never finished.
    capture(dir, { A: "new-a", Z: "new-z" }, false);
    expect(snapshotDir(rawModuleDir(dir, "s", "M"))).toEqual(before);
    expect(readRawModule(dir, "s", "M").texts.map((t) => t.text).sort()).toEqual(["old-a", "old-b"]);
    expect(listRawModules(dir, "s")).toEqual(["M"]);
  });

  it("leftover staging directories are never read, even one holding a finished manifest", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    const parent = join(rawModuleDir(dir, "s", "M"), "..");
    const stale = join(parent, "%tmp-Other-1-1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "manifest.json"), JSON.stringify({ schemaVersion: RAW_SCHEMA_VERSION, module: "Other", texts: [] }), "utf8");
    expect(listRawModules(dir, "s")).toEqual(["M"]);
  });

  it("a new capture of the same module clears that module's stale staging directory", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    // A writer that died with its process (no in-process owner) leaves its staging behind.
    const parent = join(rawModuleDir(dir, "s", "M"), "..");
    const dead = join(parent, "%tmp-M-999999-1");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "x.txt"), "never-finished", "utf8");
    expect(readdirSync(parent).filter((n) => n.startsWith("%tmp-"))).toHaveLength(1);
    capture(dir, { A: "next" });
    expect(readdirSync(parent)).toEqual(["M"]);
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("next");
  });

  it("a second unfinished writer for the same module (any case) is refused; the first is untouched", () => {
    const dir = tmp();
    const first = capture(dir, { A: "first" }, false);
    const parent = join(rawModuleDir(dir, "s", "M"), "..");
    const before = readdirSync(parent).filter((n) => n.startsWith("%tmp-"));
    expect(before).toHaveLength(1);
    expect(() => new RawModuleWriter(dir, "s", "M")).toThrow(/already in progress/);
    expect(() => new RawModuleWriter(dir, "s", "m")).toThrow(/already in progress/);
    expect(readdirSync(parent).filter((n) => n.startsWith("%tmp-"))).toEqual(before);
    // The same module captured into another scope is a different live directory: not blocked.
    const other = new RawModuleWriter(dir, "s2", "M");
    other.abort();
    first.writeManifest(meta);
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("first");
  });

  it("abort() frees the module so it can be captured again in the same process", () => {
    const dir = tmp();
    capture(dir, { A: "old" });
    const w = capture(dir, { A: "aborted" }, false);
    w.abort();
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("old");
    capture(dir, { A: "again" });
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("again");
  });

  describe("staging cleanup is exact-module (concurrent writers)", () => {
    const add = (w: RawModuleWriter, name: string, text: string): void => {
      w.add({ kind: "ServerAction", manifestKind: "ServerAction", call: "getServerAction", name, text });
    };
    const stagingNames = (dir: string): string[] =>
      readdirSync(join(rawModuleDir(dir, "s", "X"), "..")).filter((n) => n.startsWith("%tmp-"));

    it("starting X does not delete the unfinished staging of X-Y; both finish correctly", () => {
      const dir = tmp();
      const xy = new RawModuleWriter(dir, "s", "X-Y");
      add(xy, "A", "xy-a");
      const x = new RawModuleWriter(dir, "s", "X");
      add(x, "B", "x-b");
      expect(stagingNames(dir)).toHaveLength(2);
      add(xy, "C", "xy-c");
      xy.writeManifest(meta);
      x.writeManifest(meta);
      expect(readRawModule(dir, "s", "X-Y").texts.map((t) => t.text).sort()).toEqual(["xy-a", "xy-c"]);
      expect(readRawModule(dir, "s", "X").texts.map((t) => t.text)).toEqual(["x-b"]);
      expect(readdirSync(join(rawModuleDir(dir, "s", "X"), "..")).sort()).toEqual(["X", "X-Y"]);
    });

    it("starting X-Y does not delete the unfinished staging of X (reverse order)", () => {
      const dir = tmp();
      const x = new RawModuleWriter(dir, "s", "X");
      add(x, "B", "x-b");
      const xy = new RawModuleWriter(dir, "s", "X-Y");
      add(xy, "A", "xy-a");
      expect(stagingNames(dir)).toHaveLength(2);
      x.writeManifest(meta);
      xy.writeManifest(meta);
      expect(readRawModule(dir, "s", "X").texts.map((t) => t.text)).toEqual(["x-b"]);
      expect(readRawModule(dir, "s", "X-Y").texts.map((t) => t.text)).toEqual(["xy-a"]);
    });

    it("sibling modules whose encoded names share a numeric tail are not matched", () => {
      const dir = tmp();
      const a = new RawModuleWriter(dir, "s", "X-1");
      add(a, "A", "a");
      const b = new RawModuleWriter(dir, "s", "X");
      add(b, "B", "b");
      expect(stagingNames(dir)).toHaveLength(2);
      a.writeManifest(meta);
      b.writeManifest(meta);
      expect(readRawModule(dir, "s", "X-1").texts[0]?.text).toBe("a");
      expect(readRawModule(dir, "s", "X").texts[0]?.text).toBe("b");
    });

    it("stale exact-module staging is still removed, and other modules' staging is left alone", () => {
      const dir = tmp();
      const live = rawModuleDir(dir, "s", "X");
      const parent = join(live, "..");
      mkdirSync(parent, { recursive: true });
      mkdirSync(join(parent, "%tmp-X-999-1"), { recursive: true });
      mkdirSync(join(parent, "%tmp-X-Y-999-2"), { recursive: true });
      const x = new RawModuleWriter(dir, "s", "X");
      expect(existsSync(join(parent, "%tmp-X-999-1"))).toBe(false);
      expect(existsSync(join(parent, "%tmp-X-Y-999-2"))).toBe(true);
      x.abort();
    });

    it("an aborted writer leaves the previous live capture unchanged and does not disturb a sibling", () => {
      const dir = tmp();
      const prior = new RawModuleWriter(dir, "s", "X");
      add(prior, "A", "old-a");
      prior.writeManifest(meta);
      const before = snapshotDir(rawModuleDir(dir, "s", "X"));
      const xy = new RawModuleWriter(dir, "s", "X-Y");
      add(xy, "A", "xy-a");
      const x = new RawModuleWriter(dir, "s", "X");
      add(x, "A", "new-a");
      x.abort();
      expect(snapshotDir(rawModuleDir(dir, "s", "X"))).toEqual(before);
      xy.writeManifest(meta);
      expect(readRawModule(dir, "s", "X-Y").texts[0]?.text).toBe("xy-a");
      expect(readRawModule(dir, "s", "X").texts[0]?.text).toBe("old-a");
    });
  });

  it("recovers a swap killed between the two renames (old aside, no live capture)", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    const live = rawModuleDir(dir, "s", "M");
    const before = snapshotDir(live);
    renameSync(live, join(live, "..", "%old-M"));
    expect(existsSync(live)).toBe(false);
    expect(listRawModules(dir, "s")).toEqual(["M"]);
    expect(snapshotDir(live)).toEqual(before);
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("old-a");
  });

  it("recovery at the next writer start restores the old capture, and a finished swap's aside is dropped", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    const live = rawModuleDir(dir, "s", "M");
    renameSync(live, join(live, "..", "%old-M"));
    capture(dir, { A: "newer" }, false); // the constructor recovers
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("old-a");
    // Aside left beside a live capture (killed after the second rename, before the rm).
    mkdirSync(join(live, "..", "%old-M"), { recursive: true });
    recoverRawDir(dir, "s");
    expect(readdirSync(join(live, "..")).filter((n) => n.startsWith("%old-"))).toEqual([]);
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("old-a");
  });

  it("refuses to swap in a capture whose text fails the hash check and keeps the previous capture", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    const before = snapshotDir(rawModuleDir(dir, "s", "M"));
    const w = capture(dir, { A: "new-a" }, false);
    const parent = join(rawModuleDir(dir, "s", "M"), "..");
    const staged = readdirSync(parent).find((n) => n.startsWith("%tmp-M-"));
    writeFileSync(join(parent, staged as string, "ServerAction", "A.txt"), "tampered", "utf8");
    try {
      w.writeManifest(meta);
      throw new Error("expected RAW_FILE_CORRUPT");
    } catch (err) {
      expect((err as RawCaptureError).code).toBe("RAW_FILE_CORRUPT");
    }
    expect(snapshotDir(rawModuleDir(dir, "s", "M"))).toEqual(before);
    expect(readdirSync(parent)).toEqual(["M"]);
  });

  it("readers reject a live capture whose file no longer matches its manifest hash", () => {
    const dir = tmp();
    capture(dir, { A: "old-a" });
    writeFileSync(join(rawModuleDir(dir, "s", "M"), "ServerAction", "A.txt"), "tampered", "utf8");
    try {
      readRawModule(dir, "s", "M");
      throw new Error("expected RAW_FILE_CORRUPT");
    } catch (err) {
      expect((err as RawCaptureError).code).toBe("RAW_FILE_CORRUPT");
    }
  });

  it("still reads a capture written before hashes were recorded (no sha256 in the manifest)", () => {
    const dir = tmp();
    capture(dir, { A: "legacy" });
    const path = rawManifestPath(dir, "s", "M");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as RawManifest;
    for (const t of manifest.texts) delete t.sha256;
    writeFileSync(path, JSON.stringify(manifest), "utf8");
    expect(readRawModule(dir, "s", "M").texts[0]?.text).toBe("legacy");
  });

  it("a rebuild aborted by a kind-level read failure leaves the previous capture byte-identical", async () => {
    const graphDir = join(tmp(), "graphs");
    const sc = { name: "demo", modules: ["x"] };
    const snapshotPath = join(graphDir, "demo", "graph.json");
    await rebuildScope({ scope: sc, snapshotPath, session: fakeSession([syntheticXModule()]), rules, now: fixedNow, retryDelayMs: 0, rawGraphDir: graphDir });
    const before = snapshotDir(rawModuleDir(graphDir, "demo", "x"));

    const changed = syntheticXModule();
    for (const key of Object.keys(changed.texts)) changed.texts[key] = `${changed.texts[key]}\n// changed`;
    const failing = fakeSession([changed], { failures: { "getStructures:x:": Infinity } });
    await expect(
      rebuildScope({ scope: sc, snapshotPath, session: failing, rules, now: fixedNow, retryDelayMs: 0, rawGraphDir: graphDir })
    ).rejects.toMatchObject({ code: "KIND_READ_FAILED" });
    expect(snapshotDir(rawModuleDir(graphDir, "demo", "x"))).toEqual(before);
    expect(readRawModule(graphDir, "demo", "x").manifest.module).toBe("x");

    // A subsequent successful capture is the fully new one.
    await rebuildScope({ scope: sc, snapshotPath, session: fakeSession([changed]), rules, now: fixedNow, retryDelayMs: 0, rawGraphDir: graphDir });
    const after = snapshotDir(rawModuleDir(graphDir, "demo", "x"));
    expect(after).not.toEqual(before);
    expect(Object.values(after).some((t) => t.includes("// changed"))).toBe(true);
  });
});
