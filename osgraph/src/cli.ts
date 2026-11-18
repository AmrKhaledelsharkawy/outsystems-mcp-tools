#!/usr/bin/env node
import { loadConfig, OsgraphConfigError, requireServiceStudioUrl, type OsgraphConfig } from "./config.js";
import { resolveScopeSnapshotPath } from "./graph/io.js";
import { loadLayerRules } from "./layers/rules.js";
import { reextractScope } from "./reextract.js";
import { readScope } from "./scopes/index.js";
import { parseArgs, requiresServiceStudioAtStart, USAGE } from "./cli/args.js";
import { startServer } from "./server.js";
import { closeSite, ensureSite } from "./progress/site.js";
import { describeLoadFailure, loadOsopenerAdapter } from "./osopener/adapter.js";
import { createServiceStudioClient } from "./servicestudio/token.js";
import { createSharedSessionFactory } from "./tools/tool.js";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_OPEN, formatAge, refreshModule, runScope } from "./run/run.js";

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

/** A non-negative integer flag, or `fallback` when absent; `null` when present but not a number. */
function intFlag(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  // Plain decimal digits only: `Number("")`/`Number(" ")` is 0 (which would silently disable the
  // circuit breaker), and `0x10` / `1e2` are not what anyone means on a command line.
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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
  const maxOpen = intFlag(options["max-open"], DEFAULT_MAX_OPEN);
  const maxFailures = intFlag(options["max-consecutive-failures"], DEFAULT_MAX_CONSECUTIVE_FAILURES);
  if (maxOpen === null || maxOpen < 1 || maxFailures === null) {
    fail(EXIT_USAGE, `--max-open must be an integer >= 1 and --max-consecutive-failures an integer >= 0.\n${USAGE}`);
    return;
  }
  const graphDir = options["graph-dir"] ?? config.graphDir;
  const scope = readScope(config.scopesDir, scopeName);
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

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
    fetchReferencedElements: process.env.OSGRAPH_FETCH_REFERENCED_ELEMENTS === "1"
  };

  let exitCode = 0;
  let payload: unknown;
  const lines: string[] = [];
  if (options.module !== undefined) {
    const result = await refreshModule({ ...common, module: options.module });
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
    const result = await runScope({ ...common, maxOpen, maxConsecutiveFailures: maxFailures });
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
    if (!result.finalized) exitCode = 1;
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
