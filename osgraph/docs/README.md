# osgraph docs

| Path | Published? | What it is |
|---|---|---|
| [`adr/`](adr/) | **yes** | the decision record: numbered ADRs, each `accepted` or `superseded` |
| `discovery/` | no — local-only | raw measurement logs from live Service Studio runs: scripts, per-call timings, per-module names listings |

## Why the ADRs are published

Every issue in the automatic-refresh backlog is written against this vocabulary and these
decisions — a reference grid for reads, when a rebuild aborts versus skips, why flows are a separate
artifact, what a revision is. An agent working from a fresh clone has to be able to read them, so
they are tracked. [`../GLOSSARY.md`](../GLOSSARY.md) is published for the same reason.

The discovery records are not. They are measurement logs: hundreds of lines of per-module timings
and name listings, read verbatim off a real environment. Nothing in the ADRs depends on a reader
having them — where one is cited, the ADR says what it measured and notes that the record itself is
local.

## Real names are pseudonymised here

The modules this project was developed against belong to a customer estate. In the published ADRs
and glossary, their module, application and domain-specific element names are replaced with stable
pseudonyms — `demoportal` for the scope and its largest module, `MOD_DEMO_*` for modules, and
neutral element names — applied consistently so the examples still read as one coherent system.
The published tests use the same pseudonyms, for the same reason (see
[`../tests/PROVENANCE.md`](../tests/PROVENANCE.md)).

Generic OutSystems vocabulary is **not** pseudonymised and must not be: `OutSystemsUI`, `(System)`,
`MainFlow`, and the standard UI pattern names (`Accordion`, `Breadcrumbs`, `Timer`, …) are platform
nomenclature, and obscuring them would make the examples harder to read while hiding nothing.

**Measurements are never altered.** Every number in these ADRs — 7551 s, 3.19×, 319 blocks, width 4
— is the measured value. Pseudonymising a name does not license adjusting a result.

### If you add an ADR

Write it with pseudonyms from the start; do not write real names and plan to scrub later. If a
decision genuinely cannot be explained without a real name, put that part in a `discovery/` record
and cite it the way ADR-0007 and ADR-0013 do.
