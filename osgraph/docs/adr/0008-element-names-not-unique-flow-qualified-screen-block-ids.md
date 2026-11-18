---
status: accepted
revises: OSG-006 node-id rule for the Screen and Block kinds
---

# Element names are not unique within a module; node ids disambiguate by UI flow for screens and blocks

OSG-006 assumed `osgraph://<Module>/<Kind>/<Name>` is unique inside one module. Live evidence (2026-10-29, `getWebBlockNames` on `demoportal`): 319 blocks, with the same name recurring in different UI flows (`Accordion`, `AccordionView`, `Breadcrumbs`, `BreadcrumbsItem`, `HeaderView`, `ListingCards`, `Timer` — each twice). The names response carries a `UIFlow` field per entry, and the Model-API text resolves blocks per flow: `<flowVar>.Nodes.OfType<IMobileBlock>().Named("X")`, so the flow is known at the reference site too. OutSystems enforces name uniqueness only within a flow for screens and blocks; entities, structures and actions are unique per module and are unaffected.

Decision — option (i), always flow-qualified:

- **Ids.** For the kinds `Screen` and `Block` the id is `osgraph://<Module>/<Kind>/<UIFlow>/<Name>`, always, not only on collision. A collision-only scheme (option ii) would make an element's id change when an unrelated element with the same name is added elsewhere in the module, breaking the byte-identical-rebuild bar (OSG-012) and any stored query. The other four kinds keep `osgraph://<Module>/<Kind>/<Name>`. The node `label` stays the plain `<Name>`; the flow is a `uiFlow` node attribute as well as an id segment.
- **Flow source.** The extractor takes the flow for every screen/block from the names listing (`getScreenNames` / `getWebBlockNames` and their Traditional variants), which is already the first call per kind (OSG-002). The anchor `/*** creating I<Kind> '<Name>' ***/` alone does not name the flow and is not sufficient; the names listing is therefore mandatory input for these two kinds, not an optimisation.
- **Duplicate names and the per-name fetch.** `getWebBlock({ objectName })` / `getScreen({ objectName })` take a name only. Live question for the verifier: which of the two `Accordion` blocks does `getWebBlock({ objectName: "Accordion" })` return, and does any argument (flow, qualified name) select the other? Until answered, the rule is: when a name is duplicated and the tool returns one element, that element is attributed to the flow its returned text declares (the enclosing `<flowVar>` the anchor sits under); every other duplicate is a skipped element with reason `DUPLICATE_NAME_UNRESOLVABLE` in `skippedElements` and counted in `graphCompleteness.skippedCount` (OSG-011). If the verifier finds a selector, the skip disappears and this paragraph is amended.
- **Edge resolution for `.Named("X")`.** Resolve to the screen/block in the same flow when the flow var at the reference site is known; else to the unique in-module match by name; else (duplicate and flow unknown) the edge is skipped and counted — never attached to an arbitrary duplicate. Confidence stays `EXTRACTED` for the resolved cases.
- **External refs (ADR-0006).** The dependency comment gives `Module/Name` with no flow, so an out-of-scope external Screen/Block node has the flow-less id `osgraph://<Module>/<Kind>/<Name>` with `external: true`. It cannot collide with an in-scope node (the module is out of scope). When that module is in scope, the ref is resolved by name against the in-scope nodes of that module: unique match → that flow-qualified node; duplicate → edge skipped and counted as `DUPLICATE_NAME_UNRESOLVABLE`. This is the one place a flow-less and a flow-qualified id describe the same element, and it is resolved at rebuild time, never persisted twice.

Rejected alternative: numeric disambiguation (`Accordion`, `Accordion#2`) in listing order — rejected because the order is not guaranteed stable across calls, so ids would drift between rebuilds.

## Amendment, 2026-10-30 (S6 audit F14): "The dependency comment gives `Module/Name` with no flow" is stale

The "External refs (ADR-0006)" bullet above opens with *"The dependency comment gives `Module/Name`
with no flow"*. That is not what this Studio build emits. From
`tests/fixtures/demoportal/block/Partner_OTP.txt`:

```
// IMobileBlockSignature MOD_DEMO_OTP_CW/MainFlow5/Partner_OTP
```

The comment's form is `<Module>/[<Flow>/]<Name>`, and `src/extract/extractor.ts` /
`src/extract/ids.ts` already handle both shapes, so an out-of-scope external Screen/Block node
normally gets the **flow-qualified** id `osgraph://<Module>/<Kind>/<UIFlow>/<Name>` — identical to
the id that element receives once its own module is in scope. The bullet's fallback path (flow-less
external id, resolved by unique name against the in-scope nodes, duplicate →
`DUPLICATE_NAME_UNRESOLVABLE`) still applies, but only to the rarer comment that genuinely omits the
flow.

Nothing in the decision changes; the behaviour is better than this ADR described. The note is here so
nobody "corrects" the code to drop the flow segment and silently breaks cross-scope id identity.

## Amendment 2, 2026-10-30 (final audit MAJOR-1): the comment's flow is the CONSUMER's, not the producer's

Amendment 1 above says the comment's flow-qualified id is "identical to the id that element receives
once its own module is in scope". The live 30-module scope disproved it: Studio renames each imported
UI flow per consumer (`MainFlow` → `MainFlow2…MainFlow12`, `Content` → `Content2`), and the comment
carries that consumer-local name — `// IMobileBlockSignature MOD_DEMO_Profile_CW/MainFlow3/Profile_CW`
for a block that lives in the producer's `MainFlow`. The comment can also carry a historical element
name (`ST_Password2`, `Lkp_AttachmentType2`, `MainUniversityQualification`). Result before the fix:
29 in-scope nodes stayed `external`, 43 edges pointed at them, and every counter read 0.

Decision (implemented in `src/graph/build.ts` `resolveInScope`):

- **Out-of-scope refs:** unchanged. The comment id is kept as-is with `external: true`.
- **In-scope Screen/Block refs that are not a real node id:** the flow segment is ignored. Resolve by
  (module, kind, name). A unique match goes to that node. More than one match →
  `DUPLICATE_NAME_UNRESOLVABLE`: skipped, counted, edge dropped, never attached to an arbitrary duplicate.
- **Any in-scope ref still unmatched (any kind but Role):** `placeholder: true` and counted in
  `placeholderCount`, whether or not an edge points at it. **A node of an in-scope module is never
  `external`.**

Tests: `tests/graph.test.ts`, "in-scope refs with a consumer-local flow name". 4 of its 5 cases fail
on the pre-fix code.

## Amendment 3, 2026-10-30 (final-audit-2 MINOR-A): numbered local aliases from name clashes

When a consumer imports two elements with the same name from different producers, Studio keeps one
under a numbered local alias, and the dependency comment carries that alias (proof:
`demoportal/module/dataModel.txt` imports `OutSystemsUI/Size` as `Size2`). So `Name2`,
`Name3`… in a comment are not historical names.

Decision (`src/graph/build.ts` `resolveInScope`): for an in-scope ref whose exact name matches
nothing, strip the trailing number. If that base name matches **exactly one** element of the same
kind in the same module, resolve to it. The edge is marked `AMBIGUOUS` / 0.5, because the match is
inferred from Studio's naming rather than read. No match, or more than one match → counted
placeholder, never a guess.

Live result: placeholders 6 → 2. `Portal_CW/Entity/FilterOption → DGA_UI/Entity/Size` now resolves.
The 2 left are `Qualification_CW/.../MainUniversityQualification` (likely a real rename; needs
Studio to confirm) and `ST_QualificationMain2` (no `ST_QualificationMain` exists).
Tests: "consumer-side clash renames (Name2)"; 3 of them fail on the pre-amendment code.
