import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadConfig, OsgraphConfigError } from "../src/config.js";

const URL = "http://127.0.0.1:41820/mcp";
const cwd = join("C:", "work", "proj");

describe("loadConfig", () => {
  it("throws CONFIG_MISSING naming the variable when OSGRAPH_SERVICESTUDIO_URL is unset", () => {
    let caught: unknown;
    try {
      loadConfig({}, { cwd, existsSync: () => false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OsgraphConfigError);
    const e = caught as OsgraphConfigError;
    expect(e.code).toBe("CONFIG_MISSING");
    expect(e.message).toContain("OSGRAPH_SERVICESTUDIO_URL");
  });

  it("throws CONFIG_MISSING when OSGRAPH_SERVICESTUDIO_URL is empty/whitespace", () => {
    expect(() =>
      loadConfig({ OSGRAPH_SERVICESTUDIO_URL: "   " }, { cwd, existsSync: () => false })
    ).toThrowError(/OSGRAPH_SERVICESTUDIO_URL/);
  });

  it("applies defaults when only the URL is set (no osgraph folder in cwd)", () => {
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: URL }, { cwd, existsSync: () => false });
    expect(cfg.serviceStudioUrl).toBe(URL);
    expect(cfg.tokenFile).toBeUndefined();
    expect(cfg.graphDir).toBe(join(cwd, ".osgraph"));
    expect(cfg.scopesDir).toBe(join(cwd, "scopes"));
    expect(cfg.graphifyBin).toBe("graphify");
    expect(cfg.fetchConcurrency).toBe(4);
  });

  // OSG-016 §C1: the width is a knob, so a nonsense value is clamped or ignored, never fatal — a
  // whole osgraph process refusing to start over a mistyped concurrency would be worse than a 4.
  it("reads OSGRAPH_MAX_CONCURRENCY, clamped to [1, 8], and never fails over a bad value", () => {
    const width = (value: string | undefined): number =>
      loadConfig(
        { OSGRAPH_SERVICESTUDIO_URL: URL, ...(value === undefined ? {} : { OSGRAPH_MAX_CONCURRENCY: value }) },
        { cwd, existsSync: () => false }
      ).fetchConcurrency;
    expect(width(undefined)).toBe(4);
    expect(width("")).toBe(4);
    expect(width("   ")).toBe(4);
    expect(width("banana")).toBe(4);
    expect(width("1")).toBe(1); // the documented escape hatch: exactly the pre-OSG-016 serial walk
    expect(width("6")).toBe(6);
    expect(width(" 3 ")).toBe(3);
    expect(width("0")).toBe(1);
    expect(width("-2")).toBe(1);
    expect(width("9")).toBe(8);
    expect(width("1000")).toBe(8);
    expect(width("4.9")).toBe(4);
  });

  it("defaults scopesDir to <cwd>/osgraph/scopes when cwd contains an osgraph folder", () => {
    const cfg = loadConfig(
      { OSGRAPH_SERVICESTUDIO_URL: URL },
      { cwd, existsSync: (p) => p === join(cwd, "osgraph") }
    );
    expect(cfg.scopesDir).toBe(join(cwd, "osgraph", "scopes"));
  });

  it("honours every optional override", () => {
    const cfg = loadConfig(
      {
        OSGRAPH_SERVICESTUDIO_URL: URL,
        OSGRAPH_SERVICESTUDIO_TOKEN_FILE: join(cwd, "token.txt"),
        OSGRAPH_GRAPH_DIR: join("D:", "graphs"),
        OSGRAPH_SCOPES_DIR: join("D:", "scopes"),
        OSGRAPH_GRAPHIFY_BIN: join("D:", "bin", "graphify.exe")
      },
      { cwd, existsSync: () => true }
    );
    expect(cfg.tokenFile).toBe(join(cwd, "token.txt"));
    expect(cfg.graphDir).toBe(join("D:", "graphs"));
    expect(cfg.scopesDir).toBe(join("D:", "scopes"));
    expect(cfg.graphifyBin).toBe(join("D:", "bin", "graphify.exe"));
  });

  it("trims the URL", () => {
    const cfg = loadConfig(
      { OSGRAPH_SERVICESTUDIO_URL: `  ${URL}  ` },
      { cwd, existsSync: () => false }
    );
    expect(cfg.serviceStudioUrl).toBe(URL);
  });
});

import { describe as describe2, expect as expect2, it as it2 } from "vitest";
import { loadConfig as loadConfig2, OsgraphConfigError as ConfigError2 } from "../src/config.js";

describe2("loadConfig URL validation (S1 audit note 2)", () => {
  it2("rejects a non-URL value with CONFIG_INVALID", () => {
    try {
      loadConfig2({ OSGRAPH_SERVICESTUDIO_URL: "foo" }, { cwd: "C:/w", existsSync: () => false });
      throw new Error("expected throw");
    } catch (err) {
      expect2(err).toBeInstanceOf(ConfigError2);
      expect2((err as ConfigError2).code).toBe("CONFIG_INVALID");
    }
  });
});
