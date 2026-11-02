---
name: outsystems-mcp-session-guard
description: Manage approval and token reuse for OutSystems Service Studio MCP work. Use before Service Studio MCP calls and when approval, token, or connection failures occur.
---

# OutSystems MCP session guard

Service Studio requires the user to approve each new agent session through a dialog; `createSessionToken` requests that approval and returns the token every other tool takes as top-level `sessionToken`. Hooks enforce the flow below; this skill explains what they do and how to handle the failure cases.

## The flow (hook-enforced)

The token lives in `token.txt` in the project directory (`CLAUDE_PROJECT_DIR`, else cwd; git-ignored).

1. **`token.txt` present** (SessionStart reports it and hands you the value): the first Service Studio call is read-only `listApps` with that token. Success → keep the token for the whole session; `createSessionToken` is denied while the file exists. Rejection → the PostToolUse/PostToolUseFailure hook deletes the file; then call `createSessionToken`.
2. **No `token.txt`**: call `createSessionToken` once with a `clientName` that identifies this agent, wait for the user's approval; the PostToolUse hook writes the returned token to `token.txt` so the next session skips the dialog.
3. Pass `sessionToken` on every call, including `omlPublish`, `omlRefreshReferences` and `getRoleExceptions` (their schemas omit it; the server still requires it). A call without it is denied by the PreToolUse hook, whose reason repeats the saved token when there is one.
4. Keep the token out of chat: it is passed only as a tool argument.

Reuse the token after a transport reconnect or repeated MCP initialize handshake; those do not invalidate it. Keep Service Studio calls sequential in one agent session.

## Handle failures

- **Approval pending:** let the user act on the Service Studio dialog; continue when `createSessionToken` returns a token.
- **Approval denied or canceled:** stop Service Studio calls for this session and report it. Request a token at most once per session.
- **Token rejected on `listApps`:** the hook deletes `token.txt` and tells you to call `createSessionToken`. If the hook did not fire (file still present), delete `token.txt` yourself first; `createSessionToken` stays denied until it is gone.
- **Token rejected on another tool mid-session:** check the call used the token from `token.txt`; a mismatch is a call bug, not a session problem. A genuine mid-session rejection follows the `listApps` path.
- **Server unreachable or timed out:** a connection problem, not an approval problem; `token.txt` is kept. Check Service Studio and its MCP server are running and the registered endpoint matches the port shown in Service Studio, then retry `listApps` with the same token.
- **Tools unavailable:** report that the Service Studio MCP is not connected in this host.
