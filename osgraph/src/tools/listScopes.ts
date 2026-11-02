import { z } from "zod";
import { parseInput, permissiveShape, runTool, type OsgraphTool } from "./tool.js";

/**
 * F2: `listScopes` takes no arguments, so there is nothing the SDK could reject before the handler
 * runs — but the same permissive-register / strict-parse shape is kept for all six tools so no
 * future field can be added here that reintroduces the hole. Extra keys are stripped, never rejected.
 */
const strictSchema = z.object({});
const inputSchema = permissiveShape(strictSchema);

export interface ListScopesResult {
  scopes: Array<{ name: string; modules: string[]; path: string }>;
  scopesDir: string;
  count: number;
}

export const listScopes: OsgraphTool<typeof inputSchema> = {
  name: "listScopes",
  description:
    "Returns the scopes defined under the scopes directory, sorted by name (empty when the directory " +
    "does not exist). graphCompleteness is the no-snapshot value because no single scope is addressed.",
  inputSchema,
  handler: (args, ctx) =>
    runTool<ListScopesResult>(ctx, undefined, async () => {
      parseInput(strictSchema, args, "listScopes");
      const scopes = ctx.scopeStore.list().map((s) => ({ name: s.name, modules: s.modules, path: s.path }));
      return { result: { scopes, scopesDir: ctx.scopeStore.scopesDir, count: scopes.length } };
    })
};
