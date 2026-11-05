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
| **[osopener](../osopener/)** | `rebuild` can only read modules that are **open** in Service Studio. Anything else fails `MODULES_NOT_OPEN`. osopener is what opens them — Service Studio exposes no API for it |
| **[outsystems-token-manager](../outsystems-token-manager/)** | Every Service Studio read needs a **human-approved** session token. osgraph only ever *reads* `token.txt` — it never calls `createSessionToken`, because approving a session is a human act. The token manager is what obtains, persists and reuses that token |

Without both, `rebuild` cannot run — and `rebuild` is what produces the snapshot every
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
generations and the `watch` / `sync` / `status` / `doctor` commands are being built across
milestones M0–M4; the issue tracker is the authority on what has landed.

---

## Tools

| Tool | Does |
|---|---|
| `defineScope` | Writes a scope file `{ name, modules }`. Overwrites a scope of the same name |
| `listScopes` | Lists defined scopes, sorted by name |
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

### Offline re-extract

If you change the parser and want to regenerate `graph.json` + `flows.json` from raw
texts already captured — **no Service Studio, no session token**:

```bash
node dist/cli.js reextract --scope <name>
node dist/cli.js reextract --scope <name> --json   # full result as JSON
node dist/cli.js --help
```

---

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `OSGRAPH_SERVICESTUDIO_URL` | for `rebuild` | — | The `servicestudio` MCP endpoint. No default: osgraph will not guess a port |
| `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` | no | upward search for `token.txt` | Path to the session-token file |
| `OSGRAPH_GRAPH_DIR` | no | `<cwd>/.osgraph` | Where snapshots are written |
| `OSGRAPH_SCOPES_DIR` | no | `<package>/scopes` | Where scope files live |
| `OSGRAPH_GRAPHIFY_BIN` | no | `graphify` | The pinned graphify executable used by `queryPath` |
| `OSGRAPH_MAX_CONCURRENCY` | no | `4` | Reads in flight at once |
| `OSGRAPH_FETCH_REFERENCED_ELEMENTS` | no | — | Also fetch elements referenced from outside the scope |
| `OSGRAPH_REBUILD_PROGRESS` | no | `1` | Progress on stderr: `1` module+phase lines, `verbose` per element, `off` silent |
| `OSGRAPH_ID_PREFIX` | no | `osgraph://` | Node id prefix |
| `OSGRAPH_PROGRESS_SITE` | no | `on` | `off`/`0`/`false`/`no`/`none` disables the live progress site |
| `OSGRAPH_PROGRESS_HOST` | no | `127.0.0.1` | Bind address. `0.0.0.0` to read it from another device — see [the site's section](#the-live-progress-site) |
| `OSGRAPH_PROGRESS_PORT` | no | `7473` | First port tried; a busy one is stepped past (up to 20) |
| `OSGRAPH_OSOPENER_DIST` | no | `../osopener/dist` | osopener's build, used by module discovery. The repo's own layout needs no setting |

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

## Development

```bash
npm run build   # tsc
npm test        # build + vitest
npm run lint    # eslint
```

The published repository ships `src/` only. The test suite, scope files and
architecture-decision records are kept out because they carry real module and
application names from the environment this was developed against.

---

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
