---
status: accepted
revises: OSG-011 (scopes its skip-and-continue to element reads); adds one `OsgraphErrorCode`
strengthens: ADR-0008 ("the names listing is mandatory input, not an optimisation"); ADR-0009 ("a full rebuild reads every listed element")
---

# A failed kind-level read aborts the rebuild; only an element read is ever skipped

A rebuild reads a module through three kinds of servicestudio call. **Module texts** (`getDataModel`, `getStructures`) — one call each, covering every entity / every structure. **Names listings** (`getScreenNames`, `getWebBlockNames`, `getActionNames(client|server)`) — one call each, enumerating a whole kind. **Element texts** — one call per listed element. OSG-011 governs the third (one retry, then drop the element and count it); OSG-004 governs connection and auth failure (all-or-nothing, previous snapshot untouched). The S6 audit (2026-10-30, finding **F4**) found that nothing governs the first two, and that `src/rebuild/rebuild.ts:211-219` quietly routed them through OSG-011 anyway: `moduleText` falls back to `""`, `listing` falls back to `[]`, and `:309` flattens the reason to `TOOL_ERROR` — the same reason one failed element gets.

Measured on the real live target (`demoportal`, counts from a local discovery capture of its names listings: 37 screens, 319 blocks, 6 client actions, 5 server actions): one failed `getWebBlockNames` loses **319 elements** and reports `graphCompleteness.skippedCount: 1`; one failed `getDataModel` loses **every entity in the module** for the same `skippedCount: 1`. The much-thinner snapshot is then written over the previous good one by the atomic replace, and the caller's next `queryImpact` / `listViolations` reads as clean. `skippedCount: 1` for a 319-element loss is camouflage, not the disclosure OSG-011 asked for.

The decisive property is not magnitude, it is **who holds the denominator**. OSG-011's skip-and-continue is honest only because the names listing supplies the count the skip is measured against: *N listed, M skipped, N−M in the graph*. A kind-level call **is** that denominator. When it fails, the loss is not merely large, it is unquantifiable from the data that did arrive — there is no N to subtract from, and no name to attribute the gap to. No response field can recover it after the fact, which is why the audit's option (b) (`failedKinds`, distinct reasons, `allowPartial`) can only ever tell a caller *that* a kind is gone, never *how much* of the module is gone. A single element read does not have this property: the listing still proves the element exists, so its absence stays countable, attributable and loud. That line — denominator-bearing or not — is the line this ADR draws.

Decision — option **(a), abort**, with no distinction between names listings and module texts:

- **One rule for all six calls.** A names listing and a module text are the **same case**: each is the sole source of truth for one whole kind in one module, so each fails unobservably. `getDataModel` covering every entity in a single call makes it *more* load-bearing, not a different class — and the only thing a verifier could use to notice an empty data model (ADR-0009's `placeholderCount`, inflated by entity edges from screens and actions) does not exist for a failed listing, because nothing was listed. One rule, no per-kind carve-outs: a **kind-level read** that fails after OSG-011's single retry aborts the rebuild.
- **What is thrown.** `OsgraphToolError` with **one new code, `KIND_READ_FAILED`** — added to `OsgraphErrorCode` in `src/types.ts` and explicitly *not* a reuse: `SERVICESTUDIO_UNREACHABLE` and `TOKEN_EXPIRED` would lie about a healthy session (ADR-0007's serialization makes a lone failed call ordinary), and `INTERNAL_ERROR` claims an osgraph bug and is the one path whose message skips redaction (F12). `details` carries `{ scope, module, kind, call, phase, attempts: 2 }` — `call` being the servicestudio tool name (`getWebBlockNames`), `phase` the existing `RebuildPhase`. The message names the module, the kind and the tool, states that the previous snapshot is untouched, and tells the caller to rebuild again.
- **Fail fast, not fail complete.** The throw happens at the failing call, not after collecting every kind-level failure in the scope. Under ADR-0007 every further call is ≈9 s of serialized work on a rebuild that is already doomed, and the first failure is enough to act on.
- **The abort is cheap by construction, which is why it is affordable.** `ModuleWalker.walk` issues all six kind-level calls for a module *before* any of its element texts. A kind-level failure therefore surfaces within the first six calls of a module — roughly a minute of live reads — never 48 minutes in. The only work lost is the modules already walked, and after F3's fix the whole live scope is ≈44 calls, so retrying is minutes, not an hour.
- **No partial snapshot, and no `allowPartial` input.** `writeSnapshot` is already reached only after every module walks clean, so the existing OSG-004 temp-file-then-atomic-replace path needs no change: the previous snapshot survives untouched and `rebuild` returns an error, exactly like `MODULES_NOT_OPEN`. An opt-in flag is rejected — see below.
- **`graphCompleteness` gains nothing, and that is the point.** No new field on `GraphCompleteness` and none on `RebuildResult`. A kind-level loss can never appear in a written snapshot, so the envelope has nothing to disclose and no opportunity to understate. What the decision buys instead is an **invariant that makes the existing field honest**: every entry of `snapshot.graph.osgraph.skipped` names exactly one element, so `graphCompleteness.skippedCount` is always a count of elements and never a count of kinds. The `name: "*"` sentinel is deleted from the codebase; no code path may push a skip whose `name` is `"*"` or empty. On the error response, `runTool`'s `completenessFor` keeps reporting the **previous** snapshot's `{ skippedCount, lastRebuildAt }`, which is correct and not a regression: that snapshot is the one the caller's next query will actually read, and reading `graphCompleteness` without reading `error` is already a caller bug on every existing abort path. (F7's separate complaint — `completenessFor` returning `{0, null}` for an *unreadable* snapshot — is untouched by this ADR.)
- **An empty listing is distinguishable from a failed one by control flow, not by value.** A failed kind-level read never returns a value at all, so `[]` reaching the extractor can only mean "this module genuinely has zero elements of this kind" (the synthetic `x` fixture, with no screens and no blocks, is already that case). Concretely: kind-level calls stop going through the skip-recording `guarded` path. A sibling guard — same single retry, same back-off, same progress events — **throws** `KIND_READ_FAILED` instead of pushing a skip and returning `undefined`; `moduleText` and `listing` return `Promise<string>` and `Promise<ServiceStudioElementName[]>` with the `?? ""` and `?? []` fallbacks **deleted**. Removing those two literals is the type-level proof: after this change, emptiness can only come from the server. A legitimately empty module text (`""` from a successful `getDataModel`) stays legitimate under the same rule. The resulting snapshot contract is one line: **a written snapshot is one in which all six kind-level reads succeeded for every module in the scope.**
- **Progress.** The `element` progress event's `outcome` union gains `"failed"`, emitted once at the failing kind-level call before the throw. `formatProgress` interpolates `outcome` and needs no new branch, so the stderr stream shows exactly which call killed the run.
- **Interaction with F3 — a kind that yields zero *fetched* elements is not a failure.** F3's fix stops fetching listing entries whose `IsReferenced === true`; on the live target that is 319/319 blocks, 6/6 client actions and 4/5 server actions, so after F3 a *successful* `getWebBlockNames` legitimately produces **zero** block fetches and zero in-module Block nodes. This policy cannot confuse the two, because its trigger is **the kind-level call throwing** and never the number of elements that came out of it. No "0 elements ⇒ failure" heuristic exists anywhere in the rebuild, and this ADR forbids adding one. Three states per kind per module stay distinct:

  | state | kind-level call | listed | fetched | recorded as |
  |---|---|---|---|---|
  | kind read failed | throws after its one retry | — | — | `KIND_READ_FAILED`; no snapshot written |
  | kind genuinely empty | ok | 0 | 0 | nothing; `perModule` counts only |
  | every entry referenced-only (F3) | ok | N | 0 | F3's `referencedOnlyCount: N`; external nodes still recovered from every reference site (ADR-0006) |

  Two ordering rules keep it that way: the `IsReferenced` filter is applied **after** the listing call has returned successfully, inside `ModuleWalker.elements`, so it can never mask or imitate a listing failure; and `referencedOnlyCount` is a field of its own that must never feed `skipped`, `perModule.skippedCount` or `graphCompleteness.skippedCount` — a referenced-only entry is complete data, not missing data. F3 also concentrates all of a kind's risk into its single listing call (for blocks on the live target, the listing becomes the *only* block-related call), which argues for this ADR rather than against it: that one call is now the sole gate for 319 entries, and it is call #2 of the module. A Studio build that omits `IsReferenced` must keep today's behaviour and fetch the entry (`=== true`, never `!== false`); `undefined` may never be read as "referenced".

Rejected alternatives:

- **(b) Loud partial with `allowPartial: true`.** Rejected on two grounds. It cannot report the magnitude it promises to make unmissable — the denominator died with the call — so `failedKinds` is a boolean dressed as disclosure, and a caller who opts in still cannot tell a 319-block loss from a 6-element one. And it buys that weaker guarantee for a new tool input, two new skip reasons, a new `RebuildResult` field and a reshaped `graphCompleteness` carried by every tool response, in a v1 that ships now. The real-world need it imagines — one module whose listing is permanently broken — already has an answer that costs nothing: leave that module out of the scope (ADR-0005 makes the scope the user's list, and nothing else).
- **A partial snapshot written to a side path.** Two artifacts per scope, one of which answers queries wrongly, is a worse version of the same hazard; and ADR-0005 fixes exactly one snapshot path per scope.
- **Treating only names listings as fatal and letting module texts degrade.** Tempting because an empty data model leaves a footprint (ADR-0009 placeholders) while an empty listing leaves none. Rejected: entity→entity FK edges vanish with no footprint at all, every entity-targeting edge silently retargets to a placeholder, and `listViolations` over CS-layer references becomes unreliable — a different shape of the same silent-wrong-answer bug, for a saving of one `if`.
- **More than one retry for kind-level calls, given how much rides on each.** A second retry would be a new rule for one class of call; ADR-0007's transient `OML not found` already consumes OSG-011's single retry, and the caller re-running `rebuild` is the retry that belongs at this level.

Follow-ups this ADR requires:

- OSG-011 gets an amendment note scoping its skip-and-continue to element reads (exact sentence handed to the orchestrator with this decision). **ADR-0008 needs no amendment**: its "the names listing is therefore mandatory input for these two kinds, not an optimisation" is now true as written for the first time, and this ADR's front matter carries the cross-link.
- `osgraph/GLOSSARY.md` may take one entry, **Kind-level read** — "the single servicestudio call that is the sole source of truth for a whole element kind in one module: a names listing or a module text; distinct from an element read, whose loss the listing can still count and name" (_Avoid_: bulk read, kind fetch).
- `tests/rebuild.test.ts:194-200` asserts today's behaviour and must be replaced; the element-level case at `:170-184` is the contrast case and must keep passing **unchanged**.

Live-verification open points:

- Confirm against the live target that a kind-level failure is actually rare: the live run report (`osgraph/tests/live/demoportal-scope.md`) should record whether any of the six kind-level calls per module ever needed its retry. If listings turn out to fail routinely under ADR-0007's serialization, the back-off (not the policy) is what to revisit.
- Confirm that `getDataModel` on a module with no entities returns a parseable empty text rather than an error — if Studio errors instead, that module can never be rebuilt under this policy and the empty case needs an allow-list.
- Record the measured cost of one aborted-and-retried rebuild (calls spent before the abort) alongside ADR-0007's timing sample, so the "abort is cheap" claim above is evidence rather than arithmetic.

## Correction (2026-10-30, orchestrator) — the cost figure in "the abort is cheap by construction" was wrong

That paragraph says *"after F3's fix the whole live scope is ≈44 calls, so retrying is minutes,
not an hour."* **≈44 is the one-module figure for `demoportal` alone, not the scope.**
The real `demoportal` scope is 38 modules (filled into goal.md on 2026-10-30 from
a local discovery capture of its cross-module refs), and at the measured ≈12.5 s per
servicestudio call:

| | calls | wall time |
|---|---|---|
| 1 `listApps` + 6 kind-level reads × 38 modules + `demoportal`'s 38 element fetches | 267 | ≈56 min (**floor**, assumes the other 37 modules own nothing) |
| + the 295 elements of those modules that `demoportal` references (each one is *local* to its producer, so each is fetched when that producer is walked) | 562 | ≈1 h 57 min (**known lower bound**) |
| realistic, if producers own 2–4× what `demoportal` happens to use | 857–1447 | **≈3–5 h** |

**The decision is unaffected, and the reason the paragraph gave is still true in the part that
matters:** all six kind-level calls of a module are issued *before* any of its element texts, so a
kind-level failure still surfaces within the first six calls of the failing module — **detection**
stays cheap, which is what makes fail-fast right.

What is **not** cheap is the *work discarded*: every module already walked, up to hours at scope
level rather than ≈9 minutes. That is a genuine argument for a resumable rebuild (per-module
caching, so a retry re-reads only the failed module), which v1 does not have and this ADR does not
provide. Recorded here as the open consequence rather than silently re-opening abort-vs-partial:
abort remains correct for v1 because a partial snapshot is unquantifiable (the argument above,
unchanged by cost), and "expensive to retry" argues for **resumability**, not for writing a graph
nobody can trust.

Found by the S6 fix builder while implementing this ADR; arithmetic re-derived independently by the
orchestrator. ADR-0007's own ≈9 s per-call assumption was corrected to ≈12.5 s the same day.
