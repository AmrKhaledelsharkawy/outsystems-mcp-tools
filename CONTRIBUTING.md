# Contributing to outsystems-mcp-tools

Thanks for working on this. This document is the human-readable contract;
[CLAUDE.md](CLAUDE.md) is the same contract written for Claude Code sessions. The
two are kept consistent — if you change one, change the other in the same commit.
If you find them disagreeing, treat that as a bug and report it rather than
guessing which one is right.

---

## 1. What lives here, and what does not

| Folder | What it is |
|---|---|
| `osgraph/` | MCP server: deterministic dependency graph over a chosen scope |
| `osopener/` | MCP server: opens/closes modules in a running Service Studio (Windows-only) |
| `outsystems-token-manager/` | Claude Code skill + hooks for the Service Studio session token |

The published tree is **`src/` plus per-folder READMEs plus the token-manager
installer**. Test suites, scope files, `docs/` (including the ADRs), UI-Automation
dumps, screenshots and `.probe/` scripts are **git-ignored on purpose**: they carry
real module and application names from the environment these tools were developed
against. They still exist on disk — they are simply not published.

A new ADR, test or scope file therefore stays local automatically. If something
new genuinely should be public, add it to the repository tree deliberately and
**scrub real names first**.

### Architecture decisions you must not undo

- **osgraph is not standalone.** It needs **osopener** (`rebuild` can only read
  modules that are *open* in Service Studio; anything else fails
  `MODULES_NOT_OPEN`, and Studio exposes no API for opening one) and the
  **outsystems-token-manager** (every Service Studio read needs a human-approved
  session token; osgraph and osopener only *read* `token.txt` — neither calls
  `createSessionToken`, because approving a session is a human act). State this in
  any new README, install doc, ticket, ADR or PR that describes osgraph. The
  dependency runs one way: osopener and the token manager need nothing from
  osgraph.
- **Service Studio reads run four-wide** (measured admission limit, ADR-0013), and
  `reader.drain()` must be awaited before closing any module tab — closing a tab
  with reads still queued is the one reproducible failure mode.
- **Design-time and read-only.** Nothing here touches a running OutSystems app,
  its database or its runtime.
- **OutSystems 11 only** (Service Studio 11.55.x, Traditional Web / Reactive). Not
  ODC. osopener drives a live GUI and is therefore version-sensitive by nature.

### Scope rule for the current M0–M4 backlog

Every source change in the backlog lives under **`osgraph/`**. Don't modify
`osopener/`, `outsystems-token-manager/` or repository-root files unless the
ticket asks for it. If an osopener export turns out to be insufficient, record it
as an external blocker in a comment rather than widening the change.

---

## 2. Tests, lint and build

Run these from the package you changed (`osgraph/` or `osopener/`):

```bash
npm run build   # tsc — this is what CI gates
npm test        # npm run build && vitest run
npm run lint    # eslint src tests
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build` only — `osgraph` on
ubuntu-latest and windows-latest, `osopener` on windows-latest, Node 20. It does
not run tests yet (see issue #2). Any dependency you add must install cleanly on
**both** the ubuntu and windows legs; a native module that cannot is a decision to
document, not a CI leg to quietly break.

**Known pre-existing failure:** `osgraph/tests/rebuild.test.ts` → *"A6.2b: the 4
listings are one wave and the two module texts are another"*. It is a wave-ordering
assertion over an in-memory fake, undiagnosed, and unrelated to current work.
Baseline on `main` @ `5e665ce` is 553 passed / 1 failed / 2 skipped. Any *other*
failure is yours.

**Live verification.** Replay and fixture tests only exercise the fake client's
*assumptions* about the live Model API — they cannot catch a mismatch with
reality. Before you tick an acceptance criterion or write an "implementation
evidence" claim, verify against a **live, user-opened Service Studio module** when
Studio and that module are available. If they aren't, say so and leave the ticket
**unverified** rather than closed. This matters most for `osopener`: a green unit
test says nothing about whether the UI path still works on the installed Service
Studio build.

---

## 3. Branching strategy

### Hierarchy

`main` is the **stable integration branch**. Each milestone has its own
integration branch. Each implementation ticket gets its own feature branch created
from the corresponding milestone branch.

```text
main
 └── milestone/m1-watcher
      ├── issue/12-durable-state
      ├── issue/13-coalescing-planner
      └── issue/14-studio-lease
```

| Branch | Milestone | Theme |
|---|---|---|
| `milestone/m0-feasibility` | M0 | Feasibility and prerequisites |
| `milestone/m1-watcher` | M1 | Reliable incremental watcher |
| `milestone/m2-generations` | M2 | Atomic generations and backward compatibility |
| `milestone/m3-github-sync` | M3 | GitHub distribution and developer sync |
| `milestone/m4-sharepoint-ops` | M4 | SharePoint integration and operations |

Feature branches are named `issue/<number>-<short-slug>`, e.g.
`issue/22-immutable-generations`.

**Nobody implements directly on a milestone branch or on `main`.**

### Working a ticket

1. Read `CLAUDE.md` and this file.
2. Fetch the GitHub Issue.
3. Identify its milestone and its blocking dependencies (its `## Blocked by`
   section).
4. Verify every blocking dependency is complete **and present in the target
   branch**. A closed issue whose commits aren't in the branch you're building on
   is not satisfied.
5. Identify the corresponding milestone branch.
6. `git fetch origin --prune`.
7. Branch from the **updated** milestone branch:
   `git switch -c issue/12-durable-state origin/milestone/m1-watcher`.
8. Implement **only that issue**.
9. Run tests, lint and build.
10. Commit.
11. Open a PR targeting the **milestone branch — not `main`**.
12. Reference the issue in the PR body (`Closes #12`).
13. Stop there. One ticket per branch, one ticket per PR.

If a dependency turns out to be unmet, stop and say so. Don't fold the dependency
into this PR, and don't silently switch to a different ticket.

### Milestone integration

- Issue PRs merge into their milestone branch.
- A milestone branch merges into `main` **only** once its required tickets and
  validation gates are complete.
- **Later milestones must incorporate completed prerequisite work before
  dependent implementation begins** — merge the prerequisite milestone branch (or
  the updated `main`) forward into the later milestone branch first.
- Never merge incomplete milestone work into `main`.
- **No force-pushes, no destructive resets** to synchronize branches. Keep
  branches in step through deliberate, reviewable merges.
- Resolve dependency conflicts **before** starting dependent tickets, not during
  review.

---

## 4. Milestone mapping

M0–M4 are currently carried by **GitHub labels** (`M0`…`M4`), not by GitHub
milestone objects. **The issue's own GitHub metadata is the source of truth** — if
ticket numbers or milestone assignments differ from the table below, the issue
wins.

| Milestone | Theme | Issues |
|---|---|---|
| M0 | Feasibility and prerequisites | #8, #9, #10, #11 — plus the shared prerequisites #2–#7 |
| M1 | Reliable incremental watcher | #12–#21 |
| M2 | Atomic generations and backward compatibility | #22–#26 |
| M3 | GitHub distribution and developer sync | #27–#32 |
| M4 | SharePoint integration and operations | #33–#37 |

### Shared prerequisites (#2–#7)

Issues **#2–#7** are labelled `enabler` and carry no `M*` label. Their
implementation belongs on `milestone/m0-feasibility`. They are genuinely shared —
M1, M2 and M3 tickets depend on them (#12←#2,#3 · #14,#15←#5 · #19←#6 ·
#22←#4 · #30←#7) — so those milestone branches must merge the enabler work
forward before their dependent tickets start. If the published dependency graph
ever requires a different arrangement, follow the graph.

### Issue #1

**#1 — "External prerequisites for automatic refresh (humans only)"** represents
external prerequisites (`blocked-external`). It is **not** an automatically
implementable source-code ticket and must never be treated as one. It blocks #11,
#28, #33 and #37.

Issues labelled **`needs-human-publish`** (#11, #37) are live gates: they need a
human to publish into a real environment and measure the result. Scaffolding can
be prepared in advance; the gate itself cannot be closed by an agent.

### Cross-milestone dependencies

The milestone branches are not independent. Each of these edges needs a forward
merge before the dependent ticket begins:

| Dependent | Milestone | Depends on | From |
|---|---|---|---|
| #17 | M1 | #10 | M0 |
| #22 | M2 | #18 | M1 |
| #25 | M2 | #13 | M1 |
| #27, #30 | M3 | #22 | M2 |
| #29 | M3 | #11 (human gate), #13 | M0, M1 |
| #28, #33, #37 | M3/M4 | #1 (external) | — |
| #34 | M4 | #32 | M3 |
| #35 | M4 | #9, #25, #29 | M0, M2, M3 |
| #36 | M4 | #20, #31 | M1, M3 |

---

## 5. Agent sessions ("pick the next ticket")

An agent asked to pick the next ticket must: find **open** issues labelled
`ready-for-agent`; check their actual dependencies and whether those changes are
present in the target milestone branch; select **exactly one** unblocked issue;
determine the correct milestone branch; create an issue-specific feature branch;
implement and verify that issue only; open a PR against its milestone branch; and
**never automatically start another issue**.

Issues labelled `blocked-external` or `needs-human-publish` are never eligible for
automatic selection.

---

## 6. Pull requests

- Target the **milestone branch**, never `main`, unless you are merging a
  completed milestone.
- Reference the issue (`Closes #12`).
- Say which checks you ran, on which platform, and whether live Service Studio
  verification happened or was skipped — and if skipped, say so plainly.
- Keep the diff to one ticket. If you found a second problem, open an issue.
- Don't include unrelated working-tree changes.

## 7. License

MIT — see [LICENSE](LICENSE). By contributing you agree your contribution is
licensed under it.
