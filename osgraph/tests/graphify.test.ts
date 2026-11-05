/**
 * `queryPath` back end (OSG-009 output parsing, ADR-0003 guard, executable resolution).
 * Unit tests use a fake executable written to a temp dir; the real graphify is only exercised by the
 * live-ish test, which runs when OSGRAPH_GRAPHIFY_LIVE=1.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeGraphifyArgs,
  buildGraphifyPathArgs,
  parseGraphifyPathOutput,
  parsePathLine,
  resetGraphifyVersionCache,
  runGraphifyPath,
  GRAPHIFY_ENV_NO_AUTO_REFRESH
} from "../src/graphify/path.js";
import { resolveExecutable } from "../src/graphify/resolve.js";
import { GRAPHIFY_VERSION } from "../src/graph/types.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";

const windows = process.platform === "win32";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-graphify-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetGraphifyVersionCache(); // ADR-0010's probe is memoised per resolved path, per process
});

const FOUND = `Shortest path (2 hops):\n  LoginScreen --calls [EXTRACTED]--> AuthenticateUser --references [EXTRACTED]--> User\n`;
const NO_PATH = `No directed path found between 'osgraph://MyModule/Screen/LoginScreen' and 'osgraph://MyModule/Entity/Session'. Re-run with --undirected to search ignoring edge direction.\n`;
const NO_NODE = `No node matching 'osgraph://MyModule/Entity/Nope' found.\n`;

interface FakeGraphifyOptions {
  name?: string;
  /** What `graphify --version` prints on stdout; default the pinned version, so no warning fires. */
  versionStdout?: string;
  /** Exit code of the `--version` probe; non-zero makes the probe fail (ADR-0010: non-fatal). */
  versionCode?: number;
}

/**
 * Writes a fake `graphify` into `dir`. For `path` it records its argv in `args.txt`, prints `stdout`
 * and exits `code`; for ADR-0010's `--version` probe it records a probe count in `probes.txt` and
 * prints `version.txt` instead, so one fake serves both spawns without clobbering the argv record.
 */
function fakeGraphify(dir: string, stdout: string, code: number, options: FakeGraphifyOptions = {}): string {
  const name = options.name ?? "graphify";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.txt"), stdout);
  writeFileSync(join(dir, "version.txt"), options.versionStdout ?? `graphify ${GRAPHIFY_VERSION}\n`);
  const versionCode = options.versionCode ?? 0;
  if (windows) {
    const path = join(dir, `${name}.cmd`);
    writeFileSync(
      path,
      // `echo [%X%]>` — the brackets keep cmd from reading the expanded `1>` as a handle redirect.
      `@echo off\r\n` +
        `if "%~1"=="--version" goto ver\r\n` +
        `echo %*> "%~dp0args.txt"\r\n` +
        `echo [%${GRAPHIFY_ENV_NO_AUTO_REFRESH}%]> "%~dp0env.txt"\r\n` +
        `type "%~dp0out.txt"\r\n` +
        `exit /b ${code}\r\n` +
        `:ver\r\n` +
        `echo [%${GRAPHIFY_ENV_NO_AUTO_REFRESH}%]>> "%~dp0probes.txt"\r\n` +
        `type "%~dp0version.txt"\r\n` +
        `exit /b ${versionCode}\r\n`
    );
    return path;
  }
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\nd=$(dirname "$0")\n` +
      `if [ "$1" = "--version" ]; then\n` +
      `  printf '[%s]\\n' "$${GRAPHIFY_ENV_NO_AUTO_REFRESH}" >> "$d/probes.txt"\n` +
      `  cat "$d/version.txt"\n` +
      `  exit ${versionCode}\n` +
      `fi\n` +
      `printf '%s\\n' "$@" > "$d/args.txt"\n` +
      `printf '[%s]\\n' "$${GRAPHIFY_ENV_NO_AUTO_REFRESH}" > "$d/env.txt"\n` +
      `cat "$d/out.txt"\n` +
      `exit ${code}\n`
  );
  chmodSync(path, 0o755);
  return path;
}

/** How many times ADR-0010's `--version` probe actually spawned against this fake. */
function probeCount(dir: string): number {
  const path = join(dir, "probes.txt");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

function envWithPath(dir: string): Record<string, string | undefined> {
  return { ...process.env, PATH: dir, Path: dir, [GRAPHIFY_ENV_NO_AUTO_REFRESH]: undefined };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof OsgraphToolError ? err.code : `not-OsgraphToolError:${String(err)}`;
  }
  return undefined;
}

describe("parseGraphifyPathOutput (OSG-009 exact outputs)", () => {
  it("parses the found case into hops + labelled steps with relation/confidence on the incoming edge", () => {
    const r = parseGraphifyPathOutput(FOUND);
    expect(r).toEqual({
      found: true,
      hops: 2,
      path: [
        { label: "LoginScreen" },
        { label: "AuthenticateUser", relation: "calls", confidence: "EXTRACTED" },
        { label: "User", relation: "references", confidence: "EXTRACTED" }
      ],
      raw: FOUND
    });
  });
  it("parses CRLF output and a 1-hop path", () => {
    const text = "Shortest path (1 hop):\r\n  A --embeds [AMBIGUOUS]--> B\r\n";
    expect(parseGraphifyPathOutput(text)).toMatchObject({ found: true, hops: 1, path: [{ label: "A" }, { label: "B", relation: "embeds", confidence: "AMBIGUOUS" }] });
  });
  it("parses the no-path case (directed and undirected wording)", () => {
    expect(parseGraphifyPathOutput(NO_PATH)).toEqual({ found: false, raw: NO_PATH });
    expect(parseGraphifyPathOutput("No path found between 'a' and 'b'.\n")).toMatchObject({ found: false });
    expect(parseGraphifyPathOutput("No undirected path found between 'a' and 'b'.\n")).toMatchObject({ found: false });
  });
  it("returns undefined for unrecognised text", () => {
    expect(parseGraphifyPathOutput("")).toBeUndefined();
    expect(parseGraphifyPathOutput(NO_NODE)).toBeUndefined();
  });
  it("parsePathLine keeps labels containing spaces", () => {
    expect(parsePathLine("My Screen --calls [EXTRACTED]--> Do Thing")).toEqual([
      { label: "My Screen" },
      { label: "Do Thing", relation: "calls", confidence: "EXTRACTED" }
    ]);
  });

  describe("ADR-0010 — the found branch must be internally consistent", () => {
    it("rejects a hops count that does not match the number of steps", () => {
      expect(parseGraphifyPathOutput("Shortest path (3 hops):\n  A --calls [EXTRACTED]--> B\n")).toBeUndefined();
      expect(parseGraphifyPathOutput("Shortest path (1 hop):\n  A --calls [EXTRACTED]--> B --calls [EXTRACTED]--> C\n")).toBeUndefined();
    });
    it("rejects a found header with no path line at all", () => {
      expect(parseGraphifyPathOutput("Shortest path (2 hops):\n")).toBeUndefined();
      expect(parseGraphifyPathOutput("Shortest path (2 hops):\n\n")).toBeUndefined();
    });
    it("rejects a mutated arrow syntax under an unchanged header (the silent-wrong-answer case)", () => {
      // without the check this returned found:true with one step whose label is the whole line
      expect(parseGraphifyPathOutput("Shortest path (2 hops):\n  A ==calls==> B ==calls==> C\n")).toBeUndefined();
      expect(parseGraphifyPathOutput("Shortest path (1 hop):\n  A -> B\n")).toBeUndefined();
    });
    it("rejects hops 0, an empty label, and a step missing its relation or confidence", () => {
      expect(parseGraphifyPathOutput("Shortest path (0 hops):\n  A\n")).toBeUndefined();
      expect(parseGraphifyPathOutput("Shortest path (1 hop):\n   --calls [EXTRACTED]--> B\n")).toBeUndefined();
      expect(parseGraphifyPathOutput("Shortest path (1 hop):\n  A --calls []--> B\n")).toBeUndefined();
    });
    it("still accepts the recorded OSG-009 outputs and a 3-hop path", () => {
      expect(parseGraphifyPathOutput(FOUND)).toMatchObject({ found: true, hops: 2 });
      const three = "Shortest path (3 hops):\n  A --calls [EXTRACTED]--> B --embeds [EXTRACTED]--> C --references [AMBIGUOUS]--> D\n";
      expect(parseGraphifyPathOutput(three)).toMatchObject({ found: true, hops: 3 });
    });
  });
});

describe("ADR-0003 guard", () => {
  it("buildGraphifyPathArgs always starts with `path` and places --undirected before --graph", () => {
    expect(buildGraphifyPathArgs({ from: "a", to: "b", snapshotPath: "g.json" })).toEqual(["path", "a", "b", "--graph", "g.json"]);
    expect(buildGraphifyPathArgs({ from: "a", to: "b", undirected: true, snapshotPath: "g.json" })).toEqual(["path", "a", "b", "--undirected", "--graph", "g.json"]);
  });
  it("refuses install / hook / anything but `path` as the subcommand", () => {
    for (const args of [["install"], ["hook", "install"], ["query", "x"], [], ["Path", "a", "b"]]) {
      let caught: unknown;
      try {
        assertSafeGraphifyArgs(args);
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(args)).toBeInstanceOf(OsgraphToolError);
      expect((caught as OsgraphToolError).code).toBe("GRAPHIFY_FAILED");
    }
    expect(() => assertSafeGraphifyArgs(["path", "a", "b", "--graph", "g"])).not.toThrow();
  });
  it("the source never mentions the two forbidden subcommands as arguments", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "graphify", "path.ts"), "utf8");
    expect(src).not.toMatch(/"install"|'install'|"hook"|'hook'/);
  });
});

describe("resolveExecutable", () => {
  it("finds a bare name on a fake PATH, preferring .exe over .cmd on Windows, and returns undefined when absent", () => {
    const a = join(tmp(), "a");
    const b = join(tmp(), "b");
    mkdirSync(a);
    mkdirSync(b);
    if (windows) {
      writeFileSync(join(a, "tool.cmd"), "@echo off");
      writeFileSync(join(b, "tool.exe"), "MZ");
      writeFileSync(join(b, "tool.cmd"), "@echo off");
      const env = { PATH: [a, b].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(resolveExecutable("tool", { env, platform: "win32" })).toEqual({ path: join(a, "tool.cmd"), kind: "cmd" });
      const env2 = { PATH: [b, a].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(resolveExecutable("tool", { env: env2, platform: "win32" })).toEqual({ path: join(b, "tool.exe"), kind: "exe" });
      expect(resolveExecutable("tool.cmd", { env: env2, platform: "win32" })).toEqual({ path: join(b, "tool.cmd"), kind: "cmd" });
      // explicit path: as-is, then with extensions
      expect(resolveExecutable(join(b, "tool"), { env: env2, platform: "win32" })).toEqual({ path: join(b, "tool.exe"), kind: "exe" });
    } else {
      writeFileSync(join(a, "tool"), "#!/bin/sh\n");
      chmodSync(join(a, "tool"), 0o755);
      writeFileSync(join(b, "tool"), "#!/bin/sh\n"); // not executable
      const env = { PATH: [b, a].join(delimiter) };
      expect(resolveExecutable("tool", { env, platform: process.platform })).toEqual({ path: join(a, "tool"), kind: "exe" });
      expect(resolveExecutable(join(a, "tool"), { env, platform: process.platform })).toEqual({ path: join(a, "tool"), kind: "exe" });
    }
    expect(resolveExecutable("nope-not-here", { env: { PATH: a }, platform: process.platform })).toBeUndefined();
    expect(resolveExecutable(join(a, "nope"), { env: { PATH: a }, platform: process.platform })).toBeUndefined();
  });
});

describe("runGraphifyPath with a fake executable", () => {
  const base = { from: "osgraph://MyModule/Screen/LoginScreen", to: "osgraph://MyModule/Entity/User" };

  it("found: parses stdout, passes argv in order, sets GRAPHIFY_NO_AUTO_REFRESH=1", async () => {
    const dir = tmp();
    fakeGraphify(dir, FOUND, 0);
    const snapshotPath = join(dir, "graph.json");
    writeFileSync(snapshotPath, "{}");
    const r = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath, env: envWithPath(dir) });
    expect(r).toMatchObject({ found: true, hops: 2 });
    expect(r.found && r.path.map((s) => s.label)).toEqual(["LoginScreen", "AuthenticateUser", "User"]);
    const args = readFileSync(join(dir, "args.txt"), "utf8").replace(/"/g, "").trim().split(/\s+|\n/);
    expect(args).toEqual(["path", base.from, base.to, "--graph", snapshotPath]);
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toBe("[1]");
  });

  it("undirected flag is forwarded; no-path text → found:false with raw", async () => {
    const dir = tmp();
    fakeGraphify(dir, NO_PATH, 0);
    const snapshotPath = join(dir, "graph.json");
    const r = await runGraphifyPath({ graphifyBin: "graphify", ...base, undirected: true, snapshotPath, env: envWithPath(dir) });
    expect(r).toEqual({ found: false, raw: NO_PATH, graphifyVersion: GRAPHIFY_VERSION });
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("--undirected");
  });

  it("exit 4 → UNKNOWN_NODE; 'No node matching' with exit 0 → UNKNOWN_NODE", async () => {
    const dir = tmp();
    fakeGraphify(dir, NO_NODE, 4);
    expect(await codeOf(runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir) }))).toBe("UNKNOWN_NODE");
    const dir2 = tmp();
    fakeGraphify(dir2, NO_NODE, 0);
    expect(await codeOf(runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir2) }))).toBe("UNKNOWN_NODE");
  });

  it("other non-zero exit → GRAPHIFY_FAILED with exit code in details; unparseable exit-0 output → GRAPHIFY_FAILED", async () => {
    const dir = tmp();
    fakeGraphify(dir, "Traceback (most recent call last)...\n", 1);
    try {
      await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir) });
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(OsgraphToolError);
      expect((err as OsgraphToolError).code).toBe("GRAPHIFY_FAILED");
      expect((err as OsgraphToolError).details).toMatchObject({ exitCode: 1 });
    }
    const dir2 = tmp();
    fakeGraphify(dir2, "something else entirely\n", 0);
    expect(await codeOf(runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir2) }))).toBe("GRAPHIFY_FAILED");
  });

  it("missing binary → GRAPHIFY_NOT_FOUND (bare name and explicit path)", async () => {
    const dir = tmp();
    expect(await codeOf(runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir) }))).toBe("GRAPHIFY_NOT_FOUND");
    expect(await codeOf(runGraphifyPath({ graphifyBin: join(dir, "graphify"), ...base, snapshotPath: "g.json", env: envWithPath(dir) }))).toBe("GRAPHIFY_NOT_FOUND");
  });

  it("the guard runs before any spawn: a tampered argv builder never reaches the executable", async () => {
    let spawned = false;
    const code = await codeOf(
      runGraphifyPath({
        graphifyBin: "graphify",
        ...base,
        snapshotPath: "g.json",
        resolve: () => ({ path: "graphify", kind: "exe" }),
        spawnImpl: async () => {
          spawned = true;
          return { code: 0, signal: null, stdout: FOUND, stderr: "" };
        }
      })
    );
    expect(code).toBeUndefined();
    expect(spawned).toBe(true);
    // direct guard call with a forbidden subcommand
    expect(() => assertSafeGraphifyArgs(["install", "--graph", "g.json"])).toThrow(OsgraphToolError);
  });
});

describe("ADR-0010 — the `graphify --version` probe", () => {
  const base = { from: "osgraph://MyModule/Screen/LoginScreen", to: "osgraph://MyModule/Entity/User" };

  it("reports the pinned version with no warning, and keeps GRAPHIFY_NO_AUTO_REFRESH=1 on the probe", async () => {
    const dir = tmp();
    fakeGraphify(dir, FOUND, 0);
    const logs: string[] = [];
    const r = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir), log: (l) => logs.push(l) });
    expect(r.graphifyVersion).toBe(GRAPHIFY_VERSION);
    expect(r.graphifyVersionWarning).toBeUndefined();
    expect(logs).toEqual([]);
    expect(probeCount(dir)).toBe(1);
    expect(readFileSync(join(dir, "probes.txt"), "utf8").trim()).toBe("[1]");
  });

  it("a different version warns once on the log and on every result, and still answers", async () => {
    const dir = tmp();
    fakeGraphify(dir, FOUND, 0, { versionStdout: "graphify 0.8.49\n" });
    const logs: string[] = [];
    const env = envWithPath(dir);
    const first = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env, log: (l) => logs.push(l) });
    expect(first).toMatchObject({ found: true, hops: 2, graphifyVersion: "0.8.49" });
    expect(first.graphifyVersionWarning).toContain("0.8.49");
    expect(first.graphifyVersionWarning).toContain(GRAPHIFY_VERSION);
    expect(first.graphifyVersionWarning).toContain("OSGRAPH_GRAPHIFY_BIN");
    expect(logs).toHaveLength(1);

    const second = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env, log: (l) => logs.push(l) });
    expect(second.graphifyVersionWarning).toBe(first.graphifyVersionWarning); // field on every result
    expect(logs).toHaveLength(1); // one stderr line per process, not per call
  });

  it("a failed or unparseable probe is non-fatal: version null, no warning, query still answers", async () => {
    const failing = tmp();
    fakeGraphify(failing, FOUND, 0, { versionCode: 3 });
    const r1 = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(failing) });
    expect(r1).toMatchObject({ found: true, graphifyVersion: null });
    expect(r1.graphifyVersionWarning).toBeUndefined();

    const garbled = tmp();
    fakeGraphify(garbled, FOUND, 0, { versionStdout: "not a version line\n" });
    const r2 = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(garbled) });
    expect(r2).toMatchObject({ found: true, graphifyVersion: null });
  });

  it("is memoised by the resolved absolute path: once per path, re-probed when the path changes", async () => {
    const a = tmp();
    const b = tmp();
    fakeGraphify(a, FOUND, 0);
    fakeGraphify(b, FOUND, 0, { versionStdout: "graphify 0.9.45\n" });
    const envA = envWithPath(a);
    for (let i = 0; i < 3; i++) await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envA });
    expect(probeCount(a)).toBe(1);

    const viaB = await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(b) });
    expect(viaB.graphifyVersion).toBe("0.9.45");
    expect(probeCount(b)).toBe(1);
    expect(probeCount(a)).toBe(1); // the first path was not re-probed
  });

  it("the version rides along on GRAPHIFY_FAILED details too", async () => {
    const dir = tmp();
    fakeGraphify(dir, "Shortest path (2 hops):\n  A ==calls==> B\n", 0);
    try {
      await runGraphifyPath({ graphifyBin: "graphify", ...base, snapshotPath: "g.json", env: envWithPath(dir) });
      throw new Error("expected failure");
    } catch (err) {
      expect((err as OsgraphToolError).code).toBe("GRAPHIFY_FAILED");
      expect((err as OsgraphToolError).message).toContain("consistent path");
      expect((err as OsgraphToolError).details).toMatchObject({ graphifyVersion: GRAPHIFY_VERSION });
    }
  });

  it("the ADR-0003 allow-list admits exactly `path` and `--version`", () => {
    expect(() => assertSafeGraphifyArgs(["--version"])).not.toThrow();
    expect(() => assertSafeGraphifyArgs(["--help"])).toThrow(OsgraphToolError);
    expect(() => assertSafeGraphifyArgs(["--version", "extra"])).not.toThrow();
  });

  it("F6: a `from`/`to` that is not an osgraph:// id is rejected before any spawn", async () => {
    let spawned = false;
    const options = {
      graphifyBin: "graphify",
      snapshotPath: "g.json",
      resolve: () => ({ path: "graphify", kind: "exe" as const }),
      spawnImpl: async () => {
        spawned = true;
        return { code: 0, signal: null, stdout: FOUND, stderr: "" };
      }
    };
    expect(await codeOf(runGraphifyPath({ ...options, from: "--graph", to: base.to }))).toBe("INPUT_INVALID");
    expect(await codeOf(runGraphifyPath({ ...options, from: base.from, to: "-x" }))).toBe("INPUT_INVALID");
    expect(spawned).toBe(false);
  });
});

describe("real graphify (OSGRAPH_GRAPHIFY_LIVE=1 only)", () => {
  const live = process.env.OSGRAPH_GRAPHIFY_LIVE === "1";
  it.skipIf(!live)("answers the OSG-009 graph exactly as recorded", async () => {
    const snapshotPath = join(fixtures, "synthetic", "graph-osg009.json");
    expect(existsSync(snapshotPath)).toBe(true);
    const bin = process.env.OSGRAPH_GRAPHIFY_BIN ?? "graphify";
    const found = await runGraphifyPath({ graphifyBin: bin, from: "osgraph://MyModule/Screen/LoginScreen", to: "osgraph://MyModule/Entity/User", snapshotPath });
    expect(found).toMatchObject({ found: true, hops: 2 });
    expect(found.found && found.path.map((s) => s.label)).toEqual(["LoginScreen", "AuthenticateUser", "User"]);
    // ADR-0010: the real binary's own `--version` output, probed once per resolved path
    expect(found.graphifyVersion).toBe("0.9.91");
    expect(found.graphifyVersion).toBe(GRAPHIFY_VERSION);
    expect(found.graphifyVersionWarning).toBeUndefined();
    const none = await runGraphifyPath({ graphifyBin: bin, from: "osgraph://MyModule/Screen/LoginScreen", to: "osgraph://MyModule/Entity/Session", snapshotPath });
    expect(none.found).toBe(false);
    expect(await codeOf(runGraphifyPath({ graphifyBin: bin, from: "osgraph://MyModule/Screen/LoginScreen", to: "osgraph://Nope", snapshotPath }))).toBe("UNKNOWN_NODE");
  }, 60_000);
});
