/**
 * #66: local snapshot freshness. Answers "what was this scope's snapshot built from, and how
 * complete is it?" from files already on disk: `<graphDir>/<scope>/meta.json`, the graph itself,
 * and the per-module raw capture manifests. Strictly read-only; never touches Service Studio,
 * osopener or the session token, so it works with Studio shut.
 *
 * osgraph is not standalone: the captures this reads were produced by a run that needed osopener
 * and the token manager. This module only reports on what they left behind.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveScopeArtifactPaths } from "../graph/io.js";
import { IDENTITY_UNKNOWN_OLD_SCHEMA, RAW_READABLE_SCHEMA_VERSIONS, rawDir, type RawManifest } from "../rebuild/raw.js";

/** What `moduleVersion` reads when the capture did not record one. */
export const VERSION_UNKNOWN = "unknown";

export interface ModuleStatus {
  module: string;
  /** ISO-8601 clock at the end of the module's capture. */
  capturedAt: string;
  /** The version Studio reported at capture time, or `"unknown"` (see `moduleVersionReason`). */
  moduleVersion: string;
  /** `null` when the version is known, else why not (`OLD_SCHEMA`, `NOT_IN_LISTING`, ...). */
  moduleVersionReason: string | null;
  skippedCount: number;
  referencedOnlyCount: number;
}

export interface CaptureProblem {
  /** Directory name under `raw/` whose manifest could not be used. */
  directory: string;
  reason: string;
}

export interface GraphStatusResult {
  scope: string;
  snapshot: {
    present: boolean;
    /** `meta.json` `rebuiltAt`, or null when there is no snapshot / no readable meta. */
    builtAt: string | null;
    /** Set only for snapshots finalized from a staged rebuild: oldest / newest module read. */
    stagedFrom: string | null;
    stagedTo: string | null;
  };
  completeness: {
    scopeModuleCount: number;
    capturedModuleCount: number;
    /** Scope modules with no usable raw capture, by name, in scope-file order. */
    missingModules: string[];
    complete: boolean;
    /** Sum of `skippedCount` over captured modules. */
    totalSkipped: number;
    totalReferencedOnly: number;
  };
  /** Captured scope modules, sorted by name. */
  modules: ModuleStatus[];
  /** Raw directories that held a manifest this build could not use (corrupt / unknown schema). */
  captureProblems: CaptureProblem[];
}

interface LoadedManifest {
  directory: string;
  manifest: RawManifest;
}

function readManifests(graphDir: string, scope: string): { loaded: LoadedManifest[]; problems: CaptureProblem[] } {
  const loaded: LoadedManifest[] = [];
  const problems: CaptureProblem[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(rawDir(graphDir, scope), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { loaded, problems };
  }
  for (const directory of dirs) {
    const path = join(rawDir(graphDir, scope), directory, "manifest.json");
    if (!existsSync(path)) continue; // an aborted capture: no manifest is written until the end
    let manifest: RawManifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as RawManifest;
    } catch {
      problems.push({ directory, reason: "MANIFEST_UNREADABLE" });
      continue;
    }
    if (typeof manifest !== "object" || manifest === null || typeof manifest.module !== "string") {
      problems.push({ directory, reason: "MANIFEST_MALFORMED" });
      continue;
    }
    if (!RAW_READABLE_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
      problems.push({ directory, reason: "RAW_SCHEMA_MISMATCH" });
      continue;
    }
    loaded.push({ directory, manifest });
  }
  return { loaded, problems };
}

function moduleStatus(manifest: RawManifest): ModuleStatus {
  let version: string | null = typeof manifest.moduleVersion === "string" ? manifest.moduleVersion : null;
  let reason: string | null = null;
  if (manifest.schemaVersion < 2) {
    version = null;
    reason = IDENTITY_UNKNOWN_OLD_SCHEMA;
  } else if (version === null) {
    reason = typeof manifest.moduleIdentityReason === "string" ? manifest.moduleIdentityReason : "UNKNOWN";
  }
  return {
    module: manifest.module,
    capturedAt: typeof manifest.capturedAt === "string" ? manifest.capturedAt : "",
    moduleVersion: version ?? VERSION_UNKNOWN,
    moduleVersionReason: reason,
    skippedCount: Array.isArray(manifest.skipped) ? manifest.skipped.length : 0,
    referencedOnlyCount: typeof manifest.referencedOnlyCount === "number" ? manifest.referencedOnlyCount : 0
  };
}

function readSnapshotFacts(graphDir: string, scope: string): GraphStatusResult["snapshot"] {
  const paths = resolveScopeArtifactPaths(graphDir, scope);
  const out = {
    present: existsSync(paths.graph),
    builtAt: null as string | null,
    stagedFrom: null as string | null,
    stagedTo: null as string | null
  };
  try {
    const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as Record<string, unknown>;
    if (typeof meta.rebuiltAt === "string") out.builtAt = meta.rebuiltAt;
    if (typeof meta.stagedFrom === "string") out.stagedFrom = meta.stagedFrom;
    if (typeof meta.stagedTo === "string") out.stagedTo = meta.stagedTo;
  } catch {
    /* no or unreadable meta.json: builtAt stays null */
  }
  return out;
}

/** Pure local read; the caller has already resolved the scope's module list. */
export function computeGraphStatus(graphDir: string, scope: string, scopeModules: readonly string[]): GraphStatusResult {
  const { loaded, problems } = readManifests(graphDir, scope);
  const byName = new Map<string, LoadedManifest>();
  for (const l of loaded) {
    byName.set(l.manifest.module, l);
    if (typeof l.manifest.requestedAs === "string" && !byName.has(l.manifest.requestedAs)) byName.set(l.manifest.requestedAs, l);
  }
  const modules: ModuleStatus[] = [];
  const missing: string[] = [];
  const seen = new Set<LoadedManifest>();
  for (const name of scopeModules) {
    const hit = byName.get(name);
    if (hit === undefined) {
      missing.push(name);
    } else if (!seen.has(hit)) {
      seen.add(hit);
      modules.push(moduleStatus(hit.manifest));
    }
  }
  modules.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
  return {
    scope,
    snapshot: readSnapshotFacts(graphDir, scope),
    completeness: {
      scopeModuleCount: scopeModules.length,
      capturedModuleCount: modules.length,
      missingModules: missing,
      complete: missing.length === 0,
      totalSkipped: modules.reduce((n, m) => n + m.skippedCount, 0),
      totalReferencedOnly: modules.reduce((n, m) => n + m.referencedOnlyCount, 0)
    },
    modules,
    captureProblems: problems
  };
}

/** Plain-text rendering for the CLI. */
export function formatGraphStatus(r: GraphStatusResult): string {
  const lines = [
    `scope '${r.scope}': snapshot ${r.snapshot.present ? "present" : "ABSENT"}, built ${r.snapshot.builtAt ?? "unknown"}`
  ];
  if (r.snapshot.stagedFrom !== null) lines.push(`  staged from ${r.snapshot.stagedFrom} to ${r.snapshot.stagedTo ?? "?"}`);
  const c = r.completeness;
  lines.push(
    `  modules ${c.capturedModuleCount}/${c.scopeModuleCount} captured (${c.complete ? "complete" : "INCOMPLETE"}), ` +
      `${c.totalSkipped} skipped, ${c.totalReferencedOnly} referenced-only`
  );
  for (const m of c.missingModules) lines.push(`  NO CAPTURE  ${m}`);
  for (const m of r.modules) {
    lines.push(
      `  ${m.module}  captured ${m.capturedAt}  version ${m.moduleVersion}` +
        `${m.moduleVersionReason === null ? "" : ` (${m.moduleVersionReason})`}  skipped ${m.skippedCount}  referenced-only ${m.referencedOnlyCount}`
    );
  }
  for (const p of r.captureProblems) lines.push(`  UNUSABLE MANIFEST  ${p.directory}: ${p.reason}`);
  return lines.join("\n");
}
