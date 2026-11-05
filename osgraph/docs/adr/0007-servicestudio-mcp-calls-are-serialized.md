---
status: superseded
superseded-by: ADR-0013 (servicestudio reads run four wide)
date-superseded: 2026-10-31
---

# servicestudio MCP calls are serialized: one in-flight request per osgraph process

> **SUPERSEDED (2026-10-31) by
> [ADR-0013](0013-servicestudio-reads-run-four-wide.md).** Read that one; this is kept for the
> record and for the two parts of it that survive: the "fewer calls" principle (it paid 8.2x and
> remains the bigger lever) and the measured sample below.
>
> What was wrong, and why: Live-retested on the same build (11.55.94.65328), ~250
> concurrent reads: **0** read-vs-read failures. The server admits **4** concurrent calls; two or
> three modules open changes nothing and gives no extra capacity; results are byte-identical to
> serialized. What survives is narrower than this ADR claims: the error below is real, but it needs
> a **`closeModule` landing on a module whose reads are still queued** - not concurrency. The temp
> OML is per **module session** (not per call, and not a single shared file); sharing it between
> concurrent reads is safe, tearing it down under them is not. Also note the message text here
> (`OML not found`) does not match the build's actual string (`Could not find file '...-in.oml'`),
> so `isTransient` never fired - a live defect, now fixed.
> Evidence, mechanism and a 126 min -> ~40 min scope projection:
> the discovery record `docs/discovery/2026-10-31-mcp-read-concurrency.md` — **local-only**, not
> published, because it is a raw measurement log naming real modules.
> The code has now changed: `client.ts` runs a width-4 FIFO semaphore (`maxConcurrent`, default 4)
> with a `drain()` barrier, and `isTransient` matches the real message. Live-verified at **3.35x**
> (57.9 s -> 17.3 s, identical digests). `rebuild.ts` still issues calls serially, so the
> scope-level win is not realised yet.
>
> **Both halves have since landed (OSG-016, 2026-10-31):** `rebuild.ts` now walks a module as two
> kind-level waves plus a `fetchConcurrency`-wide element pool, reassembling every result in listing
> order; `drain()` is awaited before any rebuild returns. The replacement ADR is
> [ADR-0013](0013-servicestudio-reads-run-four-wide.md).

Live evidence (2026-10-29): two read calls issued concurrently (`getScreenNames` and `getActionNames`, in parallel with other reads) failed with `[-32000] OML not found: C:\Users\LENOVO\AppData\Local\Temp\ServiceStudio.MCPServer\<id>-in.oml`, while the same calls retried one after the other succeeded. The server exports a temporary OML per call into a shared temp folder and concurrent calls race on that file. Parallel extraction is therefore not a speed-up on this build; it is a source of spurious element failures that would burn OSG-011's one retry and drop elements from the graph.

Decision:

- osgraph's servicestudio client owns a **promise queue**: at most one request is in flight at any time, across every module in a scope rebuild and across tool calls (`listApps` validation included). No parallel extraction across modules or kinds; a scope rebuild walks modules, then kinds, then elements, strictly in sequence. The queue lives in the client, so extractor code stays free of concurrency logic.
- The error text matching `OML not found` (JSON-RPC code `-32000`) is classified **transient**: it counts as the failed attempt in OSG-011's one-retry-then-drop rule, with a short fixed back-off (250 ms) before the retry. It is never treated as a connection failure (OSG-004 all-or-nothing) and never as an auth failure (ADR-0004 `TOKEN_EXPIRED`).
- The guarantee is per process. osopener polls `listApps` through its own client; the orchestrator must not run `openModule` and `rebuild` at the same time (it never needs to: `rebuild` requires every scope module to be open first, ADR-0005). This sequencing is a documented caller rule, not something osgraph enforces.

Consequence: rebuild wall time ≈ the sum of every servicestudio call's latency, with no fan-out. `rebuild`'s response and the live run report (`osgraph/tests/live/demoportal-scope.md`) record `durationMs` per module so a measured sample lands here once the live tier runs; if it proves too slow the only acceptable optimisation is fewer calls (e.g. one `getDataModel` per module already covers all entities), never more concurrency. Rejected alternative: a small concurrency limit (2–3) with retries — rejected because the race is on a single shared file, so any concurrency reproduces the failure and only makes it intermittent.

## Measured sample (added 2026-10-30 by the S6 fix run, from the audit's finding F3)

The sample this ADR asked for, counted from the live names listings of the target module
(a local discovery capture of that module's names listings, read-only, during Step 0) rather
than estimated. One module, one scope, Reactive, so six kind-level calls plus one `listApps`.

| kind | listed entries | distinct names (what a fetch costs today) | `IsReferenced: true` | fetched after the fix |
|---|---|---|---|---|
| screens | 37 | 37 | 0 | 37 |
| blocks | 319 | 312 (7 duplicate names, ADR-0008) | **319** | **0** |
| client actions | 6 | 6 | **6** | **0** |
| server actions | 5 | 5 | **4** | **1** |
| **element fetches** | **367** | **360** | **329** | **38** |

Totals per rebuild of this one-module scope, including the 6 kind-level calls and 1 `listApps`:

| | before | after |
|---|---|---|
| servicestudio calls | **367** | **45** |
| at the measured 12.5 s per call | ≈76 min | **≈9 min** |

An **8.2× reduction**, entirely through "fewer calls" — no concurrency anywhere, so the one-in-flight
guarantee above is untouched. What the 322 dropped fetches returned was a one-statement dependency
stub per element: **0 of the 312 captured block texts** contain their own
`/*** creating I…Block '<Name>' ***/` anchor, so each carried no information beyond the
`// I<Kind>Signature <Module>/<Flow>/<Name>` comment ADR-0006 already recovers at every *reference*
site. The only thing lost is an isolated, edge-less external node for a referenced element that
nothing in the module actually uses.

Two corrections to this ADR's own arithmetic, from the same Step 0 capture: a call costs **≈12.5 s**,
not the ≈9 s assumed above; and after the fix a kind's whole risk concentrates into its single
listing call, which is why a failed kind-level read now aborts the rebuild (ADR-0011) instead of
degrading to an empty listing.

The escape hatch is `OSGRAPH_FETCH_REFERENCED_ELEMENTS=1`, for a Studio build that reports
`IsReferenced` differently from the one measured here; the filter compares `=== true` and never
`!== false`, so a build that omits the field keeps the old fetch-everything behaviour.

### The same sample at scope level (38 modules), which is the number that matters

The table above is **one module**. The live scope is 38 (goal.md Step 0, 2026-10-30 01:18: 41 modules
referenced, 4 non-openable). Scope cost is `1 listApps + Σ per module (6 kind-level calls + element
fetches)`, so with only `demoportal`'s element count known:

| | calls | at 12.5 s |
|---|---|---|
| 6 kind-level calls × 38 modules | 228 | ≈48 min |
| + 1 `listApps` + `demoportal`'s 38 fetches | **≥267** | **≥56 min** |

That is a **floor**, not an estimate: the other 37 modules' elements are undiscovered, and every one
they have adds 12.5 s. Before F3 the same scope was ≥589 calls, ≥2 h.

Two consequences worth recording here:

- F3 moved the bottleneck. Element fetches are no longer the dominant cost at scope level; the
  **6 kind-level calls per module** are — 228 of them, ≈85% of the floor. The only remaining
  "fewer calls" win of that size is collapsing the two `listApps` calls per rebuild (S6 audit,
  "sound (compliant), but collapse it") and skipping kinds a module provably cannot have; neither is
  decided, and neither is a builder's call.
- ADR-0011's "the abort is cheap by construction" paragraph says *"after F3's fix the whole live
  scope is ≈44 calls, so retrying is minutes, not an hour"*. That ≈44 is the **one-module** figure
  measured above; the 38-module scope is ≥267 calls. The *policy* is unaffected — a kind-level
  failure still surfaces within the first six calls of the module that failed — but the work lost is
  every module already walked, which at scope level is up to ≈56 min rather than ≈9 min. Whether
  that changes the abort-vs-resume balance is a Decider question, flagged, not answered here.

## Second measured sample (2026-10-30, three real modules) — cost is **per module**, and the scope is hours

The earlier sample in this ADR was one module extrapolated. With three modules open and each
one's 6 kind-level calls timed separately, the picture changes:

| module | 6 kind-level calls | per call | largest payload in the set | own elements left after the referenced-only filter |
|---|---|---|---|---|
| `MOD_DEMO_CommonLookups_LKP` | **29.7 s** | ≈4.9 s | `getDataModel` 258 kB | 47 (47 server actions; no screens/blocks/client actions) |
| `demoportal` | **64.9 s** | ≈10.8 s | `getWebBlockNames` 69 kB | 38 (37 screens + 1 server action) |
| `MOD_DEMO_Portal_CW` | **110.8 s** | ≈18.5 s | `getStructures` 56 kB | 65 (1 screen, 56 of 158 blocks, 2 client, 6 server) |

Two corrections to this ADR's own arithmetic:

1. **Per-call latency is a property of the module, not of the payload.** The LKP returned
   258 kB in 5.1 s; `MOD_DEMO_Portal_CW`'s `getScreenNames` returned **164 bytes in 20.2 s**.
   Cost therefore cannot be estimated from output size — only measured per module. The single
   "≈12.5 s per call" figure recorded earlier is this build's *average over one module*; the
   real range across three modules is **4.9 – 18.5 s**.
2. **Projecting each module at its own measured rate**: 4.3 min + 7.1 min + 21.9 min =
   **≈33 min for three modules**, mean ≈11 min each. The `demoportal` scope is 38
   modules and about 25 of them are `_CW` (the expensive shape in this sample), so a full
   scope rebuild is **≈4–8 hours**. The "30–60 minutes" in the rebuild tool description and
   the "≥56 min floor" derived from the one-module sample are both too low; `demoportal`
   *alone* is ≈7 min.

Cheap way to replace this extrapolation with a number: open all 38 modules (≈15 s each via
osopener) and run only the 6 kind-level calls per module (≈1 h). That yields every module's
exact element count and per-call cost — hence the real rebuild duration — without fetching a
single element.

`listApps` is free (**37 ms**) and is not part of the cost model.
