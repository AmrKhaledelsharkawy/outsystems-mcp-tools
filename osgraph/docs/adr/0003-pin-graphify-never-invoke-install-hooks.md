---
status: accepted
---

# Pin Graphify's exact version and never invoke its install/hook commands

OSG-009 found that Graphify's distributed package (`graphifyy` on GitHub, not `graphify` on PyPI) ships dormant agent-manipulation content: `CLAUDE.md`/`AGENTS.md` injection snippets and literal Claude-Code `PreToolUse` deny-hook JSON, both of which only activate if `graphify install` or `graphify hook install` is ever run. osgraph only needs `graphify path "<A>" "<B>" --graph <file>` (per OSG-007); it pins Graphify to an exact version/commit and its code must never call `install` or `hook install`, keeping that content permanently inert. The alternative — vendoring/reimplementing shortest-path ourselves to drop the dependency entirely — was considered and rejected: it discards the "integrate Graphify, don't reinvent it" destination constraint over a risk that's fully contained by simply never calling the two commands that activate it.
