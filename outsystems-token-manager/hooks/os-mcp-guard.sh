#!/bin/sh
# PreToolUse hook for servicestudio edit tools.
# Injects a factual reminder that the MOD build rules are in force. Never blocks.
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"MOD O11 build rules are in force for this servicestudio edit: skill mod-code-review (MOD Code Review Template v1.0 as rule ids UI-/CW-/SL-/BL-/CS-/LKP-/IS-NN; verify each rule with reference/rule-checks.md; evidence standard; record under docs/code-review/ with a Manual steps handoff section), skill servicestudio-action-layout (flow drawing and verification), skill mod-naming-convention (MOD_ names, descriptions, layer map + reference matrix in reference/layers.md). Rules file: ~/.claude/rules/outsystems-mcp.md."}}'
exit 0
