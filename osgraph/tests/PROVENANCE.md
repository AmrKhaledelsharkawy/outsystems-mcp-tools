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
| `rebuild.fake.ts`, `tools.helpers.ts` | the shared fakes serve those captures and the module's real names listing |
| `rebuild.test.ts`, `tools.test.ts`, `raw.test.ts`, `reextract.test.ts` | all four drive `rebuild.fake.ts` |
| `servicestudio.live.test.ts` | needs a live Service Studio MCP endpoint and an approved token |

**Porting the `rebuild.fake.ts` family to synthetic captures is deliberately not attempted here.**
Its assertions are counts and ids read off a real 319-block module (36 commented externals, a
duplicate-name block pair, a specific `IsReferenced` mix). Re-deriving them against hand-written
texts would rewrite the assertions themselves — which is how a suite stops testing what it used to
test. It is a worthwhile follow-up, and it is a different change from this one.

## The known failure

`rebuild.test.ts` → **"A6.2b: the 4 listings are one wave and the two module texts are another"**
asserts `['getDataModel','getStructures']` and receives `['getActionNames','getDataModel']`. It is a
wave-ordering assertion over an in-memory fake, **pre-existing and undiagnosed** — it fails on
`main` and has never been diagnosed, and it is *not* to be "fixed" by weakening the assertion.

It is **excluded from the published set** because its file is local-only for the provenance reason
above, so CI is green without anyone touching the assertion. The full local suite still shows it:

```
Tests  1 failed | 553 passed | 2 skipped (556)
```

That is the documented baseline. **Any other failure is caused by your change.**
