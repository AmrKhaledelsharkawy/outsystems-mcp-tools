import { z } from "zod";
import { existsSync } from "node:fs";
import { OSGRAPH_ID_PREFIX, type PathStep } from "../graphify/path.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool } from "./tool.js";

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
  undirected: z.boolean().optional().describe("Ignore edge direction when searching.")
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
      path: PathStep[];
      from: string;
      to: string;
      undirected: boolean;
      raw: string;
      graphifyVersion: string | null;
      graphifyVersionWarning?: string;
    }
  | {
      found: false;
      from: string;
      to: string;
      undirected: boolean;
      raw: string;
      graphifyVersion: string | null;
      graphifyVersionWarning?: string;
    };

export const queryPath: OsgraphTool<typeof inputSchema> = {
  name: "queryPath",
  description:
    "Shortest path between two nodes of a scope's snapshot. The only tool that shells out: runs the " +
    "pinned `graphify path <from> <to> [--undirected] --graph <snapshot>` (plus a once-per-process " +
    "read-only `graphify --version` probe; never install/hook, ADR-0003/ADR-0010) and parses its text " +
    "output. Returns found=false when no path exists. `from`/`to` must be osgraph:// node ids. Every " +
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
      const out = await ctx.runGraphifyPath({
        graphifyBin: ctx.config.graphifyBin,
        from,
        to,
        undirected,
        snapshotPath,
        env: ctx.env,
        log: ctx.log
      });
      const version = { graphifyVersion: out.graphifyVersion ?? null };
      const warning = out.graphifyVersionWarning !== undefined ? { graphifyVersionWarning: out.graphifyVersionWarning } : {};
      const result: QueryPathResult = out.found
        ? { found: true, hops: out.hops, path: out.path, from, to, undirected, raw: out.raw, ...version, ...warning }
        : { found: false, from, to, undirected, raw: out.raw, ...version, ...warning };
      return { result };
    });
  }
};
