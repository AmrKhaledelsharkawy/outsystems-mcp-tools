#!/bin/sh
# SessionStart hook: detect an OutSystems (servicestudio MCP) workspace, state its init status,
# and surface a saved Service Studio session token (token.txt) so the model reuses it.
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
MCP="$DIR/.mcp.json"
[ -f "$MCP" ] || exit 0
grep -q '"servicestudio"' "$MCP" 2>/dev/null || exit 0

if [ -f "$DIR/CLAUDE.md" ] && [ -d "$DIR/docs/agents" ]; then
  MSG="This folder is an initialized OutSystems MOD workspace (servicestudio MCP). Project CLAUDE.md, CONTEXT.md or CONTEXT-MAP.md, docs/agents/ and docs/code-review/ describe its rules, glossary, tracker and review record. Global rules: ~/.claude/rules/outsystems-mcp.md."
else
  MSG="This folder has a servicestudio MCP entry in .mcp.json but is not an initialized MOD workspace (missing CLAUDE.md or docs/agents/). The skill outsystems-workspace-init scaffolds it (script: ~/.claude/skills/outsystems-workspace-init/scripts/init-workspace.ps1)."
fi

TOKEN_FILE="$DIR/token.txt"
TOKEN=""
if [ -s "$TOKEN_FILE" ]; then
  # first non-empty line, trimmed, JSON-escaped (backslash and double quote)
  TOKEN=$(sed -n '/[^[:space:]]/{s/^[[:space:]]*//;s/[[:space:]]*$//;p;q}' "$TOKEN_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
fi

if [ -n "$TOKEN" ]; then
  MSG="$MSG Service Studio session token: a saved token exists in token.txt. Do NOT call createSessionToken. The first servicestudio call must be listApps with sessionToken \\\"$TOKEN\\\" (top-level argument). Success: keep using this token for every call, including omlPublish, omlRefreshReferences and getRoleExceptions. Rejection: delete token.txt, then call createSessionToken (the hook saves the new token). Never echo the token in chat."
else
  MSG="$MSG Service Studio session token: no token.txt. The first servicestudio call must be createSessionToken (user approves in Service Studio); the hook writes the token to token.txt for reuse. Never echo the token in chat."
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$MSG"
exit 0
