---
status: accepted
date: 2026-11-21
extends: ADR-0007 (fewer calls), ADR-0013 (reads run four wide), ADR-0009 (placeholders)
adds: per-kind `kinds` in `timings.json`; `osgraph kinds`; `OSGRAPH_SKIP_KINDS` / `OsgraphConfig.skipKinds`; `skippedKinds` in `meta.json`, the raw manifest and the rebuild result
---

# Read cost is measured per kind, and a kind that yields nothing can be switched off

A rebuild reads six kinds per module: the whole-module `Entity` and `Structure` texts, and the
`Screen`, `Block`, `ClientAction` and `ServerAction` listings plus one text per element (service
actions are a second listing of `ServerAction` and are accounted to it). Every one of those is a live
Service Studio call, and the cost of a scope is dominated by them. ADR-0007 reduced the number of
calls; it never asked which of the remaining calls pay for themselves.

## Decision

1. **Measure.** Every logical read call is timed and filed under its kind. `timings.json` records,
   per module and per kind: `calls`, `totalMs`, `p50Ms`, `p95Ms`. A call's latency includes its
   retry, and failed or skipped reads count (they cost time too). The values are per call, so read
   them against the run's width (4, ADR-0013); `totalMs` is cost, not wall-clock.
2. **Report.** `osgraph kinds --scope <name>` is offline (it reads `timings.json`, `graph.json` and
   `flows.json`) and prints, per kind, read time against edges out, edges in and flow actions. A kind
   with read time and **zero edges in either direction and zero flows** is listed with its total
   read time. Edges *in* are counted deliberately: `Entity` and `Structure` yield few edges of their
   own but are the targets of most data-access edges, and counting only edges out would nominate the
   kind whose absence hurts `queryImpact` most. A kind the snapshot was built without is never
   called zero-yield (its zeros are configuration), and without flow data no kind is.
3. **Switch off.** `OSGRAPH_SKIP_KINDS` (comma or space separated, case-insensitive) names kinds a
   rebuild does not read: no listing, no element fetch, no raw capture. Only `Entity`, `Structure`,
   `ClientAction` and `ServerAction` are accepted; anything else is `CONFIG_INVALID` rather than
   silently ignored.
4. **Not `Screen` or `Block`.** Their names feed the extractor's flow index, which disambiguates
   bare references in the texts of *every other kind*. Leaving them unread would change edges that
   other kinds contribute, which is the one thing a switch-off must never do. They stay readable-only.
5. **Say so.** A snapshot built with a kind off is partial by configuration, and must not look
   complete: `skippedKinds` is written to `meta.json`, to each module's raw manifest (so offline
   `reextract` reproduces it) and to the rebuild result. The key is absent when nothing was switched
   off, so a default build's artifacts are byte-identical to before this ADR.
6. **Width stays 4.** Nothing here changes `fetchConcurrency`; a switched-off kind only removes calls
   from the waves. `drain()` still runs on every path out.

## The default is "nothing off", pending measurement

The issue asks for the default to be decided from measured data. The measurement is a live
Service Studio step on a 30-module scope (`timings.json` before and after, totals recorded on the
issue) that an agent cannot perform, so **the default is `DEFAULT_SKIP_KINDS = []`** until a person
records it. When that data exists, the decision belongs here: change the constant, and amend this
section with the totals that justified it. Replay fixtures cannot make that call; they only show the
report is computed correctly.

## What a switched-off kind changes

- Its elements are absent from `graph.json`, and edges that target them point at **placeholders**
  (ADR-0009), so impact and path queries over those elements are degraded, visibly.
- Every other kind's edges and flows are unchanged: tested by comparing a full read with a pruned one
  (`tests/readKinds.test.ts`). The module-to-module rollup edges are the exception in one direction
  only: a rollup edge caused solely by a switched-off kind's text disappears; no edge is ever added.
- It is not a cache. Switching a kind back on and re-running the module re-reads it live.
