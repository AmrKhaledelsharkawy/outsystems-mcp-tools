/**
 * #66: `graphStatus` / `osgraph status` over synthetic on-disk snapshots. Manifests are written by
 * hand so a schema-1 (old) capture, a missing module and an unusable manifest can all be built.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeGraphStatus, formatGraphStatus, type GraphStatusResult } from "../src/status/graphStatus.js";
import { parseArgs, requiresServiceStudioAtStart, USAGE } from "../src/cli/args.js";
import { call, makeCtx, tool } from "./tools.helpers.js";

function writeManifest(graphDir: string, scope: string, module: string, body: Record<string, unknown>): void {
  const dir = join(graphDir, scope, "raw", encodeURIComponent(module));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ scope, module, moduleType: "eSpace", texts: [], ...body }));
}

const v2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 2,
  capturedAt: "2026-11-01T10:00:00.000Z",
  moduleKey: "key-a",
  moduleVersion: "3.4",
  moduleIdentityReason: null,
  referencedOnlyCount: 2,
  skipped: [],
  ...over
});

/** Old schema: no identity fields at all. */
const v1 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  capturedAt: "2026-10-01T08:00:00.000Z",
  referencedOnlyCount: 1,
  skipped: [{ kind: "Screen", name: "S1", reason: "x" }],
  ...over
});

function defineDemo(made: ReturnType<typeof makeCtx>, modules: string[]): void {
  const dir = made.config.scopesDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "demo.json"), JSON.stringify({ name: "demo", modules }));
}

function snapshotFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = statSync(p).mtimeMs + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

describe("graphStatus", () => {
  it("is registered with a documented schema and a described scope field", () => {
    const t = tool("graphStatus");
    expect(t.description).toContain("moduleVersion");
    expect(t.description).toContain("missingModules");
    expect(Object.values(t.inputSchema).map((s) => s.description ?? "")).toEqual([expect.stringContaining("Scope")]);
  });

  it("reports per-module facts, an old-schema capture, a missing module and scope totals", async () => {
    const made = makeCtx();
    defineDemo(made, ["Mod_B", "Mod_A", "Mod_Missing"]);
    const g = made.config.graphDir;
    writeManifest(g, "demo", "Mod_A", v2({ skipped: [{ kind: "Screen", name: "S", reason: "r" }] }));
    writeManifest(g, "demo", "Mod_B", v1());
    writeFileSync(join(g, "demo", "graph.json"), "{}");
    writeFileSync(join(g, "demo", "meta.json"), JSON.stringify({ rebuiltAt: "2026-11-02T00:00:00.000Z", scope: "demo", skippedCount: 2 }));

    const res = await call<GraphStatusResult>("graphStatus", { scope: "demo" }, made.ctx);
    expect(res.error).toBeUndefined();
    const r = res.result as GraphStatusResult;
    expect(r.snapshot).toEqual({ present: true, builtAt: "2026-11-02T00:00:00.000Z", stagedFrom: null, stagedTo: null });
    expect(r.modules).toEqual([
      {
        module: "Mod_A",
        capturedAt: "2026-11-01T10:00:00.000Z",
        moduleVersion: "3.4",
        moduleVersionReason: null,
        skippedCount: 1,
        referencedOnlyCount: 2
      },
      {
        module: "Mod_B",
        capturedAt: "2026-10-01T08:00:00.000Z",
        moduleVersion: "unknown",
        moduleVersionReason: "OLD_SCHEMA",
        skippedCount: 1,
        referencedOnlyCount: 1
      }
    ]);
    expect(r.completeness).toEqual({
      scopeModuleCount: 3,
      capturedModuleCount: 2,
      missingModules: ["Mod_Missing"],
      complete: false,
      totalSkipped: 2,
      totalReferencedOnly: 3
    });
    expect(r.captureProblems).toEqual([]);
  });

  it("a schema-2 capture whose listing had no version reads unknown with its reason", () => {
    const made = makeCtx();
    const g = made.config.graphDir;
    writeManifest(g, "demo", "Mod_A", v2({ moduleVersion: null, moduleKey: null, moduleIdentityReason: "NOT_IN_LISTING" }));
    const r = computeGraphStatus(g, "demo", ["Mod_A"]);
    expect(r.modules[0]).toMatchObject({ moduleVersion: "unknown", moduleVersionReason: "NOT_IN_LISTING" });
    expect(r.completeness.complete).toBe(true);
  });

  it("matches a scope spelling to the canonical module through requestedAs", () => {
    const made = makeCtx();
    const g = made.config.graphDir;
    writeManifest(g, "demo", "Mod_A", v2({ requestedAs: "mod_a" }));
    const r = computeGraphStatus(g, "demo", ["mod_a"]);
    expect(r.completeness.missingModules).toEqual([]);
    expect(r.modules.map((m) => m.module)).toEqual(["Mod_A"]);
  });

  it("no snapshot and no captures: absent snapshot, every scope module missing", async () => {
    const made = makeCtx();
    defineDemo(made, ["Mod_A"]);
    const res = await call<GraphStatusResult>("graphStatus", { scope: "demo" }, made.ctx);
    expect(res.error).toBeUndefined();
    expect(res.result?.snapshot).toEqual({ present: false, builtAt: null, stagedFrom: null, stagedTo: null });
    expect(res.result?.completeness.missingModules).toEqual(["Mod_A"]);
  });

  it("reports staged bounds and lists unusable manifests without failing", () => {
    const made = makeCtx();
    const g = made.config.graphDir;
    mkdirSync(join(g, "demo"), { recursive: true });
    writeFileSync(
      join(g, "demo", "meta.json"),
      JSON.stringify({ rebuiltAt: "2026-11-05T00:00:00.000Z", scope: "demo", skippedCount: 0, stagedFrom: "2026-11-01T00:00:00.000Z", stagedTo: "2026-11-04T00:00:00.000Z" })
    );
    writeManifest(g, "demo", "Mod_A", v2());
    writeManifest(g, "demo", "Mod_Odd", v2({ schemaVersion: 99 }));
    const bad = join(g, "demo", "raw", "Mod_Bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "manifest.json"), "{not json");
    const r = computeGraphStatus(g, "demo", ["Mod_A", "Mod_Odd"]);
    expect(r.snapshot).toMatchObject({ stagedFrom: "2026-11-01T00:00:00.000Z", stagedTo: "2026-11-04T00:00:00.000Z" });
    expect(r.captureProblems).toEqual([
      { directory: "Mod_Bad", reason: "MANIFEST_UNREADABLE" },
      { directory: "Mod_Odd", reason: "RAW_SCHEMA_MISMATCH" }
    ]);
    expect(r.completeness.missingModules).toEqual(["Mod_Odd"]);
  });

  it("is read-only: writes nothing and never creates a Studio session", async () => {
    let sessions = 0;
    const made = makeCtx({
      createSession: () => {
        sessions++;
        throw new Error("graphStatus must not open a Studio session");
      }
    });
    defineDemo(made, ["Mod_A"]);
    writeManifest(made.config.graphDir, "demo", "Mod_A", v2());
    const before = snapshotFiles(made.config.graphDir);
    const first = await call("graphStatus", { scope: "demo" }, made.ctx);
    const second = await call("graphStatus", { scope: "demo" }, made.ctx);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second)); // stable JSON
    expect(sessions).toBe(0);
    expect(snapshotFiles(made.config.graphDir)).toEqual(before);
    expect(readFileSync(join(made.config.scopesDir, "demo.json"), "utf8")).toContain("Mod_A");
  });

  it("answers an unknown scope and a bad input in the normal envelope", async () => {
    const { ctx } = makeCtx();
    const none = await call("graphStatus", { scope: "nope" }, ctx);
    expect(none.error?.code).toBe("SCOPE_NOT_FOUND");
    const bad = await call("graphStatus", {}, ctx);
    expect(bad.error?.code).toBe("INPUT_INVALID");
    expect(bad.graphCompleteness).toBeDefined();
  });

  it("formats a plain-text report that names missing modules", () => {
    const made = makeCtx();
    writeManifest(made.config.graphDir, "demo", "Mod_B", v1());
    const text = formatGraphStatus(computeGraphStatus(made.config.graphDir, "demo", ["Mod_B", "Mod_Gone"]));
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("NO CAPTURE  Mod_Gone");
    expect(text).toContain("version unknown (OLD_SCHEMA)");
  });

  it("CLI: `status` is an offline command documented in --help", () => {
    expect(requiresServiceStudioAtStart("status")).toBe(false);
    expect(parseArgs(["status", "--scope", "demo", "--json"])).toEqual({ command: "status", options: { scope: "demo", json: "true" } });
    expect(USAGE).toContain("osgraph status --scope");
  });
});
