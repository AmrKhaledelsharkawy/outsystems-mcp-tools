# osgraph

Deterministic, no-LLM dependency graph over a user-defined scope of OutSystems 11 modules open in Service Studio, exposed as its own MCP server.

## Language

**Element**:
One graphed unit of module content: an entity, structure, server action, client action, screen, or block. The v1 element set; timers, processes, integrations, roles, themes, and resources are out of scope until a later pass.
_Avoid_: Object, item, artifact

**Node**:
A single element or module represented in the graph. Every node carries the kind it was extracted as (element kind, or `module` for the layer graph). Id `osgraph://<Module>/<Kind>/<Name>`, with a `/<UIFlow>` segment before the name for screens and blocks ([ADR-0008](docs/adr/0008-element-names-not-unique-flow-qualified-screen-block-ids.md)).
_Avoid_: Entry, vertex

**External node**:
A node for an element whose producer module is outside the scope, created from the module/element name in the dependency comment ([ADR-0006](docs/adr/0006-external-refs-resolvable-by-module-and-name.md)). Carries the same id the element gets when its module is in scope, plus `external: true`, `module` and `globalKey`; has no outgoing edges.
_Avoid_: Stub, opaque ref (and **Placeholder**, which is its own distinct term below)

**Placeholder**:
A node that exists only because an edge names it, for an **in-scope** element osgraph did not read — tagged `placeholder: true` and counted in `graph.osgraph.placeholderCount` ([ADR-0009](docs/adr/0009-placeholders-skipped-targets-and-count-definitions.md)). Deliberately **not** an External node: an external's producer module is outside the scope, so osgraph was never going to read it, whereas a placeholder is a gap inside the scope and so a signal for the verifier. Excluded from `perModule.nodeCount`. Role and external targets are never placeholders, and a *skipped* element (OSG-011, element-level failure handling — a local-only ticket) is never stubbed as one — the edge to it is dropped instead.
_Avoid_: Stub, phantom node; never use "placeholder" loosely for an External node

**Referenced-only entry**:
A names-listing entry the servicestudio MCP reports with `IsReferenced: true`: the element belongs to another module and the listing only mentions it because this module references it. osgraph does not fetch its text (it is a one-statement dependency stub with no anchor of its own) and reports `referencedOnlyCount` per module and per scope ([ADR-0007](docs/adr/0007-servicestudio-mcp-calls-are-serialized.md) "fewer calls"). Complete data, never a skip and never a Placeholder: the element itself is recovered as an External node from the dependency comment at each reference site ([ADR-0006](docs/adr/0006-external-refs-resolvable-by-module-and-name.md)).
_Avoid_: Unused element, foreign element, skipped reference

**Kind-level read**:
The single servicestudio call that is the sole source of truth for a whole element kind in one module: a names listing (`getScreenNames`, `getWebBlockNames`, `getActionNames`) or a module text (`getDataModel`, `getStructures`). Distinct from an **element read**, whose loss the listing can still count and name. A failed kind-level read aborts the rebuild with `KIND_READ_FAILED` ([ADR-0011](docs/adr/0011-kind-level-read-failure-aborts-the-rebuild.md)); a failed element read is skipped and counted (OSG-011).
_Avoid_: Bulk read, kind fetch

**Edge**:
A directed reference from one node to another, discovered by parsing one element's declarative Model-API-code text for another element's generated variable name (e.g. a screen's text naming an action it calls).
_Avoid_: Link, relationship, connection

**Layer**:
One of UI, CW (Core Widgets), SL (Services), BL (Business Logic), CS (Data), LKP (Lookup) — parsed from a module's name suffix (e.g. `Orders_BL`). Applies only at the module level, never to individual elements.
_Avoid_: Tier, level

**Layer rule**:
An allowed/forbidden reference pair between two layers (e.g. "BL must never reference CW"). Stored in `layer-rules.json`, seeded from the org's MOD Code Review Template v1.0 matrix.
_Avoid_: Policy, constraint (unqualified)

**Violation**:
A cross-module edge whose source and target layers break a layer rule. Reported by query, never silently dropped from the graph.
_Avoid_: Error, breach

**Scope**:
A named list of module names, chosen by the user, that one snapshot covers (`osgraph/scopes/<name>.json`). osgraph never adds or drops modules from a scope by itself. Refs to modules outside the scope stay external.
_Avoid_: Project, workspace, set

**Snapshot**:
The on-disk graph artifact (`<graphDir>/<scope>/graph.json`, in Graphify's schema) produced by a rebuild of one scope: **one file, one scope, overwritten in place**. All queries read the snapshot; it goes stale the moment any scope module or its publish state changes, until the next rebuild. Narrower than a **Generation**, which is the immutable *set* of derived artifacts (graph **and** flows **and** manifest) that a watcher-driven assembly produces — a Generation contains the data a Snapshot holds, is never overwritten, and is selected by a pointer. Use Snapshot only for the single mutable `graph.json` artifact; the moment you mean "the coherent set a query must read together", the word is Generation.
_Avoid_: Cache, export; and never as a synonym for **Generation**

**Flow**:
The logic inside one action — a screen action, block action, client action, server action or data action — as osgraph records it: its parameters, its flow nodes, and the connectors between them ([ADR-0012](docs/adr/0012-flows-are-a-separate-artifact-built-offline-from-raw-texts.md)). Identified as `<owner element id>#<ActionName>` for an action local to a screen or block, and as the element id itself for a module-level action. Lives in `<graphDir>/<scope>/flows.json`, never in the Snapshot.
_Avoid_: Logic, action body, diagram, graph (a flow is not a Graphify graph)

**Flow node**:
One step of a Flow: `Start`, `Assign`, `If`, `Switch`, `ForEach`, a call (`ExecuteServerAction` / `ExecuteClientAction`), `Destination`, `RaiseException`, `ExceptionHandler`, `End`, and the rest of the 32 `I*Node` interfaces. Id `<flow id>/n<k>`, where `k` is the node's **creation order in Studio's text** — never the live `IAction.Nodes` order, which is not creation order (osmodel OSM-013). A node whose interface is outside the known vocabulary is kept as type `Unknown:<Interface>` with its raw statements, and counted in `unknownNodeCount`; it is never dropped.
_Avoid_: Step, instruction, statement, shape

**Connector**:
A directed link from one Flow node to another, carrying the **port** it leaves by: `Target`, `True`, `False`, `Cycle`, `Otherwise`, `Case[i]` or `Comment`. On a `ForEach`, `Cycle` is the loop **body** and `Target` is the **exit** (live-confirmed 2026-10-17). Distinct from an **Edge**, which is a reference between elements and lives in the Snapshot: a connector is internal to one action and never appears in `graph.json`. `.ConnectedBelow(x)` creates one; `.Below(x)` and `.ToTheRightOf(x)` are canvas layout and create nothing.
_Avoid_: Edge, link, arrow, transition

**Binding**:
UI-to-logic wiring declared by a screen or block outside any Flow: a widget event handler (`onclick` → an action), a screen lifecycle handler (`OnReady` → an action), a block instance's source block, its input arguments and its event handlers, an If widget's condition, and a widget's own `Visible` / `Value` expression. The half of "what calls what" that no action's flow contains.
_Avoid_: Wiring, hook, handler (unqualified), event

**Raw capture**:
Every element text one rebuild fetched for one module, written verbatim under `<graphDir>/<scope>/raw/<module>/` with a `manifest.json` naming each file's kind, element name and UI flow. The bytes are the **unwrapped** text the extractor was handed, which is what makes flow extraction a pure function over `raw/` and lets it be re-run offline (`reextract`) instead of costing another ≈11 minutes per module live. The manifest is written last, so a directory without one is an aborted capture and never read. Never a query input: the tools read `graph.json` and `flows.json`, never `raw/`.
_Avoid_: Cache, dump, mirror

**Rebuild**:
The full deterministic extraction run over one scope: use a servicestudio MCP session, read every element of every scope module, parse edges, regenerate the snapshot. **Explicitly caller-triggered** (on module-open, and after a publish's merge completes) and still supported — it is how a baseline is built, how a re-read is forced, and the only path on a machine with no change source configured. It is no longer the *only* trigger: a **Watcher** also drives extraction from detected publishes ([ADR-0014](docs/adr/0014-publishes-detected-by-polling-a-current-state-read.md)), and the two share one machine-wide lease on the Studio GUI. A Rebuild reads every module in the scope; a watcher-driven extraction reads only the modules in the **Dirty queue**.
_Avoid_: Refresh, sync, scan; and never use "rebuild" for a single-module watcher extraction

**Revision**:
An **opaque equality token** for one published version of one module, as reported by the authoritative current-state read ([ADR-0014](docs/adr/0014-publishes-detected-by-polling-a-current-state-read.md)). Compared for equality and nothing else: it is **never sorted, and never interpreted** — not as a number, not as a GUID's embedded time, not as a version string's parts, not as a timestamp. "Newest" is whatever the current-state read returns now, which is why a publish that *reverts* a module is an ordinary change. Carries the module's stable key and display name, the detector's observation time, and a real publish time only when the source can prove one.
_Avoid_: Version, version number, build, hash, timestamp — every one of them implies an order a Revision does not have

**Revision vector**:
The module-to-**Revision** map that identifies **one complete state of one scope** — the thing a Generation is built from and labelled with. Two vectors are equal or they are not; a vector is complete only when every module in the scope has a Revision in it, and an incomplete vector can never be published as a scope state.
_Avoid_: Version set, state, fingerprint

**Generation**:
One **immutable, internally consistent set** of derived artifacts — graph, flows and the **Manifest** naming them — built from a single **Revision vector**. Never modified after it is written; a new assembly writes a new Generation and a single atomic pointer switch makes it current, and every tool call pins one Generation for its whole duration so no answer is ever stitched from two. Distinct from a **Snapshot** (see that entry): Snapshot is the one mutable `graph.json`, Generation is the coherent set.
_Avoid_: Snapshot, build, version, release

**Shard**:
One **content-addressed per-module object** — a module's extraction, or a module's flows — named by the hash of its own bytes. The unit of caching and of transfer: an unchanged module's shard is identical across Generations, so it is neither re-extracted nor re-uploaded, and a consumer downloads only the hashes it is missing. A shard is per module and never per scope; the thing that turns a set of shards into a scope state is the **Manifest**.
_Avoid_: Chunk, blob, part, fragment, cache entry

**Manifest**:
The **schema-versioned index that names one Generation's Shards** and their hashes, plus the Revision vector, scope and environment the Generation represents. The single object whose arrival makes a Generation visible: it is written or committed **last** and read **first**, so a manifest never references a shard that is not already present. A manifest whose schema version is not understood is refused, not partially read.
_Avoid_: Index, catalog, metadata, pointer (the pointer is what *selects* a manifest)

**Watcher**:
The **single process** that polls the change source, maintains the **Dirty queue**, holds the machine-wide Studio lease, drives osopener and the Service Studio reads for one module at a time, assembles Generations and publishes them. Singular by necessity, not by preference: the MCP admits four concurrent reads per *process* ([ADR-0013](docs/adr/0013-servicestudio-reads-run-four-wide.md)) and the Studio GUI cannot be driven by two controllers at once. Runs in a logged-in interactive Windows session, because GUI automation does not work in Session 0.
_Avoid_: Daemon, service, monitor, listener, poller (it does far more than poll)

**Dirty queue**:
The **durable** set of modules whose latest known **Revision** has not been extracted yet. Survives restarts and crashes, because it is the only record of work owed. Revision-aware and coalescing: three publishes of the same module collapse into one pending extraction of the **latest** Revision, while the observed changes are retained for audit. A module leaves the queue only when an extraction is **verified** against the Revision it was read at — never merely because an extraction attempt finished.
_Avoid_: Backlog, pending list, to-do, change log (the audit of observed changes is a separate record)
