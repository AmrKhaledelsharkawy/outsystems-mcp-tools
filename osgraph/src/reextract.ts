/**
 * Offline re-extraction (F4; ADR-0012): rebuild `graph.json` and `flows.json` for one scope from
 * the persisted raw texts, with **no Service Studio, no session token and no network**.
 *
 * This is the payoff of F0. A live rebuild of the 38-module scope costs ≈3–5 hours (ADR-0011's
 * corrected figure); re-running the extractor and the flow parser over the texts it already fetched
 * costs seconds. Every change to `src/extract` or `src/flows` can therefore be validated against
 * the real portal's texts without touching the portal.
 *
 * The contract it is tested against: for the same capture, the `snapshot` this writes is **byte-
 * identical** to the one a live rebuild wrote. Only `meta.json`'s clock fields may differ, which is
 * why `now` is injectable.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { extractModule, type ExtractedModule } from "./extract/index.js";
import { buildScopeFlows, writeFlows, type FlowsArtifact } from "./flows/index.js";
import { buildSnapshot, writeSnapshot } from "./graph/index.js";
import { assignLayer } from "./layers/assign.js";
import { listViolations } from "./layers/violations.js";
import type { LayerRules } from "./layers/rules.js";
import { readRawModule, RawCaptureError, type RawManifestEntry, type RawModuleCapture } from "./rebuild/raw.js";
import type { ScopeDefinition } from "./scopes/store.js";
import { OsgraphToolError } from "./servicestudio/types.js";
import type { FlowNamedText, NamedText } from "./extract/index.js";

export interface ReextractOptions {
  scope: ScopeDefinition;
  /** Where `raw/`, `graph.json` and `flows.json` live. */
  graphDir: string;
  snapshotPath: string;
  rules: LayerRules;
  now?: () => Date;
  /** Injectable for tests; defaults to reading `raw/` from disk. */
  readCapture?: (graphDir: string, scope: string, module: string) => RawModuleCapture;
  onProgress?: (line: string) => void;
}

export interface ReextractResult {
  scope: string;
  snapshotPath: string;
  flowsPath: string;
  modules: Array<{
    module: string;
    capturedAt: string;
    textCount: number;
    nodeCount: number;
    edgeCount: number;
    skippedCount: number;
    flowActionCount: number;
    flowNodeCount: number;
    unknownNodeCount: number;
    parseErrorCount: number;
  }>;
  nodeCount: number;
  edgeCount: number;
  violationCount: number;
  flowActionCount: number;
  flowNodeCount: number;
  unknownNodeCount: number;
  unknownNodeTypes: string[];
  parseErrorCount: number;
  /** Scope modules with no usable raw capture. Never silently skipped. */
  missingCaptures: FlowsArtifact["missingCaptures"];
  durationMs: number;
}

/** Rebuilds a `ModuleTexts` from one capture, so `extractModule` sees exactly what it saw live. */
function textsFrom(capture: RawModuleCapture): Parameters<typeof extractModule>[0]["texts"] {
  const screens: FlowNamedText[] = [];
  const blocks: FlowNamedText[] = [];
  const clientActions: NamedText[] = [];
  const serverActions: NamedText[] = [];
  let dataModel = "";
  let structures = "";
  const flow = (e: RawManifestEntry & { text: string }): FlowNamedText => ({
    name: e.name ?? "",
    uiFlow: e.uiFlow ?? "",
    text: e.text
  });
  for (const entry of capture.texts) {
    switch (entry.kind) {
      case "Entity":
        dataModel = entry.text;
        break;
      case "Structure":
        structures = entry.text;
        break;
      case "Screen":
        screens.push(flow(entry));
        break;
      case "Block":
        blocks.push(flow(entry));
        break;
      case "ClientAction":
        clientActions.push({ name: entry.name ?? "", text: entry.text });
        break;
      case "ServerAction":
        serverActions.push({ name: entry.name ?? "", text: entry.text });
        break;
      default:
        break;
    }
  }
  return { dataModel, structures, screens, blocks, clientActions, serverActions };
}

/**
 * Runs the offline pass. Throws `FLOWS_NOT_BUILT` when **no** scope module has a usable capture —
 * there is nothing to extract and writing an empty snapshot over a good one would be the exact
 * silent-wrong-answer failure ADR-0011 forbids. A scope that is only *partly* captured still writes,
 * with every missing module named in `missingCaptures`.
 */
export function reextractScope(options: ReextractOptions): ReextractResult {
  const { scope, graphDir, snapshotPath, rules } = options;
  const now = options.now ?? (() => new Date());
  const log = options.onProgress ?? ((): void => undefined);
  const startedAt = Date.now();
  const read = options.readCapture ?? readRawModule;

  const extracted: ExtractedModule[] = [];
  const captures = new Map<string, RawModuleCapture>();
  const missing: FlowsArtifact["missingCaptures"] = [];

  const seen = new Set<string>();
  for (const name of scope.modules) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let capture: RawModuleCapture;
    try {
      capture = read(graphDir, scope.name, name);
    } catch (err) {
      missing.push({
        module: name,
        code: err instanceof RawCaptureError ? err.code : "RAW_READ_FAILED",
        message: err instanceof Error ? err.message : String(err)
      });
      log(`reextract: ${name}: no usable raw capture, skipped`);
      continue;
    }
    captures.set(capture.manifest.module, capture);
    const result = extractModule({
      module: capture.manifest.module,
      moduleType: capture.manifest.moduleType,
      texts: textsFrom(capture)
    });
    // The skips the live run recorded for failed element reads are part of the data, not of the
    // run: without them the offline snapshot would claim elements that were never read.
    for (const s of capture.manifest.skipped) result.skipped.push({ kind: s.kind, name: s.name, reason: "TOOL_ERROR" });
    extracted.push(result);
    log(
      `reextract: ${capture.manifest.module}: ${capture.texts.length} texts, ` +
        `${result.nodes.length} nodes, ${result.edges.length} edges`
    );
  }

  if (extracted.length === 0) {
    throw new OsgraphToolError(
      "FLOWS_NOT_BUILT",
      `scope '${scope.name}': no module has a usable raw capture under ${graphDir}, so there is nothing ` +
        `to re-extract and the existing snapshot is left untouched. Run a rebuild (needs Service Studio) ` +
        `to capture the texts first.`,
      { scope: scope.name, graphDir, missingCaptures: missing }
    );
  }

  const built = buildSnapshot({
    scopeName: scope.name,
    modules: extracted,
    layerAssign: (m) => assignLayer(m, rules),
    now: now()
  });
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeSnapshot(snapshotPath, built.snapshot, built.meta);

  const flows = buildScopeFlows({
    graphDir,
    scope: scope.name,
    modules: scope.modules,
    builtAt: now().toISOString(),
    graphRebuiltAt: built.meta.rebuiltAt
  });
  const flowsPath = writeFlows(snapshotPath, flows);

  const report = listViolations(built.snapshot, rules);
  return {
    scope: scope.name,
    snapshotPath,
    flowsPath,
    modules: extracted.map((m) => {
      const capture = captures.get(m.module);
      const f = flows.perModule.find((x) => x.module === m.module);
      return {
        module: m.module,
        capturedAt: capture?.manifest.capturedAt ?? "",
        textCount: capture?.texts.length ?? 0,
        nodeCount: m.nodes.length,
        edgeCount: m.edges.length,
        skippedCount: m.skipped.length,
        flowActionCount: f?.flowActionCount ?? 0,
        flowNodeCount: f?.flowNodeCount ?? 0,
        unknownNodeCount: f?.unknownNodeCount ?? 0,
        parseErrorCount: f?.parseErrorCount ?? 0
      };
    }),
    nodeCount: built.snapshot.nodes.length,
    edgeCount: built.snapshot.links.length,
    violationCount: report.violations.length,
    flowActionCount: flows.flowActionCount,
    flowNodeCount: flows.flowNodeCount,
    unknownNodeCount: flows.unknownNodeCount,
    unknownNodeTypes: flows.unknownNodeTypes,
    parseErrorCount: flows.parseErrorCount,
    missingCaptures: missing.concat(flows.missingCaptures.filter((m) => !missing.some((x) => x.module === m.module))),
    durationMs: Date.now() - startedAt
  };
}
