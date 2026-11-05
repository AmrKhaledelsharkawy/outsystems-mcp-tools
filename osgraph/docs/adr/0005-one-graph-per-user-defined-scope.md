---
status: accepted
revises: OSG-007 tool signatures; MAP destination ("the module currently open")
---

# One graph per user-defined scope of modules

v1 was designed to graph only the single module open in Service Studio, with cross-module refs left as `osgraph://external/<key>` placeholders. Real questions ("what in the portal breaks if this BL action changes?") cross modules. The user decided (2026-10-29): **one graph per scope, where the scope is a list of module names the user gives.** Not one graph per module plus an index, and not auto-discovery of every dependency.

Decision:

- **Scope = named list of modules, chosen by the user.** Stored at `osgraph/scopes/<scopeName>.json`: `{ "name": "...", "modules": ["demoportal", "..."] }`. osgraph never adds or drops modules on its own. A helper may *suggest* modules (for example, the producer modules a module references), but only the user's list is used.
- **One snapshot per scope:** `<graphDir>/<scopeName>/graph.json`. It holds every element of every scope module plus the module-level layer graph for those modules.
- **Merging is natural.** Node ids are already `osgraph://<Module>/<Kind>/<Name>` (OSG-006), so ids from different modules never collide.
- **Cross-module refs:**
  - Target module **in scope** → resolve to the real node, relation unchanged, `EXTRACTED`.
  - Target module **out of scope** → stays `osgraph://external/<key>`, `AMBIGUOUS`, tagged with the target module name when known.
  - If an external key can't be resolved to a module, it stays `AMBIGUOUS` and counts in the response's `unresolvedExternalCount`.
- **Layer checks** cover every module-to-module edge whose source is in scope, including edges to out-of-scope modules whose name (and so layer suffix) is known.
- **Opening modules is not osgraph's job.** The caller (agent/orchestrator) opens all scope modules first, using osopener (OSG-014). `rebuild({ scope })` checks `listApps`: if any scope module is not open, it fails with `MODULES_NOT_OPEN` plus the list, and the previous snapshot is untouched. osgraph stays deterministic and free of desktop automation.
- **All-or-nothing across the scope** (OSG-004's temp-file + atomic replace). Element-level skips (OSG-011) still apply, reported per module in `graphCompleteness`.
- **Tool changes (OSG-007):**
  - `rebuild({ scope })` → `{ nodeCount, edgeCount, violationCount, unknownModuleCount, unresolvedExternalCount, perModule: [{ module, layer, nodeCount, edgeCount, skippedCount }], snapshotPath }`
  - `queryPath`, `queryImpact`, `listViolations` gain a required `scope` argument and read that scope's snapshot.
  - New `defineScope({ name, modules })` writes the scope file; `listScopes()` returns the defined scopes.

**Live assumption to verify first:** servicestudio MCP read tools (`getDataModel`, `getServerAction`, …) can target any *open* module by name, not only the front tab. If they can't, the fallback is: the orchestrator brings each module to the front with osopener, and `rebuild({ scope, module })` stages that module's extraction; the snapshot is replaced only once every scope module is staged. The fallback changes only how `rebuild` is driven, not the one-graph-per-scope result.

## Amendment (2026-10-30, live) — the live assumption is confirmed: **direct mode**

The "live assumption to verify first" above has now been verified against Service Studio
11.55.94.65328 with **three** modules open (`demoportal`, `MOD_DEMO_Portal_CW`,
`MOD_DEMO_CommonLookups_LKP`, the last one in front):

| `input.eSpaceName` | is it the front tab? | ms | result |
|---|---|---|---|
| `MOD_DEMO_Portal_CW` | no | 18 865 | ok — screens returned |
| `demoportal` | no | 9 044 | ok — 37 screens |
| `MOD_DEMO_Portal_CW` (repeat) | no | 18 116 | ok — stable |

**Any open module is readable by name.** The staged fallback is therefore *not* built, and
osopener's only job before a rebuild is opening modules — never focusing them.

Two matching-rules that the same probe settled, and that `rebuild` depends on:

- `eSpaceName` is an **exact, case-sensitive** match against the `name` field `listApps`
  returns (`DemoPortal` fails where `demoportal` succeeds), and it is the *module*
  name, not the platform name shown in the tab (`MOD_DEMO_Portal_UI` fails). `rebuild` is
  already correct here: `resolveScopeModules` maps the caller's spelling to the canonical
  `app.name` and only that is passed to the walker (`src/rebuild/rebuild.ts`), so the S6-audit
  F8 case-variant dedupe cannot emit a failing call.
- A name that is not open answers `isError: true` with the text **"No module is currently open
  in Service Studio."** in 2–36 ms — even though a module *is* open. The message is
  misleading: it is the `MODULES_NOT_OPEN` case, never "Studio is empty" and never
  `SERVICESTUDIO_UNREACHABLE`. (`rebuild` learns this from `listApps` before any element call,
  so no code change follows; it matters for anyone reading a raw servicestudio response.)

## Amendment (2026-10-30, built) — the staged path exists after all, for a different reason

The amendment above retired the staged fallback because direct mode works: any *open* module is
readable by name. That remains true. The staged path was built anyway, because the constraint that
bites at scale is not **readability**, it is **how many modules Service Studio can hold at once**:

- past ~30 open modules Studio spreads them over several top-level `AggregatorWindow`s, which moves
  `Process.MainWindowHandle` to a different window and breaks any automation that identifies
  dialogs as "not the main window" (osopener did);
- the environment-list fetch grows from ≈5.3 s to **over 45 s**;
- per-call read latency rises with the tab count, so the 4.9–18.5 s/call figures in ADR-0007 — all
  measured with 1–3 modules open — are a floor, not an estimate.

`rebuild({ scope, module })` therefore reads **one** module and persists its extraction under
`<graphDir>/<scope>/stage/<module>.json`. Only that module must be open; other scope modules being
closed is not `MODULES_NOT_OPEN`. When the last missing module is staged the call finalizes:
it builds the snapshot from the stage entries **in scope order**, through the same `buildOutcome`
as the all-at-once path, writes `graph.json` atomically and clears the stage.

Guarantees, all covered by `tests/rebuild.test.ts > stageModule`:

- **Indistinguishable output.** Staging module-by-module writes a *byte-identical* `graph.json` to
  the single call over the same extractions.
- **Nothing is published early.** No `graph.json` is written until the scope is complete; a
  previous snapshot survives a half-finished stage.
- **A corrupt stage entry counts as not staged**, so finalize can never publish a scope with a hole
  in it — the module is simply re-staged.
- **Out-of-scope module → `SCOPE_INVALID`**, raised before the session is acquired and before any
  read.
- Re-staging a module overwrites its entry.

This enables the caller loop the all-at-once path cannot support: **open → stage → close**, which
keeps Studio at a couple of modules and holds read latency at the fast end of the range. Direct
mode is still the default and still correct for small scopes; `module` is opt-in per call.
