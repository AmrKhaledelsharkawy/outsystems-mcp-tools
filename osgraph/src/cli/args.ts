/**
 * CLI usage text and argument parsing, split out of `cli.ts` so it can be imported without running
 * the entry point. `cli.ts` loads configuration and may `process.exit` at module scope — importing
 * it from a test kills the test runner, which is how this split got made.
 */
export const USAGE = `osgraph — MCP server and offline tools

  osgraph                                 start the MCP server on stdio (default)
  osgraph reextract --scope <name>        rebuild graph.json + flows.json from <graphDir>/<scope>/raw/
                                          with NO Service Studio and no session token
  osgraph status --scope <name>           report how fresh and complete the local snapshot is
                                          (offline, read-only; no Service Studio, no token)
  osgraph audit --scope <name>            sample edges and absent pairs, check them against the raw texts,
                                          report precision and recall (offline; see LIVE-AUDIT.md)
  osgraph run --scope <name>              build a scope module by module: open -> stage -> drain -> close
                                          (needs Service Studio, osopener and the session token)
  osgraph run --scope <name> --module <m> re-read ONE module, then re-extract the scope offline from raw/
  osgraph run --scope <name> --modules a,b,c   re-read only the named scope modules, then re-extract offline
  osgraph run --scope <name> --changed    open each scope module, re-read only those whose listed version
                                          differs from the capture (unknown/no capture = read), then re-extract
  osgraph doctor [--scope <name>]         read-only local checks: token, Studio endpoint, osopener,
                                          scope module names, graph directory (exit 1 if any check fails)
  osgraph --help

reextract options:
  --scope <name>     required; the scope to re-extract
  --graph-dir <dir>  override OSGRAPH_GRAPH_DIR
  --json             print the full result as JSON instead of a summary
  --quiet            no per-module progress on stderr
  --serve            keep a live progress / graph-explorer site running afterwards

doctor options (read-only: calls only listApps, never creates a session token, writes nothing,
opens or closes no module):
  --scope <name>     check this scope's module names (case-exactly) and its snapshot age
  --graph-dir <dir>  override OSGRAPH_GRAPH_DIR
  --json             print the report as JSON on stdout

status options:
  --scope <name>     required; the scope to report on
  --graph-dir <dir>  override OSGRAPH_GRAPH_DIR
  --json             print the stable JSON result (same shape as the graphStatus MCP tool)

audit options:
  --scope <name>     required; the scope whose snapshot and raw/ captures are audited
  --k <n>            edges and absent pairs drawn per layer/kind (default 20)
  --seed <text>      sampling seed; the same snapshot, k and seed draw the same pairs (default 1)
  --graph-dir <dir>  override OSGRAPH_GRAPH_DIR
  --json             print the full report as JSON instead of Markdown

run options (osgraph is not standalone: run opens and closes modules through osopener, and every
read needs the human-approved session token the token manager keeps in token.txt):
  --scope <name>                    required; the scope to build
  --module <name>                   refresh only this module; every other scope module must already
                                    have a raw/ capture (else RUN_CAPTURES_MISSING)
  --modules <a,b,c>                 re-read only these scope modules (case-exact names); the others must already
                                    have a raw/ capture (else RUN_CAPTURES_MISSING)
  --changed                         re-read only modules whose Studio-listed version differs from the capture's
                                    moduleVersion; unknown version or no capture is always read. Combine with
                                    --modules to limit the candidates. Needs the live version probe (README).
  --max-open <n>                    tabs open before the run closes its own staged ones (default 12)
  --max-consecutive-failures <n>    stop after n modules in a row fail to open (default 3, 0 = never)
  --graph-dir <dir>                 override OSGRAPH_GRAPH_DIR
  --json                            print the result as JSON on stdout (log lines stay on stderr)
  --serve                           keep the progress site running after the run (until Ctrl+C)
  A full run is resumable: modules already staged are skipped, so re-run the same command to continue.
`;

/** `--flag value` and `--flag=value`, with bare flags mapping to `"true"`. */
export function parseArgs(argv: string[]): { command: string; options: Record<string, string> } {
  const options: Record<string, string> = {};
  let command = "serve";
  let i = 0;
  if (argv[0] !== undefined && !argv[0].startsWith("-")) {
    command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      options[name] = next;
      i++;
    } else {
      options[name] = "true";
    }
  }
  return { command, options };
}

/**
 * #7: command-scoped configuration. `true` = the command does nothing but drive Service Studio, so a
 * missing / invalid `OSGRAPH_SERVICESTUDIO_URL` fails it at start with the config exit code (2).
 * `false` = the command starts without an endpoint: `reextract` and `audit` only read local captures, and
 * `serve` hosts the offline query tools alongside `rebuild`, which checks the endpoint itself when it
 * is dispatched; `run` (#48) does nothing but drive Studio, so it needs the endpoint at start. A new live-only CLI command must be listed here as `true`.
 */
export const REQUIRES_SERVICESTUDIO_AT_START: Readonly<Record<string, boolean>> = {
  serve: false,
  reextract: false,
  doctor: false,
  status: false,
  audit: false,
  run: true
};

/**
 * Whether `command` needs a valid Service Studio endpoint before it starts. Unknown commands answer
 * `false` so they reach the usage error instead of a configuration error.
 */
export function requiresServiceStudioAtStart(
  command: string,
  table: Readonly<Record<string, boolean>> = REQUIRES_SERVICESTUDIO_AT_START
): boolean {
  return Object.prototype.hasOwnProperty.call(table, command) && table[command] === true;
}
