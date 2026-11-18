import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadConfig, OsgraphConfigError, requireServiceStudioUrl } from "../src/config.js";

const URL = "http://127.0.0.1:41820/mcp";
const cwd = join("C:", "work", "proj");

describe("loadConfig", () => {
  // #7: before command-scoped configuration this was the unconditional process-start check. The
  // same error, code and message now come from `requireServiceStudio: true` (a live-only command)
  // and from `requireServiceStudioUrl` (a live operation being dispatched).
  it("throws CONFIG_MISSING naming the variable when OSGRAPH_SERVICESTUDIO_URL is unset and Studio is required", () => {
    let caught: unknown;
    try {
      loadConfig({}, { cwd, existsSync: () => false, requireServiceStudio: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OsgraphConfigError);
    const e = caught as OsgraphConfigError;
    expect(e.code).toBe("CONFIG_MISSING");
    expect(e.message).toContain("OSGRAPH_SERVICESTUDIO_URL");
  });

  it("throws CONFIG_MISSING when OSGRAPH_SERVICESTUDIO_URL is empty/whitespace and Studio is required", () => {
    expect(() =>
      loadConfig({ OSGRAPH_SERVICESTUDIO_URL: "   " }, { cwd, existsSync: () => false, requireServiceStudio: true })
    ).toThrowError(/OSGRAPH_SERVICESTUDIO_URL/);
  });

  // #7: an offline command must start on a workstation with no Service Studio at all.
  it("loads with OSGRAPH_SERVICESTUDIO_URL unset or blank when Studio is not required (the default)", () => {
    for (const env of [{}, { OSGRAPH_SERVICESTUDIO_URL: "" }, { OSGRAPH_SERVICESTUDIO_URL: "   " }]) {
      const cfg = loadConfig(env, { cwd, existsSync: () => false });
      expect(cfg.serviceStudioUrl).toBeUndefined();
      expect(cfg.graphDir).toBe(join(cwd, ".osgraph"));
      expect(cfg.scopesDir).toBe(join(cwd, "scopes"));
      expect(cfg.fetchConcurrency).toBe(4);
    }
  });

  it("does not validate a malformed URL until a live operation asks for it", () => {
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: "  foo  " }, { cwd, existsSync: () => false });
    expect(cfg.serviceStudioUrl).toBe("foo");
    expect(() => requireServiceStudioUrl(cfg)).toThrowError(OsgraphConfigError);
  });

  // #7: every other variable keeps its name, default and clamp when the URL is absent.
  it("keeps every knob, clamp and escape hatch working with no endpoint configured", () => {
    const cfg = loadConfig(
      {
        OSGRAPH_MAX_CONCURRENCY: "1",
        OSGRAPH_PROGRESS_SITE: "off",
        OSGRAPH_PROGRESS_HOST: "0.0.0.0",
        OSGRAPH_PROGRESS_PORT: "8123",
        OSGRAPH_OSOPENER_DIST: join("D:", "osopener", "dist"),
        OSGRAPH_GRAPHIFY_BIN: join("D:", "bin", "graphify.exe"),
        OSGRAPH_SERVICESTUDIO_TOKEN_FILE: join(cwd, "token.txt")
      },
      { cwd, existsSync: () => false }
    );
    expect(cfg.serviceStudioUrl).toBeUndefined();
    expect(cfg.fetchConcurrency).toBe(1);
    expect(cfg.site).toEqual({ enabled: false, host: "0.0.0.0", port: 8123, osopenerDist: join("D:", "osopener", "dist") });
    expect(cfg.graphifyBin).toBe(join("D:", "bin", "graphify.exe"));
    expect(cfg.tokenFile).toBe(join(cwd, "token.txt"));
    expect(loadConfig({ OSGRAPH_MAX_CONCURRENCY: "99" }, { cwd, existsSync: () => false }).fetchConcurrency).toBe(8);
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
  it2("rejects a non-URL value with CONFIG_INVALID when Studio is required", () => {
    try {
      loadConfig2({ OSGRAPH_SERVICESTUDIO_URL: "foo" }, { cwd: "C:/w", existsSync: () => false, requireServiceStudio: true });
      throw new Error("expected throw");
    } catch (err) {
      expect2(err).toBeInstanceOf(ConfigError2);
      expect2((err as ConfigError2).code).toBe("CONFIG_INVALID");
    }
  });
});

describe2("requireServiceStudioUrl (#7: the live-operation gate)", () => {
  const codeOf = (serviceStudioUrl: string | undefined): string | undefined => {
    try {
      requireServiceStudioUrl({ serviceStudioUrl });
      return undefined;
    } catch (err) {
      expect2(err).toBeInstanceOf(ConfigError2);
      expect2((err as ConfigError2).message).toContain("OSGRAPH_SERVICESTUDIO_URL");
      return (err as ConfigError2).code;
    }
  };

  it2("CONFIG_MISSING when unset or blank", () => {
    expect2(codeOf(undefined)).toBe("CONFIG_MISSING");
    expect2(codeOf("")).toBe("CONFIG_MISSING");
    expect2(codeOf("  ")).toBe("CONFIG_MISSING");
  });

  it2("CONFIG_INVALID when not an http(s) URL", () => {
    expect2(codeOf("foo")).toBe("CONFIG_INVALID");
    expect2(codeOf("ftp://127.0.0.1:41820/mcp")).toBe("CONFIG_INVALID");
    expect2(codeOf("file:///C:/mcp")).toBe("CONFIG_INVALID");
  });

  it2("returns the trimmed URL when it is a valid http(s) URL", () => {
    expect2(requireServiceStudioUrl({ serviceStudioUrl: ` ${URL} ` })).toBe(URL);
    expect2(requireServiceStudioUrl({ serviceStudioUrl: "https://studio.example.test/mcp" })).toBe("https://studio.example.test/mcp");
  });
});
