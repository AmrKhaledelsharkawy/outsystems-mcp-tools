import { z } from "zod";
import {
  formatProgress,
  rebuildScope,
  stageModule,
  type RebuildProgressEvent,
  type RebuildResult,
  type StageOutcome
} from "../rebuild/rebuild.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { completenessFor, parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool, type ToolContext } from "./tool.js";

/**
 * A staged `rebuild` answers with the stage state. The snapshot and meta stay on disk — only the
 * `RebuildResult` summary is inlined, and only on the call that finalized the scope.
 */
export type StageToolResult = Omit<StageOutcome, "outcome"> & { rebuild?: RebuildResult };

const strictSchema = z.object({
  scope: z
    .string()
    .min(1)
    .describe("Scope name (<scopesDir>/<scope>.json) whose snapshot to regenerate."),
  module: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Staged mode (ADR-0005): read ONLY this scope module and persist its extraction, instead of " +
        "reading every scope module in one call. Only this module has to be open in Service Studio, so a " +
        "caller can loop open -> rebuild({scope,module}) -> close and keep Studio small. graph.json is " +
        "written when the last missing module is staged (finalized: true in the result)."
    )
});

/** F2: the SDK gets the permissive shape; `strictSchema` runs inside the handler. */
const inputSchema = permissiveShape(strictSchema);

/** `OSGRAPH_REBUILD_PROGRESS`: unset/`1` = module+phase lines on stderr; `verbose` = per element; `0`/`off` = silent. */
export const ENV_REBUILD_PROGRESS = "OSGRAPH_REBUILD_PROGRESS";
/**
 * `OSGRAPH_FETCH_REFERENCED_ELEMENTS`: escape hatch for S6 audit F3. Unset (default) = listing
 * entries reported `IsReferenced: true` are counted as `referencedOnlyCount` and never fetched;
 * `1`/`true`/`on`/`yes` = fetch them anyway, for a Studio build that reports the field differently.
 */
export const ENV_FETCH_REFERENCED_ELEMENTS = "OSGRAPH_FETCH_REFERENCED_ELEMENTS";

export function progressSink(ctx: ToolContext): ((event: RebuildProgressEvent) => void) | undefined {
  const setting = (ctx.env[ENV_REBUILD_PROGRESS] ?? "1").trim().toLowerCase();
  if (setting === "0" || setting === "off" || setting === "false" || setting === "none") return undefined;
  const verbose = setting === "verbose" || setting === "2";
  return (event) => {
    if (event.type === "element" && !verbose && event.outcome === "ok") return;
    ctx.log(formatProgress(event));
  };
}

export function fetchReferencedElements(ctx: ToolContext): boolean {
  const setting = (ctx.env[ENV_FETCH_REFERENCED_ELEMENTS] ?? "").trim().toLowerCase();
  return setting === "1" || setting === "true" || setting === "on" || setting === "yes";
}

export const rebuild: OsgraphTool<typeof inputSchema> = {
  name: "rebuild",
  description:
    "Full deterministic extraction run over one scope: reads every element of every scope module " +
    "through the servicestudio MCP (read-only, up to fetchConcurrency reads at once), parses edges, and regenerates " +
    "<graphDir>/<scope>/graph.json atomically (all-or-nothing; the previous snapshot survives any failure). " +
    "Caller-triggered (on module-open and after a publish's merge completes). Fails with MODULES_NOT_OPEN " +
    "when a scope module is not open in Service Studio; TOKEN_EXPIRED / SERVICESTUDIO_UNREACHABLE abort. " +
    "Element-level read failures are retried once, then skipped and reported (skippedElements, " +
    "graphCompleteness.skippedCount); a kind-level read failure (a names listing or getDataModel/getStructures, " +
    "each the sole source of truth for a whole element kind) aborts with KIND_READ_FAILED and writes nothing. " +
    "Listing entries reported IsReferenced:true belong to another module and are NOT fetched — they are " +
    "reported as referencedOnlyCount (complete data, never a skip); set OSGRAPH_FETCH_REFERENCED_ELEMENTS=1 " +
    "to fetch them anyway. Rebuilds are serialized process-wide: a second concurrent call returns " +
    "REBUILD_IN_PROGRESS immediately rather than queueing — one pool of reads is the whole process's budget, " +
    "so two concurrent rebuilds would split it, not double it. NO internal timeout. Cost is (6 kind-level calls " +
    "per module, run as 2 waves + elements actually fetched, 4 at a time) x the per-call latency of THAT module. " +
    "Measured 2026-10-30 across three real modules: 4.9 s, 10.8 s and 18.5 s per call, giving 4.3, 7.1 and " +
    "21.9 minutes per module SERIALIZED; at the default width 4 budget ABOUT 3 MINUTES PER MODULE (measured " +
    "3.35x client-side, OSG-016/ADR-0013). Payload size does not predict latency (258 kB in 5.1 s vs 164 bytes " +
    "in 20.2 s), and every module costs its 6 kind-level calls even when it has no elements. " +
    "OSGRAPH_MAX_CONCURRENCY (1-8, default 4) sets the width; 1 restores the old fully serial behaviour. The " +
    "width used is reported as fetchConcurrency beside durationMs, and per-module phase durations are " +
    "OVERLAPPING SPANS that do not sum to durationMs above width 1. Progress goes to stderr " +
    "(OSGRAPH_REBUILD_PROGRESS). Set your MCP client's tool-call timeout accordingly, generously.",
  inputSchema,
  handler: (args, ctx) => {
    const scope = scopeArg(args.scope);
    return runTool<RebuildResult | StageToolResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "rebuild");
      // ADR-0007/F1: one rebuild at a time per process, and the loser is answered now, not in an hour.
      if (!ctx.rebuildGate.tryAcquire()) {
        throw new OsgraphToolError(
          "REBUILD_IN_PROGRESS",
          "another rebuild is already running in this osgraph process; the servicestudio read pool is " +
            "process-wide (ADR-0013: 4 reads at once, shared) and a scope rebuild can run for a long time " +
            "(measured: about 3 minutes per module at width 4). A second rebuild would split that budget, not add " +
            "to it. Wait for it to finish, then rebuild again, or use staged mode to read one module at a time.",
          { scope: input.scope }
        );
      }
      try {
        const definition = ctx.scopeStore.read(input.scope);
        if (input.module !== undefined) {
          const staged = await stageModule({
            scope: definition,
            module: input.module,
            graphDir: ctx.config.graphDir,
            snapshotPath: ctx.snapshotPath(input.scope),
            session: ctx.createSession(),
            rules: ctx.loadRules(),
            now: ctx.now,
            onProgress: progressSink(ctx),
            fetchReferencedElements: fetchReferencedElements(ctx),
            fetchConcurrency: ctx.config.fetchConcurrency
          });
          // The snapshot and meta stay on disk: a tool response must never carry the whole graph.
          const { outcome: finalized, ...rest } = staged;
          const result: StageToolResult = finalized ? { ...rest, rebuild: finalized.result } : rest;
          return {
            result,
            graphCompleteness: finalized?.graphCompleteness ?? completenessFor(ctx, input.scope)
          };
        }
        const outcome = await rebuildScope({
          scope: definition,
          snapshotPath: ctx.snapshotPath(input.scope),
          session: ctx.createSession(),
          rules: ctx.loadRules(),
          now: ctx.now,
          onProgress: progressSink(ctx),
          fetchReferencedElements: fetchReferencedElements(ctx),
          // OSG-016 §C1: the same width the client's gate is set to, from one config field.
          fetchConcurrency: ctx.config.fetchConcurrency,
          // F0: capture every element text under `<graphDir>/<scope>/raw/`, so flow extraction can be
          // re-run offline (`reextract`) instead of re-reading the scope live.
          rawGraphDir: ctx.config.graphDir
        });
        return { result: outcome.result, graphCompleteness: outcome.graphCompleteness };
      } finally {
        ctx.rebuildGate.release();
      }
    });
  }
};
