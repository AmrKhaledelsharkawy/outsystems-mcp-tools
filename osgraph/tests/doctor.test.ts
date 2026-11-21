/**
 * #63 `osgraph doctor`: every failure class, driven against fakes. No Service Studio, no osopener
 * build, no real token, no network - every module name and token is synthetic.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  renderDoctorReport,
  resolveModuleName,
  runDoctor,
  SCOPE_NOT_OPEN_EXPLANATION,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport
} from "../src/doctor/doctor.js";
import { resolveTokenFile } from "../src/doctor/token.js";
import { describeLoadFailure, type OsopenerLoadResult } from "../src/osopener/adapter.js";
import { REQUIRES_SERVICESTUDIO_AT_START } from "../src/cli/args.js";
import { FakeServiceStudio, type FakeReply, type RecordedCall } from "./servicestudio.fake.js";

const URL = "http://127.0.0.1:41820/mcp";
const TOKEN = "synthetic-token-value-0001";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-doctor-"));
  dirs.push(d);
  return d;
}

const app = (name: string, isOpen = true) => ({
  key: name,
  name,
  kind: "eSpace",
  version: "1",
  description: "",
  isOpen,
  isReference: false,
  moduleType: "Reactive"
});
const appsText = (...apps: ReturnType<typeof app>[]) => JSON.stringify({ apps });

const OPENER_OK: OsopenerLoadResult = { ok: true, adapter: {} as never };

interface Workspace {
  root: string;
  work: string;
  scopesDir: string;
  graphDir: string;
}
function workspace(): Workspace {
  const root = tmp();
  const work = join(root, "work", "nested");
  const scopesDir = join(root, "scopes");
  mkdirSync(work, { recursive: true });
  mkdirSync(scopesDir, { recursive: true });
  return { root, work, scopesDir, graphDir: join(root, "graphs") };
}
function writeScope(ws: Workspace, name: string, modules: string[]): void {
  writeFileSync(join(ws.scopesDir, `${name}.json`), JSON.stringify({ name, modules }));
}

function setup(
  ws: Workspace,
  handler: (c: RecordedCall) => FakeReply,
  extra: Partial<DoctorOptions> = {},
  envOverrides: Record<string, string | undefined> = {}
) {
  const fake = new FakeServiceStudio(handler);
  const env = {
    OSGRAPH_SERVICESTUDIO_URL: URL,
    OSGRAPH_SCOPES_DIR: ws.scopesDir,
    OSGRAPH_GRAPH_DIR: ws.graphDir,
    ...envOverrides
  };
  const config = loadConfig(env, { cwd: ws.work, existsSync: () => false });
  const base: DoctorOptions = {
    config,
    env,
    cwd: ws.work,
    fetchImpl: fake.fetch,
    loadOpener: async () => OPENER_OK
  };
  return { fake, run: (o: Partial<DoctorOptions> = {}) => runDoctor({ ...base, ...extra, ...o }) };
}

const accepting = (...apps: ReturnType<typeof app>[]) => (call: RecordedCall): FakeReply =>
  call.sessionToken === TOKEN
    ? { text: appsText(...apps) }
    : { rpcError: { code: -32000, message: "Invalid session token" } };

const check = (r: DoctorReport, id: DoctorCheck["id"]): DoctorCheck => {
  const c = r.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no ${id} check`);
  return c;
};

function putToken(dir: string, content = TOKEN): void {
  writeFileSync(join(dir, "token.txt"), content);
}

describe("osgraph doctor: healthy machine", () => {
  it("passes every check, never prints the token, calls only listApps", async () => {
    const ws = workspace();
    putToken(ws.root); // two levels above cwd: found by walking up
    writeScope(ws, "demo", ["alpha", "beta"]);
    const { fake, run } = setup(ws, accepting(app("alpha"), app("beta")));
    const report = await run({ scope: "demo" });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "token:pass",
      "endpoint:pass",
      "osopener:pass",
      "scope:pass",
      "graphDir:pass"
    ]);
    expect(fake.calls.map((c) => c.name)).toEqual(["listApps"]);
    const text = JSON.stringify(report) + renderDoctorReport(report);
    expect(text).not.toContain(TOKEN);
  });

  it("reports a missing snapshot as fine and an existing one with its age", async () => {
    const ws = workspace();
    putToken(ws.root);
    writeScope(ws, "demo", ["alpha"]);
    const { run } = setup(ws, accepting(app("alpha")));
    const before = await run({ scope: "demo" });
    expect(check(before, "graphDir").summary).toContain("no snapshot");

    mkdirSync(join(ws.graphDir, "demo"), { recursive: true });
    writeFileSync(join(ws.graphDir, "demo", "graph.json"), "{}");
    writeFileSync(
      join(ws.graphDir, "demo", "meta.json"),
      JSON.stringify({ rebuiltAt: "2026-11-01T00:00:00.000Z", scope: "demo", skippedCount: 0 })
    );
    const after = await run({ scope: "demo", now: () => new Date("2026-11-03T04:30:00.000Z") });
    const g = check(after, "graphDir");
    expect(g.status).toBe("pass");
    expect(g.summary).toContain("age 2d 4h");
    expect(g.details?.snapshotAgeMs).toBe((2 * 24 + 4.5) * 3_600_000);
  });
});

describe("osgraph doctor: token", () => {
  it("missing token.txt: says a human must approve; never calls createSessionToken", async () => {
    const ws = workspace();
    const { fake, run } = setup(ws, accepting(app("alpha")), {}, { OSOPENER_TOKEN_SEARCH_DIR: ws.work });
    const report = await run();
    const t = check(report, "token");
    expect(t.status).toBe("fail");
    expect(t.summary).toContain("a human must approve a new Service Studio session");
    expect(fake.calls.some((c) => c.name === "createSessionToken")).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("expired token: token fails, endpoint passes (Studio answered)", async () => {
    const ws = workspace();
    putToken(ws.root, "an-old-expired-token");
    const { fake, run } = setup(ws, accepting(app("alpha")));
    const report = await run();
    expect(check(report, "token").status).toBe("fail");
    expect(check(report, "token").summary).toContain("rejected the token");
    expect(check(report, "token").summary).toContain("a human must approve");
    expect(check(report, "endpoint").status).toBe("pass");
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("an-old-expired-token");
  });

  it("empty token file fails without calling Studio with a token", async () => {
    const ws = workspace();
    putToken(ws.root, "   \n");
    const { fake, run } = setup(ws, accepting(app("alpha")));
    const report = await run();
    expect(check(report, "token").summary).toContain("is empty");
    expect(fake.calls.every((c) => c.sessionToken === undefined)).toBe(true);
  });

  it("an explicit OSGRAPH_SERVICESTUDIO_TOKEN_FILE wins over a searched token.txt", () => {
    const ws = workspace();
    putToken(ws.root);
    const explicit = join(ws.root, "other.txt");
    writeFileSync(explicit, TOKEN);
    const r = resolveTokenFile({ OSGRAPH_SERVICESTUDIO_TOKEN_FILE: explicit }, { cwd: ws.work });
    expect(r.source).toBe("env");
    expect(r.path).toBe(explicit);
    const walked = resolveTokenFile({}, { cwd: ws.work });
    expect(walked.source).toBe("search");
    expect(walked.path).toBe(join(ws.root, "token.txt"));
    expect(walked.probed[0]).toBe(join(ws.work, "token.txt"));
  });

  it("an env token file that does not exist is reported by name", async () => {
    const ws = workspace();
    const missing = join(ws.root, "nope.txt");
    const { run } = setup(ws, accepting(app("alpha")), {}, {
      OSGRAPH_SERVICESTUDIO_TOKEN_FILE: missing,
      OSOPENER_TOKEN_SEARCH_DIR: ws.work
    });
    const t = check(await run(), "token");
    expect(t.status).toBe("fail");
    expect(t.summary).toContain(missing);
  });
});

describe("osgraph doctor: endpoint", () => {
  it("unreachable endpoint is distinct from a rejected token", async () => {
    const ws = workspace();
    putToken(ws.root);
    const { run } = setup(ws, () => ({ throwError: new Error("connect ECONNREFUSED 127.0.0.1:41820") }));
    const report = await run();
    const e = check(report, "endpoint");
    expect(e.status).toBe("fail");
    expect(e.summary).toContain("unreachable");
    expect(e.details?.code).toBe("SERVICESTUDIO_UNREACHABLE");
    // The token cannot be judged when Studio cannot be reached.
    expect(check(report, "token").status).toBe("skip");
    expect(report.ok).toBe(false);
  });

  it("a non-2xx answer counts as unreachable", async () => {
    const ws = workspace();
    putToken(ws.root);
    const { run } = setup(ws, () => ({ status: 503, text: "" }));
    expect(check(await run(), "endpoint").status).toBe("fail");
  });

  it("an unset endpoint fails with CONFIG_MISSING and sends nothing", async () => {
    const ws = workspace();
    putToken(ws.root);
    const fake = new FakeServiceStudio(() => ({ text: appsText() }));
    const env = { OSGRAPH_SCOPES_DIR: ws.scopesDir, OSGRAPH_GRAPH_DIR: ws.graphDir };
    const config = loadConfig(env, { cwd: ws.work, existsSync: () => false });
    const report = await runDoctor({ config, env, cwd: ws.work, fetchImpl: fake.fetch, loadOpener: async () => OPENER_OK });
    expect(check(report, "endpoint").details?.code).toBe("CONFIG_MISSING");
    expect(fake.calls).toHaveLength(0);
    expect(report.ok).toBe(false);
  });
});

describe("osgraph doctor: osopener", () => {
  it("surfaces the adapter's failure verbatim, with its cause and code", async () => {
    const ws = workspace();
    putToken(ws.root);
    const failure = {
      cause: "config-rejected" as const,
      dist: join(ws.root, "osopener", "dist"),
      message: "osopener rejected its configuration: CONFIG_MISSING synthetic",
      code: "CONFIG_MISSING"
    };
    const { run } = setup(ws, accepting(app("alpha")), { loadOpener: async () => ({ ok: false, failure }) });
    const report = await run();
    const o = check(report, "osopener");
    expect(o.status).toBe("fail");
    expect(o.summary).toBe(describeLoadFailure(failure));
    expect(o.details).toMatchObject({ cause: "config-rejected", code: "CONFIG_MISSING" });
    expect(report.ok).toBe(false);
  });

  it("with the real adapter and a missing dist, reports 'absent'", async () => {
    const ws = workspace();
    putToken(ws.root);
    const env = {
      OSGRAPH_SERVICESTUDIO_URL: URL,
      OSGRAPH_GRAPH_DIR: ws.graphDir,
      OSGRAPH_OSOPENER_DIST: join(ws.root, "no-osopener")
    };
    const config = loadConfig(env, { cwd: ws.work, existsSync: () => false });
    const fake = new FakeServiceStudio(accepting(app("alpha")));
    const report = await runDoctor({ config, env, cwd: ws.work, fetchImpl: fake.fetch });
    expect(check(report, "osopener").details?.cause).toBe("absent");
    expect(check(report, "osopener").summary).toContain("osopener unavailable (absent)");
  });
});

describe("osgraph doctor: scope module names", () => {
  it("resolveModuleName: exact, case, typo, closed, missing", () => {
    const apps = [app("PaymentsCore"), app("ReportsHub"), app("Archive", false)];
    expect(resolveModuleName("PaymentsCore", apps)).toEqual({ module: "PaymentsCore", status: "exact" });
    expect(resolveModuleName("paymentscore", apps)).toEqual({
      module: "paymentscore",
      status: "near-miss",
      suggestion: "PaymentsCore",
      reason: "case"
    });
    expect(resolveModuleName("PaymentsCoer", apps)).toMatchObject({ status: "near-miss", suggestion: "PaymentsCore", reason: "typo" });
    expect(resolveModuleName("Archive", apps).status).toBe("not-open");
    expect(resolveModuleName("Totally Unrelated", apps).status).toBe("missing");
    expect(resolveModuleName("x", [])).toEqual({ module: "x", status: "missing" });
  });

  it("wrong-case, typo and unknown names fail with a suggestion and the 'No module is currently open' explanation", async () => {
    const ws = workspace();
    putToken(ws.root);
    writeScope(ws, "demo", ["alpha", "BETA", "gamaa", "zzzzzzzz"]);
    const { run } = setup(ws, accepting(app("alpha"), app("beta"), app("gamma")));
    const report = await run({ scope: "demo" });
    const s = check(report, "scope");
    expect(s.status).toBe("fail");
    expect(s.summary).toContain("did you mean 'beta' (different case)");
    expect(s.summary).toContain("did you mean 'gamma' (possible typo)");
    expect(s.summary).toContain("'zzzzzzzz' is not in Studio's module listing");
    expect(s.summary).toContain(SCOPE_NOT_OPEN_EXPLANATION);
    expect(SCOPE_NOT_OPEN_EXPLANATION).toContain("No module is currently open");
    expect(report.modules?.map((m) => m.status)).toEqual(["exact", "near-miss", "near-miss", "missing"]);
    expect(report.ok).toBe(false);
  });

  it("a listed-but-closed module is a warning, not a failure", async () => {
    const ws = workspace();
    putToken(ws.root);
    writeScope(ws, "demo", ["alpha"]);
    const { run } = setup(ws, accepting(app("alpha", false)));
    const report = await run({ scope: "demo" });
    expect(check(report, "scope").status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("is skipped, not failed, when there is no listing to resolve against", async () => {
    const ws = workspace();
    putToken(ws.root, "expired");
    writeScope(ws, "demo", ["alpha"]);
    const { run } = setup(ws, accepting(app("alpha")));
    expect(check(await run({ scope: "demo" }), "scope").status).toBe("skip");
  });

  it("an undefined scope fails the scope check", async () => {
    const ws = workspace();
    putToken(ws.root);
    const { run } = setup(ws, accepting(app("alpha")));
    const s = check(await run({ scope: "ghost" }), "scope");
    expect(s.status).toBe("fail");
    expect(s.details?.code).toBe("SCOPE_NOT_FOUND");
  });
});

describe("osgraph doctor: graph directory", () => {
  it("a non-writable graph directory fails", async () => {
    const ws = workspace();
    putToken(ws.root);
    mkdirSync(ws.graphDir, { recursive: true });
    const { run } = setup(ws, accepting(app("alpha")), {
      canWrite: () => {
        throw new Error("EACCES: permission denied");
      }
    });
    const report = await run();
    const g = check(report, "graphDir");
    expect(g.status).toBe("fail");
    expect(g.summary).toContain("not writable");
    expect(report.ok).toBe(false);
  });

  it("a directory that does not exist yet is judged by its nearest existing parent", async () => {
    const ws = workspace();
    putToken(ws.root);
    const probed: string[] = [];
    const { run } = setup(ws, accepting(app("alpha")), { canWrite: (p) => void probed.push(p) });
    const g = check(await run({ graphDir: join(ws.root, "a", "b", "c") }), "graphDir");
    expect(g.status).toBe("pass");
    expect(g.summary).toContain("will be created");
    expect(probed).toEqual([ws.root]);
  });
});

describe("osgraph doctor: read-only", () => {
  it("writes nothing, creates no directory and opens or closes no module", async () => {
    const ws = workspace();
    putToken(ws.root);
    writeScope(ws, "demo", ["alpha"]);
    const snapshot = (d: string): string[] =>
      readdirSync(d, { recursive: true, withFileTypes: true }).map((e) => join(e.parentPath, e.name));
    const before = snapshot(ws.root);
    const touched: string[] = [];
    const adapter = new Proxy({}, { get: (_t, prop) => (touched.push(String(prop)), undefined) });
    const { fake, run } = setup(ws, accepting(app("alpha")), { loadOpener: async () => ({ ok: true, adapter: adapter as never }) });
    await run({ scope: "demo" });
    expect(snapshot(ws.root)).toEqual(before);
    expect(readdirSync(ws.root)).not.toContain("graphs");
    expect(touched).toEqual([]);
    expect(fake.calls.map((c) => c.name)).toEqual(["listApps"]);
  });
});

describe("osgraph doctor: CLI", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const runCli = (args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("is a command that starts without a Studio endpoint", () => {
    expect(REQUIRES_SERVICESTUDIO_AT_START.doctor).toBe(false);
  });

  it("--json prints the report and exits 1 when a check fails (endpoint unset, no token)", async () => {
    const ws = workspace();
    const r = await runCli(
      ["doctor", "--json"],
      {
        OSGRAPH_SERVICESTUDIO_URL: "",
        OSGRAPH_GRAPH_DIR: ws.graphDir,
        OSGRAPH_OSOPENER_DIST: join(ws.root, "no-osopener"),
        OSOPENER_TOKEN_SEARCH: "off"
      },
      ws.work
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.id)).toContain("endpoint");
    expect(readdirSync(ws.root)).not.toContain("graphs");
  }, 30_000);
});
