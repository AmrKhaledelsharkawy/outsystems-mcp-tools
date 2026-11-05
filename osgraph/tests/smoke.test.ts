/**
 * Spawns the built CLI (dist/cli.js). Run `npm run build` first; the `npm test` script does so.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "dist", "cli.js");
const URL = "http://127.0.0.1:41820/mcp";
/** Discard port: refused immediately, so `rebuild` can never reach a live Service Studio from a test. */
const DEAD_URL = "http://127.0.0.1:9/mcp";
const EXPECTED_TOOLS = [
  "rebuild",
  "queryPath",
  "queryImpact",
  "listViolations",
  "getFlow",
  "searchFlows",
  "defineScope",
  "listScopes"
];

/** Child env: inherit PATH etc. but strip every OSGRAPH_* variable first. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OSGRAPH_")) env[k] = v;
  }
  return { ...env, ...extra };
}

interface ExitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(env: Record<string, string>): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("osgraph CLI smoke", () => {
  it("dist/cli.js exists (run `npm run build` first)", () => {
    expect(existsSync(cliPath)).toBe(true);
  });

  it("exits 2, names OSGRAPH_SERVICESTUDIO_URL on stderr, writes nothing to stdout when URL unset", async () => {
    const result = await runCli(cleanEnv());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OSGRAPH_SERVICESTUDIO_URL");
    expect(result.stderr).toContain("CONFIG_MISSING");
  });

  it("serves all eight tools over stdio; listScopes on an empty workspace answers with graphCompleteness", async () => {
    const root = mkdtempSync(join(tmpdir(), "osgraph-smoke-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: cleanEnv({ OSGRAPH_SERVICESTUDIO_URL: URL, OSGRAPH_GRAPH_DIR: join(root, "graphs"), OSGRAPH_SCOPES_DIR: join(root, "scopes") }),
      stderr: "pipe"
    });
    const client = new Client({ name: "osgraph-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
      expect(tools).toHaveLength(8);

      const res = await client.callTool({ name: "listScopes", arguments: {} });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      const body = JSON.parse(content[0]!.text) as {
        result?: { scopes: unknown[]; count: number };
        graphCompleteness?: { skippedCount: number; lastRebuildAt: string | null };
      };
      expect(body.result).toMatchObject({ scopes: [], count: 0 });
      expect(body.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("end-to-end over stdio: defineScope → listScopes → (fixture snapshot) → listViolations → queryImpact; stdout stays MCP-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "osgraph-smoke-e2e-"));
    const graphDir = join(root, "graphs");
    const scopesDir = join(root, "scopes");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: cleanEnv({ OSGRAPH_SERVICESTUDIO_URL: DEAD_URL, OSGRAPH_GRAPH_DIR: graphDir, OSGRAPH_SCOPES_DIR: scopesDir }),
      stderr: "pipe"
    });
    let stderr = "";
    transport.stderr?.on("data", (d) => (stderr += String(d)));
    const client = new Client({ name: "osgraph-smoke", version: "0.0.0" });

    const callJson = async <T,>(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: T }> => {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text: string }>;
      return { isError: res.isError === true, body: JSON.parse(content[0]!.text) as T };
    };
    type Resp<T> = { result?: T; error?: { code: string; message: string; details?: unknown }; graphCompleteness: { skippedCount: number; lastRebuildAt: string | null } };

    try {
      await client.connect(transport);

      const def = await callJson<Resp<{ name: string; modules: string[]; path: string }>>("defineScope", {
        name: "demo",
        modules: ["Demo_UI", "Demo_CW", "Demo_SL", "Demo_BL", "Demo_CS"]
      });
      expect(def.isError).toBe(false);
      expect(def.body.result).toMatchObject({ name: "demo", path: join(scopesDir, "demo.json") });
      expect(existsSync(join(scopesDir, "demo.json"))).toBe(true);

      const list = await callJson<Resp<{ scopes: Array<{ name: string }>; count: number }>>("listScopes", {});
      expect(list.body.result?.scopes.map((s) => s.name)).toEqual(["demo"]);

      // before a snapshot exists the query tools say SNAPSHOT_MISSING (scope exists)
      const missing = await callJson<Resp<unknown>>("listViolations", { scope: "demo" });
      expect(missing.isError).toBe(true);
      expect(missing.body.error?.code).toBe("SNAPSHOT_MISSING");
      expect(missing.body.graphCompleteness).toEqual({ skippedCount: 0, lastRebuildAt: null });

      // install the synthetic violation graph as the scope's snapshot (what a rebuild would write)
      mkdirSync(join(graphDir, "demo"), { recursive: true });
      copyFileSync(join(here, "fixtures", "synthetic", "violation-graph.json"), join(graphDir, "demo", "graph.json"));
      writeFileSync(join(graphDir, "demo", "meta.json"), JSON.stringify({ rebuiltAt: "2026-10-29T00:00:00.000Z", scope: "demo", skippedCount: 1 }));

      const viol = await callJson<Resp<{ count: number; violations: Array<{ sourceLayer: string; targetLayer: string }>; unknownModules: string[] }>>(
        "listViolations",
        { scope: "demo" }
      );
      expect(viol.isError).toBe(false);
      expect(viol.body.result?.count).toBe(2);
      expect(viol.body.result?.violations.map((v) => `${v.sourceLayer}->${v.targetLayer}`)).toEqual(["BL->CW", "UI->CS"]);
      expect(viol.body.result?.unknownModules).toEqual(["Foundation"]);
      expect(viol.body.graphCompleteness).toEqual({ skippedCount: 1, lastRebuildAt: "2026-10-29T00:00:00.000Z" });

      const impact = await callJson<Resp<{ root: string; count: number; nodes: Array<{ id: string; depth: number }> }>>("queryImpact", {
        scope: "demo",
        nodeId: "osgraph://Demo_CS/Entity/Customer",
        direction: "dependents",
        maxDepth: 2
      });
      expect(impact.isError).toBe(false);
      expect(impact.body.result?.count).toBe(3);
      expect(impact.body.result?.nodes.map((n) => n.id)).toEqual([
        "osgraph://Demo_BL/ServerAction/BL_Do",
        "osgraph://Demo_UI/Screen/MainFlow/Home",
        "osgraph://Demo_SL/ServerAction/SL_Do"
      ]);

      const unknown = await callJson<Resp<unknown>>("queryImpact", { scope: "demo", nodeId: "osgraph://Nope", direction: "dependents" });
      expect(unknown.isError).toBe(true);
      expect(unknown.body.error?.code).toBe("UNKNOWN_NODE");
      expect(unknown.body.graphCompleteness.skippedCount).toBe(1);

      // F2: the SDK must NOT answer a bad call itself — every rejection comes back in osgraph's own
      // envelope, with graphCompleteness, rather than as a bare MCP -32602 input-validation error.
      for (const [name, args, field] of [
        ["rebuild", {}, "scope"],
        ["rebuild", { scope: 7 }, "scope"],
        ["queryImpact", { scope: "demo", nodeId: "osgraph://Nope", direction: "sideways" }, "direction"],
        ["queryImpact", { scope: "demo", nodeId: "osgraph://Nope", direction: "dependents", maxDepth: 0 }, "maxDepth"],
        ["defineScope", { name: "d2", modules: [] }, "modules"],
        ["queryPath", { scope: "demo", from: "--help", to: "osgraph://Nope" }, "from"]
      ] as Array<[string, Record<string, unknown>, string]>) {
        const bad = await callJson<Resp<unknown>>(name, args);
        expect(bad.isError, name).toBe(true);
        expect(bad.body.error?.code, `${name} ${JSON.stringify(args)}`).toBe("INPUT_INVALID");
        expect(bad.body.error?.message).toContain(`'${field}'`);
        expect(bad.body.graphCompleteness).toBeDefined();
        expect(typeof bad.body.graphCompleteness.skippedCount).toBe("number");
      }

      // rebuild against an unreachable servicestudio URL fails fast with a structured error (no snapshot change)
      const before = readFileSync(join(graphDir, "demo", "graph.json"), "utf8");
      const rb = await callJson<Resp<unknown>>("rebuild", { scope: "demo" });
      expect(rb.isError).toBe(true);
      expect(["SERVICESTUDIO_UNREACHABLE", "TOKEN_EXPIRED"]).toContain(rb.body.error?.code);
      expect(readFileSync(join(graphDir, "demo", "graph.json"), "utf8")).toBe(before);
      expect(rb.body.graphCompleteness.skippedCount).toBe(1);
      expect(stderr).toContain("rebuild: acquiring session token");
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
