---
status: accepted
date: 2026-10-30
extends: ADR-0001 (Graphify is the storage schema, not the query interface); ADR-0005 (one graph per scope, staged rebuild)
constrains: ADR-0010 (the Graphify output contract is the gate) — by keeping flow data out of `graph.json` entirely
adds: `<graphDir>/<scope>/raw/` and `<graphDir>/<scope>/flows.json`; one `OsgraphErrorCode` (`FLOWS_NOT_BUILT`)
defers: Option B (`graph.json` edges carrying an action-level `sourceElement`) — see "Rejected / deferred"
---

# Flows are a separate artifact, parsed offline from persisted raw texts

osgraph v1.1 records the logic *inside* actions: flow nodes, the connectors between them, every
expression as text, and the widget wiring that connects UI to logic. This decides where that data
lives, how it is produced, and what it is allowed to touch.

Three things are decided together because they are one mechanism:

1. **Every element text a rebuild fetches is persisted** under `<graphDir>/<scope>/raw/<module>/`,
   verbatim, as the unwrapped string the extractor was handed (slice F0, `src/rebuild/raw.ts`).
2. **Flow extraction is a pure function over those files** — no token, no Studio, no clock
   (`src/flows/parse.ts`).
3. **The result is its own artifact**, `<graphDir>/<scope>/flows.json`, beside `graph.json` and
   never inside it.

## Why the texts are kept at all

v1 threw every text away the moment `extractModule` had walked it. The only way to change what
osgraph understands about a module was then to read that module live again, and ADR-0007's measured
cost for that is **≈11 minutes per module, ≈3–5 hours for the 38-module live scope** (ADR-0011's
correction, re-derived at ≈12.5 s per serialized call).[^cost-2026-10-31]

[^cost-2026-10-31]: **Updated 2026-10-31.** Those figures are the *serialized* cost. Reads now run
    four wide ([ADR-0013](0013-servicestudio-reads-run-four-wide.md)), which puts a re-read at
    ≈**3 minutes per module** and the 30-module `demoportal` scope at ≈**40 min** rather than
    126. **The decision does not change**: 3 minutes a module is still three orders of magnitude
    more than parsing the persisted text, which discovery §7 measured at 86–88 ms per scope —
    0.009% of rebuild time. Keeping the raw texts remains the right call; only the size of the
    number it is weighed against moved. A flow parser is not a thing that can be
iterated on at that price: it is 32 node interfaces, a dozen widget-wiring forms, and — as F2 found
twice in one afternoon — bugs that only a real text exposes. The first (`").ConnectedBelow(startNode"`
read as a node label) came from cutting a create call's arguments at the last `)`. The second (the
screen's own variable never bound, so every `Destination` lost its target) came from the lambda
header having no `;` and merging with the first declaration. Neither is visible in a hand-written
fixture; both were found and fixed in minutes against a persisted real text, and would have cost a
live read each.

So the texts are the input, and they are kept. Three consequences are deliberate:

- **Written as each text arrives, not at the end of the module.** A rebuild that aborts partway
  (`KIND_READ_FAILED`, an expired token, Studio closed) still leaves everything it had already paid
  for on disk. Under ADR-0011's "the work discarded is not cheap" correction, this is the first step
  toward the resumability that ADR left open — the reads are no longer lost, only the snapshot is.
- **`manifest.json` is written last and is the only thing read back.** A `raw/<module>/` directory
  without a manifest is an aborted capture and is reported as `RAW_NOT_CAPTURED`, never fed to the
  parser as if it were whole. File names are an encoding for the filesystem's benefit and are lossy
  in principle (two UI flows can encode to one segment, which `claimPath` resolves with a `~2`
  suffix); the manifest carries the real kind, element name and UI flow beside the file each text
  went to.
- **`raw/` is never a query input.** The tools read `graph.json` and `flows.json`. Nothing reads
  `raw/` except the parser and `reextract`. It is `.gitignore`d (both as `.osgraph/` and as `raw/`),
  because it is reproducible, large, and never reviewed.

## Why `flows.json` is separate from `graph.json`

The size argument is real but secondary. Measured on the three live screen captures
(`tests/fixtures/demoportal/screen/{Login,Jobs,Contact}.txt`, 37,825 bytes of text → 10
actions, 26 flow nodes):

| | measured |
|---|---|
| `flows.json` bytes per element text byte | **0.58** |
| bytes per flow node | **849** |
| of which repeated `osgraph://…` ids | **44 %** |
| the same three texts as v1 graph data (10 nodes, 24 edges) | **7,845 bytes** |

So flow data is roughly **2.8×** the graph data for the same elements, and the budget this ADR sets
is **`flows.json` ≤ 0.6 × `raw/`**.

**Confirmed live the same day** on the module the open point named. A staged rebuild of
`MOD_DEMO_Booking_CW` (scope `demoflows`, 2026-10-30, 664 s — almost exactly ADR-0007's ≈11-minutes-
per-module budget) captured 19 texts totalling **580 kB**, which parse to **304 kB** of flow data:

| | measured on `MOD_DEMO_Booking_CW` |
|---|---|
| `raw/` bytes | 594,119 (19 texts; the largest single block is 146 kB) |
| `flows.json` bytes for that module | 310,817 |
| **ratio** | **0.523** — inside the 0.6 budget |
| actions / flow nodes / bindings | 53 / 299 / 406 |
| bytes per flow node | 1,040 |
| unknown node types / parse errors | **0 / 0** |

Note the **406 bindings against 299 flow nodes**: on a real CW module the UI wiring is more of the
answer than the action logic is, which is why `Binding` is a first-class part of the IR and not an
appendix.

### Correction, same day — the 0.6 budget was wrong, and one module broke it

The second CW module measured **0.837**, outside the budget:

| | `MOD_DEMO_Booking_CW` | `MOD_DEMO_Application_CW` |
|---|---|---|
| `raw/` | 580 kB | 1,253 kB |
| `flows.json` share | 304 kB | 1,049 kB |
| ratio | 0.523 | **0.837** |
| flow nodes | 299 | 680 |
| bindings | 406 | **1,465** |
| `actions[]` / `bindings[]` share | 43 % / 57 % | 34 % / **66 %** |
| of total: `widgetPath` | 16 % | 20 % |
| of total: all `osgraph://` ids | 43 % | 46 % |

**0.6 was a prediction from a three-screen proxy, and it is the prediction that was wrong — not the
artifact.** The ratio is driven by **binding density**, not node count: a module whose blocks are
mostly UI wiring produces more bindings per byte of text, and bindings are the larger half of the
artifact on both modules. The budget is therefore revised to **`flows.json` ≤ 1.0 × `raw/`**, with
0.52–0.84 as the measured range over two real CW modules, and the driver recorded so the next
surprise is diagnosable rather than mysterious.

Two levers exist if it ever needs to come down, both measured rather than guessed: grouping
bindings under their owner would reclaim the repeated `owner` id (**≈14 %**), and dropping or
shortening `widgetPath` would reclaim **≈20 %**. Neither is taken now — `widgetPath` is not
recoverable from anything else stored, and a flat `bindings[]` is what makes `searchFlows` a single
pass.

### The consequence that does matter: one file per scope will not reach 38 modules

At ≈0.5–1.0 MB of flow data per CW module, the 38-module live scope projects to **≈15–25 MB** in a
single `flows.json` — and `requireFlows` parses the whole file on **every** `getFlow` and
`searchFlows` call. That is seconds per query, for a design whose point is that queries are cheap.

This ADR's "one artifact per scope" is right for the 4-module scope it was verified on and wrong at
full scope. The fix is already implied by the shape of the data — `flows/<module>.json` plus a small
index, so a query loads only the modules it addresses, which `searchFlows({module})` and `getFlow`
both already narrow to — but it is a schema change with its own staleness story and is **not** taken
inside this slice. Recorded here as the known scaling limit, not left to be discovered by the first
person who runs a full-scope rebuild.

The decisive argument is not size, it is **ADR-0001 and ADR-0010**. `graph.json` is in Graphify's
schema because Graphify is the storage schema, and ADR-0010 makes Graphify's *output contract* the
gate that a rebuild must pass. `queryPath` runs the pinned Graphify binary over that file. Putting
thousands of flow nodes into it would (a) put osgraph-specific logic nodes into a graph whose node
vocabulary is the element set the GLOSSARY defines, (b) change what Graphify traverses, so every
path query would have to learn to ignore them, and (c) invalidate the determinism snapshots that
ADR-0010 makes the gate. A second file costs one path and one staleness check. That is the whole
trade.

## Flows are built by the offline path, always — including during a live rebuild

The important structural choice. `flows.json` is **not** built from the live extraction in memory
and **not** stored in the stage (`STAGE_SCHEMA_VERSION` therefore stays **1**; the stage shape does
not change). It is built by reading `raw/` back and running the parser — the same code, in the same
order, whether it is invoked by a finalizing staged rebuild, by an all-at-once rebuild, or by the
offline `reextract` command.

This is what makes the F4 claim *"`reextract` reproduces a live rebuild"* true **by construction
rather than by testing**. There is no second implementation to drift. The cost is one extra read of
files that were just written, which against ≈11 minutes per module of live reads is nothing.

It does mean the live path's `flows.json` depends on `raw/` having been written, so a rebuild with
raw capture disabled produces no flows. That is stated, not hidden: the staged path always captures
(it is where re-reading hurts most), the tool-level `rebuild` always captures, and only a direct
`rebuildScope({ rawGraphDir: undefined })` call — which exists for tests — does not.

`graph.json` keeps being built from the live extraction, so the two artifacts are produced from
different passes over the same bytes. The F4 test that matters is therefore: a `reextract` from
`raw/` must reproduce the live `graph.json`'s `snapshot` **byte for byte**. Only `meta`'s clock
fields (`rebuiltAt`, the duration figures) may differ, because they time the run and not the data —
`reextract` takes an injectable `now` so even that is testable.

## The IR, confirmed as proposed, with four refinements

The goal's Design 3 is accepted: `FlowAction` / `FlowNode` / `Connector` / `Binding`, expressions as
opaque strings, no expression parser, no data-flow tracing (osmodel's rule). Ids are
`<owner element id>#<ActionName>` for a local action, the element id for a module-level one, and
`<action id>/n<k>` for a node where `k` is **creation order in the text**. Creation order, never the
live `IAction.Nodes` order, which osmodel found returning `Assign, Start, End`.

Four refinements the parser forced:

1. **`Connector.via: "explicit" | "connectedBelow"`** — added. `.ConnectedBelow(prev)` creates a
   connector; `.Below(prev)` and `.ToTheRightOf(prev)` are canvas layout and create nothing. The live
   fixtures prove the distinction (a ForEach created `.ToTheRightOf(ifNode)` is wired by a separate
   `ifNode.FalseTarget = forEachNode`), and conflating them would invent one edge and duplicate
   another. `via` is kept in the IR because the two are not interchangeable *evidence*: only the
   explicit form names its port, so a `ConnectedBelow` off a branching node is a parser question
   rather than a fact, and it must be visible as one.
2. **Properties are collected generically; a short named set is promoted.** Rather than a handler per
   node interface, every `node.<Prop> = <rhs>` and `node.Set<Prop>(…)` is recorded, and
   `condition`, `recordList`, `callee`, `destination`, `exception`, `message`, `assignments` and
   `arguments` are promoted to typed fields. This is what makes the DoD's "unknown node types are
   never dropped" structural: a node type this build has never seen arrives as
   `Unknown:I…Node` **with all of its expressions captured and searchable**, plus its raw statements.
   Verified on a deliberately invented `IQuantumFluxNode`.
3. **A statement marked `// default value` contributes nothing.** That comment is Studio's own marker
   for a value it emitted because it had to, and dropping those is most of why `flows.json` is 0.58×
   and not 2× the text. `HorizontalPosition` / `VerticalPosition` are dropped as pure layout. One
   case needed care: `raiseNode.Exception = null; // default value` is both the default *and*
   semantically meaningful, so "no exception field" is defined as the generic exception and
   `getFlow` renders it as such — equivalent information, no exception to the rule.
4. **`FlowRef` carries both `text` and an optional `id`.** `text` is what `searchFlows` matches and
   `getFlow` prints; `id` is the `buildId` node id when the reference resolved to a module, kind and
   name. The `id` is what lets a flow be joined back to `graph.json` — and it is what makes
   deferring Option B (below) acceptable rather than merely cheaper.

Absolute node ids are kept even though 44 % of `flows.json` is ids. Rewriting them relative to their
action (`n3` instead of the full string) was measured at a **17 %** total saving; rejected, because a
node id that a caller cannot paste into the next tool call stops being an id, and `searchFlows`
returns `{actionId, nodeId}` pairs whose whole purpose is to be handed to `getFlow`. 17 % is not
worth an expand-on-read step on the query path.

## Staleness

`getFlow` and `searchFlows` fail with a new `OsgraphErrorCode`, **`FLOWS_NOT_BUILT`**, when
`flows.json` is missing, unreadable, or older than `graph.json`. Not a reuse: `SNAPSHOT_MISSING`
would send the caller to run a rebuild they may already have run, and the actionable instruction
differs — `reextract` fixes a stale `flows.json` offline in seconds, where a missing snapshot needs
Service Studio.

The comparison is `flows.json`'s own recorded `builtAt` against `meta.json`'s `rebuiltAt`, not file
mtimes: mtimes are not preserved by copying a `.osgraph` directory between machines, and the two
artifacts are written seconds apart by the same run.

## Rejected / deferred

- **Option B now: `graph.json` edges carrying `sourceElement = <action id>`.** Deferred, not
  rejected on merit. It would change every edge in the snapshot, so ADR-0010's determinism snapshots
  all need regenerating, and `queryImpact`'s existing contract ("`sourceElement` is the id of the
  element whose text produced the edge") would quietly change meaning for every existing caller —
  in a goal whose own rule is that it *extends* v1 and reopens no v1 decision. The need it serves
  ("name the action, not just the block") is already met from the other side: `searchFlows({in:
  ["calls"]})` returns the `actionId` of every call to a given element, and every `FlowRef` carries
  the callee's `id`, so the join `graph.json` edge ↔ `flows.json` action exists today. If
  `queryImpact` should report action-level sources, that is its own ADR with its own snapshot
  regeneration.
- **Storing flows in the stage entries.** Rejected: it bumps `STAGE_SCHEMA_VERSION` (invalidating
  every stage file mid-flight, each worth ≈11 minutes of live reads under ADR-0011's version check),
  and it creates the second parser invocation path this ADR exists to avoid.
- **Parsing flows at query time from `raw/`.** Rejected: a `searchFlows` over a 38-module scope would
  re-parse every text on every call, and ADR-0001's separation of storage from query interface says
  the artifact is what queries read.
- **Parsing expressions into ASTs, or tracing data flow through variables.** Out of scope by the
  goal, and the reason is sound: OutSystems expression syntax is not specified anywhere this project
  can rely on, a wrong parse is worse than an opaque string, and a regex over the text answers the
  questions actually being asked ("is this field passed into that action?").
- **Keeping widgets as their own array.** Rejected as scope: widgets exist in the IR only to hang
  bindings on, so a `Binding` carries its widget's id, type, label and a readable ancestry path, and
  there is no widget tree to maintain or to keep deterministic.

## Live-verification open points (F6 must close these)

- ~~**The size budget.**~~ **Closed 2026-10-30, and the budget was revised**: 0.523 on
  `MOD_DEMO_Booking_CW` but **0.837** on `MOD_DEMO_Application_CW`, so the bound became
  ≤ 1.0 × `raw/`. See the correction above — including the scaling limit it exposed, which is the
  one open design item this slice leaves behind.
- ~~**The "Unverified" syntax table.**~~ **Closed 2026-10-30 (F6).** Fourteen constructs moved to
  confirmed live, `ISwitchNode` among them; eight parser defects found on the real texts and fixed.
  Three stay unverified because they **do not occur** in the four modules: `IAggregateNode`,
  `ISQLNode`, a named user exception on a raise.
- ~~**`unknownNodeCount` on the three CW modules.**~~ **Closed: 0** on all three, 0 parse errors.
- ~~**Whether `raw/` byte-equals the live tool text.**~~ **Closed**: a real staged rebuild wrote
  `raw/`, and `reextract` from it reproduces every module's live node/edge counts exactly.
- **New, found by F6 — Studio's own text is not deterministic.** Two live reads of an unchanged
  `MOD_DEMO_Employment_CW` gave 8 of 9 texts byte-identical; `EmploymentJob_MainBlock`
  differed only in the order of one event handler's `SetArgumentValue` calls. The parser therefore
  sorts unordered collections (a node's `arguments`, `bindings`) and keeps semantic order
  (`assignments`, switch cases). Result: the module's flows are byte-identical across the two live
  reads although the raw texts are not. Consequence for F0: `raw/` is a faithful capture, **not** a
  stable one — never diff `raw/` across rebuilds to detect model change; diff `flows.json`.
