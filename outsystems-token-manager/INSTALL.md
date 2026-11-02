# OutSystems token manager — install guide

A Claude Code **skill + four hooks** that manage the Service Studio MCP session
token for you, so an agent never burns a turn on the approval dance and never
prints the token into a transcript.

- **Skill** — `outsystems-mcp-session-guard`: tells the model what the flow is and how to
  handle each failure case.
- **Hooks** — enforce that flow mechanically, so it holds even when the model forgets.

Works with any MCP server named `servicestudio` (the in-process MCP server that
ships inside OutSystems Service Studio 11).

> **Both servers in this repository require this package.** Neither
> [osgraph](../osgraph/) nor [osopener](../osopener/) calls `createSessionToken` — they
> only ever *read* `token.txt`, because approving a session is a human act. So without
> the token manager installed there is nothing to create that file, and every Service
> Studio read fails. Install this **first**.
>
> It stands on its own, though: it is useful with the bare `servicestudio` MCP server
> and needs nothing else from this repository.

---

## What problem this solves

Service Studio requires a **human** to approve each new agent session through a
modal dialog. `createSessionToken` raises that dialog and returns a token that
every other tool then takes as a top-level `sessionToken` argument.

Left alone, an agent will:

1. call `createSessionToken` at the start of every session, making you click a dialog each time;
2. forget `sessionToken` on the tools whose schemas omit it (`omlPublish`,
   `omlRefreshReferences`, `getRoleExceptions`) and get denied;
3. echo the token into chat.

This package makes the token **survive across sessions** in a git-ignored
`token.txt`, and makes the three mistakes above impossible rather than merely discouraged.

---

## What gets installed

| File | Installed to | Role |
|---|---|---|
| `skill/SKILL.md` | `~/.claude/skills/outsystems-mcp-session-guard/SKILL.md` | Explains the flow and the failure cases to the model |
| `hooks/os-session-token-guard.py` | `~/.claude/hooks/` | The enforcer: `PreToolUse` + `PostToolUse` + `PostToolUseFailure` |
| `hooks/os-session-start.sh` | `~/.claude/hooks/` | `SessionStart`: detects the workspace, reports token status |
| `hooks/os-mcp-guard.sh` | `~/.claude/hooks/` | *Optional.* `PreToolUse` reminder on edit tools — **see the note below** |
| `settings-snippet.json` | merged into `~/.claude/settings.json` | Wires the four hook events |

### The optional hook

`os-mcp-guard.sh` injects a reminder naming three **MOD-specific review skills**
(`mod-code-review`, `servicestudio-action-layout`, `mod-naming-convention`) that are
**not part of this repository** — they belong to a private OutSystems build convention.

If you don't have those skills, install with `-SkipMcpGuard`. Nothing else depends on it.

---

## Prerequisites

| Need | Why | Check |
|---|---|---|
| Claude Code | Host for the skill + hooks | `claude --version` |
| **Python 3** on `PATH` as `py` | The token guard runs as `py -3 <script>` | `py -3 --version` |
| **`sh`** on `PATH` | The `SessionStart` hook is a POSIX script (Git Bash ships one) | `sh --version` |
| Windows PowerShell 5.1+ | Runs `install.ps1` | `$PSVersionTable.PSVersion` |

No Python packages are required — the guard uses only the standard library.

---

## Install

```powershell
# from this folder
./install.ps1

# if you do not have the MOD review skills (most people):
./install.ps1 -SkipMcpGuard

# see exactly what would change, write nothing:
./install.ps1 -DryRun
```

Then **restart Claude Code** so the hooks are loaded.

The installer is **idempotent and additive**: it only appends a hook block when no
entry with the same matcher *and* the same command already exists, it never removes
or rewrites hooks you already had, and it backs `settings.json` up to
`settings.json.bak-<timestamp>` before its first write. Re-running it reports
`nothing to add`.

Installing somewhere other than `~/.claude`:

```powershell
./install.ps1 -ClaudeDir D:\profiles\work\.claude
```

### Manual install

If you would rather not run the script: copy the four files to the paths in the table
above, then merge `settings-snippet.json`'s `hooks` object into your `settings.json`,
replacing `<HOME>` with your home directory (forward slashes are fine on Windows).
Validate the result before restarting — a `settings.json` that does not parse disables
*all* your hooks:

```powershell
Get-Content $HOME\.claude\settings.json -Raw | ConvertFrom-Json | Out-Null
```

---

## Verify it works

1. Open a folder whose `.mcp.json` contains a `servicestudio` entry.
2. On session start you should see context stating either *"a saved token exists in
   token.txt"* or *"no token.txt"*.
3. With no `token.txt`: ask the agent to list the open modules. It calls
   `createSessionToken` once, you approve in Service Studio, and the `PostToolUse`
   hook writes `token.txt`.
4. Start a new session. It should now go straight to `listApps` with the saved token
   and raise **no dialog**.

Re-run the installer at any time to check the wiring — it reports what is already present.

---

## How the flow works

The token lives in `token.txt` in the project directory (`CLAUDE_PROJECT_DIR`, else cwd).

```
SessionStart ──► token.txt present? ──► yes ──► model is told: first call is listApps with it
                      │                              │
                      │                              ├─ accepted ──► reuse for the whole session
                      │                              └─ rejected ──► PostToolUseFailure deletes
                      │                                              token.txt, then createSessionToken
                      └── no ──► model calls createSessionToken once (you approve)
                                      └─► PostToolUse writes token.txt for next time
```

Enforced by the hooks, not by good intentions:

- **`PreToolUse` on `mcp__servicestudio__.*`** — denies any call missing `sessionToken`,
  and the denial reason carries the saved token so the model can retry correctly.
  It also denies `createSessionToken` while a `token.txt` exists, which is what stops
  the needless approval dialog.
- **`PostToolUse` on `createSessionToken` / `listApps`** — persists a newly issued token.
- **`PostToolUseFailure` on `listApps`** — deletes a `token.txt` the server rejected,
  so the next request starts clean.

The token is only ever passed as a tool argument, never written to chat.

---

## Add `token.txt` to `.gitignore`

It is a live credential for your Service Studio session. In every project where you
use this:

```gitignore
token.txt
```

---

## Uninstall

```powershell
Remove-Item $HOME\.claude\skills\outsystems-mcp-session-guard -Recurse
Remove-Item $HOME\.claude\hooks\os-session-token-guard.py, `
            $HOME\.claude\hooks\os-session-start.sh, `
            $HOME\.claude\hooks\os-mcp-guard.sh -ErrorAction SilentlyContinue
```

Then delete the five `mcp__servicestudio__*` / `startup|resume|clear` blocks from the
`hooks` object in `settings.json` — or restore the newest `settings.json.bak-*` the
installer left behind.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every session raises the approval dialog | `token.txt` not being written | Confirm `py -3 --version` works and the `PostToolUse` block is in `settings.json` |
| `createSessionToken` is denied | A `token.txt` already exists — by design | Delete `token.txt` if the token is genuinely dead |
| Calls denied for a missing token | The model dropped `sessionToken` | Intended: the denial reason tells it the token. If it persists, check the skill installed |
| No SessionStart context at all | `sh` missing, or `.mcp.json` has no `servicestudio` entry | Install Git Bash; check the MCP server name is exactly `servicestudio` |
| Hooks stopped firing entirely | `settings.json` does not parse | Validate it (command above); restore the `.bak` |
| Server unreachable / timeouts | Not an approval problem | Check Service Studio is running and the port in `.mcp.json` matches the one it shows |

---

## License

MIT — see the [LICENSE](../LICENSE) at the repository root.
