import { z } from "zod";
import { existsSync } from "node:fs";
import { OSGRAPH_ID_PREFIX, type PathStep } from "../graphify/path.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { DEFAULT_SUGGESTION_LIMIT, didYouMean, suggestNames } from "../suggest.js";
import { loadSnapshot, parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool, type ToolContext } from "./tool.js";

/** Default / ceiling for `queryPath`'s `limit` (#70): path steps returned. */
export const DEFAULT_PATH_LIMIT = 200;
export const MAX_PATH_LIMIT = 5000;

/**
 * S6 audit F6: `from`/`to` reach graphify as bare positionals, so a value starting with `-` is read
 * as an option. `--` is not a usable separator (graphify 0.9.91 reads it as a node id), so the
 * schema requires the `osgraph://` scheme every node id osgraph writes already has (ADR-0006/0008).
 */
const nodeId = (what: string) =>
  z
    .string()
    .min(1)
    .startsWith(OSGRAPH_ID_PREFIX, `must be an osgraph node id starting with '${OSGRAPH_ID_PREFIX}'`)
    .describe(what);

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope whose snapshot to query."),
  from: nodeId("Source node id (osgraph://<Module>/<Kind>/[<UIFlow>/]<Name>)."),
  to: nodeId("Target node id (osgraph://<Module>/<Kind>/[<UIFlow>/]<Name>)."),
  undirected: z.boolean().optional().describe("Ignore edge direction when searching."),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_PATH_LIMIT)
    .optional()
    .describe(
      `Maximum path steps to return; default ${DEFAULT_PATH_LIMIT}. \`total\` reports the true number of steps and \`truncated\` whether any were dropped (then \`raw\` is returned empty).`
    )
});

/** F2: the SDK gets the permissive shape; `strictSchema` runs inside the handler. */
const inputSchema = permissiveShape(strictSchema);

/**
 * ADR-0010: both arms always carry the version the resolved graphify binary reported (`null` when
 * the probe failed or was unparseable — never fatal), plus `graphifyVersionWarning` only when that
 * version is not the pinned `GRAPHIFY_VERSION`. The fields live here and not on `ToolResponse` /
 * `graphCompleteness`: `queryPath` is the only tool that spawns (OSG-007), so the others must not
 * grow a field they can never populate.
 */
export type QueryPathResult =
  | {
      found: true;
      hops: number;
      /** At most `limit` steps, from the start. */
      path: PathStep[];
      /** Steps before `limit` (hops + 1). */
      total: number;
      limit: number;
      truncated: boolean;
      from: string;
      to: string;
      undirected: boolean;
      raw: string;
      graphifyVersion: string | null;
      graphifyVersionWarning?: string;
    }
  | {
      found: false;
      total: 0;
      limit: number;
      truncated: false;
      from: string;
      to: string;
      undirected: boolean;
      raw: string;
      graphifyVersion: string | null;
      graphifyVersionWarning?: string;
    };

/**
 * graphify reports a missing node as UNKNOWN_NODE without saying what is nearby. The snapshot is a
 * local file, so the near-misses are read from it here (offline); any failure to do so leaves the
 * original error untouched.
 */
function withPathSuggestions(err: unknown, ctx: ToolContext, scope: string, from: string, to: string): unknown {
  if (!(err instanceof OsgraphToolError) || err.code !== "UNKNOWN_NODE") return err;
  try {
    const ids = new Set(loadSnapshot(ctx, scope).snapshot.nodes.map((n) => n.id));
    const missing = [from, to].filter((id) => !ids.has(id));
    if (missing.length === 0) return err;
    const suggestions: Record<string, string[]> = {};
    for (const id of missing) suggestions[id] = suggestNames(id, ids, DEFAULT_SUGGESTION_LIMIT);
    const tail = missing.map((id) => (suggestions[id].length > 0 ? ` For '${id}':${didYouMean(suggestions[id])}` : "")).join("");
    const details = typeof err.details === "object" && err.details !== null ? (err.details as Record<string, unknown>) : {};
    return new OsgraphToolError("UNKNOWN_NODE", `${err.message}${tail}`, { ...details, suggestions });
  } catch {
    return err;
  }
}

export const queryPath: OsgraphTool<typeof inputSchema> = {
  name: "queryPath",
  description:
    "Shortest path between two nodes of a scope's snapshot. The only tool that shells out: runs the " +
    "pinned `graphify path <from> <to> [--undirected] --graph <snapshot>` (plus a once-per-process " +
    "read-only `graphify --version` probe; never install/hook, ADR-0003/ADR-0010) and parses its text " +
    "output. Returns found=false when no path exists. Returns at most `limit` steps (default 200) with `total` and `truncated`. `from`/`to` must be osgraph:// node ids. Every " +
    "result reports graphifyVersion, with graphifyVersionWarning when it is not the pinned version. " +
    "Errors: INPUT_INVALID, SCOPE_NOT_FOUND, SNAPSHOT_MISSING, UNKNOWN_NODE, GRAPHIFY_NOT_FOUND, GRAPHIFY_FAILED.",
  inputSchema,
  handler: (args, ctx) => {
    const scope = scopeArg(args.scope);
    return runTool<QueryPathResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "queryPath");
      const snapshotPath = ctx.snapshotPath(input.scope);
      if (!existsSync(snapshotPath)) {
        if (!ctx.scopeStore.exists(input.scope)) ctx.scopeStore.read(input.scope); // throws SCOPE_NOT_FOUND
        throw new OsgraphToolError(
          "SNAPSHOT_MISSING",
          `scope '${input.scope}' has no snapshot yet (expected ${snapshotPath}); run rebuild({ scope: "${input.scope}" }) first`,
          { scope: input.scope, path: snapshotPath }
        );
      }
      const { from, to } = input;
      const undirected = input.undirected === true;
      const limit = input.limit ?? DEFAULT_PATH_LIMIT;
      let out;
      try {
        out = await ctx.runGraphifyPath({
          graphifyBin: ctx.config.graphifyBin,
          from,
          to,
          undirected,
          snapshotPath,
          env: ctx.env,
          log: ctx.log
        });
      } catch (err) {
        throw withPathSuggestions(err, ctx, input.scope, from, to);
      }
      const version = { graphifyVersion: out.graphifyVersion ?? null };
      const warning = out.graphifyVersionWarning !== undefined ? { graphifyVersionWarning: out.graphifyVersionWarning } : {};
      const result: QueryPathResult = out.found
        ? {
            found: true,
            hops: out.hops,
            path: out.path.slice(0, limit),
            total: out.path.length,
            limit,
            truncated: out.path.length > limit,
            from,
            to,
            undirected,
            raw: out.path.length > limit ? "" : out.raw,
            ...version,
            ...warning
          }
        : { found: false, total: 0, limit, truncated: false, from, to, undirected, raw: out.raw, ...version, ...warning };
      return { result };
    });
  }
};
