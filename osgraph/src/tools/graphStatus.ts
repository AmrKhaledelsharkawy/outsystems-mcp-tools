import { z } from "zod";
import { computeGraphStatus, type GraphStatusResult } from "../status/graphStatus.js";
import { parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool } from "./tool.js";

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope name whose local snapshot and raw captures to report on.")
});
const inputSchema = permissiveShape(strictSchema);

export const graphStatus: OsgraphTool<typeof inputSchema> = {
  name: "graphStatus",
  description:
    "Read-only freshness report for a scope's LOCAL snapshot: what it was built from and how complete it is. " +
    "Reads only files on disk (meta.json and the raw capture manifests); makes no Service Studio or osopener call, " +
    "so it works with Studio shut. Result schema (stable; modules sorted by name): " +
    "{ scope, snapshot: { present, builtAt|null, stagedFrom|null, stagedTo|null }, " +
    "completeness: { scopeModuleCount, capturedModuleCount, missingModules: string[] (scope modules with no capture), " +
    'complete: boolean, totalSkipped, totalReferencedOnly }, ' +
    'modules: [{ module, capturedAt, moduleVersion ("unknown" for old-schema captures), moduleVersionReason|null, ' +
    "skippedCount, referencedOnlyCount }], captureProblems: [{ directory, reason }] }. " +
    "The scope must be defined (SCOPE_NOT_FOUND otherwise).",
  inputSchema,
  handler: (args, ctx) =>
    runTool<GraphStatusResult>(ctx, scopeArg(args.scope), async () => {
      const { scope } = parseInput(strictSchema, args, "graphStatus");
      const entry = ctx.scopeStore.read(scope); // throws SCOPE_NOT_FOUND
      return { result: computeGraphStatus(ctx.config.graphDir, entry.name, entry.modules) };
    })
};
