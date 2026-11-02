import { z } from "zod";
import { parseInput, permissiveShape, runTool, scopeArg, type OsgraphTool } from "./tool.js";

const strictSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Scope name (letters, digits, '_', '.', '-'); written to <scopesDir>/<name>.json."),
  modules: z
    .array(z.string().min(1))
    .min(1)
    .describe("Module names the scope covers, chosen by the user (order kept, duplicates dropped).")
});

/** F2: the SDK gets the permissive shape; `strictSchema` runs inside the handler. */
const inputSchema = permissiveShape(strictSchema);

export interface DefineScopeResult {
  name: string;
  modules: string[];
  path: string;
}

export const defineScope: OsgraphTool<typeof inputSchema> = {
  name: "defineScope",
  description:
    "Writes a scope file { name, modules } under the scopes directory (ADR-0005). osgraph never adds " +
    "or drops modules from a scope by itself. Overwrites an existing scope of the same name. " +
    "Errors: INPUT_INVALID, SCOPE_INVALID.",
  inputSchema,
  handler: (args, ctx) => {
    const scopeName = scopeArg(args.name);
    return runTool<DefineScopeResult>(ctx, scopeName, async () => {
      const input = parseInput(strictSchema, args, "defineScope");
      const entry = ctx.scopeStore.define({ name: input.name, modules: input.modules });
      return { result: { name: entry.name, modules: entry.modules, path: entry.path } };
    });
  }
};
