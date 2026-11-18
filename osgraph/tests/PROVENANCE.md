# Which tests are published, and why

This repository ships **two** test sets out of one directory.

| Set | Where it lives | How to run it | Who can run it |
|---|---|---|---|
| **Published** | tracked in git; listed file-by-file in [`vitest.published.config.ts`](../vitest.published.config.ts) | `npm run test:published` | anyone with a fresh clone, and CI on ubuntu and windows |
| **Local-only** | git-ignored by the rules in the repository-root `.gitignore` | `npm test` (runs **everything present**, published set included) | whoever has the local working material |

`npm test` is still the real gate for a change. The published set exists so that **an agent picking
up any issue in this backlog can prove its change did not break something**, which before this
split was impossible from a clone: zero test files were tracked and CI only compiled.

## The rule for deciding which side a test belongs on

**Fixture provenance, not convenience.**

> A test belongs in the **local-only** set if it reads — directly or through a helper — any capture
> that carries a **real module, application, entity, screen, block or action name** from the
> environment this project was developed against. It also stays local if it needs **Service Studio,
> osopener, a session token or network access** to run.
>
> Everything else is **published**: tests over hand-written synthetic fixtures, tests that build
> their inputs in memory, and tests whose module names are arbitrary identifiers.

Two consequences worth stating, because both have already bitten:

- **A real name is a real name wherever it appears** — including as a bare string in an in-memory
  fake, with no fixture file involved. The published tests use pseudonyms (`demoportal`,
  `MOD_DEMO_*`) for exactly this reason. Renaming them changed no behaviour: in those tests a module
  name is an opaque key.
- **Adding a file to the published set is a deliberate edit**, because the config names each file
  instead of globbing. A glob would pass on a developer machine (where the local files exist) and
  publish a real name without anyone noticing. If you add a published test, add its path to
  `vitest.published.config.ts` in the same commit.

## What is local-only today, and why

| Path | Why it stays local |
|---|---|
| `fixtures/<captured-module>/` | verbatim read-only captures of one real Reactive module — its screens, blocks and data model, named as they are named in production. The directory is named after that module, which is why this file does not spell it out |
| `fixtures/flows/` | real `*_CW` block and screen captures (the flow-parser corpus), plus the syntax table that cites them |
| `fixtures/osmodel-replays/` | `getServerAction` replays from a real environment's scratch module |
| `fixtures/README.md` | the provenance table itself — it is a list of real element names |
| `live/` | records of live rebuild runs against a named 30-module scope |
| `extract.test.ts` | reads the captured module's texts directly |
| `flows.parse.test.ts`, `flows.live-fixtures.test.ts`, `flows.tools.test.ts` | read `fixtures/flows/`, the replays and the captured module's screens |
| `graph.live-fixtures.test.ts` | the byte-identical-rebuild determinism case, split out of `graph.test.ts` so the rest of that suite could be published |
| `rebuild.capture.fake.ts` | serves the captured module and its real names listing through the published `FakeReader`; split out of `rebuild.fake.ts` so that file could be published |
| `rebuild.capture.test.ts` | the real-capture rebuild cases kept after the port (see below) |
| `rebuild.wave-order.test.ts` | the known A6.2b failure, kept verbatim (see "The known failure") |
| `servicestudio.live.test.ts` | needs a live Service Studio MCP endpoint and an approved token |

## The `rebuild.fake.ts` family: published on a synthetic module, with the real-capture cases kept

`rebuild.test.ts`, `tools.test.ts`, `raw.test.ts`, `reextract.test.ts`, `rebuild.fake.ts` and
`tools.helpers.ts` are **published** (#41). They used to drive a real 319-block module's verbatim
captures; they now drive **`fixtures/synthetic/demoportal/`** (a Reactive module) and
**`fixtures/synthetic/demoservices/`** (a Service module), hand-written to carry the same *shapes*:

| Shape the real capture had | Where the synthetic fixture has it |
|---|---|
| more elements of a kind than the width-4 pool holds | 5 screens, 8 blocks, 5 client actions, 6 server actions — every fetched kind has more than four (`A6.2c`) |
| a duplicate block name across two UI flows (ADR-0008) | `Card` in `Common` and in `DemoPatterns` |
| commented externals (ADR-0006), the first one behind `var eSpace = …` | 12 `// I…Signature` lines in `module/dataModel.txt` |
| an uncommented, opaque `AddDependency` | `legacySource` inside `DemoVisit` → an `AMBIGUOUS` edge |
| a mixed `IsReferenced` listing | `Card` ×2, `OtpPanel`, `CNF_ExternalPage` are referenced-only; the rest are not |
| action flows and UI bindings on a sign-in screen | `screen/SignIn.txt` |
| an edge to a local element that is never read (ADR-0009 placeholder) | `SignIn` → `MainFlow/Dashboard` |
| Studio's CRLF line endings | `demoportal` texts are served as CRLF by the fake, whatever the checkout did to the files |
| a Service module whose service actions are all referenced-only | `demoservices`: three `SL_*` service actions, all `IsReferenced: true` |

**Every ported assertion was re-derived from the synthetic fixture, not adjusted until it passed.**
Literal counts that only described the real module (e.g. "0 block fetches", "4 referenced-only")
became either the property they encoded or the synthetic fixture's own count, with the derivation
in a comment: `referencedOnlyCount` is checked against a count taken off the listing
(`referencedIn`), the block fetches are the exact list of non-referenced blocks, and the
"every element fails" case asserts one skip per failed *fetch* (24 entries, 23 fetches).

The fake reads every fixture with its line endings normalised first, so the published suite serves
the same bytes on the ubuntu and the windows CI leg.

### Which real-capture tests were kept, and why (per file)

The synthetic fixture was written by the people who wrote the parser, so it can only contain shapes
they already knew about. The cases that still prove something about *what Studio actually returns*
stay local, in `rebuild.capture.test.ts`:

| Ported from | Kept locally because |
|---|---|
| `rebuild.test.ts` — happy path's F3 counts, the real `UIFlow` spelling | the real listing's `IsReferenced`/`UIFlow` values are Studio's, not ours |
| `rebuild.test.ts` — the escape hatch's `Accordion` duplicate | the ADR-0008 duplicate as Studio really reports it |
| `rebuild.test.ts` / `reextract.test.ts` — byte-identical rebuilds | real texts arrive in Studio's JSON envelope with escapes and CRLF; byte-identity over *those* is the claim that matters live |
| `raw.test.ts` — "one file per fetched text, byte-equal" | same, for `raw/` |
| `reextract.test.ts` — reextract reproduces graph + flows | same, for the offline path |
| `reextract.test.ts` — the Login flows parse with 0 unknown / 0 errors | a real screen can contain node types no synthetic author wrote |
| `tools.test.ts` | nothing kept: every case is about the handler envelope, which no real text changes |

`flows.tools.test.ts` (local) reads the captured Login screen, so it builds its tool context from
`rebuild.capture.fake.ts` instead of `tools.helpers.ts`'s synthetic default.

## The known failure

**"A6.2b: the 4 listings are one wave and the two module texts are another"** asserts
`['getDataModel','getStructures']` and receives `['getActionNames','getDataModel']`. It is a
wave-ordering assertion over an in-memory fake, **pre-existing**, and it is *not* to be "fixed" by
weakening the assertion.

It used to live in `rebuild.test.ts`. When that file was published (#41) the test was moved,
**verbatim**, into the local-only `rebuild.wave-order.test.ts`, so the published set does not carry it
and nobody had to touch the assertion to get CI green. The full local suite still shows it:

```
Tests  1 failed | 562 passed | 2 skipped (565)
```

That is the documented baseline. **Any other failure is caused by your change.**
