/**
 * `flows.json` persistence and the staleness rule (F4; ADR-0012).
 *
 * Written with the same `canonicalJson` + atomic replace as `graph.json`, so two builds from the
 * same capture are byte-identical and a crash never leaves a half-written artifact for the query
 * tools to read.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, readMeta, writeFileAtomic } from "../graph/io.js";
import { OsgraphToolError } from "../servicestudio/types.js";
import { FLOWS_SCHEMA_VERSION, type FlowsArtifact } from "./build.js";

export const FLOWS_FILE = "flows.json";

/** `<dir of graph.json>/flows.json` — one artifact per scope, beside the snapshot (ADR-0005). */
export function flowsPath(graphPath: string): string {
  return join(dirname(graphPath), FLOWS_FILE);
}

export function writeFlows(graphPath: string, artifact: FlowsArtifact): string {
  const path = flowsPath(graphPath);
  writeFileAtomic(path, canonicalJson(artifact));
  return path;
}

export type FlowsState =
  | { state: "ok"; artifact: FlowsArtifact; path: string }
  | { state: "missing"; path: string }
  | { state: "unreadable"; path: string; reason: string }
  | { state: "schema"; path: string; found: unknown }
  | { state: "stale"; path: string; builtFor: string | null; snapshot: string | null };

/**
 * Reads `flows.json` and classifies it against the snapshot beside it.
 *
 * Staleness is **equality** of `graphRebuiltAt` with the snapshot's current `rebuiltAt`, not an
 * ordering of timestamps or mtimes: the two artifacts are written seconds apart by one run, mtimes
 * do not survive copying a `.osgraph` directory between machines, and what a query tool needs to
 * know is "were these flows built from the same read as this graph?".
 */
export function readFlowsState(graphPath: string): FlowsState {
  const path = flowsPath(graphPath);
  if (!existsSync(path)) return { state: "missing", path };
  let artifact: FlowsArtifact;
  try {
    artifact = JSON.parse(readFileSync(path, "utf8")) as FlowsArtifact;
  } catch (err) {
    return { state: "unreadable", path, reason: err instanceof Error ? err.message : String(err) };
  }
  if (typeof artifact !== "object" || artifact === null || !Array.isArray(artifact.modules)) {
    return { state: "unreadable", path, reason: "not a flows artifact" };
  }
  if (artifact.schemaVersion !== FLOWS_SCHEMA_VERSION) {
    return { state: "schema", path, found: artifact.schemaVersion };
  }
  const snapshotRebuiltAt = readMeta(graphPath)?.rebuiltAt ?? null;
  if (artifact.graphRebuiltAt !== snapshotRebuiltAt) {
    return { state: "stale", path, builtFor: artifact.graphRebuiltAt, snapshot: snapshotRebuiltAt };
  }
  return { state: "ok", artifact, path };
}

/**
 * The artifact, or `FLOWS_NOT_BUILT` with an instruction that matches the actual cause. Deliberately
 * not `SNAPSHOT_MISSING`: the fix for a stale or missing `flows.json` is `osgraph reextract`, which
 * runs offline in seconds, where a missing snapshot needs Service Studio and hours.
 */
export function requireFlows(graphPath: string, scope: string): FlowsArtifact {
  const state = readFlowsState(graphPath);
  if (state.state === "ok") return state.artifact;
  const rerun = `Run \`osgraph reextract --scope ${scope}\` (offline, reads <graphDir>/${scope}/raw/), or rebuild the scope.`;
  const messages: Record<Exclude<FlowsState["state"], "ok">, string> = {
    missing: `scope '${scope}': no flow data has been built (${state.path} does not exist). ${rerun}`,
    unreadable: `scope '${scope}': ${state.path} could not be read${
      state.state === "unreadable" ? `: ${state.reason}` : ""
    }. ${rerun}`,
    schema: `scope '${scope}': ${state.path} is schema ${
      state.state === "schema" ? String(state.found) : "?"
    }, this build reads ${FLOWS_SCHEMA_VERSION}. ${rerun}`,
    stale: `scope '${scope}': the flow data was built for a different rebuild of this scope${
      state.state === "stale" ? ` (flows: ${String(state.builtFor)}, graph: ${String(state.snapshot)})` : ""
    }, so it may disagree with graph.json. ${rerun}`
  };
  throw new OsgraphToolError("FLOWS_NOT_BUILT", messages[state.state], {
    scope,
    path: state.path,
    state: state.state
  });
}
