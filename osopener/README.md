# osopener

An MCP server that **opens and closes OutSystems 11 modules in a running Service
Studio** — so an agent can read a module that isn't on screen yet.

Service Studio's own MCP server (`servicestudio`) can only read the module that is
**currently open**. Ask it for anything else and it answers, misleadingly:

> `No module is currently open in Service Studio.`

…even when other modules *are* open. That message really means *"that name is not an
open module"*. osopener is the missing piece: it opens the module for you, confirms it
through `listApps`, and gets out of the way.

It does this by driving the real Service Studio UI (Windows UI Automation +
keyboard), because Service Studio exposes no API for opening a module.

> **Windows only.** osopener drives Win32 UI Automation. It refuses to start on any
> other platform.

---

## Tools

| Tool | Input | Does |
|---|---|---|
| `listOpenModules` | — | Lists every open module, plus a `tabs[]` row per module giving its **application** name and which Studio window holds its tab |
| `openModule` | `name` | Opens a module by exact name; returns once `listApps` confirms it |
| `closeModule` | `name` | Closes a module's tab |
| `focusStudio` | — | Brings Service Studio to the front. Opens nothing |

`name` is an **exact, case-sensitive** match on the `name` field that `listApps`
returns — *not* the application name shown in brackets on the tab.

### Typical timings

| Situation | Cost |
|---|---|
| Already open | ~25 ms — doesn't touch the UI at all |
| In Studio's recent list | ~7 s |
| Cold, from the environment | ~15–20 s |

---

## Safety rules it will not break

`closeModule` is deliberately conservative — it is the one operation that can lose
work, so the guard lives in the code and cannot be configured away:

- it **never** closes Service Studio itself;
- it **never** closes a module with unsaved changes;
- it **never** answers a save prompt — it cancels with `Esc`, leaves the module open,
  and fails with `UNSAVED_CHANGES_DIALOG`.

---

## Install

Requires **Node.js 20+**, Windows, and a running Service Studio 11 with its MCP server
enabled.

```bash
git clone https://github.com/AmrKhaledelsharkawy/outsystems-mcp-tools.git
cd outsystems-mcp-tools/osopener
npm install
npm run build
```

That produces `dist/cli.js`, the server entry point.

---

## Run

osopener is a **stdio** MCP server — your MCP client launches it; you don't start it
yourself. Register it in `.mcp.json` (project scope) or in your user-scope MCP config:

```json
{
  "mcpServers": {
    "osopener": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/outsystems-mcp-tools/osopener/dist/cli.js"],
      "env": {
        "OSGRAPH_SERVICESTUDIO_URL": "http://127.0.0.1:41820/mcp"
      }
    }
  }
}
```

Use the port Service Studio actually shows for its MCP server — `41820` is only the
common default.

To check it starts and see how it resolved its configuration:

```bash
OSGRAPH_SERVICESTUDIO_URL=http://127.0.0.1:41820/mcp node dist/cli.js
```

It prints its token resolution to stderr, then waits for MCP traffic on stdin.
`Ctrl+C` to stop.

---

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `OSGRAPH_SERVICESTUDIO_URL` | **yes** | — | The `servicestudio` MCP endpoint. No default: osopener will not guess a port |
| `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` | no | — | Explicit path to the session-token file |
| `OSOPENER_TOKEN_SEARCH_DIR` | no | cwd | Where the upward search for `token.txt` starts |
| `OSOPENER_TOKEN_SEARCH` | no | `on` | `off`/`0`/`false`/`no`/`none` disables the upward search |
| `OSOPENER_TOKEN_FILE_NAME` | no | `token.txt` | Token file name to look for |
| `OSOPENER_STUDIO_EXE` | no | auto-detect | Path to `ServiceStudio.exe` |
| `OSOPENER_DATA_DIR` | no | package root | Where it writes its own data |
| `OSOPENER_POWERSHELL` | no | `powershell.exe` | PowerShell used to drive UI Automation |

### How the session token is found

osopener **only ever reads** the token — it never calls `createSessionToken`, because
approving a session is a human act.

1. `OSGRAPH_SERVICESTUDIO_TOKEN_FILE`, if set.
2. Otherwise it searches **upward from its working directory** for `token.txt`, so it
   picks up the token of whichever project you have open rather than a hardcoded one.
3. Neither found → it still starts, and `focusStudio` still works; the
   `listApps`-backed tools fail until a token exists.

Its first stderr line names the file it read. A `TOKEN_EXPIRED` means *that
workspace's* token needs re-approving.

To issue and persist tokens automatically, see
[`../outsystems-token-manager`](../outsystems-token-manager/INSTALL.md).

---

## Errors

| Code | Meaning |
|---|---|
| `CONFIG_MISSING` | `OSGRAPH_SERVICESTUDIO_URL` is unset |
| `PLATFORM_UNSUPPORTED` | Not running on Windows |
| `STUDIO_NOT_FOUND` | No Service Studio process found |
| `MODULE_NOT_FOUND` | No module by that exact name is available to open |
| `MODULES_NOT_OPEN` | The named module is not among the open ones |
| `OPEN_TIMEOUT` | The open was driven but `listApps` never confirmed it |
| `UNSAVED_CHANGES_DIALOG` | Close refused: the module has unsaved changes |
| `UIA_ELEMENT_NOT_FOUND` | The expected Studio UI element wasn't there (version drift) |
| `SERVICESTUDIO_UNREACHABLE` | The endpoint didn't answer — check Studio and the port |
| `TOKEN_EXPIRED` | The session token was rejected; re-approve it |
| `HELPER_FAILED` | The PowerShell UI-Automation helper failed |

---

## Operating notes

Facts verified against Service Studio **11.55.94**, which are easy to get wrong:

- **Any open module is readable by name.** You never need to focus or switch tabs to
  *read* a module — only to open it. A background tab reads exactly as well as the
  front one.
- **Never close a module while reads are still pending.** The `servicestudio` server
  admits about 4 concurrent reads; `openModule` during reads is harmless, and closing
  a module nobody is reading is harmless. The one combination that fails is
  `closeModule` landing on a module whose reads are still *queued* — those fail with
  `Could not find file '…-in.oml'`. A read that already exported survives its tab
  closing; one still waiting does not. Let reads finish first.
- **Service Studio degrades past roughly 30 open modules** — it spreads them across
  several top-level windows and its "open from environment" module list grows from
  about 5 s to over 45 s. Close what you no longer need instead of accumulating tabs.

---

## Development

```bash
npm run build   # tsc
npm test        # build + vitest
npm run lint    # eslint
```

The published repository ships `src/` only; the test suite, UI-Automation dumps and
Studio screenshots are kept out because they carry real module and application names
from the environment this was developed against.

Because osopener drives a live GUI, its behaviour is version-sensitive. Treat any
change to selectors or timings as needing a check against a real Service Studio.

---

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
