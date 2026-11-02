/**
 * Scope rebuild orchestration (GLOSSARY "Rebuild"; ADR-0004/0005/0007/0008/0011, OSG-004/011).
 *
 *  1. acquire the session token once;
 *  2. `listApps` — every scope module must be open, else `MODULES_NOT_OPEN` (snapshot untouched);
 *  3. per module, in three phases (ADR-0013, OSG-016): the four names listings as ONE wave of 4, then
 *     `getDataModel` / `getStructures` as a second wave, then every element text through a worker pool
 *     `fetchConcurrency` wide. Order of *completion* never reaches an output: every result is
 *     reassembled in listing order (see `elements`). The two classes fail differently:
 *       - a **kind-level read** is the sole source of truth for one whole element kind in one module,
 *         so it *is* the denominator a skip would be measured against; failing it after OSG-011's
 *         single retry aborts the rebuild with `KIND_READ_FAILED` (ADR-0011) and writes nothing;
 *       - an **element read** failure is retried once, then recorded as a skipped element with reason
 *         `TOOL_ERROR` (OSG-011) — the listing still proves the element existed, so the loss stays
 *         countable and attributable;
 *     a session-level `OsgraphToolError` (TOKEN_EXPIRED / SERVICESTUDIO_UNREACHABLE) aborts the whole
 *     rebuild (OSG-004);
 *  4. extract + merge + write the snapshot atomically (temp file + rename).
 *
 * A written snapshot is therefore one in which all six kind-level reads succeeded for every module
 * in the scope, and every entry of `skipped` names exactly one element.
 *
 * Listing entries reported `IsReferenced: true` are NOT fetched (ADR-0007 "fewer calls"; S6 audit
 * F3): the element lives in another module and its text is a one-statement signature stub whose only
 * information — the producer module, flow and name — ADR-0006 already recovers at every reference
 * site. They are counted as `referencedOnlyCount`, which is complete data, never a skip.
 *
 * There is deliberately NO internal timeout. Per-call latency is a property of the module, not of the
 * payload: measured live on 2026-10-30, three real modules answered
 * at ≈4.9 s, ≈10.8 s and ≈18.5 s per call (a 258 kB response took 5.1 s; a 164-byte one took 20.2 s).
 * One rebuild costs `Σ over modules of (6 kind-level calls + elements fetched) × that module's latency`
 * — 4.3, 7.1 and 21.9 minutes for those three *when every call was serialized*. At the default width 4
 * that is ≈**3 minutes per module** (measured 3.35× client-side over 8 real reads, OSG-016/ADR-0013);
 * every module still costs its 6 kind-level calls even when it has no elements at all, but they now cost
 * 2 waves rather than 6 calls. See ADR-0013 and
 * `docs/discovery/2026-10-31-mcp-read-concurrency.md`. Progress is reported through `onProgress` (the MCP
 * tool forwards it to stderr, never stdout).
 */
import { mkdirSync } from "node:fs";
import { DEFAULT_FETCH_CONCURRENCY, MAX_FETCH_CONCURRENCY, MIN_FETCH_CONCURRENCY } from "../config.js";
import { clearStage, missingFromStage, readStage, writeStageEntry, type StageEntry } from "./stage.js";
import { RawModuleWriter, type RawElementKind } from "./raw.js";
import { buildScopeFlows, writeFlows, type FlowsArtifact } from "../flows/index.js";
import { dirname } from "node:path";
import { extractModule, type ExtractedModule, type FlowNamedText, type ModuleInput, type NamedText } from "../extract/index.js";
import { buildSnapshot, writeSnapshot, type Snapshot, type SnapshotMeta } from "../graph/index.js";
import { assignLayer } from "../layers/assign.js";
import type { LayerRules } from "../layers/rules.js";
import { listViolations } from "../layers/violations.js";
import { OsgraphToolError, ServiceStudioCallError, type ServiceStudioApp, type ServiceStudioElementName } from "../servicestudio/types.js";
import type { GraphCompleteness } from "../types.js";
import type { ScopeDefinition } from "../scopes/store.js";
import type { ServiceStudioReader, ServiceStudioSession } from "./reader.js";

export type RebuildPhase =
  | "listing"
  | "dataModel"
  | "structures"
  | "screens"
  | "blocks"
  | "clientActions"
  | "serverActions"
  | "extract";

export const REBUILD_PHASES: readonly RebuildPhase[] = [
  "listing",
  "dataModel",
  "structures",
  "screens",
  "blocks",
  "clientActions",
  "serverActions",
  "extract"
];

export type RebuildProgressEvent =
  | { type: "session"; message: string }
  | { type: "module-start"; module: string; index: number; total: number; moduleType: string }
  | { type: "phase-start"; module: string; phase: RebuildPhase; total?: number }
  /**
   * One servicestudio call, element- or kind-level.
   *
   * `index`/`total` are the element's position in the module's LISTING, not a monotonic counter:
   * element fetches run through a `fetchConcurrency`-wide pool (OSG-016/ADR-0013), so these events
   * interleave and arrive out of order, and the last one is not necessarily `total`. That is correct
   * and deliberate — it is a progress label, which is why it names the listing position rather than
   * "the nth call made". Do NOT "fix" it into a serial counter; the serial counter is what a
   * concurrent walk cannot honestly report, and `index` is the one number that stays stable between a
   * width-1 and a width-4 run of the same module.
   */
  | { type: "element"; module: string; phase: RebuildPhase; kind: string; name: string; index: number; total: number; outcome: "ok" | "retry" | "skipped" | "failed"; durationMs: number }
  | { type: "phase-done"; module: string; phase: RebuildPhase; durationMs: number }
  | { type: "module-done"; module: string; durationMs: number; skippedCount: number }
  | { type: "done"; durationMs: number; snapshotPath: string };

export interface RebuildPerModule {
  /** Canonical module name as Service Studio reports it (`listApps`). */
  module: string;
  /** Present only when the scope file spelled the module differently (case-insensitive match). */
  requestedAs?: string;
  layer: string;
  nodeCount: number;
  edgeCount: number;
  skippedCount: number;
  /**
   * Listing entries reported `IsReferenced: true` and therefore never fetched (S6 audit F3).
   * Complete data, not missing data: it never feeds `skipped`, `skippedCount` or
   * `graphCompleteness.skippedCount` (ADR-0011).
   */
  referencedOnlyCount: number;
  durationMs: number;
  /**
   * Wall-clock span of each phase. These are spans, NOT a partition of `durationMs`: at
   * `concurrency > 1` a phase contains overlapping calls, and the two kind-level waves overlap each
   * other's phases outright (`dataModel` ∥ `structures`), so the phases sum to **more** than
   * `durationMs` whenever work ran in parallel and the sum carries no meaning of its own. Read a
   * single phase against `concurrency` to recover a per-call figure (OSG-016 §A5).
   */
  phaseDurationsMs: Record<RebuildPhase, number>;
  /** Read width this module was walked at (OSG-016/ADR-0013) — what `phaseDurationsMs` must be read against. */
  concurrency: number;
  /**
   * Flow counts for this module (F4; ADR-0012). Absent when no flow data was built — a rebuild run
   * with raw capture disabled, or a module whose raw capture could not be read back.
   */
  flows?: {
    flowActionCount: number;
    flowNodeCount: number;
    bindingCount: number;
    unknownNodeCount: number;
    parseErrorCount: number;
  };
}

export interface RebuildSkippedElement {
  module: string;
  kind: string;
  name: string;
  reason: string;
}

export interface RebuildResult {
  nodeCount: number;
  edgeCount: number;
  violationCount: number;
  unknownModuleCount: number;
  unresolvedExternalCount: number;
  /** Nodes tagged `placeholder: true` in the snapshot (ADR-0009) — a non-zero count is a signal for
   *  the verifier, surfaced here so it need not open `graph.json` (S6 audit F16). */
  placeholderCount: number;
  /** Edges dropped because their in-scope target is a skipped element (ADR-0009, OSG-011, F16). */
  droppedEdgeCount: number;
  /** Scope total of `perModule.referencedOnlyCount` (S6 audit F3). */
  referencedOnlyCount: number;
  perModule: RebuildPerModule[];
  skippedElements: RebuildSkippedElement[];
  snapshotPath: string;
  /**
   * Read width this rebuild ran at (OSG-016 §C1): `fetchConcurrency` from the config, i.e. the
   * `OSGRAPH_MAX_CONCURRENCY` clamp or its default of 4. Reported beside `durationMs` so a recorded
   * run always says which width produced its timings — a measurement without it is unreadable.
   */
  fetchConcurrency: number;
  /**
   * Scope totals for `flows.json` (F4; ADR-0012), plus anything that went wrong building it.
   * Absent when no flow data was built. `missingCaptures` is the honest counterpart of
   * `skippedElements`: a module whose `raw/` capture could not be read contributes no flows, and
   * saying so is what stops the artifact from looking complete.
   */
  flows?: {
    path: string;
    flowActionCount: number;
    flowNodeCount: number;
    bindingCount: number;
    unknownNodeCount: number;
    unknownNodeTypes: string[];
    parseErrorCount: number;
    missingCaptures: FlowsArtifact["missingCaptures"];
  };
  durationMs: number;
}

export interface RebuildOutcome {
  result: RebuildResult;
  snapshot: Snapshot;
  meta: SnapshotMeta;
  graphCompleteness: GraphCompleteness;
}

export interface RebuildOptions {
  scope: ScopeDefinition;
  snapshotPath: string;
  session: ServiceStudioSession;
  rules: LayerRules;
  now?: () => Date;
  onProgress?: (event: RebuildProgressEvent) => void;
  /** Back-off before the OSG-011 element retry; default 250 ms, tests pass 0. */
  retryDelayMs?: number;
  /**
   * Element fetches issued at once per module (OSG-016 §C1; ADR-0013). Default
   * `DEFAULT_FETCH_CONCURRENCY` (4). Must match the client's `maxConcurrent`: a larger value here
   * only parks promises on the client's queue, a smaller one leaves the server's admission window
   * unused. `1` restores exactly the pre-OSG-016 serial walk, element for element.
   */
  fetchConcurrency?: number;
  /**
   * Escape hatch for S6 audit F3's `IsReferenced` filter (`OSGRAPH_FETCH_REFERENCED_ELEMENTS=1`):
   * fetch referenced-only listing entries anyway, in case a Studio build reports `IsReferenced`
   * differently from the one this was measured on. Default false.
   */
  fetchReferencedElements?: boolean;
  /**
   * Where `raw/` goes (F0 / Design 1): every element text the rebuild fetched is written verbatim
   * under `<rawGraphDir>/<scope>/raw/<module>/`, so flow extraction can be re-run offline instead of
   * costing another ≈11 minutes per module live. Undefined disables the capture; the staged path
   * always sets it to its own `graphDir`.
   */
  rawGraphDir?: string;
}

interface ResolvedModule {
  requested: string;
  app: ServiceStudioApp;
}

/**
 * Matches every scope module against `listApps`: exact name first, then case-insensitive.
 * Throws `MODULES_NOT_OPEN` listing the modules that are missing or not open.
 *
 * The output is deduped by the canonical `app.name` (S6 audit F8): `normalizeModules` only drops
 * exact duplicates, so a scope listing two case-variants of one module would otherwise walk it twice
 * — double the servicestudio calls (ADR-0007), two identical `perModule` rows and the module listed
 * twice in the snapshot. The collapse is reported through the existing `requestedAs`: the spelling
 * kept is one that differs from the canonical name whenever the scope offered one, so a collapse is
 * never silent.
 */
export function resolveScopeModules(scope: ScopeDefinition, apps: ServiceStudioApp[]): ResolvedModule[] {
  const byName = new Map<string, ResolvedModule>();
  const missing: string[] = [];
  for (const requested of scope.modules) {
    const exact = apps.find((a) => a.name === requested);
    const app = exact ?? apps.find((a) => a.name.toLowerCase() === requested.toLowerCase());
    if (app === undefined || app.isOpen !== true) {
      missing.push(requested);
      continue;
    }
    const already = byName.get(app.name);
    if (already === undefined) {
      byName.set(app.name, { requested, app });
    } else if (already.requested === app.name && requested !== app.name) {
      already.requested = requested; // make the collapse visible as `requestedAs`
    }
  }
  if (missing.length > 0) {
    const open = apps.filter((a) => a.isOpen === true).map((a) => a.name).sort();
    throw new OsgraphToolError(
      "MODULES_NOT_OPEN",
      `scope '${scope.name}': ${missing.length} module(s) not open in Service Studio: ${missing.join(", ")}. ` +
        `Open them first (osopener), then rebuild again; the previous snapshot is untouched.`,
      { scope: scope.name, missing, open }
    );
  }
  return [...byName.values()];
}

/**
 * OSG-016 §C1: the width a walk actually runs at. Clamped to [1, 8] here as well as in
 * `loadConfig`, because `rebuildScope` is a library entry point reachable without the config (tests,
 * the CLI, a future caller) and a width of 0 or NaN would deadlock or fan out unbounded.
 */
function resolveFetchConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_FETCH_CONCURRENCY;
  return Math.min(MAX_FETCH_CONCURRENCY, Math.max(MIN_FETCH_CONCURRENCY, Math.trunc(value)));
}

function isTraditional(moduleType: string): boolean {
  return /traditional/i.test(moduleType);
}

/**
 * The ADR-0005 open-module check. A `ServiceStudioCallError` here (an unparseable `listApps`, or one
 * the server answered with an error) is not an element-level failure and has no OSG-011 skip to
 * degrade to: nothing of the scope can be resolved, so it is a connection-class abort (OSG-004).
 * Without this it surfaced as `INTERNAL_ERROR`, claiming an osgraph bug (S6 audit F12).
 */
async function listOpenApps(reader: ServiceStudioReader, scope: string): Promise<ServiceStudioApp[]> {
  try {
    return await reader.listApps();
  } catch (err) {
    if (!(err instanceof ServiceStudioCallError)) throw err;
    throw new OsgraphToolError(
      "SERVICESTUDIO_UNREACHABLE",
      `scope '${scope}': listApps failed, so the open-module check (ADR-0005) could not run: ${err.message}. ` +
        `The previous snapshot is untouched.`,
      { scope, call: "listApps" }
    );
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

/**
 * Bounded worker pool over `items` (OSG-016 §A1 step 2). At most `width` of `run` are pending at
 * once; results come back **indexed by input position**, never by completion order, which is the one
 * property every determinism claim in this file rests on.
 *
 * Why a pool and not `Promise.all`: the client's semaphore already caps real concurrency at
 * `maxConcurrent`, so handing it 312 promises would be *correct* — and would also create 312
 * simultaneous promises, each holding an abort controller and a retry timer, to run 4 at a time. The
 * pool pulls from a shared cursor instead, so the in-flight set is bounded on the caller side too.
 *
 * Failure: a rejection does not cancel the siblings (they are already in flight at the server and
 * their results are wanted anyway). Every worker runs to the end of the queue and the FIRST rejection
 * **in input order** is rethrown — never the first in time — so which error aborts a rebuild cannot
 * depend on timing (§A4).
 */
async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors = new Array<unknown>(items.length);
  const failed = new Array<boolean>(items.length).fill(false);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await run(items[i], i);
      } catch (err) {
        failed[i] = true;
        errors[i] = err;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.trunc(width), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  const first = failed.indexOf(true);
  if (first !== -1) throw errors[first];
  return results;
}

class ModuleWalker {
  readonly skipped: RebuildSkippedElement[] = [];
  /** Listing entries never fetched because `IsReferenced === true` (S6 audit F3). Never a skip. */
  referencedOnlyCount = 0;
  readonly phaseDurations: Record<RebuildPhase, number> = Object.fromEntries(
    REBUILD_PHASES.map((p) => [p, 0])
  ) as Record<RebuildPhase, number>;

  constructor(
    private readonly reader: ServiceStudioReader,
    private readonly scope: string,
    private readonly module: string,
    private readonly traditional: boolean,
    private readonly retryDelayMs: number,
    private readonly fetchReferenced: boolean,
    /** Element fetches in flight at once (OSG-016 §C1); 1 is the pre-OSG-016 serial walk. */
    private readonly fetchConcurrency: number,
    private readonly emit: (e: RebuildProgressEvent) => void,
    /**
     * Raw-text capture (F0). Undefined disables it; the walk is otherwise identical, so a test or a
     * caller that does not want files on disk pays nothing and sees the same extraction.
     */
    private readonly raw?: RawModuleWriter
  ) {}

  /**
   * One ELEMENT servicestudio call under OSG-011: `ServiceStudioCallError` → retry once → skip.
   * `OsgraphToolError` (session-level) and anything else propagate and abort the rebuild.
   *
   * It **returns** the skip record rather than pushing it onto `this.skipped` (OSG-016 §A3). Under
   * the element pool these calls complete out of order, so appending here would order `skipped` —
   * and therefore `skippedElements` and `graphCompleteness.skippedCount`'s companions in every tool
   * response (OSG-011) — by *completion*, i.e. by timing. The caller appends during its ordered
   * reassembly pass instead, so this file has exactly one ordering rule: listing order, everywhere.
   *
   * Retry budget (OSG-016 §C2): the client ALSO retries once, but only for a transient temp-OML
   * error (`isTransientOmlError`). So one element costs at most **2** attempts for an ordinary tool
   * error and at most **4** (2 client × 2 here, back-offs 250 ms + `retryDelayMs`) for the transient
   * one. Both layers are kept deliberately: the temp-OML window is exactly what concurrency widens,
   * and spending seconds on a fourth attempt is strictly better than skipping an element — or, at
   * kind level, aborting a 40-minute rebuild — over a blip. Every attempt past the first is visible
   * as a `retry` progress event, so the budget is observable and not just documented.
   */
  private async guarded<T>(
    phase: RebuildPhase,
    kind: string,
    name: string,
    index: number,
    total: number,
    call: () => Promise<T>
  ): Promise<{ value: T } | { skip: RebuildSkippedElement }> {
    const started = Date.now();
    const report = (outcome: "ok" | "retry" | "skipped"): void =>
      this.emit({ type: "element", module: this.module, phase, kind, name, index, total, outcome, durationMs: Date.now() - started });
    try {
      const value = await call();
      report("ok");
      return { value };
    } catch (err) {
      if (!(err instanceof ServiceStudioCallError)) throw err;
      report("retry");
      await sleep(this.retryDelayMs);
      try {
        const value = await call();
        report("ok");
        return { value };
      } catch (err2) {
        if (!(err2 instanceof ServiceStudioCallError)) throw err2;
        report("skipped");
        return { skip: { module: this.module, kind, name, reason: "TOOL_ERROR" } };
      }
    }
  }

  /**
   * One KIND-LEVEL servicestudio call under ADR-0011: same single retry, same back-off and the same
   * progress events as `guarded`, but the second failure **throws** `KIND_READ_FAILED` instead of
   * recording a skip. It never returns `undefined`, which is the type-level proof the ADR asks for:
   * after this change an empty listing or an empty module text can only have come from the server,
   * so "genuinely empty" and "failed" are told apart by control flow and never by value.
   *
   * Fail fast, not fail complete: every further call is seconds of work on a rebuild that is already
   * doomed, and all six kind-level calls of a module run before any of its element texts, so the abort
   * surfaces within the module's first two waves. Which of a wave's failures aborts the rebuild is
   * decided by listing order, not by which answered first — see `mapPool` and ADR-0013.
   */
  private async kindLevel<T>(phase: RebuildPhase, kind: string, call: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const report = (outcome: "ok" | "retry" | "failed"): void =>
      this.emit({ type: "element", module: this.module, phase, kind, name: call, index: 1, total: 1, outcome, durationMs: Date.now() - started });
    try {
      const value = await run();
      report("ok");
      return value;
    } catch (err) {
      if (!(err instanceof ServiceStudioCallError)) throw err;
      report("retry");
      await sleep(this.retryDelayMs);
      try {
        const value = await run();
        report("ok");
        return value;
      } catch (err2) {
        if (!(err2 instanceof ServiceStudioCallError)) throw err2;
        report("failed");
        throw new OsgraphToolError(
          "KIND_READ_FAILED",
          `scope '${this.scope}': module '${this.module}' kind '${kind}': ${call} failed twice ` +
            `(${err2.message}). That call is the only source of truth for every ${kind} in the module, so the ` +
            `rebuild is aborted rather than written with an unquantifiable gap (ADR-0011). The previous ` +
            `snapshot is untouched; run rebuild({ scope: "${this.scope}" }) again.`,
          { scope: this.scope, module: this.module, kind, call, phase, attempts: 2 }
        );
      }
    }
  }

  private async phase<T>(phase: RebuildPhase, total: number | undefined, run: () => Promise<T>): Promise<T> {
    this.emit({ type: "phase-start", module: this.module, phase, total });
    const started = Date.now();
    try {
      return await run();
    } finally {
      const durationMs = Date.now() - started;
      this.phaseDurations[phase] += durationMs;
      this.emit({ type: "phase-done", module: this.module, phase, durationMs });
    }
  }

  /**
   * A whole-module text (`getDataModel` / `getStructures`) — a kind-level read (ADR-0011).
   *
   * It deliberately does NOT write the raw capture: the two run as one wave (OSG-016 §A4), so
   * capturing here would record them in the order the server answered, and `raw/`'s manifest order is
   * an *output* that ADR-0012 requires `reextract` to reproduce byte-for-byte. `walk` captures both
   * in fixed order once the wave has settled.
   */
  private moduleText(
    phase: "dataModel" | "structures",
    kind: string,
    call: string,
    run: () => Promise<string>
  ): Promise<string> {
    return this.phase(phase, 1, () => this.kindLevel(phase, kind, call, run));
  }

  /** A names listing — a kind-level read (ADR-0011); failure aborts, it never degrades to `[]`. */
  private listing(
    kind: string,
    call: string,
    run: () => Promise<ServiceStudioElementName[]>
  ): Promise<ServiceStudioElementName[]> {
    return this.kindLevel("listing", kind, call, run);
  }

  /**
   * Fetches every listed element by name. Duplicate names (ADR-0008) are fetched once and the same
   * text is attached to each listing entry with its own `UIFlow`; the extractor decides attribution.
   *
   * S6 audit F3 / ADR-0007 "fewer calls": an entry reported `IsReferenced === true` is a reference to
   * an element of another module, and its text is a one-statement dependency stub with no anchor of
   * its own — on the live target 0 of 312 captured block texts contained one. Everything such a
   * fetch could yield is already recovered from the `// I<Kind>Signature <Module>/[<Flow>/]<Name>`
   * comment at each *reference* site (ADR-0006), so the entry is counted as `referencedOnlyCount` and
   * not fetched. The comparison is `=== true` and never `!== false`: a Studio build that omits
   * `IsReferenced` must keep today's behaviour and fetch the entry (ADR-0011). The filter runs only
   * after the listing call has returned successfully, so it can never mask or imitate a listing
   * failure, and its count never feeds `skipped`.
   */
  private async elements<T extends NamedText>(
    phase: RebuildPhase,
    kind: RawElementKind,
    call: string,
    listing: ServiceStudioElementName[],
    fetch: (name: string) => Promise<string>,
    make: (entry: ServiceStudioElementName, text: string) => T
  ): Promise<T[]> {
    const wanted = this.fetchReferenced ? listing : listing.filter((e) => e.IsReferenced !== true);
    this.referencedOnlyCount += listing.length - wanted.length;
    return this.phase(phase, wanted.length, async () => {
      // --- Pass 1: resolve the distinct fetch set. No I/O, so it cannot be raced (OSG-016 §A1/§A2).
      // De-duplicating HERE and not at `texts.has(name)` is the whole point: that check was only safe
      // because the loop was serial — two entries sharing a name would both pass it under the pool and
      // cost a second call, breaking ADR-0007's "fewer calls".
      const names: string[] = [];
      /** name → its 1-based position in `wanted`, for the progress event's `index` (stable at any width). */
      const firstPosition = new Map<string, number>();
      for (const [i, entry] of wanted.entries()) {
        const name = String(entry.Name ?? "");
        if (name.length === 0) continue;
        if (firstPosition.has(name)) continue;
        firstPosition.set(name, i + 1);
        names.push(name);
      }

      // --- Pass 2: the only I/O, `fetchConcurrency` wide, results indexed by input position.
      const fetched = await mapPool(names, this.fetchConcurrency, (name) =>
        this.guarded(phase, kind, name, firstPosition.get(name) ?? 1, wanted.length, () => fetch(name))
      );
      const byName = new Map(names.map((name, i) => [name, fetched[i]]));

      // --- Pass 3: reassemble in LISTING order. Everything that leaves this method or lands on disk
      // is produced here, so no output can carry completion order: `out`, `raw/`'s manifest order and
      // `this.skipped` are all in `wanted` order whether the fetches finished forwards, backwards or
      // interleaved (§A6.1 is the test).
      const out: T[] = [];
      const skipRecorded = new Set<string>();
      for (const entry of wanted) {
        const name = String(entry.Name ?? "");
        if (name.length === 0) continue;
        const outcome = byName.get(name);
        if (outcome === undefined) continue;
        if ("skip" in outcome) {
          // One skip per failed FETCH, not per listing entry — a duplicate name cost one call and
          // loses one text; recorded at the first occurrence's position, never at completion time.
          if (!skipRecorded.has(name)) {
            skipRecorded.add(name);
            this.skipped.push(outcome.skip);
          }
          continue;
        }
        out.push(make(entry, outcome.value));
        // One raw file per *listing entry*, not per fetch: a duplicate name in two UI flows
        // (ADR-0008) is two elements and must be two files, even though it cost one call.
        this.raw?.add({
          kind,
          manifestKind: kind,
          call,
          name,
          // Normalized exactly as the extractor's `flow()` maker does, so `reextract` can rebuild
          // the same `FlowNamedText`; omitted for the two kinds that have no flow at all.
          ...(kind === "Screen" || kind === "Block"
            ? { uiFlow: typeof entry.UIFlow === "string" ? entry.UIFlow : "" }
            : {}),
          text: outcome.value
        });
      }
      return out;
    });
  }

  async walk(): Promise<ModuleInput["texts"]> {
    const r = this.reader;
    const m = this.module;
    const t = this.traditional;

    // --- Wave 1 (OSG-016 §A4): the four name listings at once. They are independent of each other and
    // exactly fill the server's admission window, so a module's listing phase costs one call's latency
    // instead of four. `mapPool` returns them positionally, and rethrows the first failure in THIS
    // order (screens, blocks, clientActions, serverActions) — ADR-0011 still aborts the rebuild on the
    // first kind-level failure, but "first" means first in listing order and not first in time, so
    // which call aborts a rebuild never depends on which of the four happened to answer soonest.
    //
    // The phase boundary is kept: every listing must be complete before any element fetch starts,
    // because `elements()` consumes `listings.*`.
    const listingWave = [
      {
        kind: "Screen",
        call: t ? "getScreenNamesTraditional" : "getScreenNames",
        run: () => (t ? r.getScreenNamesTraditional(m) : r.getScreenNames(m))
      },
      {
        kind: "Block",
        call: t ? "getWebBlockNamesTraditional" : "getWebBlockNames",
        run: () => (t ? r.getWebBlockNamesTraditional(m) : r.getWebBlockNames(m))
      },
      { kind: "ClientAction", call: "getActionNames(client)", run: () => r.getActionNames(m, "client") },
      { kind: "ServerAction", call: "getActionNames(server)", run: () => r.getActionNames(m, "server") },
      // A Service module publishes `SL_*` service actions, which the "server" listing does not
      // return. Without this the whole SL layer reads as empty — 38 of 38 `_SL` modules yielded no
      // actions at all, and the layer became a terminal wall with 46 edges in and 0 out.
      { kind: "ServiceAction", call: "getActionNames(service)", run: () => r.getActionNames(m, "service") }
    ] as const;
    const [screenNames, blockNames, clientActionNames, serverActionNames, serviceActionNames] = await this.phase(
      "listing",
      listingWave.length,
      () => mapPool(listingWave, this.fetchConcurrency, (spec) => this.listing(spec.kind, spec.call, spec.run))
    );
    // Service actions join the server-action listing rather than forming a phase of their own. Three
    // reasons, all load-bearing: `kinds.ts` already normalises `ServiceAction` -> `ServerAction`, so
    // the node id matches the External/Placeholder stub the consumer side already created; `raw/`
    // keeps one directory per kind, so reextract needs no change and stays byte-identical; and
    // `phaseDurationsMs` keeps its eight documented phases, so the dashboard does not break.
    const serviceNames = new Set(serviceActionNames.map((e) => String(e.Name ?? "")));
    const listings = {
      screens: screenNames,
      blocks: blockNames,
      clientActions: clientActionNames,
      serverActions: [...serverActionNames, ...serviceActionNames]
    };

    // --- Wave 2: the two whole-module texts. Their phases overlap each other by construction, which
    // is exactly why `phaseDurationsMs` is documented as a set of spans and not a partition.
    const moduleTextWave = [
      { phase: "dataModel", kind: "Entity", call: "getDataModel", run: () => r.getDataModel(m) },
      { phase: "structures", kind: "Structure", call: "getStructures", run: () => r.getStructures(m) }
    ] as const;
    const [dataModel, structures] = await mapPool(moduleTextWave, this.fetchConcurrency, (spec) =>
      this.moduleText(spec.phase, spec.kind, spec.call, spec.run)
    );
    // Captured here, in fixed order, rather than inside `moduleText`: `raw/`'s manifest order is an
    // output (ADR-0012 byte-identity), so it must not record which of the two answered first.
    this.raw?.add({ kind: "dataModel", manifestKind: "Entity", call: "getDataModel", text: dataModel });
    this.raw?.add({ kind: "structures", manifestKind: "Structure", call: "getStructures", text: structures });

    const flow = (entry: ServiceStudioElementName, text: string): FlowNamedText => ({
      name: String(entry.Name),
      uiFlow: typeof entry.UIFlow === "string" ? entry.UIFlow : "",
      text
    });
    const plain = (entry: ServiceStudioElementName, text: string): NamedText => ({ name: String(entry.Name), text });

    const screenCall = t ? "getScreenTraditional" : "getScreen";
    const blockCall = t ? "getWebBlockTraditional" : "getWebBlock";
    const screens = await this.elements("screens", "Screen", screenCall, listings.screens, (n) => (t ? r.getScreenTraditional(m, n) : r.getScreen(m, n)), flow);
    const blocks = await this.elements("blocks", "Block", blockCall, listings.blocks, (n) => (t ? r.getWebBlockTraditional(m, n) : r.getWebBlock(m, n)), flow);
    const clientActions = await this.elements("clientActions", "ClientAction", "getClientAction", listings.clientActions, (n) => r.getClientAction(m, n), plain);
    const serverActionCall = serviceNames.size > 0 ? "getServerAction+getServiceAction" : "getServerAction";
    const serverActions = await this.elements(
      "serverActions",
      "ServerAction",
      serverActionCall,
      listings.serverActions,
      (n) => (serviceNames.has(n) ? r.getServiceAction(m, n) : r.getServerAction(m, n)),
      plain
    );

    return { dataModel, structures, screens, blocks, clientActions, serverActions };
  }
}

/** Runs one scope rebuild end to end. Throws `OsgraphToolError` on every abort path (snapshot untouched). */
interface ModuleTiming {
  module: string;
  requested: string;
  durationMs: number;
  referencedOnlyCount: number;
  /** Overlapping wall-clock spans, not a partition of `durationMs` — see `RebuildPerModule`. */
  phases: Record<RebuildPhase, number>;
  /** Width the module was walked at; what `phases` has to be read against (OSG-016 §A5). */
  concurrency: number;
}

interface WalkAndExtractOptions {
  session: ServiceStudioSession;
  scope: string;
  app: ServiceStudioApp;
  requested: string;
  index: number;
  total: number;
  retryDelayMs: number;
  fetchReferenced: boolean;
  /** Element fan-out width for this module (OSG-016 §C1). */
  fetchConcurrency: number;
  emit: (event: RebuildProgressEvent) => void;
  /** F0 raw capture root; undefined writes no files. */
  rawGraphDir?: string;
  now: () => Date;
}

/**
 * Reads one module and parses it. Shared by the all-at-once path (`rebuildScope`) and the staged
 * one (`stageModule`) so both produce byte-identical extractions — the staged snapshot must not be
 * distinguishable from the one the single call would have written.
 */
async function walkAndExtract(
  options: WalkAndExtractOptions
): Promise<{ extracted: ExtractedModule; timing: ModuleTiming }> {
  const { session, scope, app, requested, index, total, retryDelayMs, fetchReferenced, fetchConcurrency, emit } = options;
  const moduleStarted = Date.now();
  emit({ type: "module-start", module: app.name, index, total, moduleType: app.moduleType });
  const raw =
    options.rawGraphDir !== undefined ? new RawModuleWriter(options.rawGraphDir, scope, app.name) : undefined;
  const walker = new ModuleWalker(
    session.reader,
    scope,
    app.name,
    isTraditional(app.moduleType),
    retryDelayMs,
    fetchReferenced,
    fetchConcurrency,
    emit,
    raw
  );
  const texts = await walker.walk();

  const extractStarted = Date.now();
  emit({ type: "phase-start", module: app.name, phase: "extract" });
  const result = extractModule({ module: app.name, moduleType: app.moduleType, texts });
  // Tool-level skips (OSG-011) sit beside the extractor's own NO_ANCHOR / PARSE_ERROR skips.
  for (const s of walker.skipped) result.skipped.push({ kind: s.kind, name: s.name, reason: "TOOL_ERROR" });
  walker.phaseDurations.extract = Date.now() - extractStarted;
  emit({ type: "phase-done", module: app.name, phase: "extract", durationMs: walker.phaseDurations.extract });

  // The manifest is written last and only once the module's walk completed, so its presence is the
  // marker that `raw/<module>/` is a whole capture and not the remains of an aborted one.
  raw?.writeManifest({
    requestedAs: requested,
    moduleType: app.moduleType,
    capturedAt: options.now().toISOString(),
    referencedOnlyCount: walker.referencedOnlyCount,
    skipped: walker.skipped.map((s) => ({ kind: s.kind, name: s.name, reason: s.reason }))
  });

  const durationMs = Date.now() - moduleStarted;
  emit({ type: "module-done", module: app.name, durationMs, skippedCount: result.skipped.length });
  return {
    extracted: result,
    timing: {
      module: app.name,
      requested,
      durationMs,
      referencedOnlyCount: walker.referencedOnlyCount,
      phases: walker.phaseDurations,
      concurrency: fetchConcurrency
    }
  };
}

export async function rebuildScope(options: RebuildOptions): Promise<RebuildOutcome> {
  const { scope, snapshotPath, session, rules } = options;
  const now = options.now ?? (() => new Date());
  const emit = options.onProgress ?? (() => undefined);
  const retryDelayMs = options.retryDelayMs ?? 250;
  const fetchReferenced = options.fetchReferencedElements === true;
  const fetchConcurrency = resolveFetchConcurrency(options.fetchConcurrency);
  const startedAt = Date.now();

  try {
    emit({ type: "session", message: "acquiring session token" });
    await session.acquire();
    emit({ type: "session", message: "listing open modules" });
    const apps = await listOpenApps(session.reader, scope.name);
    const resolved = resolveScopeModules(scope, apps);

    const extracted: ExtractedModule[] = [];
    const perModuleTiming: ModuleTiming[] = [];

    for (const [i, { requested, app }] of resolved.entries()) {
      const walked = await walkAndExtract({
        session,
        scope: scope.name,
        app,
        requested,
        index: i + 1,
        total: resolved.length,
        retryDelayMs,
        fetchReferenced,
        fetchConcurrency,
        emit,
        rawGraphDir: options.rawGraphDir,
        now
      });
      extracted.push(walked.extracted);
      perModuleTiming.push(walked.timing);
    }

    const outcome = buildOutcome({
      scopeName: scope.name,
      snapshotPath,
      rules,
      now: now(),
      extracted,
      perModuleTiming,
      startedAt,
      fetchConcurrency,
      ...(options.rawGraphDir !== undefined
        ? { flows: { graphDir: options.rawGraphDir, modules: scope.modules } }
        : {})
    });
    emit({ type: "done", durationMs: outcome.result.durationMs, snapshotPath });
    return outcome;
  } finally {
    // OSG-016 §B1: do not hand the caller back control while reads are still in flight. The caller's
    // very next act is typically osopener's `closeModule`, and closing a module out from under a
    // queued read is the one thing that reproduces the temp-OML error. On the success path everything
    // has already settled and this is free; on an abort path (a session-level error, a kind-level
    // failure) it is the only thing between a half-finished wave and a closing tab.
    await session.reader.drain?.();
    session.release();
  }
}

/** Human-readable one-liner per progress event (stderr output of the MCP tool). */
export function formatProgress(event: RebuildProgressEvent): string {
  switch (event.type) {
    case "session":
      return `rebuild: ${event.message}`;
    case "module-start":
      return `rebuild: module ${event.index}/${event.total} '${event.module}' (${event.moduleType})`;
    case "phase-start":
      return `rebuild:   ${event.module} ${event.phase}${event.total !== undefined ? ` (${event.total})` : ""}`;
    case "element":
      return `rebuild:     ${event.module} ${event.kind} '${event.name}' ${event.index}/${event.total} ${event.outcome} ${event.durationMs}ms`;
    case "phase-done":
      return `rebuild:   ${event.module} ${event.phase} done ${event.durationMs}ms`;
    case "module-done":
      return `rebuild: module '${event.module}' done ${event.durationMs}ms, skipped ${event.skippedCount}`;
    case "done":
      return `rebuild: done ${event.durationMs}ms -> ${event.snapshotPath}`;
  }
}

interface BuildOutcomeOptions {
  scopeName: string;
  snapshotPath: string;
  rules: LayerRules;
  now: Date;
  extracted: ExtractedModule[];
  perModuleTiming: ModuleTiming[];
  startedAt: number;
  /** Width the run used; reported as `result.fetchConcurrency` (OSG-016 §C1). */
  fetchConcurrency: number;
  /** Staged finalize only: the real age span of the data (S6 re-audit MAJOR-2). */
  stageAge?: { oldest: string; newest: string } | null;
  /**
   * Build `flows.json` as well (F4; ADR-0012). `modules` must be the scope's own order, so a
   * finalize and an offline `reextract` produce byte-identical artifacts. Omitted when no raw
   * capture was taken, in which case there is nothing to parse and no flow data is written.
   */
  flows?: { graphDir: string; modules: string[] };
}

/**
 * Builds the snapshot, writes it atomically and shapes the `RebuildResult`. Shared by the
 * all-at-once path and the staged one's finalize step, so a staged scope and a single-call scope
 * produce the same `graph.json` from the same extractions.
 */
function buildOutcome(options: BuildOutcomeOptions): RebuildOutcome {
  const { scopeName, snapshotPath, rules, now, extracted, perModuleTiming, startedAt } = options;
  const stageAge = options.stageAge ?? null;
  const built = buildSnapshot({
    scopeName,
    modules: extracted,
    layerAssign: (m) => assignLayer(m, rules),
    now
  });
  if (stageAge) {
    built.meta.stagedFrom = stageAge.oldest;
    built.meta.stagedTo = stageAge.newest;
  }
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeSnapshot(snapshotPath, built.snapshot, built.meta);

  // Flows are built AFTER the snapshot, by reading `raw/` back (ADR-0012): one code path shared with
  // `reextract`, and `graphRebuiltAt` can then record the exact snapshot it belongs to. A failure
  // here must not undo a published snapshot, so it is reported rather than thrown.
  let flowsArtifact: FlowsArtifact | undefined;
  let flowsPathWritten: string | undefined;
  if (options.flows !== undefined) {
    flowsArtifact = buildScopeFlows({
      graphDir: options.flows.graphDir,
      scope: scopeName,
      modules: options.flows.modules,
      builtAt: now.toISOString(),
      graphRebuiltAt: built.meta.rebuiltAt
    });
    flowsPathWritten = writeFlows(snapshotPath, flowsArtifact);
  }

  const { snapshot, meta } = built;
  const report = listViolations(snapshot, rules);
  const durationMs = Date.now() - startedAt;

  const perModule: RebuildPerModule[] = snapshot.graph.osgraph.perModule.map((pm) => {
    const timing = perModuleTiming.find((t) => t.module === pm.module);
    const entry: RebuildPerModule = {
      module: pm.module,
      layer: pm.layer,
      nodeCount: pm.nodeCount,
      edgeCount: pm.edgeCount,
      skippedCount: pm.skippedCount,
      referencedOnlyCount: timing?.referencedOnlyCount ?? 0,
      durationMs: timing?.durationMs ?? 0,
      phaseDurationsMs: timing?.phases ?? (Object.fromEntries(REBUILD_PHASES.map((p) => [p, 0])) as Record<RebuildPhase, number>),
      concurrency: timing?.concurrency ?? options.fetchConcurrency
    };
    if (timing && timing.requested !== pm.module) entry.requestedAs = timing.requested;
    const flows = flowsArtifact?.perModule.find((f) => f.module === pm.module);
    if (flows !== undefined) {
      entry.flows = {
        flowActionCount: flows.flowActionCount,
        flowNodeCount: flows.flowNodeCount,
        bindingCount: flows.bindingCount,
        unknownNodeCount: flows.unknownNodeCount,
        parseErrorCount: flows.parseErrorCount
      };
    }
    return entry;
  });

  const result: RebuildResult = {
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.links.length,
    violationCount: report.violations.length,
    unknownModuleCount: snapshot.graph.osgraph.unknownModuleCount,
    unresolvedExternalCount: snapshot.graph.osgraph.unresolvedExternalCount,
    placeholderCount: snapshot.graph.osgraph.placeholderCount,
    droppedEdgeCount: snapshot.graph.osgraph.droppedEdgeCount,
    referencedOnlyCount: perModuleTiming.reduce((n, t) => n + t.referencedOnlyCount, 0),
    perModule,
    skippedElements: snapshot.graph.osgraph.skipped.map((s) => ({ module: s.module, kind: s.kind, name: s.name, reason: s.reason })),
    snapshotPath,
    fetchConcurrency: options.fetchConcurrency,
    durationMs
  };
  if (flowsArtifact !== undefined && flowsPathWritten !== undefined) {
    result.flows = {
      path: flowsPathWritten,
      flowActionCount: flowsArtifact.flowActionCount,
      flowNodeCount: flowsArtifact.flowNodeCount,
      bindingCount: flowsArtifact.bindingCount,
      unknownNodeCount: flowsArtifact.unknownNodeCount,
      unknownNodeTypes: flowsArtifact.unknownNodeTypes,
      parseErrorCount: flowsArtifact.parseErrorCount,
      missingCaptures: flowsArtifact.missingCaptures
    };
  }
  return {
    result,
    snapshot,
    meta,
    graphCompleteness: { skippedCount: meta.skippedCount, lastRebuildAt: meta.rebuiltAt }
  };
}

export interface StageModuleOptions extends RebuildOptions {
  /** The single scope module to read and stage. Must be in the scope and open in Service Studio. */
  module: string;
  /** Where the stage lives: `<graphDir>/<scope>/stage/`. */
  graphDir: string;
}

export interface StagedModuleSummary {
  module: string;
  requestedAs?: string;
  nodeCount: number;
  edgeCount: number;
  skippedCount: number;
  referencedOnlyCount: number;
  durationMs: number;
  phaseDurationsMs: Record<RebuildPhase, number>;
  /** Width this module was staged at (OSG-016 §C1); `phaseDurationsMs` means nothing without it. */
  concurrency: number;
}

export interface StageOutcome {
  mode: "staged";
  /** What this call read. */
  staged: StagedModuleSummary;
  stagedModules: string[];
  missingModules: string[];
  /**
   * Stage files that exist but could not be used (corrupt, truncated, or a different
   * `STAGE_SCHEMA_VERSION`). They are counted as *not staged*, so their modules appear in
   * `missingModules` too; naming them here is what stops a wedged stage from looking like an
   * ordinary "still a few modules to go" (S6 re-audit MAJOR-1).
   */
  unreadableStageFiles: string[];
  /**
   * How old the data behind a finalize actually is. `meta.rebuiltAt` is the clock at finalize, so
   * on its own it would claim a 38-module scope staged over days was "rebuilt minutes ago"
   * (S6 re-audit MAJOR-2). Present on every staged response; `oldest`/`newest` span every entry
   * currently staged.
   */
  stageAge: { oldest: string; newest: string; spanMs: number } | null;
  /** True when this call completed the scope and wrote `graph.json`. */
  finalized: boolean;
  /** Present only when `finalized`; identical in shape to an all-at-once rebuild. */
  outcome?: RebuildOutcome;
  stagePath: string;
}

/**
 * ADR-0005's staged path: read **one** scope module, persist its extraction, and finalize once every
 * module of the scope is staged. Only the named module has to be open, so the caller can run
 * open → stage → close and keep Service Studio small and fast (live-evidence §S9).
 *
 * The snapshot a finalize writes is built from the same extractions, in scope order, through the
 * same `buildOutcome` as `rebuildScope` — a staged scope and a single-call scope are not
 * distinguishable from `graph.json`.
 */
export async function stageModule(options: StageModuleOptions): Promise<StageOutcome> {
  const { scope, snapshotPath, session, rules, module, graphDir } = options;
  const now = options.now ?? (() => new Date());
  const emit = options.onProgress ?? (() => undefined);
  const retryDelayMs = options.retryDelayMs ?? 250;
  const fetchReferenced = options.fetchReferencedElements === true;
  const fetchConcurrency = resolveFetchConcurrency(options.fetchConcurrency);
  const startedAt = Date.now();

  const inScope = scope.modules.find((m) => m.toLowerCase() === module.toLowerCase());
  if (inScope === undefined) {
    throw new OsgraphToolError(
      "SCOPE_INVALID",
      `module '${module}' is not in scope '${scope.name}'. Staged rebuild reads only scope modules; ` +
        `add it with defineScope first, or correct the spelling.`,
      { scope: scope.name, module, modules: scope.modules }
    );
  }

  try {
    emit({ type: "session", message: "acquiring session token" });
    await session.acquire();
    emit({ type: "session", message: "listing open modules" });
    const apps = await listOpenApps(session.reader, scope.name);
    // Only this module must be open — that is the whole point of staging.
    const [resolved] = resolveScopeModules({ name: scope.name, modules: [inScope] }, apps);

    const walked = await walkAndExtract({
      session,
      scope: scope.name,
      app: resolved.app,
      requested: resolved.requested,
      index: 1,
      total: 1,
      retryDelayMs,
      fetchReferenced,
      fetchConcurrency,
      emit,
      // The staged path always captures: `graphDir` is where its stage already lives, and a staged
      // run is exactly the case (one module at a time, hours apart) where re-reading live is worst.
      rawGraphDir: options.rawGraphDir ?? graphDir,
      now
    });

    const entry: StageEntry = {
      scope: scope.name,
      module: resolved.app.name,
      moduleType: resolved.app.moduleType,
      stagedAt: now().toISOString(),
      durationMs: walked.timing.durationMs,
      referencedOnlyCount: walked.timing.referencedOnlyCount,
      phaseDurationsMs: walked.timing.phases,
      concurrency: walked.timing.concurrency,
      extracted: walked.extracted
    };
    if (walked.timing.requested !== resolved.app.name) entry.requestedAs = walked.timing.requested;
    const stagePathWritten = writeStageEntry(graphDir, entry);

    const { entries, unreadable } = readStage(graphDir, scope.name);
    const missingModules = missingFromStage(scope.modules, entries);
    const stagedTimes = entries.map((e) => Date.parse(e.stagedAt)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    const stageAge =
      stagedTimes.length > 0
        ? {
            oldest: new Date(stagedTimes[0]).toISOString(),
            newest: new Date(stagedTimes[stagedTimes.length - 1]).toISOString(),
            spanMs: stagedTimes[stagedTimes.length - 1] - stagedTimes[0]
          }
        : null;
    const staged: StagedModuleSummary = {
      module: entry.module,
      nodeCount: entry.extracted.nodes.length,
      edgeCount: entry.extracted.edges.length,
      skippedCount: entry.extracted.skipped.length,
      referencedOnlyCount: entry.referencedOnlyCount,
      durationMs: entry.durationMs,
      phaseDurationsMs: entry.phaseDurationsMs,
      concurrency: entry.concurrency ?? fetchConcurrency
    };
    if (entry.requestedAs !== undefined) staged.requestedAs = entry.requestedAs;

    const base: StageOutcome = {
      mode: "staged",
      staged,
      stagedModules: entries.map((e) => e.module),
      missingModules,
      unreadableStageFiles: unreadable,
      stageAge,
      finalized: false,
      stagePath: stagePathWritten
    };
    if (missingModules.length > 0) return base;

    // Scope complete: finalize in scope order so the snapshot matches the all-at-once one.
    const byName = new Map(entries.map((e) => [e.module.toLowerCase(), e]));
    const ordered: StageEntry[] = [];
    for (const m of scope.modules) {
      const e = byName.get(m.toLowerCase());
      if (e && !ordered.includes(e)) ordered.push(e);
    }
    const outcome = buildOutcome({
      scopeName: scope.name,
      snapshotPath,
      rules,
      now: now(),
      extracted: ordered.map((e) => e.extracted),
      perModuleTiming: ordered.map((e) => ({
        module: e.module,
        requested: e.requestedAs ?? e.module,
        durationMs: e.durationMs,
        referencedOnlyCount: e.referencedOnlyCount,
        phases: e.phaseDurationsMs,
        concurrency: e.concurrency ?? fetchConcurrency
      })),
      startedAt,
      fetchConcurrency,
      stageAge,
      flows: { graphDir: options.rawGraphDir ?? graphDir, modules: scope.modules }
    });
    // The snapshot is already published; a stage file we cannot delete (locked, scanned, read-only)
    // must not turn a successful rebuild into INTERNAL_ERROR. Worst case it is re-read next time.
    try {
      clearStage(graphDir, scope.name);
    } catch {
      /* best effort */
    }
    emit({ type: "done", durationMs: outcome.result.durationMs, snapshotPath });
    return { ...base, finalized: true, outcome };
  } finally {
    // Same barrier as `rebuildScope`, and it matters more here: the staged loop's whole shape is
    // open → stage → close, so a `closeModule` follows this return within seconds (OSG-016 §B1).
    await session.reader.drain?.();
    session.release();
  }
}
