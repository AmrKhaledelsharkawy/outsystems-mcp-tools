/**
 * Shared types for every osgraph MCP tool (GLOSSARY terms: scope, snapshot, rebuild, violation).
 */

/** Error codes a tool response may carry. */
export type OsgraphErrorCode =
  | "NOT_IMPLEMENTED"
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "TOKEN_EXPIRED"
  | "MODULES_NOT_OPEN"
  | "SCOPE_NOT_FOUND"
  | "SNAPSHOT_MISSING"
  | "SERVICESTUDIO_UNREACHABLE"
  | "UNKNOWN_NODE"
  /** `defineScope` input rejected (bad name or module list), or a scope file on disk is malformed. */
  | "SCOPE_INVALID"
  /**
   * Tool arguments failed the handler's strict schema check (S6 audit F2, orchestrator decision
   * 2026-10-30). Protocol-level validation is inside OSG-011's "every response carries
   * graphCompleteness" rule, so the SDK is registered with permissive schemas and the strict
   * `safeParse` runs inside the handler; `message` names the offending field(s) and `details.issues`
   * carries the structured zod issues.
   */
  | "INPUT_INVALID"
  /**
   * ADR-0011: a kind-level read (names listing or module text — the sole source of truth for one
   * whole element kind in one module) failed after OSG-011's single retry. The rebuild aborts, no
   * snapshot is written and the previous one survives.
   */
  | "KIND_READ_FAILED"
  /**
   * ADR-0007/F1, ADR-0013: another `rebuild` is already running in this process. Rebuilds are
   * serialized process-wide — not against a race (concurrent reads are safe) but because the
   * servicestudio read pool of 4 is per process: a second rebuild would split that budget, not add
   * to it. A live rebuild still runs for a long time, so the second caller is answered immediately
   * rather than queued behind it.
   */
  | "REBUILD_IN_PROGRESS"
  /**
   * ADR-0012: `getFlow` / `searchFlows` were asked for flow data that is missing, unreadable, of
   * another schema version, or was built for a different rebuild of the scope than the snapshot
   * beside it. Distinct from `SNAPSHOT_MISSING` because the fix is different and far cheaper:
   * `osgraph reextract --scope <name>` rebuilds it offline from `<graphDir>/<scope>/raw/` in
   * seconds, where a missing snapshot needs Service Studio and hours.
   */
  | "FLOWS_NOT_BUILT"
  /** `queryPath`: the pinned graphify executable could not be found (ENOENT). */
  | "GRAPHIFY_NOT_FOUND"
  /** `queryPath`: graphify exited non-zero for a reason other than an unknown node. */
  | "GRAPHIFY_FAILED"
  /** Unexpected exception inside a tool handler (message passes through the client's redaction). */
  | "INTERNAL_ERROR";

export interface OsgraphError {
  code: OsgraphErrorCode;
  message: string;
  details?: unknown;
}

/**
 * OSG-011: carried by EVERY tool response so an incomplete snapshot is never silently invisible.
 * `skippedCount` = elements dropped by skip-and-continue in the last rebuild;
 * `lastRebuildAt` = ISO-8601 timestamp of that rebuild, or null when no snapshot exists.
 */
export interface GraphCompleteness {
  skippedCount: number;
  lastRebuildAt: string | null;
  /**
   * S6 audit F7: present (and always `true`) only when a snapshot exists for the addressed scope but
   * its completeness could NOT be determined — an unreadable `meta.json`, corrupt JSON, or a legacy
   * `graph.json` with no `graph.osgraph.skipped`. The two numbers above are then placeholders, not
   * measurements: the tool still answers from that snapshot, so the uncertainty must be visible
   * rather than reading as "complete, never rebuilt". Absent means the numbers were read.
   */
  completenessUnknown?: true;
}

/** Common envelope of every osgraph tool result. Exactly one of `result` / `error` is present. */
export interface ToolResponse<T = unknown> {
  result?: T;
  error?: OsgraphError;
  graphCompleteness: GraphCompleteness;
}

/** `graphCompleteness` value used before any snapshot exists for the addressed scope. */
export const NO_SNAPSHOT_COMPLETENESS: GraphCompleteness = {
  skippedCount: 0,
  lastRebuildAt: null
};

/**
 * `graphCompleteness` value for a scope whose snapshot exists but whose completeness is unreadable
 * (S6 audit F7). Same numbers as `NO_SNAPSHOT_COMPLETENESS`, plus the flag that says so.
 */
export const UNKNOWN_COMPLETENESS: GraphCompleteness = {
  skippedCount: 0,
  lastRebuildAt: null,
  completenessUnknown: true
};
