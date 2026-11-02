/**
 * `queryPath` back end: the ONE place osgraph shells out to Graphify (ADR-0001, OSG-007), and only
 * ever to `graphify path <from> <to> [--undirected] --graph <snapshot>` or the read-only
 * `graphify --version` probe (ADR-0003 as widened by ADR-0010: never the two commands that activate
 * the package's bundled agent-manipulation content). Output is plain text and the exit code is 0 for
 * both "found" and "no path" (OSG-009), so the result is parsed from stdout; exit 4 /
 * "No node matching" = unknown node. ADR-0010 makes that text contract the gate: a found header
 * whose path line is not internally consistent with it fails as `GRAPHIFY_FAILED` rather than
 * answering with a wrong path.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { GRAPHIFY_VERSION } from "../graph/types.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { resolveExecutable, type ResolvedExecutable } from "./resolve.js";

export const GRAPHIFY_ALLOWED_SUBCOMMAND = "path";
/** ADR-0010: read-only version probe, the second and last argv[0] osgraph is allowed to run. */
export const GRAPHIFY_VERSION_FLAG = "--version";
/**
 * ADR-0003's behavioural guard as an allow-list (widened by ADR-0010 to admit the probe): exactly
 * these two argv[0] values may ever be spawned. Everything else throws before any process starts.
 */
export const GRAPHIFY_ALLOWED_ARGV0: readonly string[] = [GRAPHIFY_ALLOWED_SUBCOMMAND, GRAPHIFY_VERSION_FLAG];
/** Set on every graphify spawn (OSG-009 precaution against the package's self-refresh behaviour). */
export const GRAPHIFY_ENV_NO_AUTO_REFRESH = "GRAPHIFY_NO_AUTO_REFRESH";
/** ADR-0006/0008: every node id osgraph writes into a snapshot starts with this scheme. */
export const OSGRAPH_ID_PREFIX = "osgraph://";

export interface PathStep {
  label: string;
  /** Relation of the edge that leads INTO this step from the previous one; absent on the first step. */
  relation?: string;
  /** Confidence tag of that same edge (`EXTRACTED` / `AMBIGUOUS`); absent on the first step. */
  confidence?: string;
}

/**
 * ADR-0010: the version the resolved binary reported, `null` when the probe failed or its output was
 * unparseable (never fatal), plus the one-line mismatch warning when it is not the pinned
 * `GRAPHIFY_VERSION`. Optional here so test doubles of the runner stay terse; `queryPath` normalises
 * the version to `string | null` on both arms of its own result.
 */
export interface GraphifyVersionReport {
  graphifyVersion?: string | null;
  graphifyVersionWarning?: string;
}

export type GraphifyPathResult =
  | ({ found: true; hops: number; path: PathStep[]; raw: string } & GraphifyVersionReport)
  | ({ found: false; raw: string } & GraphifyVersionReport);

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type SpawnLike = (file: string, args: string[], options: SpawnOptions) => Promise<SpawnResult>;

export interface RunGraphifyPathOptions {
  /** `config.graphifyBin`: a bare name looked up on PATH, or a path. */
  graphifyBin: string;
  from: string;
  to: string;
  undirected?: boolean;
  snapshotPath: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Injectable process runner (tests). */
  spawnImpl?: SpawnLike;
  /** Injectable resolver (tests). */
  resolve?: (bin: string) => ResolvedExecutable | undefined;
  /**
   * Diagnostic sink (`ctx.log` -> stderr). ADR-0010 warns on a version mismatch here exactly once
   * per resolved executable, in addition to the field on the result.
   */
  log?: (line: string) => void;
}

/** Builds the exact argv. Pure. */
export function buildGraphifyPathArgs(args: { from: string; to: string; undirected?: boolean; snapshotPath: string }): string[] {
  return [
    GRAPHIFY_ALLOWED_SUBCOMMAND,
    args.from,
    args.to,
    ...(args.undirected ? ["--undirected"] : []),
    "--graph",
    args.snapshotPath
  ];
}

/**
 * ADR-0003 guard, widened by ADR-0010 to a two-entry allow-list: `argv[0]` must be exactly `path`
 * (the query) or `--version` (the read-only probe). Anything else — the two package commands that
 * activate its dormant agent-manipulation content emphatically included — throws `GRAPHIFY_FAILED`
 * before any process is spawned. Only `argv[0]` decides, which is sound because graphify's argparse
 * takes a subcommand in that one position; the positionals after it are validated separately
 * (`assertGraphifyNodeId`, S6 audit F6) because argparse reads a leading `-` as an option.
 */
export function assertSafeGraphifyArgs(args: readonly string[]): void {
  if (args.length === 0 || !GRAPHIFY_ALLOWED_ARGV0.includes(args[0]!)) {
    throw new OsgraphToolError(
      "GRAPHIFY_FAILED",
      `refusing to run graphify with subcommand '${args[0] ?? ""}': osgraph only ever runs ` +
        `${GRAPHIFY_ALLOWED_ARGV0.map((a) => `'graphify ${a}'`).join(" or ")} (ADR-0003, ADR-0010)`,
      { args: [...args] }
    );
  }
}

/**
 * S6 audit F6: `from`/`to` reach graphify as bare positionals, so a value starting with `-` is read
 * as an option (`--help`, `--graph`, …) and produces confusing `GRAPHIFY_FAILED` noise instead of a
 * clear rejection. `--` is NOT a usable separator: graphify 0.9.91 reads it as a node id
 * (`No node matching '--' found.`, exit 4, measured 2026-10-30), so the only correct fix is to
 * require the `osgraph://` scheme every node id osgraph writes already has (ADR-0006/0008).
 */
export function assertGraphifyNodeId(field: "from" | "to", value: string): void {
  if (!value.startsWith(OSGRAPH_ID_PREFIX)) {
    throw new OsgraphToolError(
      "INPUT_INVALID",
      `'${field}' must be an osgraph node id starting with '${OSGRAPH_ID_PREFIX}' ` +
        `(got ${JSON.stringify(value)}); graphify reads a bare positional starting with '-' as an option`,
      { field, value }
    );
  }
}

const SHORTEST_RE = /^Shortest path \((\d+) hops?\):\s*$/m;
const NO_PATH_RE = /^No (?:directed |undirected )?path found/m;
const NO_NODE_RE = /No node matching/;
const STEP_RE = /\s--([\w-]+)\s\[([^\]]*)\]-->\s/;

/** Parses the `A --rel [CONF]--> B --rel [CONF]--> C` line. */
export function parsePathLine(line: string): PathStep[] {
  const steps: PathStep[] = [];
  let rest = line.trim();
  let pending: { relation: string; confidence: string } | undefined;
  for (;;) {
    const m = STEP_RE.exec(rest);
    const label = (m ? rest.slice(0, m.index) : rest).trim();
    const step: PathStep = { label };
    if (pending) {
      step.relation = pending.relation;
      step.confidence = pending.confidence;
    }
    steps.push(step);
    if (!m) break;
    pending = { relation: m[1]!, confidence: m[2]! };
    rest = rest.slice(m.index + m[0].length);
  }
  return steps;
}

/**
 * ADR-0010: the output contract is the gate. A found header is only believed when the path line it
 * announces is internally consistent with it — `hops >= 1`, exactly `hops + 1` steps, every label
 * non-empty, and every step after the first carrying the relation and confidence of the edge that
 * led into it. The three-version differential (0.8.49 / 0.9.45 / 0.9.91) showed the real
 * silent-wrong-answer risk is not the version number but a changed ` --rel [CONF]--> ` arrow syntax
 * under an unchanged `Shortest path (N hops):` header: `SHORTEST_RE` would still match and
 * `queryPath` would answer `found: true` with one step whose label is the whole line.
 */
function isConsistentPath(hops: number, steps: PathStep[]): boolean {
  if (!Number.isInteger(hops) || hops < 1) return false;
  if (steps.length !== hops + 1) return false;
  return steps.every(
    (step, i) =>
      step.label.length > 0 &&
      (i === 0 ||
        (step.relation !== undefined && step.relation.length > 0 && step.confidence !== undefined && step.confidence.length > 0))
  );
}

/**
 * Parses graphify's stdout (OSG-009 formats). Returns undefined when neither outcome is recognised
 * OR when a found header did not parse into a consistent path (ADR-0010) — the caller turns both
 * into the existing `GRAPHIFY_FAILED`, so an unrecognised contract is never answered as a result.
 */
export function parseGraphifyPathOutput(stdout: string): GraphifyPathResult | undefined {
  const raw = stdout;
  const text = stdout.replace(/\r\n/g, "\n");
  const found = SHORTEST_RE.exec(text);
  if (found) {
    const hops = Number(found[1]);
    const after = text.slice(found.index + found[0].length);
    const pathLine = after.split("\n").find((l) => l.trim().length > 0) ?? "";
    const path = pathLine.length > 0 ? parsePathLine(pathLine) : [];
    if (!isConsistentPath(hops, path)) return undefined;
    return { found: true, hops, path, raw };
  }
  if (NO_PATH_RE.test(text)) return { found: false, raw };
  return undefined;
}

const VERSION_RE = /^graphify\s+(\d+\.\d+\.\d+\S*)/m;

/**
 * ADR-0010 probe result, memoised by the RESOLVED ABSOLUTE PATH of the executable — so a changed
 * `OSGRAPH_GRAPHIFY_BIN` or PATH re-probes, and the probe and the query always describe the same
 * file. This dev machine carries three `graphify.exe` on PATH (0.9.91 / 0.9.45 / 0.8.49), which is
 * exactly why the version is reported rather than assumed.
 */
const versionCache = new Map<string, GraphifyVersionReport>();

/** Test-only: forget every memoised probe so a test can count probe spawns deterministically. */
export function resetGraphifyVersionCache(): void {
  versionCache.clear();
}

/**
 * Runs `<resolved exe> --version` at most once per resolved path and reports what it said.
 * Never fatal (ADR-0010): a failed, non-zero or unparseable probe yields `graphifyVersion: null`.
 * A version other than the pinned `GRAPHIFY_VERSION` adds `graphifyVersionWarning` to every result
 * and writes one line to `log` — once per resolved path, not once per call.
 */
async function graphifyVersionReport(
  exe: ResolvedExecutable,
  context: { env: Record<string, string>; platform: NodeJS.Platform; run: SpawnLike; log?: (line: string) => void }
): Promise<GraphifyVersionReport> {
  const cached = versionCache.get(exe.path);
  if (cached !== undefined) return cached;

  let version: string | null = null;
  try {
    const outcome = await spawnGraphify(exe, [GRAPHIFY_VERSION_FLAG], context);
    if (outcome.code === 0) version = VERSION_RE.exec(outcome.stdout.replace(/\r\n/g, "\n"))?.[1] ?? null;
  } catch {
    version = null; // the probe is diagnostic; a query that cannot spawn fails on its own spawn
  }

  const report: GraphifyVersionReport = { graphifyVersion: version };
  if (version !== null && version !== GRAPHIFY_VERSION) {
    report.graphifyVersionWarning =
      `graphify at ${exe.path} reports version ${version}, but osgraph pins ${GRAPHIFY_VERSION}; ` +
      `set OSGRAPH_GRAPHIFY_BIN to the absolute path of the pinned executable (a bare name is resolved by ` +
      `PATH order, which is not a pin). Results are still returned: the output contract, not the version, is the gate.`;
    context.log?.(`queryPath: ${report.graphifyVersionWarning}`);
  }
  versionCache.set(exe.path, report);
  return report;
}

function defaultSpawn(file: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => (stdout += String(d)));
    child.stderr?.on("data", (d: Buffer | string) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** cmd.exe quoting for one argument; rejects metacharacters a node id never legitimately contains. */
function cmdQuote(arg: string): string {
  if (/["\r\n%!^&|<>]/.test(arg)) {
    throw new OsgraphToolError("GRAPHIFY_FAILED", `argument contains characters unsafe for cmd.exe: ${JSON.stringify(arg)}`, { arg });
  }
  return `"${arg}"`;
}

/**
 * One graphify spawn. Shared by the `path` query and ADR-0010's `--version` probe so both run the
 * same resolved file, the same `GRAPHIFY_NO_AUTO_REFRESH=1` precaution and the same cmd.exe handling.
 */
function spawnGraphify(
  exe: ResolvedExecutable,
  args: readonly string[],
  context: { env: Record<string, string>; platform: NodeJS.Platform; run: SpawnLike }
): Promise<SpawnResult> {
  assertSafeGraphifyArgs(args);
  // Windows batch scripts cannot be spawned directly (Node refuses .cmd/.bat without a shell since
  // CVE-2024-27980); run them through cmd.exe with every argument double-quoted — still shell:false.
  let file = exe.path;
  let argv = [...args];
  const spawnOptions: SpawnOptions = { env: context.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
  if (exe.kind === "cmd" && context.platform === "win32") {
    file = context.env.ComSpec ?? context.env.COMSPEC ?? "cmd.exe";
    argv = ["/d", "/s", "/c", `"${[exe.path, ...args].map(cmdQuote).join(" ")}"`];
    spawnOptions.windowsVerbatimArguments = true;
  }
  return context.run(file, argv, spawnOptions);
}

/**
 * Runs `graphify path`. Throws `GRAPHIFY_NOT_FOUND` (binary missing), `UNKNOWN_NODE` (exit 4 /
 * "No node matching"), `GRAPHIFY_FAILED` (any other non-zero exit, unparseable output, or output
 * whose found branch is not internally consistent — ADR-0010), `INPUT_INVALID` (a `from`/`to` that
 * is not an `osgraph://` node id — S6 audit F6). Every result carries the version the resolved
 * binary reported (ADR-0010), probed once per resolved path and never fatal.
 */
export async function runGraphifyPath(options: RunGraphifyPathOptions): Promise<GraphifyPathResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  assertGraphifyNodeId("from", options.from);
  assertGraphifyNodeId("to", options.to);
  const args = buildGraphifyPathArgs(options);
  assertSafeGraphifyArgs(args);

  const resolve = options.resolve ?? ((bin: string) => resolveExecutable(bin, { env, platform }));
  const exe = resolve(options.graphifyBin);
  if (exe === undefined) {
    throw new OsgraphToolError(
      "GRAPHIFY_NOT_FOUND",
      `graphify executable '${options.graphifyBin}' was not found on PATH; install the pinned version and/or set OSGRAPH_GRAPHIFY_BIN`,
      { graphifyBin: options.graphifyBin }
    );
  }

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  childEnv[GRAPHIFY_ENV_NO_AUTO_REFRESH] = "1";

  const context = { env: childEnv, platform, run: options.spawnImpl ?? defaultSpawn, log: options.log };
  // ADR-0010: probed immediately before the first `path` spawn of this process, then memoised.
  const version = await graphifyVersionReport(exe, context);

  let outcome: SpawnResult;
  try {
    outcome = await spawnGraphify(exe, args, context);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new OsgraphToolError("GRAPHIFY_NOT_FOUND", `graphify executable '${exe.path}' could not be started (ENOENT)`, { path: exe.path });
    }
    throw new OsgraphToolError("GRAPHIFY_FAILED", `graphify could not be started: ${(err as Error).message}`, { path: exe.path, code });
  }

  const combined = `${outcome.stdout}\n${outcome.stderr}`;
  if (outcome.code === 4 || NO_NODE_RE.test(combined)) {
    throw new OsgraphToolError("UNKNOWN_NODE", `graphify: ${firstLine(combined) || "no node matching the given id"}`, {
      from: options.from,
      to: options.to,
      exitCode: outcome.code,
      stdout: outcome.stdout.slice(0, 2000),
      stderr: outcome.stderr.slice(0, 2000)
    });
  }
  if (outcome.code !== 0) {
    throw new OsgraphToolError("GRAPHIFY_FAILED", `graphify path exited with code ${outcome.code ?? `signal ${outcome.signal}`}`, {
      exitCode: outcome.code,
      signal: outcome.signal,
      stdout: outcome.stdout.slice(0, 2000),
      stderr: outcome.stderr.slice(0, 2000)
    });
  }
  const parsed = parseGraphifyPathOutput(outcome.stdout);
  if (parsed === undefined) {
    throw new OsgraphToolError(
      "GRAPHIFY_FAILED",
      "graphify path exited 0 but its output matched neither 'Shortest path' nor 'No path found', " +
        "or did not parse as a consistent path",
      {
        stdout: outcome.stdout.slice(0, 2000),
        stderr: outcome.stderr.slice(0, 2000),
        ...version
      }
    );
  }
  return { ...parsed, ...version };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}
