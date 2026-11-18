---
status: accepted
date: 2026-11-06
supersedes: ADR-0002 (rebuild is explicit and caller-triggered, not passively detected) — in full
keeps: ADR-0002's finding that the servicestudio MCP exposes no publish event; the detector polls a *different* source
extends: ADR-0005 (one graph per user-defined scope) — the scope is also the unit a revision vector covers
constrains: ADR-0013 (reads run four wide) — the measured per-module read cost is what makes freshness a target rather than a bound
adds: the vocabulary `Revision`, `Revision vector`, `Generation`, `Shard`, `Manifest`, `Watcher`, `Dirty queue` (see [`GLOSSARY.md`](../../GLOSSARY.md))
---

# Publishes are detected by polling an authoritative current-state read, bridged to events

ADR-0002 decided that osgraph has no passive change detection: a caller invokes `rebuild` after a
publish, and the snapshot is only ever as fresh as that last call. That decision was correct about
the mechanism available to it and wrong about the mechanism available at all, and the whole
automatic-refresh backlog (issues #2–#37) builds the thing it forbids. This ADR replaces it so that
an agent reading the decision record before writing watcher code does not hit a direct
contradiction.

## What ADR-0002 got right, and is kept

**The servicestudio MCP exposes no publish event.** It is synchronous and caller-driven:
`omlPublish` / `omlMerge` report only to whoever called them, and there is no webhook, event log or
pollable field by which another process learns "a publish just completed". That observation stands
and is not re-litigated here. **OutSystems 11 has no native Service Studio publish webhook, and
nothing in this backlog pretends otherwise.**

What ADR-0002 did not consider is that Service Studio is not the only authority on what is
published. The platform's own deployment metadata — read-only, authorized, environment-scoped —
knows the current published version of every module in DEV. That is a *different source*, outside
the MCP, and it can be read.

## Decision

1. **Detection is a poll of an authoritative current-state read, bridged to events.** A
   `ChangeSource` adapter answers one narrow question — *what is the current published revision of
   each module in this environment?* — and the Watcher turns successive answers into change events
   by comparing them. The bridge is the design, not a workaround for a missing webhook: there is no
   webhook to miss.
2. **The source is behind an interface, and the rest of the system depends on the interface.**
   Nothing above the adapter knows which platform API produced a revision. The first implementation
   reads the LifeTime v2 read-only surface; an installation that cannot serve it can be given
   another adapter without touching the queue, the worker or the publisher.
3. **A revision is an opaque equality token.** It is compared for equality and never ordered.
   "Newest" is whatever the authoritative current-state read returns right now — never inferred from
   a GUID, a version string or a timestamp. A publish that *reverts* a module is a change like any
   other.
4. **Only successful, current DEV publications count.** Draft saves, failed publications, merge
   attempts, application tags and QA/PROD deployment activity are not change events.
5. **A failed poll is not an observation.** A 401/403/429/5xx, a timeout, a malformed or partial
   payload advances nothing and never reads as "every module was deleted". Only a poll that
   completes and parses fully counts as a scan.
6. **An optional HTTP webhook input may be added for a trusted existing upstream publisher, but it
   is never the only detector.** The poll plus a periodic full reconciliation scan remains the
   floor, so a missed or spoofed callback degrades freshness instead of silently losing a module.
7. **`rebuild` stays.** The explicit, caller-triggered tool ADR-0002 created is not removed or
   deprecated: it remains the way to build a baseline, to force a re-read, and to work on a machine
   with no change source configured. Passive detection is added *beside* it, and the two share one
   machine-wide lease on the Studio GUI so they cannot both drive it.

### Freshness is a measured target with reported misses, never a guaranteed bound

8. **The fifteen-minute figure is an objective to measure and alert on. osgraph must never claim it
   as a guarantee**, and must never mark an event compliant on the strength of an assumption.

   The reason is arithmetic over a measured cost. Under ADR-0013 a single real module commonly costs
   **around three minutes** of extraction at four parallel reads (the `demoportal` 30-module
   scope measured 2366 s total, ≈79 s per module average, with large modules well past three
   minutes). There is **one** Studio worker, because the admission limit of 4 is per *process* and
   the GUI cannot be driven by two controllers at once. So a handful of modules published at the
   same moment serializes: five simultaneous changes at three minutes each is fifteen minutes of
   extraction alone, before detection lag, open/close GUI time, assembly and publication. A sixth
   module, a slow module, a GUI failure or an expired session token puts the event over any
   fifteen-minute goal, on a correctly working system.

9. **Therefore every event carries a deadline and a verdict, and misses are reported rather than
   smoothed.** The planner orders by deadline, records detected/started/completed times, and reports
   p95/p99 plus per-event overdue state. When the source cannot prove a publish timestamp, the
   latency is reported as unmeasurable rather than computed from the observation time — an
   unverifiable number is worse than an absent one.

## Consequences

- **The glossary grows a vocabulary the later issues already assume.** `Revision`,
  `Revision vector`, `Generation`, `Shard`, `Manifest`, `Watcher` and `Dirty queue` are defined in
  [`GLOSSARY.md`](../../GLOSSARY.md) with the same `_Avoid_` discipline as the existing entries.
  **Snapshot** is reconciled with **Generation** there: Snapshot stays the name of the single
  mutable `graph.json` artifact ADR-0001 and ADR-0005 describe; Generation is the immutable,
  internally consistent *set* of derived artifacts that supersedes it once issue #22 lands.
- **ADR-0002's text is left intact**, marked `status: superseded` by this ADR, in the style used for
  ADR-0007. Its reasoning about the MCP remains the record of why detection does not live there.
- **The `Rebuild` glossary entry no longer says osgraph has no passive change detection.** It is the
  one sentence in the existing documentation that this decision falsifies outright.
- **osgraph is still not standalone.** Detection removes the human from *noticing* a publish; it
  does not remove osopener (nothing else can open a module for reading) or the token manager (a
  session approval is a human act). A watcher whose token has expired enters an explicit
  `AUTH_REQUIRED` state and alerts. It never attempts to bypass approval.
- **A detector that cannot prove publish times is still usable, and says so.** Observation time is
  always set; publish time is present only when the source proves one. The verdict machinery treats
  the difference as a reported limitation of the installation, not as an error and not as zero.
- **What this ADR does not decide:** whether the *installed* LifeTime v2 exposes every successful
  DEV publish quickly enough and with enough metadata. That is a feasibility gate measured against a
  live environment in the M0 live gate (issue #11), deliberately a testable integration boundary
  rather than an assumption buried in code. A negative verdict changes the adapter, not this
  decision.
