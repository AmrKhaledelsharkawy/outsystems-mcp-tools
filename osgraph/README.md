# osgraph

An MCP server that builds a **deterministic dependency graph** over a set of
OutSystems 11 modules, then answers impact, path, layer-violation and
logic-search questions against it — **with no LLM in the loop**.

Every answer comes from a snapshot on disk produced by parsing what Service Studio
reported. Nothing is inferred, summarised or guessed, so the same question returns
the same answer, and "what breaks if I change this?" is a graph traversal rather
than a judgement call.

Two kinds of question it answers:

- **Between elements** — who calls this server action? what does this screen depend on?
  which cross-module references break our layering rules? how do I get from A to B?
- **Inside elements** — what do the action flows actually *do*? Which actions anywhere
  in the scope assign to this variable, or call that action?

---

## ⚠️ Hard requirement — osgraph does not work alone

**Install both of these before osgraph. This is not optional.**

| Required | Why osgraph cannot do without it |
|---|---|
| **[osopener](../osopener/)** | `rebuild` can only read modules that are **open** in Service Studio. Anything else fails `MODULES_NOT_OPEN`. osopener is what opens them — Service Studio exposes no API for it. `osgraph run` loads it directly to open and close every module |
| **[outsystems-token-manager](../outsystems-token-manager/)** | Every Service Studio read needs a **human-approved** session token. osgraph only ever *reads* `token.txt` — it never calls `createSessionToken`, because approving a session is a human act. The token manager is what obtains, persists and reuses that token |

Without both, neither `rebuild` nor `osgraph run` can run — and `rebuild` is what produces the snapshot every
other tool reads. You can still query a snapshot that already exists, but you cannot
build one, which means you cannot get started and cannot ever refresh.

---

## Why a scope

A graph is built per **scope**: a named list of modules you choose
(`{ name, modules }`). osgraph never adds or drops modules from a scope by itself —
that stays an explicit decision, so a snapshot always covers exactly what you said.

---

## Architecture

How a published change becomes an answer. Read it as one pipeline, left to right:

```text
 developer's 1-Click Publish to DEV
              |
              v
  [1] detection ....... poll an authoritative current-state read, every 60 s,
                        plus a periodic full reconciliation scan.
                        OutSystems 11 exposes NO publish webhook (ADR-0014);
                        a revision is an opaque equality token, never ordered.
              |
              v
  [2] dirty queue ..... durable, revision-aware, coalescing. Three publishes of
                        one module become one pending extraction of the latest
                        revision. Survives restart, because it is the only
                        record of work owed.
              |
              v
  [3] Studio worker ... ONE process, one machine-wide lease, one module at a
                        time: osopener opens the module -> verify revision ->
                        read it four-wide (ADR-0013) -> drain -> verify revision
                        again -> close. Needs a logged-in interactive Windows
                        desktop; GUI automation does not work in Session 0.
              |
              v
  [4] shard cache ..... content-addressed per-module extraction and flow
                        objects. An unchanged module is never re-read and its
                        shard never re-uploaded.
              |
              v
  [5] assembly ........ recompute the whole scope from the cached shards of ALL
                        its modules - a pure, deterministic merge, no Studio
                        involved - into one immutable generation plus a
                        manifest. An incomplete revision vector is never
                        published as a scope state.
              |
              v
  [6] publication ..... upload immutable shards first, then the manifest, to a
                        separate private GitHub repository (default) or a
                        SharePoint document library. The manifest lands last and
                        is read first, so it never names a missing shard.
              |
              v
  [7] developer sync .. `osgraph sync` on each workstation downloads only the
                        hashes it lacks, validates them, merges locally with the
                        same deterministic builders, and atomically switches its
                        local pointer. No Service Studio on the client, and no
                        GUI control handed to it.
```

The vocabulary this pipeline uses — *revision*, *revision vector*, *generation*,
*shard*, *manifest*, *watcher*, *dirty queue* — is defined, with the distinctions that
matter, in [`GLOSSARY.md`](GLOSSARY.md).

**Freshness is a measured target, not a guaranteed bound.** One real module commonly
costs around three minutes of extraction at four parallel reads, and there is exactly
one Studio worker, so a handful of simultaneously-changed modules can exceed any
fifteen-minute goal on a correctly working system. osgraph therefore records a deadline
per event and **reports the misses** instead of claiming compliance it cannot verify
([ADR-0014](docs/adr/0014-publishes-detected-by-polling-a-current-state-read.md)).

**And none of it makes osgraph standalone.** Automatic detection removes the human from
*noticing* a publish. It does not remove **osopener** — nothing else can open a module
for reading — or the **token manager**, because approving a Service Studio session is a
human act that is never bypassed or automated. A watcher whose session token has expired
stops and alerts; it does not work around the approval. See **"Hard requirement —
osgraph does not work alone"** above.

**What exists today:** stages 3, 4 (as `raw/` captures) and 5 (as a single snapshot) ship
in the caller-triggered [`rebuild`](#tools) tool, which is **not** being removed — it stays
the way to build a baseline and to force a re-read. Stages 1, 2, 6 and 7, immutable
generations and the `watch` / `sync` / `status` commands are being built across
milestones M0–M4; the issue tracker is the authority on what has landed.

---

## Tools

| Tool | Does |
|---|---|
| `defineScope` | Writes a scope file `{ name, modules }`. Overwrites a scope of the same name |
| `listScopes` | Lists defined scopes, sorted by name |
| `graphStatus` | Read-only freshness report for one scope's **local** snapshot: snapshot build time, scope completeness (scope modules with no capture, by name), and per module `capturedAt`, `moduleVersion` (`"unknown"` for captures that predate the version field), skipped and referenced-only counts. Reads files on disk only: no Studio, no osopener, works with Studio shut. CLI twin: `osgraph status --scope <name> [--json]` |
| `rebuild` | Full extraction run over one scope: reads every element of every module through the `servicestudio` MCP (read-only), parses edges, regenerates the snapshot **atomically** — all-or-nothing, so the previous snapshot survives any failure. Raises the [live progress site](#the-live-progress-site) and returns its URL |
| `queryImpact` | Reachable node set from one node (dependents *or* dependencies, optionally depth-capped), by in-process BFS |
| `queryPath` | Shortest path between two nodes |
| `listViolations` | Every cross-module edge whose source/target layers break a layer rule, plus modules whose layer suffix is `UNKNOWN` (exempt, never scored) |
| `getFlow` | The logic **inside** one element's actions — flow nodes in walk order, a compact text listing, and the full IR |
| `searchFlows` | Regex search across the logic of every action in the scope: callee names, assignments, If conditions, ForEach lists, exception text, call arguments, and UI wiring |

Node ids look like `osgraph://<Module>/<Kind>/<Name>`, or
`osgraph://<Module>/<Kind>/<UIFlow>/<Name>` for screens and blocks.

## The live progress site

**Every `rebuild` raises a live progress site automatically and returns its URL.** No flag, no
separate process, no setup.

A rebuild runs for minutes to hours and its only other output is stderr — which most MCP clients
swallow. Without this, a running rebuild is indistinguishable from a hang. So the site comes up
**before the first Service Studio call**, meaning there is never a window where work is happening
that you cannot watch.

The URL is returned **in the `rebuild` result** as `progressSite.url`, and printed to stderr as a
banner. It is in the result on purpose: a URL that only ever reached stderr is a URL you never saw.

What the page shows:

| Live progress | Graph explorer |
|---|---|
| Overall progress weighted by expected duration, time remaining, elapsed, current module and its phase, per-module table with node/edge counts, live log | The finished graph, find-element search, per-module breakdown, and depth-N module **discovery** that can build a new scope for you |

### Lifetime

The site lives **in the osgraph server process** — so it stays up for your whole session, long
after the run finishes, and disappears when the session ends. Nothing is left behind: no PID file,
no stop command, no orphaned process holding a port.

For the offline `reextract` command the site is **opt-in** (`--serve`), because that command is a
one-shot process: a site raised there would die the instant it printed its own URL.

### It binds to loopback by default

The page serves your module names, your graph and your live log **with no authentication**. The
shipped default is therefore `127.0.0.1`. To read it from your phone:

```
OSGRAPH_PROGRESS_HOST=0.0.0.0
```

The banner then lists every address the site is genuinely reachable on — only adapters that are
actually up, so it can never print a stale IP from a disconnected adapter.

**Mutating routes stay loopback-only regardless of the bind address.** Viewing the page is a
convenience worth sharing; starting a discovery that opens modules in your live Service Studio, or
writing a scope file, is not something a device across the network gets to do. Those return `403`
to any non-loopback peer.

### Turning it off

```
OSGRAPH_PROGRESS_SITE=off
```

Starting the site can never fail a rebuild: if the port cannot be bound, the reason is reported and
the rebuild proceeds without the view.

### Time remaining

The ETA is weighted by each module's **measured** duration, so one 40-minute module cannot read as
"1 of 30". Those measurements are written to `<graphDir>/<scope>/timings.json` after each run, which
is why a real ETA appears from the **second** run onward. Timings are read across all scopes — read
latency is a property of the module, not of the scope — so a new scope made of known modules has an
ETA on its first run. An ETA is only promised when every unfinished module has history: one unknown
module could be the 40-minute one, and a confidently wrong ETA is worse than none.

### Which tools need Service Studio

Only `rebuild` talks to Service Studio. `getFlow`, `searchFlows`, `queryImpact`,
`queryPath` and `listViolations` read the snapshot on disk — they work with **Studio
shut down entirely**, which is what makes them cheap to use repeatedly.

`queryPath` is the one tool that shells out, to a pinned `graphify` binary.

---

## Layer rules

`listViolations` is driven by `layer-rules.json`, where `allow[layer]` lists every
layer that `layer` may reference (same-layer peers always allowed). Any pair not
listed is forbidden:

| Layer | May reference |
|---|---|
| `UI` | `UI`, `CW`, `SL` |
| `CW` | `CW`, `SL` |
| `SL` | `SL`, `BL` |
| `BL` | `BL`, `CS` |
| `CS` | `CS` |
| `LKP` | `LKP` |

A module's layer comes from its name suffix (`_UI`, `_CW`, `_SL`, `_BL`, `_CS`,
`_LKP`); anything else is tagged `UNKNOWN` and never evaluated. Edit the file to match
your own conventions.

---

## Install

Requires **Node.js 20+**, a running Service Studio 11 with its MCP server enabled, and —
as above — **[osopener](../osopener/) and
[outsystems-token-manager](../outsystems-token-manager/) installed first**.

```bash
git clone https://github.com/AmrKhaledelsharkawy/outsystems-mcp-tools.git
cd outsystems-mcp-tools

# 1. the module opener osgraph depends on (Windows)
cd osopener && npm install && npm run build && cd ..

# 2. the session-token manager osgraph depends on
cd outsystems-token-manager && ./install.ps1 -SkipMcpGuard && cd ..

# 3. osgraph itself
cd osgraph && npm install && npm run build
```

That produces `dist/cli.js`.

**`queryPath` additionally needs the `graphify` CLI on `PATH`**
(or pointed at by `OSGRAPH_GRAPHIFY_BIN`). Every other tool works without it.

---

## Run

osgraph is a **stdio** MCP server — your MCP client launches it. Register it in
`.mcp.json` (project scope) or your user-scope MCP config:

```json
{
  "mcpServers": {
    "osgraph": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/outsystems-mcp-tools/osgraph/dist/cli.js"],
      "env": {
        "OSGRAPH_SERVICESTUDIO_URL": "http://127.0.0.1:41820/mcp"
      }
    }
  }
}
```

Use the port Service Studio actually shows for its MCP server — `41820` is only the
common default.

### First run

**Prerequisite:** osopener and the token manager must already be installed — see the
hard requirement above.

1. Make sure a session token exists. With the token manager installed this happens by
   itself: the first Service Studio call raises the approval dialog once, and the token
   is saved to `token.txt` for every session after that.
2. `defineScope` with a name and the modules you care about.
3. Open those modules with **osopener**'s `openModule`. `rebuild` fails
   `MODULES_NOT_OPEN` for anything that isn't open, and Service Studio has no API for
   opening a module — this step is why osopener is required, not merely convenient.
4. `rebuild` that scope. It reads every element of every module, so expect this to
   take a while on a large scope; it runs 4 reads at a time by default. **Open the
   `progressSite.url` from the result** to watch it — that is also how you find out it is
   progressing rather than hung.
5. Query away — `queryImpact`, `searchFlows`, `listViolations` — with Studio closed if
   you like.

Re-run `rebuild` when modules change (after a publish's merge completes). Rebuilds are
caller-triggered on purpose: nothing watches your modules behind your back.

The steps above suit a **small** scope. Past roughly 30 open modules Service Studio
degrades (it splits into extra windows and its environment-list fetch grows from ~5 s
to over 45 s), so for anything larger use `osgraph run` below.

### Large scopes and single-module refresh: `osgraph run`

> **Requires osopener and the token manager, like every live osgraph path.** `run`
> opens and closes each module through **osopener** (Service Studio has no API for
> opening one), and every read needs the human-approved session token in `token.txt`
> that the **token manager** creates — osgraph only reads it. Without osopener `run`
> stops with `OSOPENER_UNAVAILABLE` before touching Studio; without a token no read
> can succeed. `run` also needs `OSGRAPH_SERVICESTUDIO_URL` at start.

```bash
node dist/cli.js run --scope <name>                    # full staged build, resumable
node dist/cli.js run --scope <name> --module <module>  # refresh ONE module
node dist/cli.js run --scope <name> --modules a,b,c            # re-read the named modules only
node dist/cli.js run --scope <name> --changed                # re-read only modules whose listed version changed
node dist/cli.js run --scope <name> --max-open 12 --max-consecutive-failures 3 --json
```

**Full staged build.** For each scope module that is not yet staged: make room
(closing only tabs this process opened whose extraction is already staged, while
`--max-open`, default 12, tabs are open), open it via osopener, stage it, wait for the
read drain, and close the tab it opened. A module you already had open is read but
left open. The last module finalizes `graph.json` and `flows.json` exactly as the
staged `rebuild({ scope, module })` does. **Resumable:** a module with a stage entry is
skipped, so after an interruption you run the same command again.

**One-module refresh.** `--module M` re-reads only `M` and then re-extracts the whole
scope offline from `raw/`, so `graph.json` and `flows.json` come out byte-identical to
`osgraph reextract` over the same captures. Every other scope module must already have
a `raw/` capture; if one does not, it fails with `RUN_CAPTURES_MISSING` naming them
(run a full `osgraph run --scope <name>` first). It reports the capture age of every
other module: the rest of the graph is only as fresh as its last full read.

**Several modules, or only the changed ones.** `--modules a,b,c` reads only the named scope
modules (names are case-exact; anything outside the scope is `SCOPE_INVALID`), then runs one
offline re-extract; the unnamed modules need a `raw/` capture. `--changed` opens each scope
module, compares the version Service Studio lists for it with the `moduleVersion` in its capture
manifest, and re-reads only those that differ; then one re-extract. Every module is reported with
its reason: `unchanged`, `changed`, `unknown` (the capture or the listing carries no version,
e.g. a schema-1 manifest) or `no capture`. An unknown version is never treated as unchanged. The two
flags combine (`--modules` limits the candidates). Opening, `--max-open` and drain-before-close are
the same as a full run. The comparison is one function (`decideChange` in `src/run/changed.ts`) so a
stronger change signal can replace it later. Like every `osgraph run` mode this needs osopener and the
token manager's session token. A failed module skips the re-extract and exits 1.

**Verifying `--changed` (human, live Service Studio required).** The listed version is trusted only
after this probe passes: (1) publish a throwaway module and confirm the version `listApps` reports for
it changes; (2) close and reopen an unchanged module and confirm its version does not change; (3) after
publishing one module of a small scope, run `osgraph run --scope <scope> --changed` and confirm only
that module is read (see the run log and timings). If (1) or (2) fails, set
`OSGRAPH_DISABLE_CHANGED=1`: `--changed` then refuses with `CHANGED_DISABLED`; use `--modules` instead.
Record the probe result in the issue.

**Robustness**, learned from a 287-module run:

- **Foreground gate** — osopener only sends input while Studio owns the foreground;
  `run` waits (logging the window in front about once a minute) instead of failing.
- **Retry by failure kind** — `foreground` waits and retries; `studio-busy` (only a
  transient Progress window appeared) waits for Studio to go idle; `open-dialog`
  closes the "Open from Environment" dialog only after confirming it is up, and logs
  "dismissed" only when it is gone afterwards; `other` is not retried.
- **Full diagnostics** — every failed attempt logs code, message and failed step;
  giving up keeps osopener's real error and saves a screenshot under
  `<graphDir>/<scope>/run/screenshots/`. The run log and a per-module report sit in
  `<graphDir>/<scope>/run/`.
- **Circuit breaker** — after `--max-consecutive-failures` (default 3, `0` disables)
  modules in a row fail to open, the run stops: Studio itself is most likely stuck.
  Fix or restart it and run the same command again.
- A tab is never closed with reads still queued (the reader is drained first), and
  osopener refuses to close a module with unsaved changes.

The live progress site is raised and its URL printed before any work starts; add
`--serve` to keep it up after the run ends.

### `osgraph doctor` — why a rebuild or run cannot work here

One **read-only** command that explains, before anything fails halfway, whether this machine can
rebuild or `run` a scope:

```bash
node dist/cli.js doctor --scope <name>
node dist/cli.js doctor --scope <name> --json   # the report as JSON on stdout
```

| Check | Fails when |
|---|---|
| `token` | no `token.txt` at or above the working directory (the same search osopener uses), the file is empty, or Studio's `listApps` rejects it. The remedy is always a **human approving a new session through the token manager**; the doctor never calls `createSessionToken` and never prints the token. |
| `endpoint` | `OSGRAPH_SERVICESTUDIO_URL` is unset/invalid, or Studio's MCP endpoint cannot be reached. A reachable endpoint that rejects the token is reported as a `token` failure, not an `endpoint` one. |
| `osopener` | the shared adapter cannot load osopener; its failure cause is shown verbatim. |
| `scope` | a module in the scope does not match a listed name **case-exactly**. Near misses (different case, typo) are reported with a suggestion. A listed-but-closed module is a warning. |
| `graphDir` | the graph directory is not writable. Also reports whether a snapshot exists and how old it is. |

`scope` and the snapshot age need `--scope`. Exit code is `1` when any check fails, `0` otherwise.
It writes nothing and opens or closes no module; its one Studio call is `listApps`.

**"No module is currently open in Service Studio"** means *that name is not an open module* — a
closed, misspelled or wrongly-cased name — even while other modules are open. It does not mean
Studio is empty or unreachable. The `scope` check says which of your names it is.

This is the **local** doctor. Source / DEV-environment preflight (issue #9) is deferred and will
extend this command rather than replace it. As everywhere, osgraph is not standalone: the doctor
checks the two things it depends on — the human-approved session token and osopener.

#### Live verification procedure (human, Service Studio open)

Run each case and confirm the named check fails with the right cause, then restore the setup:

1. **Expired token** — keep Studio open, put a stale value in the workspace's `token.txt`
   (or let the session lapse). Expect `token` FAIL ("rejected the token") and `endpoint` PASS.
2. **Studio closed** — quit Service Studio. Expect `endpoint` FAIL ("unreachable"), `token` SKIP.
3. **Wrong-case scope name** — open the scope's modules, change one module name's case in the
   scope file. Expect `scope` FAIL with `did you mean '<correct name>' (different case)`.

### Offline re-extract

If you change the parser and want to regenerate `graph.json` + `flows.json` from raw
texts already captured — **no Service Studio, no session token, no `OSGRAPH_SERVICESTUDIO_URL`**:

```bash
node dist/cli.js reextract --scope <name>
node dist/cli.js reextract --scope <name> --json   # full result as JSON
node dist/cli.js --help
```

### Snapshot freshness

`graphStatus` (MCP) and `osgraph status --scope <name> [--json]` (CLI) report, from files on disk only, when a scope's snapshot was built and how complete it is. They need no Service Studio and no token. The captures they describe were produced by `run`/`rebuild`, which do need osopener and the token manager.

Live check (human, with Service Studio open): after a real `osgraph run --scope <name>`, compare `osgraph status --scope <name> --json` with each `<graphDir>/<scope>/raw/<module>/manifest.json` (`capturedAt`, `moduleVersion`, `skipped.length`, `referencedOnlyCount`); they must match exactly.

### Accuracy audit

`osgraph audit --scope <name> [--k 20] [--seed 1] [--json]` samples K edges and K absent pairs per
consumer layer and producer kind from the snapshot, checks each against the consumer element's raw
text, and reports precision, recall and every disagreement. It reads only the snapshot and `raw/` that
an earlier `run` produced (so, like every osgraph command that builds data, it depends on osopener and
the token manager having produced them), and needs no Service Studio itself. The human half, comparing
sampled module pairs with Studio's dependency list, is written up in [`LIVE-AUDIT.md`](LIVE-AUDIT.md).

### Read cost per kind

Every rebuild records, in `<graphDir>/<scope>/timings.json`, how many read calls each element kind
cost in each module and their p50/p95 latency. `osgraph kinds` joins that to what each kind yielded
and lists kinds with read time but zero edges and zero flows:

```bash
node dist/cli.js kinds --scope <name>          # offline: no Service Studio, no session token
node dist/cli.js kinds --scope <name> --json
```

A kind found there can be switched off with `OSGRAPH_SKIP_KINDS` (e.g. `Structure,ClientAction`).
The snapshot is then partial by configuration and says so (`skippedKinds` in `meta.json`); edges that
target the unread elements point at placeholders. Concurrency is unchanged (4). Nothing is switched off
by default. Rationale and limits: [ADR-0016](docs/adr/0016-read-cost-per-kind-and-opt-out-of-zero-yield-kinds.md).
Recording the before/after profile on a real 30-module scope is a live-Studio step for a person.

### Query ergonomics (offline)

- **Did-you-mean.** `UNKNOWN_NODE` and `SCOPE_NOT_FOUND` carry up to 5 ranked `details.suggestions` (case-insensitive match, then prefix, substring, edit distance) and name them in the message. Suggestions are advice only: the exact name is still required for a lookup to succeed.
- **Result limits.** `queryImpact` (`limit`, default 500 nodes, nearest first), `searchFlows` (`limit`, default 200 hits) and `queryPath` (`limit`, default 200 steps) report `total` and `truncated`. Calls without `limit` keep working; `queryImpact.count` is still the true total. When `queryPath` truncates, `raw` is returned empty.
- **CLI.** `osgraph impact --scope <s> --node <id> --direction dependents|dependencies [--max-depth n] [--limit n]`, `osgraph flow --scope <s> --element <id|name> [--action a] [--module m]`, `osgraph path --scope <s> --from <id> --to <id> [--undirected] [--limit n]`, each with `--json` (the MCP tool's response envelope, verbatim) or human-readable output; exit code 1 on an error response. They call the same handlers as the MCP tools, need no Service Studio and no token, and only read a snapshot that `run` / `rebuild` (osopener and the token manager) already produced. `path` still needs the pinned graphify.

Live check (human, local): run the three CLI commands and the matching MCP tools against a large installed snapshot (hundreds of modules) with Service Studio shut, and record the timings. Until recorded, issue #70 stays unverified.

---

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `OSGRAPH_SERVICESTUDIO_URL` | for `rebuild` and `run` | — | The `servicestudio` MCP endpoint. No default: osgraph will not guess a port. Only commands that talk to Studio need it: `run` refuses to start without it (exit 2), the server and `reextract` start without it, and `rebuild` then refuses with `CONFIG_MISSING` (or `CONFIG_INVALID` for a non-http(s) value) when it is called |
| `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` | no | upward search for `token.txt` | Path to the session-token file |
| `OSGRAPH_GRAPH_DIR` | no | `<cwd>/.osgraph` | Where snapshots are written |
| `OSGRAPH_SCOPES_DIR` | no | `<package>/scopes` | Where scope files live |
| `OSGRAPH_GRAPHIFY_BIN` | no | `graphify` | The pinned graphify executable used by `queryPath` |
| `OSGRAPH_MAX_CONCURRENCY` | no | `4` | Reads in flight at once |
| `OSGRAPH_SKIP_KINDS` | no | none | Kinds a rebuild does not read: any of `Entity`, `Structure`, `ClientAction`, `ServerAction` (comma separated). `Screen` and `Block` cannot be switched off. The default is empty until a live read-cost profile justifies a change — see [Read cost per kind](#read-cost-per-kind) |
| `OSGRAPH_FETCH_REFERENCED_ELEMENTS` | no | — | Also fetch elements referenced from outside the scope |
| `OSGRAPH_REBUILD_PROGRESS` | no | `1` | Progress on stderr: `1` module+phase lines, `verbose` per element, `off` silent |
| `OSGRAPH_ID_PREFIX` | no | `osgraph://` | Node id prefix |
| `OSGRAPH_PROGRESS_SITE` | no | `on` | `off`/`0`/`false`/`no`/`none` disables the live progress site |
| `OSGRAPH_PROGRESS_HOST` | no | `127.0.0.1` | Bind address. `0.0.0.0` to read it from another device — see [the site's section](#the-live-progress-site) |
| `OSGRAPH_PROGRESS_PORT` | no | `7473` | First port tried; a busy one is stepped past (up to 20) |
| `OSGRAPH_OSOPENER_DIST` | no | `../osopener/dist` | osopener's build, used by module discovery and `osgraph run`. The repo's own layout needs no setting |
| `OSGRAPH_STUDIO_LOCK` | no | `<tmpdir>/osgraph-studio.lock` | Cross-process Service Studio lock file (ADR-0017). `osgraph run`, MCP `rebuild` and module discovery hold it while they open, read and close tabs; a second contender fails fast with `BUSY` naming the holder. Every osgraph process on the machine must use the same path |

osgraph **only ever reads** the session token — it never calls `createSessionToken`,
because approving a session is a human act. It therefore **cannot obtain a token by
itself**, which is why [outsystems-token-manager](../outsystems-token-manager/INSTALL.md)
is a hard requirement rather than a convenience: without it there is nothing to create
`token.txt`, and every Service Studio read fails.

---

## Operating notes

Measured against Service Studio **11.55.94**:

- **Four concurrent reads is the server's admission limit**, and the default for good
  reason: on a 30-module scope, running 4-wide cut a rebuild from about 7,550 s to
  2,370 s (≈3.2×). Raising `OSGRAPH_MAX_CONCURRENCY` past 4 buys nothing.
- **Don't close a module mid-rebuild.** A read already exported survives its tab
  closing; one still queued fails. Let a rebuild finish.
- **`rebuild` is atomic.** A failure leaves the previous snapshot intact, so a bad run
  can't cost you a working graph. A kind-level read failure aborts the whole rebuild
  rather than silently producing a partial graph.

---

### Verifying the Studio lock live

Replay and unit tests cover the lock; they cannot show that no tab is closed under a run's reads. A
person with Service Studio open and the session token approved does this once:

1. Pick a small scope of two or three modules.
2. Terminal A: `osgraph run --scope <small-scope>`. Wait until the progress site shows a module reading.
3. Call the MCP `rebuild` tool on the same scope (or run the CLI again from a second terminal).
4. Expect an immediate `BUSY` error naming terminal A's pid and `osgraph run --scope <small-scope>`,
   and no change in Terminal A's progress. Confirm in Service Studio that no module tab closed or
   reopened except the ones run A itself opens and closes.
5. Let run A finish, then repeat step 3: `rebuild` now proceeds, and the lockfile is gone.
6. Kill run A mid-way (Ctrl+C, then `kill -9` on a second try) and confirm the next command recovers the
   stale lock instead of reporting `BUSY`.

Record the outcome in the issue; until then the lock is unverified live.

## Development

```bash
npm run build          # tsc
npm run test:published # build + the suite a fresh clone can run — this is what CI gates
npm test               # build + every test present locally, published set included
npm run lint           # eslint
```

**Two suites, one directory.** The tests are split by **fixture provenance**: a test that reads a
capture carrying real module, application, entity or screen names — or that needs Service Studio,
osopener, a token or the network — stays local and git-ignored. Everything else is tracked, named
file-by-file in [`vitest.published.config.ts`](vitest.published.config.ts), and runs in CI on ubuntu
and windows. The rule, the per-file reasons and the one known pre-existing failure are in
[`tests/PROVENANCE.md`](tests/PROVENANCE.md).

`npm test` is still the gate for a change: locally it runs strictly more than CI can.

### Accuracy regression gate

[`tests/accuracy.gate.test.ts`](tests/accuracy.gate.test.ts) runs inside `npm test` and keeps graph
correctness from regressing across the three ways a snapshot is produced: `osgraph run` (full),
the MCP `rebuild`, and offline `reextract`. On the same synthetic captured inputs it asserts:

- the three paths write byte-identical `graph.json` and `flows.json` (a failure names the artifact,
  the two paths compared and the JSON path of the first difference);
- a producer deleted or renamed upstream gives the consumer's edge an explicit `placeholder: true`
  node, never a stale node that looks real;
- a skipped read is recorded (`skipped`, completeness meta, `missingCaptures`) and never stubbed or
  counted as read, so neither a module nor the scope looks complete;
- the node-order permutation invariance and the listing-wave contract hold end to end.

It uses fakes only: no Service Studio, osopener, token or network. **Replay-green is not live-green.**
The live check is a human step, and until it is recorded the issue stays *unverified*:

1. In a throwaway module (never a production one) that has a consumer module in the scope, rename a
   server action, then publish the module.
2. With Service Studio open, the token approved and osopener available (osgraph depends on both),
   run `osgraph run --module <producer-module>` for the scope.
3. Query the consumer's flow or impact. Expected: the consumer's reference points at a
   `placeholder: true` node for the old name, not at a node that looks real; the renamed action
   appears as a real node.
4. Record the outcome (date, module, build) on the issue.

The [decision record](docs/adr/) and [`GLOSSARY.md`](GLOSSARY.md) **are** published — every issue in
the automatic-refresh backlog is written against their vocabulary. Real names in them are
pseudonymised; the raw discovery measurement logs are not published at all. See
[`docs/README.md`](docs/README.md).

---

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
