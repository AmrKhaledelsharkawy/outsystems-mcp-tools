# CLAUDE.md — agent rules for `outsystems-mcp-tools`

This file governs every Claude Code session in this repository. Read it **and**
[CONTRIBUTING.md](CONTRIBUTING.md) before touching a branch, a file or a ticket.
The two files are deliberately consistent: CONTRIBUTING.md is the same contract
written for humans. If they ever disagree, stop and report the contradiction
instead of picking one.

---

## 1. What this repository is

Three tools that make an AI agent useful against an **OutSystems 11** codebase
(full description in [README.md](README.md)):

| Folder | What it is |
|---|---|
| `osgraph/` | MCP server: deterministic dependency graph over a chosen scope; impact, path, layer violations, regex search inside action logic, live progress site |
| `osopener/` | MCP server: opens/closes modules in a running Service Studio via Windows UI Automation (win32-only by declaration) |
| `outsystems-token-manager/` | Claude Code skill + hooks managing the human-approved Service Studio session token |

### Architecture facts that are not negotiable

- **osgraph is not standalone.** It requires **osopener** (`rebuild` can only read
  modules that are *open* in Service Studio — anything else fails
  `MODULES_NOT_OPEN` — and Studio exposes no API for opening one) and the
  **token manager** (every read needs a human-approved session token; osgraph and
  osopener only ever *read* `token.txt`, neither calls `createSessionToken`,
  because approving a session is a human act). Never document, package, describe
  or reason about osgraph as if it were standalone — state the dependency in every
  new README, install doc, ADR, ticket or PR body that describes osgraph.
  The dependency is **one-way**: osopener and the token manager need nothing from
  osgraph.
- **Service Studio reads run four-wide** (measured admission limit, ADR-0013), and
  `reader.drain()` must be awaited before any module tab is closed. Closing a tab
  while reads are still queued is the one reproducible failure mode.
- **Design-time only, read-only against Service Studio.** Nothing here touches a
  running OutSystems app, its database or its runtime. osopener's only mutation is
  opening and closing tabs, and it refuses to close a module with unsaved changes.
- **The published tree is `src/` + per-folder READMEs + the token-manager
  installer.** Test suites, scope files, `docs/` (including ADRs), UI-Automation
  dumps, screenshots and `.probe/` scripts are **git-ignored on purpose**: they
  carry real module and application names. A new ADR, test or scope file
  therefore stays local automatically. Making something public is a deliberate
  act that requires scrubbing names first.

### Source-scope rule for the current backlog

Every source change in the M0–M4 backlog lives under **`osgraph/`**. Do not modify
`osopener/`, `outsystems-token-manager/`, or repository-root files unless the
ticket explicitly asks for it. If an osopener export proves insufficient, record
it as an external blocker in an issue comment rather than widening the change.

### Testing and checks

| Command | Where | Notes |
|---|---|---|
| `npm run build` | `osgraph/`, `osopener/` | `tsc`; this is what CI gates |
| `npm test` | `osgraph/`, `osopener/` | `npm run build && vitest run`; suites are local-only (git-ignored) |
| `npm run lint` | `osgraph/`, `osopener/` | `eslint src tests` |

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build` only, for `osgraph`
on {ubuntu-latest, windows-latest} and `osopener` on windows-latest, at Node 20.
It does not run tests yet — see issue **#2**. Any storage or native dependency you
add must install cleanly on **both** the ubuntu and windows legs.

**Known pre-existing failure.** `osgraph/tests/rebuild.test.ts` →
*"A6.2b: the 4 listings are one wave and the two module texts are another"* fails,
asserting `['getDataModel','getStructures']` and receiving
`['getActionNames','getDataModel']`. It is a wave-ordering assertion over an
in-memory fake, pre-existing and undiagnosed. Baseline for `main` @ `5e665ce`:
**553 passed, 1 failed, 2 skipped**. Any *other* failing test is caused by your
change.

**Live testing before any ticket claim.** Replay and fixture tests only exercise
the fake client's *assumptions* about what the live Model API returns; they cannot
catch a mismatch between those assumptions and reality. Before marking an
acceptance-criteria bullet done, or writing an "implementation evidence" claim,
test against a **live, user-opened Service Studio module** when Studio and that
module are available. If they are not, say so explicitly and treat the ticket as
**unverified** rather than closed. This applies with extra force to `osopener`,
which drives a live GUI: a green unit test says nothing about whether the UI path
still works on the installed build.

---

## 2. Branch hierarchy

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

Milestone branches:

| Branch | Milestone | Theme |
|---|---|---|
| `milestone/m0-feasibility` | M0 | Feasibility and prerequisites |
| `milestone/m1-watcher` | M1 | Reliable incremental watcher |
| `milestone/m2-generations` | M2 | Atomic generations and backward compatibility |
| `milestone/m3-github-sync` | M3 | GitHub distribution and developer sync |
| `milestone/m4-sharepoint-ops` | M4 | SharePoint integration and operations |

Feature-branch naming: `issue/<number>-<short-slug>` — e.g.
`issue/22-immutable-generations`.

**Never implement directly on a milestone branch or on `main`.**

---

## 3. Ticket implementation rules

Whenever a session starts implementing a ticket, in this order:

1. Read `CLAUDE.md` and `CONTRIBUTING.md`.
2. Fetch the GitHub Issue.
3. Identify its milestone and its blocking dependencies (the issue's
   `## Blocked by` section).
4. Verify that **all** blocking dependencies are completed and actually present
   in the target branch. A closed issue whose commits are not in the branch you
   are about to build on is *not* satisfied — check the branch, not just the
   issue state.
5. Identify the corresponding milestone branch.
6. Fetch the latest remote changes (`git fetch origin --prune`).
7. Create a new issue branch from the **updated** milestone branch.
8. Implement **only that issue**.
9. Run the required tests, lint and build checks.
10. Commit the changes.
11. Open a PR targeting the **milestone branch, not `main`**.
12. Reference the GitHub Issue in the PR body (`Closes #<n>` / `Refs #<n>`).
13. Comment on the Issue with the PR number and what landed (see "Closing an
    issue" below). Leave the Issue **open**.
14. **Stop** after completing the ticket.

If a blocking dependency is unmet, stop and report it. Do not implement the
dependency as a side quest, and do not start a different ticket instead unless
explicitly asked.

### Closing an issue

**An issue is closed when its PR is merged — never when the PR is merely open.**
A PR under review can still get changes requested, and an issue closed at
open-time hides live work from every "what is left?" query. Opening the PR earns
a comment on the issue; merging it earns the close.

**Nothing closes these issues automatically, and `Closes #<n>` will not do it.**
GitHub honours a closing keyword only when the PR merges into the repository's
**default** branch. Every issue PR here targets a **milestone branch** by design
(§2, §4), so the keyword is documentation of intent, not a mechanism. Keep
writing it — it links the PR to the issue — but **close the issue by hand**.

So, after a merge:

1. Confirm the merge actually landed: `git fetch origin --prune` and check the
   merge commit is on the milestone branch. A merged PR page is not proof the
   commits are where the next ticket will branch from (§3 step 4 depends on this).
2. Comment on the issue naming **the PR and the merge commit**, and state which
   acceptance criteria are met — and which are **not**, if any.
3. Close it with state reason **completed**.
4. Anything deliberately left undone becomes its **own** issue, linked from that
   comment. Never close over an unmet criterion in silence.

Three cases that are not a plain close:

- **Work split across published and local-only trees.** Some acceptance criteria
  land in git-ignored files (ADRs, test fixtures carrying real module names). The
  comment must say so explicitly, so a reader of the clone is not left looking
  for a file that was never published.
- **A `needs-human-publish` issue** (the live gates, e.g. #11, #37) is closed by
  the human who ran it, on measured evidence recorded in the issue. An agent
  never closes one of these on the strength of fixture or replay tests.
- **An issue that turns out to be unnecessary** closes as **not planned**, with
  the reason — not as completed, and not silently.

Do not reopen a closed issue to add follow-up work; file the follow-up.

---

## 4. Milestone integration rules

- Issue PRs merge into their corresponding **milestone branch**.
- A milestone merges into `main` **only** after its required tickets and
  validation gates are complete.
- **Later milestones must incorporate completed prerequisite changes before
  dependent implementation begins** — merge the prerequisite milestone branch (or
  the updated `main`) forward into the later milestone branch first.
- Do not merge incomplete milestone work into `main`.
- **Never use force-pushes or destructive resets** to synchronize branches.
- Keep milestone branches synchronized through deliberate, reviewable **merges**.
- Resolve dependency conflicts **before** starting dependent tickets.

---

## 5. Milestone mapping

M0–M4 are currently carried by **GitHub labels** (`M0`…`M4`), not by GitHub
milestone objects. If milestone objects are later created, **the issue's own
GitHub metadata is the source of truth** and overrides the table below.

| Milestone | Branch | Issues (by label) |
|---|---|---|
| M0 — feasibility and prerequisites | `milestone/m0-feasibility` | #8, #9, #10, #11 — plus the shared prerequisites #2–#7 (`enabler`) |
| M1 — reliable incremental watcher | `milestone/m1-watcher` | #12–#21 |
| M2 — atomic generations, backward compatibility | `milestone/m2-generations` | #22–#26 |
| M3 — GitHub distribution and developer sync | `milestone/m3-github-sync` | #27–#32 |
| M4 — SharePoint integration and operations | `milestone/m4-sharepoint-ops` | #33–#37 |

### Shared prerequisites (#2–#7)

Issues **#2–#7** are labelled `enabler` and carry no `M*` label. Implement them on
`milestone/m0-feasibility`. They are *shared*: the dependency graph has M1, M2 and
M3 tickets consuming them (#12←#2,#3 · #14,#15←#5 · #19←#6 · #22←#4 ·
#30←#7). Consequently **M1, M2 and M3 branches must merge the enabler work
forward before their dependent tickets begin** — see §4. If the published
dependency graph ever requires a different arrangement, the graph wins.

### Issue #1 is not implementable

**#1 — "External prerequisites for automatic refresh (humans only)"**
(`blocked-external`) represents external prerequisites. It must **never** be
treated as an automatically implementable source-code ticket. It blocks #11, #28,
#33 and #37.

Issues labelled **`needs-human-publish`** (#11, #37) are live gates requiring a
human to publish in a real environment. An agent may prepare measurement
scaffolding, but cannot close them.

---

## 6. Mandatory agent behaviour — "pick the next ticket"

When asked to pick the next ticket, Claude must:

1. Find **open** GitHub Issues labelled `ready-for-agent`.
2. Check their **actual** dependencies (`## Blocked by`), and whether those
   dependencies' changes are present in the target milestone branch.
3. Select **exactly one** unblocked issue.
4. Determine the correct milestone branch.
5. Create an issue-specific feature branch from it.
6. Implement and verify **that issue only**.
7. Open a PR against its **milestone branch**.
8. **Never automatically start another issue.**

Issues labelled `blocked-external` or `needs-human-publish` are never eligible.

---

## 7. Cross-milestone dependencies to watch

The milestone branches are **not independent**. These edges cross milestone
boundaries, and each one requires a forward merge before the dependent ticket
starts:

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

## 8. Repository configuration is a separate kind of work

Branch creation, documentation of this workflow, and label or milestone
administration are **configuration** tasks. They do not implement tickets and must
not modify osgraph source code. Equally, a ticket implementation must not quietly
change this contract.
