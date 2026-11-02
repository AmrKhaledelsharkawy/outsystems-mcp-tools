import { z } from "zod";
import { listViolations as evaluate, type LayerViolation } from "../layers/violations.js";
import { loadSnapshot, parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool } from "./tool.js";

const strictSchema = z.object({
  scope: z.string().min(1).describe("Scope whose snapshot to check against layer-rules.json.")
});

/** F2: the SDK gets the permissive shape; `strictSchema` runs inside the handler. */
const inputSchema = permissiveShape(strictSchema);

export interface ListViolationsResult {
  violations: LayerViolation[];
  unknownModules: string[];
  count: number;
  snapshotPath: string;
}

export const listViolations: OsgraphTool<typeof inputSchema> = {
  name: "listViolations",
  description:
    "Lists every cross-module edge in the scope's snapshot whose source/target layers break a " +
    "layer rule (layer-rules.json), plus modules whose layer suffix is UNKNOWN (exempt, never scored). " +
    "In-process read of graph.json; no graphify call. Errors: INPUT_INVALID, SCOPE_NOT_FOUND, SNAPSHOT_MISSING.",
  inputSchema,
  handler: (args, ctx) => {
    const scope = scopeArg(args.scope);
    return runTool<ListViolationsResult>(ctx, scope, async () => {
      const input = parseInput(strictSchema, args, "listViolations");
      const { snapshot, path } = loadSnapshot(ctx, input.scope);
      const report = evaluate(snapshot, ctx.loadRules());
      return {
        result: {
          violations: report.violations,
          unknownModules: report.unknownModules,
          count: report.violations.length,
          snapshotPath: path
        }
      };
    });
  }
};
