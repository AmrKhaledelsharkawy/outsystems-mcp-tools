/**
 * Builds the `flows.json` artifact from persisted raw captures (F4; ADR-0012).
 *
 * This is the **only** path that produces flow data. A finalizing staged rebuild, an all-at-once
 * rebuild and the offline `reextract` command all come through here, reading `raw/` back from disk
 * rather than using whatever extraction happens to be in memory. That is what makes "`reextract`
 * reproduces a live rebuild" true by construction instead of by test: there is no second
 * implementation to drift from the first.
 *
 * Pure except for reading `raw/`: no token, no Service Studio, no clock of its own (`builtAt` is
 * passed in), so two builds over the same capture are byte-identical.
 */
import type { ElementKind } from "../extract/types.js";
import { isUnknownNodeType } from "./nodeKinds.js";
import { parseElementFlows } from "./parse.js";
import { RawCaptureError, readRawModule, type RawManifestEntry, type RawModuleCapture } from "../rebuild/raw.js";
import type { Binding, FlowAction, FlowParseError, ModuleFlows } from "./types.js";

/** Bumped when `FlowsArtifact`'s shape changes incompatibly; an older artifact is treated as stale. */
export const FLOWS_SCHEMA_VERSION = 1;

/** Manifest `kind` → the element kind the parser needs. Entity/Structure texts carry no flows. */
function elementKindFor(entry: RawManifestEntry): ElementKind | undefined {
  switch (entry.kind) {
    case "Screen":
    case "Block":
    case "ClientAction":
    case "ServerAction":
      return entry.kind;
    default:
      return undefined;
  }
}

export interface ModuleFlowsSummary {
  module: string;
  /** From the raw manifest, so the artifact says how old the data behind it is (cf. `stageAge`). */
  capturedAt: string;
  flowActionCount: number;
  flowNodeCount: number;
  bindingCount: number;
  unknownNodeCount: number;
  parseErrorCount: number;
}

export interface FlowsArtifact {
  schemaVersion: number;
  scope: string;
  /** ISO-8601, supplied by the caller. */
  builtAt: string;
  /**
   * The `meta.json` `rebuiltAt` of the snapshot this was built beside, or null when none existed.
   * The staleness check compares this for **equality** with the current `rebuiltAt`, not for order:
   * file mtimes do not survive copying a `.osgraph` directory between machines, and "equal to the
   * snapshot it was built with" is the property the query tools actually need.
   */
  graphRebuiltAt: string | null;
  flowActionCount: number;
  flowNodeCount: number;
  bindingCount: number;
  unknownNodeCount: number;
  parseErrorCount: number;
  /** Distinct `Unknown:*` node types across the scope, sorted. Empty is the DoD's target. */
  unknownNodeTypes: string[];
  perModule: ModuleFlowsSummary[];
  /** Modules whose raw capture was absent or unusable, with the reason. Never silently omitted. */
  missingCaptures: Array<{ module: string; code: string; message: string }>;
  modules: ModuleFlows[];
}

/** Parses every flow-bearing text of one captured module. */
export function buildModuleFlows(capture: RawModuleCapture): ModuleFlows {
  const module = capture.manifest.module;
  const actions: FlowAction[] = [];
  const bindings: Binding[] = [];
  const parseErrors: Array<FlowParseError & { element: string }> = [];
  const unknownNodeTypes = new Set<string>();

  for (const entry of capture.texts) {
    const kind = elementKindFor(entry);
    if (kind === undefined || entry.name === undefined) continue;
    const parsed = parseElementFlows(entry.text, {
      module,
      kind,
      name: entry.name,
      ...(entry.uiFlow !== undefined ? { uiFlow: entry.uiFlow } : {})
    });
    actions.push(...parsed.actions);
    bindings.push(...parsed.bindings);
    for (const t of parsed.unknownNodeTypes) unknownNodeTypes.add(t);
    for (const e of parsed.parseErrors) parseErrors.push({ ...e, element: parsed.element.id });
  }

  const flowNodeCount = actions.reduce((n, a) => n + a.nodes.length, 0);
  const unknownNodeCount = actions.reduce(
    (n, a) => n + a.nodes.filter((node) => isUnknownNodeType(node.type)).length,
    0
  );
  return {
    module,
    actions,
    bindings,
    flowActionCount: actions.length,
    flowNodeCount,
    unknownNodeCount,
    unknownNodeTypes: [...unknownNodeTypes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    parseErrors
  };
}

export interface BuildScopeFlowsOptions {
  graphDir: string;
  scope: string;
  /**
   * Modules in the order they should appear, which must be the **scope's** order so a finalize and
   * a `reextract` produce byte-identical artifacts.
   */
  modules: string[];
  builtAt: string;
  graphRebuiltAt: string | null;
  /** Injectable for tests; defaults to reading `raw/` from disk. */
  readCapture?: (graphDir: string, scope: string, module: string) => RawModuleCapture;
}

/**
 * Builds the whole-scope artifact. A module with no usable raw capture is recorded in
 * `missingCaptures` and contributes nothing — the artifact must never look complete when it is not,
 * and `getFlow` on such a module then reports a gap rather than "this element has no flows".
 */
export function buildScopeFlows(options: BuildScopeFlowsOptions): FlowsArtifact {
  const read = options.readCapture ?? readRawModule;
  const modules: ModuleFlows[] = [];
  const perModule: ModuleFlowsSummary[] = [];
  const missingCaptures: FlowsArtifact["missingCaptures"] = [];
  const unknownNodeTypes = new Set<string>();

  const seen = new Set<string>();
  for (const name of options.modules) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let capture: RawModuleCapture;
    try {
      capture = read(options.graphDir, options.scope, name);
    } catch (err) {
      missingCaptures.push({
        module: name,
        code: err instanceof RawCaptureError ? err.code : "RAW_READ_FAILED",
        message: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    const flows = buildModuleFlows(capture);
    modules.push(flows);
    for (const t of flows.unknownNodeTypes) unknownNodeTypes.add(t);
    perModule.push({
      module: flows.module,
      capturedAt: capture.manifest.capturedAt,
      flowActionCount: flows.flowActionCount,
      flowNodeCount: flows.flowNodeCount,
      bindingCount: flows.bindings.length,
      unknownNodeCount: flows.unknownNodeCount,
      parseErrorCount: flows.parseErrors.length
    });
  }

  const sum = (pick: (m: ModuleFlows) => number): number => modules.reduce((n, m) => n + pick(m), 0);
  return {
    schemaVersion: FLOWS_SCHEMA_VERSION,
    scope: options.scope,
    builtAt: options.builtAt,
    graphRebuiltAt: options.graphRebuiltAt,
    flowActionCount: sum((m) => m.flowActionCount),
    flowNodeCount: sum((m) => m.flowNodeCount),
    bindingCount: sum((m) => m.bindings.length),
    unknownNodeCount: sum((m) => m.unknownNodeCount),
    parseErrorCount: sum((m) => m.parseErrors.length),
    unknownNodeTypes: [...unknownNodeTypes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    perModule,
    missingCaptures,
    modules
  };
}
