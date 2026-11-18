---
status: accepted
revises: OSG-006 "Opaque cross-module references" bullet; ADR-0005 "Cross-module refs" bullets
---

# External references are resolvable by module and element name; node ids are shared across scope boundaries

OSG-006 assumed a cross-module dependency arrives as an opaque key only — `eSpace.AddDependency(ParseGlobalKey("<key>"))` with "no readable name, no resolver tool" — and so gave every external ref a placeholder id `osgraph://external/<raw-key>` tagged `AMBIGUOUS`. Live evidence (2026-10-29, read-only `getDataModel` on `demoportal`) disproves the premise for this Studio build: every `AddDependency` line is immediately preceded by a comment naming the signature kind, the producer module and the element, e.g. `// IStaticEntitySignature OutSystemsUI/AccordionIconPosition`, `// IServerEntitySignature (System)/Activity`, `// IStaticEntitySignature MOD_DEMO_CommonLookups_LKP/LKP_Gender`. Module and element name are therefore available at the reference site, with no resolver call.

Decision:

- **One id for an element whether or not its module is in scope.** An external ref with a module/name comment gets the id `osgraph://<ProducerModule>/<Kind>/<Name>` — exactly the id the element receives when its own module is extracted (OSG-006's anchor-derived id). ADR-0005's in-scope resolution thus becomes trivial: the node already exists with full data, and the edge simply points at it. For an out-of-scope module the id is the same but the node is an **External node**: attributes `external: true`, `module: <ProducerModule>`, `globalKey: <raw key>`, `label: <Name>`, and no outgoing edges (osgraph never read that module). When a later rebuild brings the module into scope, the same id is now backed by a real node and the `external` placeholder is not emitted.
- **Confidence.** Edge to a ref whose module/name comment is present → `EXTRACTED` (direct name match, same standard as every other edge in OSG-006). `AMBIGUOUS` is now reserved for the case the comment is **absent** and only the opaque key is known; then — and only then — the OSG-006 fallback id `osgraph://external/<raw-key>` is used and the ref counts in `unresolvedExternalCount`. Extraction must tolerate both forms in one text.
- **Kind mapping** from the signature interface in the comment (and, equivalently, from the `/*** creating I<Kind> '<Name>' ***/` anchor when the module itself is extracted — the two must normalize to the same spelling or the ids cannot coincide) to the GLOSSARY element kind:

  | Interface (signature or anchor form) | Kind in id |
  |---|---|
  | `IServerEntity`, `IStaticEntity` (+`Signature`) | `Entity` |
  | `IStructure` | `Structure` |
  | `IServerAction`, `IServiceAction` | `ServerAction` |
  | `IClientAction` | `ClientAction` |
  | `IScreen`, `IMobileScreen`, `IWebScreen` | `Screen` |
  | `IBlock`, `IMobileBlock`, `IWebBlock` | `Block` |
  | `IRole` | `Role` (edge target only, see below) |
  | anything else (themes, images, sites, resources, timers, processes, …) | not graphed in v1 |

  Canonical Kind spellings used in ids are exactly: `Entity`, `Structure`, `ServerAction`, `ClientAction`, `Screen`, `Block`, `Role`, and the layer-graph module node `osgraph://<Module>` (kind `module`, no further segments). Dependencies on non-graphed kinds are dropped silently (they are outside the v1 element set, not failures) and do not count toward `unresolvedExternalCount`. `requires_role` edges still target `osgraph://<Module>/Role/<Name>` as OSG-006 allows; a Role node is an edge-target placeholder with no data of its own, in scope or not.
- **Module name spelling.** The producer module is stored verbatim from the comment, minus any surrounding parentheses: `(System)` → `System`. Its layer is `UNKNOWN` under OSG-003 (no MOD suffix), so edges into it are informational and never scored as violations. Any other module whose name does not match `layerSuffixPattern` is handled the same way; no special-casing of `System` beyond the paren strip.
- **Screens and blocks** referenced externally carry no UI-flow information in the comment; ADR-0008 defines how a flow-less external id relates to the flow-qualified in-scope id.

Why this is an extension of OSG-006, not a reopening: the id scheme `osgraph://<Module>/<Kind>/<Name>` is unchanged and the anchor remains the in-scope source of truth; what changes is that the external placeholder is the exception (comment missing) rather than the rule. ADR-0005's "tagged with the target module name when known" is tightened to "always known when the comment exists", and its "in scope → resolve to the real node" rule is now satisfied by id identity rather than by a lookup step. Rejected alternative: keep `osgraph://external/<key>` as the id and add a `resolvesTo` attribute — rejected because two ids for one element break `queryPath`/`queryImpact` across scope boundaries and make byte-identical rebuilds depend on which modules happened to be in scope.

## Amendment, 2026-10-30 (S6 audit F14): the dependency comment carries the UI flow too

This ADR's last decision bullet says screens and blocks "referenced externally carry no UI-flow
information in the comment". Live evidence says otherwise. The captured block text
`tests/fixtures/demoportal/block/Partner_OTP.txt` reads:

```
// IMobileBlockSignature MOD_DEMO_OTP_CW/MainFlow5/Partner_OTP
```

so the comment's form is `<Module>/[<Flow>/]<Name>`, not `<Module>/<Name>`. The code already parses
both (`src/extract/extractor.ts`, `src/extract/ids.ts`), so an external Screen/Block node comes out
**flow-qualified** — which makes ADR-0008's id identity across a scope boundary stronger than either
ADR claimed, not weaker: the external node gets exactly the id the element receives when its own
module is in scope, flow segment included, with no by-name resolution step needed.

This note exists so a future reader does not "fix" the code back to the flow-less form. The decision
is unchanged; only this ADR's description of the evidence was stale, and stale in the project's
favour. The flow-less form is still accepted — a comment that gives only `<Module>/<Name>` is
resolved by name as ADR-0008 describes.
