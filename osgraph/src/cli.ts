#!/usr/bin/env node
import { join } from "node:path";
import { loadConfig, OsgraphConfigError, type OsgraphConfig } from "./config.js";
import { loadLayerRules } from "./layers/rules.js";
import { reextractScope } from "./reextract.js";
import { readScope } from "./scopes/index.js";
import { parseArgs, USAGE } from "./cli/args.js";
import { startServer } from "./server.js";
import { ensureSite } from "./progress/site.js";

const EXIT_CONFIG = 2;
const EXIT_FATAL = 1;
const EXIT_USAGE = 64;

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
    snapshotPath: join(graphDir, scope.name, "graph.json"),
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

const { command, options } = parseArgs(process.argv.slice(2));

if (options.help === "true" || command === "help") {
  process.stdout.write(USAGE);
} else {
  let config: OsgraphConfig | undefined;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    fail(EXIT_CONFIG, err instanceof OsgraphConfigError ? `${err.code}: ${err.message}` : String(err));
  }

  if (config !== undefined) {
    if (command === "reextract") {
      runReextract(config, options).catch((err: unknown) => {
        fail(EXIT_FATAL, err instanceof Error ? err.message : String(err));
      });
    } else if (command === "serve") {
      startServer(config).catch((err: unknown) => {
        fail(EXIT_FATAL, `fatal: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      fail(EXIT_USAGE, `unknown command '${command}'.\n${USAGE}`);
    }
  }
}
