import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeStore, defineScope, listScopes, readScope } from "../src/scopes/index.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-scopes-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof OsgraphToolError ? err.code : `not-OsgraphToolError:${String(err)}`;
  }
  return undefined;
}

describe("ScopeStore (ADR-0005)", () => {
  it("round-trips a scope through a missing directory, keeping user order and deduping", () => {
    const dir = join(tmp(), "nested", "scopes");
    const entry = defineScope(dir, { name: "demoportal", modules: ["demoportal", "MOD_B_CW", "demoportal", " MOD_A_BL "] });
    expect(entry).toEqual({
      name: "demoportal",
      modules: ["demoportal", "MOD_B_CW", "MOD_A_BL"],
      path: join(dir, "demoportal.json")
    });
    expect(readFileSync(entry.path, "utf8")).toBe(
      `{\n  "modules": [\n    "demoportal",\n    "MOD_B_CW",\n    "MOD_A_BL"\n  ],\n  "name": "demoportal"\n}\n`
    );
    expect(readScope(dir, "demoportal")).toEqual(entry);
    expect(existsSync(`${entry.path}.tmp-${process.pid}`)).toBe(false);
  });

  it("listScopes: [] for a missing dir, sorted by name otherwise, skipping junk files", () => {
    const dir = join(tmp(), "none");
    expect(listScopes(dir)).toEqual([]);
    defineScope(dir, { name: "zeta", modules: ["Z"] });
    defineScope(dir, { name: "alpha", modules: ["A"] });
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "alpha.json.tmp-123"), "{}");
    expect(listScopes(dir).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("readScope: SCOPE_NOT_FOUND for a missing scope; SCOPE_INVALID for a malformed or misnamed file", () => {
    const dir = tmp();
    expect(codeOf(() => readScope(dir, "nope"))).toBe("SCOPE_NOT_FOUND");
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(codeOf(() => readScope(dir, "bad"))).toBe("SCOPE_INVALID");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ name: "different", modules: ["A"] }));
    expect(codeOf(() => readScope(dir, "other"))).toBe("SCOPE_INVALID");
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ name: "empty", modules: [] }));
    expect(codeOf(() => readScope(dir, "empty"))).toBe("SCOPE_INVALID");
  });

  it("defineScope validation: SCOPE_INVALID for bad names and module lists", () => {
    const store = new ScopeStore(tmp());
    for (const name of ["", "a b", "a/b", "..", ".", "a\\b", "ünïcode", "x:y"]) {
      expect(codeOf(() => store.define({ name, modules: ["A"] })), name).toBe("SCOPE_INVALID");
    }
    expect(codeOf(() => store.define({ name: "ok", modules: [] }))).toBe("SCOPE_INVALID");
    expect(codeOf(() => store.define({ name: "ok", modules: ["A", ""] }))).toBe("SCOPE_INVALID");
    expect(codeOf(() => store.define({ name: "ok", modules: ["A/B"] }))).toBe("SCOPE_INVALID");
    expect(codeOf(() => store.define({ name: "ok", modules: "A" }))).toBe("SCOPE_INVALID");
    expect(codeOf(() => store.define({ name: "o.k_-1", modules: ["A"] }))).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("redefining a scope overwrites it", () => {
    const store = new ScopeStore(tmp());
    store.define({ name: "s", modules: ["A"] });
    store.define({ name: "s", modules: ["B", "C"] });
    expect(store.read("s").modules).toEqual(["B", "C"]);
    expect(store.exists("s")).toBe(true);
    expect(store.exists("t")).toBe(false);
  });
});
