---
status: accepted
supersedes: OSG-004 "Token lifecycle" and "Auth failure" bullets (when a token file is configured)
---

# Reuse one human-approved session token; never re-prompt from inside osgraph

Every servicestudio `createSessionToken` call shows an approval prompt in Service Studio that a human must click. OSG-004 called it fresh on every `rebuild`, so every rebuild needed a human, which blocks the unattended agent loop (open module → rebuild → query → dependency walk).

Decision:

- **Token file, read-only.** New optional env var `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` (path, usually the workspace `token.txt`). osgraph and osopener only *read* it. The single writer is the `outsystems-mcp-session-guard` hook, which saves the token after the human approves. One writer means no races between the two servers.
- **Validate before use.** At the start of each `rebuild`, osgraph reads the file and calls `listApps` with it. Valid → use it for the whole rebuild (still held in memory only for the call).
- **Never prompt.** When a token file is configured, osgraph never calls `createSessionToken`. Invalid, missing or empty token → the tool returns error code `TOKEN_EXPIRED` with the message "session token invalid; a human must approve a new one in Service Studio". The orchestrator makes exactly one `createSessionToken` call, waits for approval, then retries.
- **Mid-rebuild auth failure.** Re-read the file once (the orchestrator may have refreshed it) and retry the failed call. Still failing → abort with `TOKEN_EXPIRED`. OSG-004's all-or-nothing temp-file rule still applies, so the previous `graph.json` is untouched.
- **Studio restarts.** A restart invalidates the token. osopener's `openModule`/`focusStudio` return `studioLaunched: true` when they had to start Studio, so the orchestrator knows to redo Step 0 before the next rebuild instead of discovering it through a failure.
- **No token file configured** → OSG-004 behaviour is unchanged (fresh token per rebuild, interactive use).
- **Secrecy.** The token never appears in logs, tool responses, `graph.json`, walk reports or errors.

Consequence: one human approval per Studio session covers any number of rebuilds and module opens. The only remaining human step is re-approving after Studio restarts.
