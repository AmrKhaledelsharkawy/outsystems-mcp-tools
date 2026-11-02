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

## Why a scope

A graph is built per **scope**: a named list of modules you choose
(`{ name, modules }`). osgraph never adds or drops modules from a scope by itself —
that stays an explicit decision, so a snapshot always covers exactly what you said.

---

## Tools

| Tool | Does |
|---|---|
| `defineScope` | Writes a scope file `{ name, modules }`. Overwrites a scope of the same name |
| `listScopes` | Lists defined scopes, sorted by name |
| `rebuild` | Full extraction run over one scope: reads every element of every module through the `servicestudio` MCP (read-only), parses edges, regenerates the snapshot **atomically** — all-or-nothing, so the previous snapshot survives any failure |
| `queryImpact` | Reachable node set from one node (dependents *or* dependencies, optionally depth-capped), by in-process BFS |
| `queryPath` | Shortest path between two nodes |
| `listViolations` | Every cross-module edge whose source/target layers break a layer rule, plus modules whose layer suffix is `UNKNOWN` (exempt, never scored) |
| `getFlow` | The logic **inside** one element's actions — flow nodes in walk order, a compact text listing, and the full IR |
| `searchFlows` | Regex search across the logic of every action in the scope: callee names, assignments, If conditions, ForEach lists, exception text, call arguments, and UI wiring |

Node ids look like `osgraph://<Module>/<Kind>/<Name>`, or
`osgraph://<Module>/<Kind>/<UIFlow>/<Name>` for screens and blocks.

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

Requires **Node.js 20+** and a running Service Studio 11 with its MCP server enabled
(for `rebuild` only).

```bash
git clone https://github.com/AmrKhaledelsharkawy/outsystems-mcp-tools.git
cd outsystems-mcp-tools/osgraph
npm install
npm run build
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

1. `defineScope` with a name and the modules you care about.
2. Open those modules in Service Studio (`rebuild` fails `MODULES_NOT_OPEN` otherwise —
   [osopener](../osopener) can open them for you).
3. `rebuild` that scope. It reads every element of every module, so expect this to
   take a while on a large scope; it runs 4 reads at a time by default.
4. Query away — `queryImpact`, `searchFlows`, `listViolations` — with Studio closed if
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
| `OSGRAPH_REBUILD_PROGRESS` | no | — | Per-module progress on stderr |
| `OSGRAPH_ID_PREFIX` | no | `osgraph://` | Node id prefix |

osgraph **only ever reads** the session token — it never calls `createSessionToken`,
because approving a session is a human act. To have tokens issued and persisted
automatically, see [`../outsystems-token-manager`](../outsystems-token-manager/INSTALL.md).

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
