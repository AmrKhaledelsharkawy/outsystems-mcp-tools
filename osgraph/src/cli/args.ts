/**
 * CLI usage text and argument parsing, split out of `cli.ts` so it can be imported without running
 * the entry point. `cli.ts` loads configuration and may `process.exit` at module scope — importing
 * it from a test kills the test runner, which is how this split got made.
 */
export const USAGE = `osgraph — MCP server and offline tools

  osgraph                                 start the MCP server on stdio (default)
  osgraph reextract --scope <name>        rebuild graph.json + flows.json from <graphDir>/<scope>/raw/
                                          with NO Service Studio and no session token
  osgraph --help

reextract options:
  --scope <name>     required; the scope to re-extract
  --graph-dir <dir>  override OSGRAPH_GRAPH_DIR
  --json             print the full result as JSON instead of a summary
  --quiet            no per-module progress on stderr
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
