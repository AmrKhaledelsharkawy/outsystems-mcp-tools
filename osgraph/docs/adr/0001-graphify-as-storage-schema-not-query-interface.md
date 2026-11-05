---
status: accepted
---

# Integrate Graphify as a storage schema and deterministic CLI, not its NL query layer or MCP server

Graphify-Labs/graphify is a mature, actively maintained knowledge-graph tool, but its primary interface (`graphify query "..."`) is natural-language and assumes an LLM/host assistant in the loop, and its tree-sitter parsers have no OutSystems support. Since osgraph must stay deterministic (no LLM) and OutSystems has no off-the-shelf parser, osgraph writes its own extracted nodes/edges directly into Graphify's `graph.json` schema and reads them back through Graphify's deterministic, non-NL commands (e.g. `graphify path`) instead of Graphify's NL query layer or its own MCP server. This is "integrating Graphify, not reinventing it" at the storage/schema level, while deliberately not adopting the parts of Graphify that require an LLM.
