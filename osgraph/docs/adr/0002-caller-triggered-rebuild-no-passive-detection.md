---
status: superseded
superseded-by: ADR-0014 (publishes are detected by polling an authoritative current-state read)
date-superseded: 2026-11-06
kept: the finding that the servicestudio MCP exposes no publish event; detection moved to a different source, outside the MCP
---

# Rebuild is explicit and caller-triggered, not passively detected

The servicestudio MCP is fully synchronous and caller-driven: `omlPublish`/`omlMerge` report results only to whoever calls them, with no webhook, event log, or version/timestamp field another process could poll to learn "a publish just completed." osmodel's own drift detection confirms this — it compares a `ContentDigest` fingerprint at apply-time, it doesn't watch for changes. Rather than build polling infrastructure the rest of this MCP stack doesn't have, osgraph exposes an explicit `rebuild` tool that the calling agent/workflow is responsible for invoking after opening a module and after a publish's merge completes. The snapshot is therefore only ever as fresh as the last explicit rebuild call.
