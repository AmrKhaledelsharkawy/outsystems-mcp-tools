import type { ListOpenModulesResult } from "../types.js";
import { listModuleTabs } from "./closeModule.js";
import { toOsopenerError, type OsopenerTool } from "./tool.js";

export const listOpenModules: OsopenerTool = {
  name: "listOpenModules",
  description:
    "Names of the modules currently open in Service Studio, from servicestudio `listApps` (the source of truth), " +
    "plus one `tabs` row per module tab giving its application name and which Studio window holds it (read from the " +
    "UI; omitted if the UI cannot be read, which is never an error here). Use it to decide which modules a close loop " +
    "may let go of. Needs the hook-saved token file; an invalid or missing token returns TOKEN_EXPIRED.",
  inputSchema: {},
  async handler(_args, ctx): Promise<ListOpenModulesResult> {
    let modules: string[];
    try {
      modules = await ctx.client.listOpenModules();
    } catch (err) {
      return { modules: [], error: toOsopenerError(err) };
    }
    try {
      // Best effort: the UI read is extra context, never the source of truth, so its failure must
      // not turn a good listApps answer into an error.
      return { modules, tabs: await listModuleTabs(ctx) };
    } catch {
      return { modules };
    }
  }
};
