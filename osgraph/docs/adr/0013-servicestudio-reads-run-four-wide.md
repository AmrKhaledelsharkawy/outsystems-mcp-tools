---
status: accepted
date: 2026-10-31
supersedes: ADR-0007 (servicestudio MCP calls are serialized) — in full
extends: ADR-0011 (a kind-level read failure aborts the rebuild) — by fixing which failure in a wave aborts it
keeps: ADR-0007's "fewer calls" principle, which paid 8.2× and still does
adds: `OSGRAPH_MAX_CONCURRENCY` / `OsgraphConfig.fetchConcurrency`; `ServiceStudioClient.drain()`; `result.fetchConcurrency`
---

# servicestudio reads run four wide, and the only unsafe thing is closing a module under them

ADR-0007 decided that the servicestudio MCP answers one call at a time and that osgraph must
therefore serialize every read. That cost the `demoportal` 30-module scope a **measured
7551 s (126 min)** of read time. This ADR replaces it outright, on live evidence from the same
build it was written against.

All measurements: Service Studio **11.55.94.65328**, MCP `http://127.0.0.1:41820/mcp`, 2026-10-31.
Full record, including the scripts and raw timings:
`docs/discovery/2026-10-31-mcp-read-concurrency.md` — **local-only**, not published, because it is a
raw measurement log naming real modules
(§3 the width sweep, §4 why ADR-0007 was wrong, §6 the multi-module arm, §8 the osopener arm, §11
what was implemented).

## What the measurements said

- **The server admits exactly 4 concurrent calls** (§3.2). Widths 1, 2, 3 and 4 all complete in
  ≈11.5 s; a 5th caller waits a whole ≈11 s wave. Above 4 the extra callers only queue
  *server-side*, which inflates each call's observed latency without adding throughput — a timeout
  risk, not a speed-up.
- **Concurrent reads do not corrupt anything** (§3, §4). ≈250 concurrent reads produced **0**
  read-vs-read failures, and every result was byte-identical to the serialized one.
- **The pool is one per *process*** (§6.2), not per module and not per call. With two and with three
  modules open the width stayed 4. A second open module buys no capacity.
- **Per-call latency is a property of the module, not the payload** (§6.3) — independently
  re-confirmed, so ADR-0007's one correct observation survives.
- **The temp OML is per *module session***, not a single shared file (§8). *Sharing* it between
  concurrent reads is safe; *tearing it down* under a queued read is not.
- **ADR-0007's own failure needed a `closeModule`** (§8.2–8.4). Closing a module while reads for it
  are still **queued** fails them all with
  `[-32000] Could not find file '…\ServiceStudio.MCPServer\<guid>-in.oml'`. A read that has already
  exported survives the tab closing under it; one still waiting its turn does not. `openModule`
  during reads is harmless (44/44 OK across 3 opens), and closing a module nobody is reading is
  harmless (44/44 OK).
- **ADR-0007's transient matcher never fired** (§9). It matched `OML not found`, which is not the
  string this build returns, so the one error the retry exists for was classified non-transient and
  ADR-0011 aborted whole rebuilds on a single blip. A live defect, fixed.

## Decision

1. **Reads run up to 4 at a time.** `ServiceStudioClient` owns a FIFO semaphore of width
   `maxConcurrent` (default `DEFAULT_MAX_CONCURRENT = 4`), replacing ADR-0007's one-in-flight
   promise chain. The gate is **per client instance**, and the server creates exactly one client per
   process (`createSharedSessionFactory`), so it is per process — the unit the server's limit is
   measured in.
2. **The caller fans out to match.** A gate is a cap, not a fan-out: with the semaphore alone
   `rebuild` still issued one call at a time and stayed at 126 min. `src/rebuild/rebuild.ts`
   therefore walks a module as **two kind-level waves** (the 4 name listings; then
   `getDataModel` ∥ `getStructures`) and then fetches elements through an explicit worker pool
   `fetchConcurrency` wide. The pool is explicit rather than `Promise.all` so that a 312-element
   module creates 4 pending promises, not 312.
3. **The width is one number, configurable.** `OsgraphConfig.fetchConcurrency` feeds both the
   client's `maxConcurrent` and the walker's pool; `OSGRAPH_MAX_CONCURRENCY` overrides it, clamped
   to `[1, 8]`. **`1` reproduces the pre-OSG-016 serial walk exactly**, element for element — the
   escape hatch if a different Studio build regresses. A bad value is ignored rather than fatal.
   The width used is reported as `result.fetchConcurrency` and `perModule[].concurrency`, so a
   recorded measurement always says which width produced it.
4. **Completion order never reaches an output.** This is the load-bearing constraint, because
   `tests/live/demoportal-scope.md` records two consecutive live rebuilds producing
   byte-identical artifacts and ADR-0012 requires `reextract` to reproduce `flows.json`
   byte-for-byte. Every result is reassembled in **listing order**: element texts, the `raw/`
   manifest's `texts` order, and `skipped` (which is why `guarded()` *returns* its skip record
   instead of appending it). The two module texts are captured after their wave settles, in fixed
   order, for the same reason.
5. **A wave's failure is resolved by listing order, not by time.** Under ADR-0011 the first
   kind-level failure aborts the rebuild. In a wave the siblings are already in flight, so the pool
   lets them settle and rethrows the first failure **in input order** (screens, blocks,
   clientActions, serverActions). ADR-0011's "fail fast, not fail complete" is preserved — the
   wave is 4 calls, not a module's worth — and *which* failure aborts a rebuild no longer depends on
   which call happened to answer soonest.
6. **Drain before close — a hard rule.** `client.drain()` resolves once nothing is in flight or
   queued. `rebuildScope` and `stageModule` both await it before returning, success or abort, so **a
   returned tool response is itself the barrier** and an out-of-process caller (the live scripts,
   osopener drivers) needs only to wait for its call to answer before closing a module. Concurrency
   did not create this hazard; it widened the window, so the barrier matters more now, not less.
7. **`rebuild` stays serialized process-wide.** `REBUILD_IN_PROGRESS` is retained, with a changed
   justification: not a race any more, but **budget-sharing**. One pool of 4 is the whole process's
   capacity, so two concurrent rebuilds would halve each other (§6.2) and make every reported
   timing meaningless. Do not relax it on the grounds that the race is gone.
8. **Write paths stay strictly serialized.** `applyModelApiCode`, `omlRefreshReferences` and
   `omlPublish` were never tested at any width (§12). osgraph never calls them, and nothing here
   licenses concurrency on them.
9. **ADR-0007's "fewer calls" principle is kept.** It paid 8.2× by not fetching `IsReferenced: true`
   entries, and it remains the bigger lever. The two compose: concurrency shortens whatever call
   list is left.

### Retry layering, decided deliberately

Before the `isTransient` fix the client never retried a temp-OML error, so `guarded()`'s single
retry was the only one. Now both layers can fire, and that was an accident of two fixes landing
together. The decision is to **keep both, with a stated budget**:

| failure | client attempts | walker attempts | total | back-off |
|---|---:|---:|---:|---|
| transient temp-OML (`isTransientOmlError`) | 2 | 2 | **4** | 250 ms, then `retryDelayMs` |
| any other `ServiceStudioCallError` | 1 | 2 | **2** | `retryDelayMs` |

Rationale: the transient error is exactly the one concurrency makes more likely, an extra attempt
costs seconds, and the alternative outcomes are an element silently skipped (OSG-011) or — at kind
level — a 40-minute rebuild aborted (ADR-0011) over a blip. Every attempt past the first is emitted
as a `retry` progress event, so the budget is observable rather than merely documented. The rejected
option was to let the client own transient retries and drop the walker's for `transient === true`:
cleaner, but it buys nothing and spends robustness where a rebuild is most expensive.

## Consequences

- **`demoportal` 30-module scope: 7551 s → 2366 s = 3.19×, saving 86.4 min. MEASURED
  2026-10-31** (discovery §15), against a model that predicted 2402 s / 3.14× — right to 1.4%. Call
  count is unchanged at 778; this is not a "fewer calls" change. Supporting measurements: 3.35× at
  the client over 8 real reads, and 2.91× end-to-end on a single 126-element module. Small modules
  (`E ≤ 5`) land at 2.4–2.8×, large ones at 3.5–3.7×; the `MOD_DEMO_Portal_CW` outlier the model
  distrusted turned out to be the **best** performer at 3.74×, confirming it is a genuinely
  expensive module export rather than a measurement artefact.
- **The ceiling is ≈3.3×, not 4×**, and the reason is measured: per-call latency rises from ≈7.9 s
  to ≈11 s under width 4 because the server interleaves the four. The win is 4 calls per ≈11 s.
- **`phaseDurationsMs` no longer partitions `durationMs`.** Phases are now overlapping wall-clock
  spans (the `dataModel` and `structures` phases overlap outright), so above width 1 they sum to
  more than the module's duration. Documented on the field, and `concurrency` is reported beside
  them so a reader can interpret them. Not silently left to imply something false.
- **The `element` progress event interleaves.** Its `index`/`total` are the element's *listing*
  position, not a monotonic counter — stable between a width-1 and a width-4 run of the same module,
  which a serial counter could not be. Deliberate; do not "fix" it.
- **Fanning out across element *kinds*** (running the screens/blocks/clientActions/serverActions
  phases concurrently) is left undone. It would help small modules most, but it breaks the
  one-phase-at-a-time assumption in the progress events and `phaseDurations`. A follow-up, once §A
  is measured.
- **Parallelising the flow parser is rejected on measurement** (§7): 86–88 ms per scope, ≈0.7 s for
  all 30 modules — 0.009% of rebuild time, against 34 ms just to spawn 4 `worker_threads`.
- **Live re-reads are not byte-reproducible, and that is upstream of this decision** (discovery
  §16, OSG-017). The Model API emits an action's nodes in an unstable order: 4 serial isolated reads
  of one unchanged block returned 3 distinct texts of identical length. Across the 30-module scope
  that moved exactly one edge (4079 → 4080, and the new value is the correct one). It is **not**
  caused by concurrency — every probe was serial — but it does mean the determinism this ADR
  guarantees is "same inputs ⇒ same output", which is what `reextract` from a fixed `raw/` capture
  gives (ADR-0012), and not "two live reads agree".
- **Raising the width above 4 is rejected**: the server does not admit more, so a 5th caller only
  queues. The clamp allows 8 purely as headroom for a future build that admits more; nothing here
  claims one does.
