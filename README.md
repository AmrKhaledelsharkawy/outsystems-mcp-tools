# outsystems-mcp-tools

Three tools that make an AI agent genuinely useful against an **OutSystems 11**
codebase, built around the MCP server that ships inside Service Studio.

Service Studio's own `servicestudio` MCP server can read the module that happens to be
open, one element at a time, if you hold a human-approved session token. That's a
narrow window onto a large codebase. These three widen it:

| Folder | What it is | Needs Studio running? |
|---|---|---|
| **[osgraph](osgraph/)** | MCP server: a deterministic dependency graph over a chosen set of modules. Impact, shortest path, layer violations, and regex search *inside* action logic | Only to build the snapshot — queries work offline |
| **[osopener](osopener/)** | MCP server: opens/closes modules in a running Service Studio via Windows UI Automation, so an agent can read a module that isn't on screen | Yes — it drives the real UI |
| **[outsystems-token-manager](outsystems-token-manager/)** | Claude Code skill + hooks that manage the Service Studio session token: approve once, reuse across sessions, never leak it into a transcript | — |

They're independent. Take one, take all three.

---

## The problems each one solves

**"No module is currently open in Service Studio."** That's what `servicestudio`
answers for any module that isn't open — even when others *are*. It doesn't mean Studio
is empty; it means *that name isn't open*. **osopener** opens it and confirms through
`listApps`.

**"What breaks if I change this?"** On a real OutSystems estate that question spans
dozens of modules, and asking an LLM to read them all is slow, expensive and
non-reproducible. **osgraph** reads every element once, writes a snapshot, and answers
from the graph — same question, same answer, no model involved, Studio can be shut.

**The approval dialog.** Service Studio requires a human to approve each new agent
session, and an unmanaged agent will request a fresh one every session, forget to pass
the token to the tools whose schemas omit it, and print it into chat.
**outsystems-token-manager** makes all three mechanically impossible.

---

## Quick start

Both servers need **Node.js 20+**. osopener is **Windows-only** (it drives UI
Automation). osgraph runs anywhere, though `rebuild` needs a reachable Service Studio.

```bash
git clone https://github.com/AmrKhaledelsharkawy/outsystems-mcp-tools.git
cd outsystems-mcp-tools

# whichever you want
cd osgraph  && npm install && npm run build
cd ../osopener && npm install && npm run build
```

Then register them with your MCP client. Both are **stdio** servers — the client
launches them:

```json
{
  "mcpServers": {
    "osgraph": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/outsystems-mcp-tools/osgraph/dist/cli.js"],
      "env": { "OSGRAPH_SERVICESTUDIO_URL": "http://127.0.0.1:41820/mcp" }
    },
    "osopener": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/outsystems-mcp-tools/osopener/dist/cli.js"],
      "env": { "OSGRAPH_SERVICESTUDIO_URL": "http://127.0.0.1:41820/mcp" }
    }
  }
}
```

Use the port Service Studio actually shows for its MCP server — `41820` is only the
common default.

For the token manager: `cd outsystems-token-manager && ./install.ps1 -SkipMcpGuard`
(see its [INSTALL.md](outsystems-token-manager/INSTALL.md)).

Per-folder READMEs cover tools, configuration and errors in full.

---

## How they fit together

```
                    ┌──────────────────────────────┐
                    │   Service Studio 11          │
                    │   `servicestudio` MCP server │
                    └──────────────┬───────────────┘
                 reads one open    │   needs a human-approved
                 module at a time  │   session token
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
      ┌─────▼─────┐          ┌─────▼─────┐        ┌───────▼────────┐
      │ osopener  │          │  osgraph  │        │ token manager  │
      │           │          │           │        │ (skill+hooks)  │
      │ opens the │          │ reads all │        │ approve once,  │
      │ module    │─────────►│ elements  │◄───────│ reuse, never   │
      │ Studio    │  so it   │ → snapshot│ reads  │ leak           │
      │ isn't     │  can be  │           │ token  │                │
      │ showing   │  read    │ queries   │        │                │
      └───────────┘          │ run with  │        └────────────────┘
                             │ Studio    │
                             │ shut      │
                             └───────────┘
```

Neither server ever calls `createSessionToken` — both only *read* the token, because
approving a session is a human act. That's the token manager's job.

---

## Scope and honesty about it

- **OutSystems 11 only** (Traditional Web / Reactive via Service Studio 11.55.x).
  Not ODC.
- **Design-time only.** These read and navigate module *structure and logic*. None of
  them touch a running OutSystems app, its database or its runtime.
- **osopener drives a live GUI**, so it's version-sensitive by nature: selectors and
  timings were verified against Service Studio 11.55.94 and may need revisiting on
  other builds.
- **Read-only against Service Studio.** osgraph and osopener only read module content;
  osopener's single mutating action is opening and closing tabs, and it refuses to
  close a module with unsaved changes or to answer a save prompt.

This repository ships `src/` plus per-folder docs. Test suites, scope files,
UI-Automation dumps and architecture-decision records are kept out of the published
tree: they carry real module and application names from the environment these were
developed against.

---

## License

MIT — see [LICENSE](LICENSE).
