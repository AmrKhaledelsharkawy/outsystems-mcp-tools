---
status: accepted
revises: OSG-006 relation wording ("references"); clarifies OSG-011 and ADR-0005 response fields
---

# Skipped elements are never stubbed; placeholders are explicit; response counts are defined

The S3/S4 audit (2026-10-30) found the snapshot builder created an ordinary node for any in-scope edge target that had no extracted node, including elements that OSG-011 had just skipped. That contradicts OSG-011 ("omitted from graph.json entirely, not stubbed; any edge that would have pointed at it is simply not created") and inflates `nodeCount`. Two response fields named by ADR-0005 (`unknownModuleCount`, `unresolvedExternalCount`) had no written definition.

Decision:

- **Skipped targets.** An edge whose target resolves to an in-scope element listed in `skipped` (same module, kind, name) is dropped. No node is created for a skipped element. The dropped edge count is reported as `graph.osgraph.droppedEdgeCount` so the loss is visible.
- **Explicit placeholders.** A node that exists only because an edge names it, and that osgraph did not read, is allowed in exactly two cases: a **Role** target (ADR-0006) and an **external** target (module out of scope, `external: true`). Any other in-scope target with no extracted node (an element the names listing did not return, or a kind osgraph does not fetch) gets a node tagged `placeholder: true` with the kind taken from the reference site, and is counted in `graph.osgraph.placeholderCount`; `perModule.nodeCount` excludes placeholders. A full rebuild reads every listed element, so placeholders should be rare; a non-zero count is a signal for the verifier, not an error.
- **Count definitions** (deterministic, computed from the written snapshot):
  - `nodeCount` / `edgeCount`: all nodes and links in the snapshot, placeholders and externals included.
  - `unknownModuleCount`: distinct module nodes (in scope or referenced) whose layer is `UNKNOWN`. Informational, per OSG-003.
  - `unresolvedExternalCount`: distinct `osgraph://external/<key>` targets (comment absent, AMBIGUOUS).
  - `placeholderCount`, `droppedEdgeCount`: as above.
- **Relation wording.** OSG-006's `references` is defined as "a direct, name-resolved reference to an entity, structure or screen" (FK, aggregate source, entity CRUD action, screen navigation `Destination`). The vocabulary stays closed at four relations; no `navigates` relation is added.
- **AMBIGUOUS score** is `0.5` (OSG-001 fixes no number for AMBIGUOUS).
- **Out of v1 (recorded for v2):** references inside expression strings, e.g. `SetCondition("Param1 = Entities.LKP_ServiceType.ServiceA")`. OSG-006 extraction is syntactic over Model-API statements; string contents are stripped on purpose. This is the only way the captured screens reference static entities, so entity edges from screens are under-reported in v1 by design.
