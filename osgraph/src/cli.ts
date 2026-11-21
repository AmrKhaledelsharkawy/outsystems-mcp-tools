#!/usr/bin/env node
import { loadConfig, OsgraphConfigError, requireServiceStudioUrl, type OsgraphConfig } from "./config.js";
import { resolveScopeSnapshotPath } from "./graph/io.js";
import { loadLayerRules } from "./layers/rules.js";
import { reextractScope } from "./reextract.js";
import { computeGraphStatus, formatGraphStatus } from "./status/graphStatus.js";
import { auditScope, DEFAULT_K, DEFAULT_SEED, formatReport } from "./audit/index.js";
import { buildKindReport, formatKindReport } from "./report/kinds.js";
import { readScope } from "./scopes/index.js";
import { renderDoctorReport, runDoctor } from "./doctor/doctor.js";
import { parseArgs, requiresServiceStudioAtStart, USAGE } from "./cli/args.js";
import { startServer } from "./server.js";
import { CliUsageError, formatQueryResponse, isQueryCommand, runQueryCommand, type QueryCommand } from "./cli/query.js";
import { defaultStudioLockPath, createFileStudioLock } from "./lock/studioLock.js";
import { closeSite, ensureSite } from "./progress/site.js";
import { describeLoadFailure, loadOsopenerAdapter } from "./osopener/adapter.js";
import { createServiceStudioClient } from "./servicestudio/token.js";
import { createSharedSessionFactory, createToolContext } from "./tools/tool.js";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_OPEN, formatAge, refreshModule, refreshModules, runScope } from "./run/run.js";
import { RunControl } from "./run/control.js";
import { createInterface } from "node:readline";

/** Environment alternative to the prompt (non-interactive starts). Never logged. */
const ENV_CONTROL_PASSWORD = "OSGRAPH_CONTROL_PASSWORD";

/**
 * Reads a line from the terminal without echoing it (the remote-control password). Prompt and
 * newline go to stderr, so `--json` output on stdout stays clean.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Swallow readline's echo of the typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    rl.once("line", (line) => {
      rl.close();
      process.stderr.write("\n");
      resolve(line);
    });
    rl.once("SIGINT", () => {
      rl.close();
      process.stderr.write("\n");
      resolve("");
    });
  });
}

/**
 * `--wait`: Enter in the terminal presses Start. Only on an interactive terminal; returns the
 * function that stops listening (stdin is released so the process can exit).
 */
function startOnEnter(control: RunControl, log: (line: string) => void): () => void {
  if (process.stdin.isTTY !== true) return () => undefined;
  const onData = (): void => {
    if (control.start()) log("Start pressed in the terminal.");
    stop();
  };
  const stop = (): void => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
  process.stdin.on("data", onData);
  process.stdin.resume();
  return stop;
}

const EXIT_CONFIG = 2;
const EXIT_FATAL = 1;
const EXIT_USAGE = 64;

/** #7: `serve` starts without an endpoint, but says up front (stderr, never stdout) what that costs. */
function noteMissingEndpoint(config: OsgraphConfig): void {
  try {
    requireServiceStudioUrl(config);
  } catch (err) {
    if (!(err instanceof OsgraphConfigError)) throw err;
    process.stderr.write(
      `osgraph: ${err.code}: ${err.message}\n` +
        `osgraph: offline tools are available; 'rebuild' will refuse with ${err.code} until this is fixed.\n`
    );
  }
}

/**
 * Writes the message to stderr and exits once the write has flushed.
 * On Windows, pipes are asynchronous: a synchronous `process.exit` right after
 * `stderr.write` can truncate the message the host captures.
 */
function fail(code: number, message: string): void {
  process.exitCode = code;
  process.stderr.write(`osgraph: ${message}\n`, () => process.exit(code));
}

async function runReextract(config: OsgraphConfig, options: Record<string, string>): Promise<void> {
  const scopeName = options.scope;
  if (scopeName === undefined || scopeName === "true") {
    fail(EXIT_USAGE, `reextract needs --scope <name>.\n${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const result = reextractScope({
    scope,
    graphDir,
    snapshotPath: resolveScopeSnapshotPath(graphDir, scope.name),
    rules: loadLayerRules(),
    ...(options.quiet === "true" ? {} : { onProgress: (line: string) => process.stderr.write(`${line}\n`) })
  });
  // Raised before either output mode branches, so `--json --serve` behaves like `--serve`.
  //
  // `reextract` is a one-shot command: a site raised unasked would die with the process the moment
  // it printed its own URL, so this is opt-in rather than automatic — unlike `rebuild`, which runs
  // inside the long-lived MCP server and so can always raise one.
  const site = options.serve === "true" ? await ensureSite(config) : null;
  if (site !== null) {
    site.state.beginRun(scope.name, scope.modules);
    site.state.finishRun([]);
  }

  if (options.json === "true") {
    const payload = site === null ? result : { ...result, progressSite: { url: site.url, urls: site.urls } };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (site !== null) process.stderr.write(`${site.banner}\n  (serving until Ctrl+C)\n`);
    return;
  }
  const lines = [
    `scope '${result.scope}': ${result.modules.length} module(s) re-extracted in ${result.durationMs} ms`,
    `  graph.json  ${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.violationCount} violation(s)`,
    `  flows.json  ${result.flowActionCount} actions, ${result.flowNodeCount} flow nodes, ` +
      `${result.unknownNodeCount} unknown, ${result.parseErrorCount} parse error(s)`
  ];
  if (result.unknownNodeTypes.length > 0) lines.push(`  unknown node types: ${result.unknownNodeTypes.join(", ")}`);
  for (const m of result.missingCaptures) lines.push(`  NO CAPTURE  ${m.module}: ${m.code}`);

  if (site !== null) {
    lines.push("");
    for (const bannerLine of site.banner.split("\n")) lines.push(bannerLine);
    if (site.url !== null) lines.push("  (serving until Ctrl+C)");
  } else {
    lines.push("  re-run with --serve to browse this scope's graph in a browser");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** #66 `osgraph status`: offline, read-only freshness report for one scope's local snapshot. */
function runStatus(config: OsgraphConfig, options: Record<string, string>): void {
  const scopeName = options.scope;
  if (scopeName === undefined || scopeName === "true") {
    fail(EXIT_USAGE, `status needs --scope <name>.
${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const result = computeGraphStatus(graphDir, scope.name, scope.modules);
  process.stdout.write(options.json === "true" ? `${JSON.stringify(result, null, 2)}
` : `${formatGraphStatus(result)}
`);
}

/** #69 `osgraph kinds`: the offline read-cost report. */
async function runKinds(config: OsgraphConfig, options: Record<string, string>): Promise<void> {
  const scopeName = options.scope;
  if (scopeName === undefined || scopeName === "true") {
    fail(EXIT_USAGE, `kinds needs --scope <name>.\n${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const report = buildKindReport({
    graphDir,
    scope: scope.name,
    snapshotPath: resolveScopeSnapshotPath(graphDir, scope.name)
  });
  process.stdout.write(options.json === "true" ? `${JSON.stringify(report, null, 2)}\n` : `${formatKindReport(report)}\n`);
}

/** #70 `osgraph impact | flow | path`: offline mirrors of the MCP query tools. */
async function runQuery(command: QueryCommand, config: OsgraphConfig, options: Record<string, string>): Promise<void> {
  const ctx = createToolContext(options["graph-dir"] !== undefined ? { ...config, graphDir: options["graph-dir"] } : config);
  let response;
  try {
    response = await runQueryCommand(command, options, ctx);
  } catch (err) {
    if (err instanceof CliUsageError) {
      fail(EXIT_USAGE, `${err.message}\n${USAGE}`);
      return;
    }
    throw err;
  }
  process.stdout.write(
    options.json === "true" ? `${JSON.stringify(response, null, 2)}\n` : `${formatQueryResponse(command, response)}\n`
  );
  if (response.error) process.exitCode = EXIT_FATAL;
}

/** A non-negative integer flag, or `fallback` when absent; `null` when present but not a number. */
function intFlag(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  // Plain decimal digits only: `Number("")`/`Number(" ")` is 0 (which would silently disable the
  // circuit breaker), and `0x10` / `1e2` are not what anyone means on a command line.
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** #67 `osgraph audit`: offline accuracy audit of a scope's snapshot against its raw texts. */
function runAudit(config: OsgraphConfig, options: Record<string, string>): void {
  const scopeName = options.scope;
  if (scopeName === undefined || scopeName === "true") {
    fail(EXIT_USAGE, `audit needs --scope <name>.
${USAGE}`);
    return;
  }
  const k = intFlag(options.k, DEFAULT_K);
  if (k === null || k < 1) {
    fail(EXIT_USAGE, `--k must be an integer >= 1.
${USAGE}`);
    return;
  }
  if (options.seed === "true") {
    fail(EXIT_USAGE, `--seed needs a value.
${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const report = auditScope({ graphDir, scope: scope.name, k, seed: options.seed ?? DEFAULT_SEED });
  process.stdout.write(options.json === "true" ? `${JSON.stringify(report, null, 2)}
` : formatReport(report));
}

/**
 * #48 `osgraph run`. The progress site is raised and its URL printed before anything else happens;
 * osopener is loaded next (a run cannot open a single module without it), and only then does the
 * first Service Studio call go out.
 */
async function runRun(config: OsgraphConfig, options: Record<string, string>): Promise<void> {
  const scopeName = options.scope;
  if (scopeName === undefined || scopeName === "true") {
    fail(EXIT_USAGE, `run needs --scope <name>.\n${USAGE}`);
    return;
  }
  if (options.module === "true") {
    fail(EXIT_USAGE, `--module needs a module name.\n${USAGE}`);
    return;
  }
  if (options.modules === "true" || options.modules === "") {
    fail(EXIT_USAGE, `--modules needs a comma-separated list of module names.
${USAGE}`);
    return;
  }
  if (options.module !== undefined && (options.modules !== undefined || options.changed !== undefined)) {
    fail(EXIT_USAGE, `--module cannot be combined with --modules or --changed.
${USAGE}`);
    return;
  }
  if (options.changed !== undefined && options.changed !== "true") {
    fail(EXIT_USAGE, `--changed takes no value.
${USAGE}`);
    return;
  }
  if (options.changed === "true" && process.env.OSGRAPH_DISABLE_CHANGED === "1") {
    fail(
      EXIT_USAGE,
      "CHANGED_DISABLED: --changed is switched off (OSGRAPH_DISABLE_CHANGED=1), because the listed-module-version signal " +
        "failed or has not passed its live probe. Use --modules <names> or a full run instead."
    );
    return;
  }
  const maxOpen = intFlag(options["max-open"], DEFAULT_MAX_OPEN);
  const maxFailures = intFlag(options["max-consecutive-failures"], DEFAULT_MAX_CONSECUTIVE_FAILURES);
  if (maxOpen === null || maxOpen < 1 || maxFailures === null) {
    fail(EXIT_USAGE, `--max-open must be an integer >= 1 and --max-consecutive-failures an integer >= 0.\n${USAGE}`);
    return;
  }
  const pipelineDepth = intFlag(options["pipeline-depth"], 1);
  if (pipelineDepth === null || pipelineDepth < 1) {
    fail(EXIT_USAGE, `--pipeline-depth must be an integer >= 1.\n${USAGE}`);
    return;
  }
  // --pipeline-depth and --trace only exist on the full run. The refresh modes would silently ignore
  // them, and `--changed --pipeline-depth 4` would look pipelined while running one module at a time.
  const refreshMode = options.module !== undefined || options.modules !== undefined || options.changed === "true";
  if (refreshMode) {
    const unsupported = [
      ...(options["pipeline-depth"] !== undefined && pipelineDepth !== 1 ? ["--pipeline-depth"] : []),
      ...(options.trace !== undefined ? ["--trace"] : []),
      ...(options.wait !== undefined ? ["--wait"] : [])
    ];
    if (unsupported.length > 0) {
      fail(
        EXIT_USAGE,
        `${unsupported.join(" and ")} ${unsupported.length > 1 ? "apply" : "applies"} only to a full run (osgraph run --scope <name>); --module, --modules and ` +
          `--changed always read one module at a time. Drop ${unsupported.length > 1 ? "them" : "it"} or run the full scope.\n${USAGE}`
      );
      return;
    }
  }
  if (options.trace !== undefined && options.trace !== "true") {
    fail(EXIT_USAGE, `--trace takes no value.\n${USAGE}`);
    return;
  }
  if (options.wait !== undefined && options.wait !== "true") {
    fail(EXIT_USAGE, `--wait takes no value.\n${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  // #64: the cross-process Studio lock comes first: before the site is raised, before osopener is
  // loaded, before any Studio call. A contender throws BUSY here and costs nothing. Released on every
  // exit path: after the Studio work below, in the `finally`, on process exit, and on SIGINT/SIGTERM.
  const studioHold = createFileStudioLock({ path: defaultStudioLockPath(process.env) }).acquire(
    `osgraph run --scope ${scopeName}${options.module !== undefined ? ` --module ${options.module}` : ""}`
  );
  const onExit = (): void => studioHold.release();
  // A full run is driven by a RunControl: the site's Start / Pause / Resume / Cancel, Enter in this
  // terminal (Start, with --wait) and Ctrl+C (Cancel) all act on it. The first Ctrl+C cancels gracefully:
  // no new opens, in-flight modules finish, drain and close, the report is written. A second Ctrl+C, or
  // any signal in the refresh modes (which have no cancellation path), exits at once as before.
  const control = new RunControl({ waitForStart: options.wait === "true" });
  control.onChange((state, previous) => log(`run control: ${previous} -> ${state}`));
  let graceful = false;
  const onSignal = (): void => {
    if (graceful && control.cancel()) {
      log(
        "CANCEL requested: opening no more modules; waiting for the ones in flight to finish, drain and close " +
          "(press Ctrl+C again to exit immediately)."
      );
      return;
    }
    studioHold.release();
    process.exit(130);
  };
  process.on("exit", onExit);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const releaseStudio = (): void => {
    studioHold.release();
    process.off("exit", onExit);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  try {
    await runRunLocked(
      config,
      options,
      {
        scopeName,
        graphDir,
        scope,
        log,
        maxOpen,
        maxFailures,
        pipelineDepth,
        control,
        enableGracefulCancel: () => {
          graceful = true;
        }
      },
      releaseStudio
    );
  } finally {
    releaseStudio();
  }
}

interface RunLockedArgs {
  scopeName: string;
  graphDir: string;
  scope: ReturnType<typeof readScope>;
  log: (line: string) => void;
  maxOpen: number;
  maxFailures: number;
  pipelineDepth: number;
  /** Start gate / pause / cancel for the full run (site buttons, Enter, Ctrl+C). */
  control: RunControl;
  /** Called right before `runScope`: only the full run has a graceful cancellation path. */
  enableGracefulCancel: () => void;
}

/** The Studio-touching body of `run`; `releaseStudio` is called the moment the Studio work is over. */
async function runRunLocked(
  config: OsgraphConfig,
  options: Record<string, string>,
  args: RunLockedArgs,
  releaseStudio: () => void
): Promise<void> {
  const { graphDir, scope, log, maxOpen, maxFailures, pipelineDepth } = args;
  // The URL is printed before any other work: a multi-hour run must never be unobservable.
  const site = await ensureSite({ ...config, graphDir });
  for (const line of site.banner.split("\n")) log(line);

  const loaded = await loadOsopenerAdapter(config.site.osopenerDist, { env: process.env });
  if (!loaded.ok) {
    site.state.failRun("OSOPENER_UNAVAILABLE", describeLoadFailure(loaded.failure));
    await closeSite();
    fail(EXIT_FATAL, `OSOPENER_UNAVAILABLE: ${describeLoadFailure(loaded.failure)}`);
    return;
  }

  const createSession = createSharedSessionFactory(() => {
    const built = createServiceStudioClient(config);
    return { reader: built.client, tokenProvider: built.tokenProvider };
  });
  const common = {
    scope,
    graphDir,
    rules: loadLayerRules(),
    createSession,
    opener: loaded.adapter,
    state: site.state,
    log,
    fetchConcurrency: config.fetchConcurrency,
    skipKinds: config.skipKinds,
    fetchReferencedElements: process.env.OSGRAPH_FETCH_REFERENCED_ELEMENTS === "1"
  };

  let exitCode = 0;
  let payload: unknown;
  const lines: string[] = [];
  if (options.modules !== undefined || options.changed === "true") {
    const result = await refreshModules({
      ...common,
      ...(options.modules !== undefined ? { modules: options.modules.split(",").map((m) => m.trim()).filter((m) => m !== "") } : {}),
      changed: options.changed === "true",
      maxOpen,
      maxConsecutiveFailures: maxFailures
    });
    payload = result;
    lines.push(
      `scope '${result.scope}': ${result.readCount} module(s) read of ${result.rows.length} considered, ${result.failures} failure(s)`
    );
    for (const r of result.rows) {
      const tagText = r.error !== undefined ? "FAILED " : r.read ? "read   " : "reused ";
      const errText = r.error !== undefined ? ` -- ${r.error.code}: ${r.error.message}` : "";
      lines.push(`  ${tagText} ${r.module}  [${r.reason}] ${r.detail}${errText}`);
    }
    if (result.stoppedEarly !== undefined) lines.push(`  STOPPED: ${result.stoppedEarly}`);
    if (result.reextract !== undefined) {
      lines.push(
        `  graph.json  ${result.reextract.nodeCount} nodes, ${result.reextract.edgeCount} edges, ${result.reextract.violationCount} violation(s)`,
        `  flows.json  ${result.reextract.flowActionCount} actions, ${result.reextract.flowNodeCount} flow nodes`
      );
    } else {
      lines.push("  not re-extracted: fix the failures and run the same command again");
      exitCode = 1;
    }
    lines.push(`  log ${result.logPath}`);
  } else if (options.module !== undefined) {
    const result = await refreshModule({ ...common, module: options.module });
    releaseStudio();
    payload = result;
    lines.push(
      `scope '${result.scope}': refreshed '${result.module}' (nodes ${result.staged.nodeCount}, edges ${result.staged.edgeCount}), ` +
        `re-extracted ${result.reextract.modules.length} module(s) offline`,
      `  graph.json  ${result.reextract.nodeCount} nodes, ${result.reextract.edgeCount} edges, ${result.reextract.violationCount} violation(s)`,
      `  flows.json  ${result.reextract.flowActionCount} actions, ${result.reextract.flowNodeCount} flow nodes`,
      `  the rest of the graph is only as fresh as each module's last capture:`
    );
    for (const c of result.otherCaptures) lines.push(`    ${c.module}  captured ${c.capturedAt}  (${formatAge(c.ageMs)} old)`);
  } else {
    args.enableGracefulCancel();
    const { control } = args;
    // Remote control (a phone's Start / Pause / Resume / Cancel) needs a password set here, at the
    // laptop, for this run only. Asked only when the site is reachable from other devices.
    if (site.url !== null && site.urls.length > 1) {
      const fromEnv = process.env[ENV_CONTROL_PASSWORD];
      let password = fromEnv;
      if (password === undefined && process.stdin.isTTY === true) {
        password = await promptHidden(
          "Set a run password to control this run from your phone (hidden; Enter = control from this PC only): "
        );
      }
      control.setRemotePassword(password);
      log(
        control.remoteEnabled
          ? `remote control: ON. On the phone open ${site.urls[1]} and type the run password to use Start / Pause / Resume / Cancel.`
          : "remote control: OFF. The buttons work on this PC only; other devices can watch."
      );
    }
    site.state.attachControl(control);
    const stopEnter = control.state === "waiting" ? startOnEnter(control, log) : () => undefined;
    if (control.state === "waiting") {
      log(
        `READY: ${scope.modules.length} module(s), pipeline depth ${pipelineDepth}. Nothing touches Service Studio until you ` +
          `press Start${site.url !== null ? ` on ${site.url} (this PC)` : ""} or Enter here.` +
          (site.urls[1] !== undefined ? ` Watch from a phone: ${site.urls[1]}` : "")
      );
    }
    let result: Awaited<ReturnType<typeof runScope>>;
    try {
      result = await runScope({
        ...common,
        maxOpen,
        maxConsecutiveFailures: maxFailures,
        pipelineDepth,
        control,
        ...(options.trace === "true" ? { trace: true } : {})
      });
    } finally {
      stopEnter();
      control.finish();
    }
    releaseStudio();
    payload = result;
    const staged = result.rows.filter((r) => r.outcome === "staged").length;
    lines.push(
      `scope '${result.scope}': ${staged} staged this run, ${result.alreadyStaged} already staged, ` +
        `${result.failures} failure(s), ${result.total} module(s) in scope`
    );
    if (result.rebuild !== undefined) {
      lines.push(
        `  graph.json  ${result.rebuild.nodeCount} nodes, ${result.rebuild.edgeCount} edges, ${result.rebuild.violationCount} violation(s)`
      );
    } else {
      lines.push("  not finalized: run the same command again to continue (staged modules are skipped)");
    }
    for (const r of result.rows.filter((x) => x.error !== undefined)) {
      lines.push(`  FAILED  ${r.module}: ${r.error?.code}: ${r.error?.message}${r.screenshotPath ? ` (screenshot ${r.screenshotPath})` : ""}`);
    }
    if (result.stoppedEarly !== undefined) lines.push(`  STOPPED: ${result.stoppedEarly}`);
    lines.push(`  log ${result.logPath}`);
    if (result.incomplete !== undefined) lines.push(`  INCOMPLETE: ${result.incomplete}`);
    // Anything short of a written graph.json is not success, whatever the reason.
    if (!result.finalized) exitCode = result.cancelled === true ? 130 : 1;
  }

  if (options.json === "true") {
    process.stdout.write(`${JSON.stringify({ ...(payload as object), progressSite: { url: site.url, urls: site.urls } }, null, 2)}\n`);
  } else {
    if (site.url !== null) lines.push(`  progress site: ${site.url}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (options.serve === "true" && site.url !== null) {
    log("  (progress site serving until Ctrl+C)");
    process.exitCode = exitCode;
    return;
  }
  await closeSite();
  process.exitCode = exitCode;
}

/** #63 `osgraph doctor`: read-only; exit 1 when any check fails. */
async function runDoctorCommand(config: OsgraphConfig, options: Record<string, string>): Promise<void> {
  if (options.scope === "true" || options["graph-dir"] === "true") {
    fail(EXIT_USAGE, `--scope and --graph-dir need a value.
${USAGE}`);
    return;
  }
  const report = await runDoctor({
    config,
    env: process.env,
    cwd: process.cwd(),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options["graph-dir"] !== undefined ? { graphDir: options["graph-dir"] } : {})
  });
  process.stdout.write(options.json === "true" ? `${JSON.stringify(report, null, 2)}
` : renderDoctorReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

const { command, options } = parseArgs(process.argv.slice(2));

if (options.help === "true" || command === "help") {
  process.stdout.write(USAGE);
} else {
  let config: OsgraphConfig | undefined;
  try {
    config = loadConfig(process.env, { requireServiceStudio: requiresServiceStudioAtStart(command) });
  } catch (err) {
    fail(EXIT_CONFIG, err instanceof OsgraphConfigError ? `${err.code}: ${err.message}` : String(err));
  }

  if (config !== undefined) {
    if (command === "reextract") {
      runReextract(config, options).catch((err: unknown) => {
        fail(EXIT_FATAL, err instanceof Error ? err.message : String(err));
      });
    } else if (command === "doctor") {
      runDoctorCommand(config, options).catch((err: unknown) => {
        fail(EXIT_FATAL, err instanceof Error ? err.message : String(err));
      });
    } else if (command === "status") {
      try {
        runStatus(config, options);
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        fail(EXIT_FATAL, `${typeof code === "string" ? `${code}: ` : ""}${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (command === "audit") {
      try {
        runAudit(config, options);
      } catch (err) {
        fail(EXIT_FATAL, err instanceof Error ? err.message : String(err));
      }
    } else if (command === "kinds") {
      runKinds(config, options).catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        fail(EXIT_FATAL, `${typeof code === "string" ? `${code}: ` : ""}${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (isQueryCommand(command)) {
      runQuery(command, config, options).catch((err: unknown) => {
        fail(EXIT_FATAL, err instanceof Error ? err.message : String(err));
      });
    } else if (command === "run") {
      runRun(config, options).catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        const text = `${typeof code === "string" ? `${code}: ` : ""}${message}`;
        if (options.json === "true") {
          // A --json consumer reads stdout only: give it the error there too, then fail as usual.
          const details = (err as { details?: unknown } | null)?.details;
          const payload = { error: { code: typeof code === "string" ? code : "INTERNAL_ERROR", message, ...(details !== undefined ? { details } : {}) } };
          process.stdout.write(`${JSON.stringify(payload, null, 2)}
`, () => fail(EXIT_FATAL, text));
          return;
        }
        fail(EXIT_FATAL, text);
      });
    } else if (command === "serve") {
      noteMissingEndpoint(config);
      startServer(config).catch((err: unknown) => {
        fail(EXIT_FATAL, `fatal: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      fail(EXIT_USAGE, `unknown command '${command}'.\n${USAGE}`);
    }
  }
}
