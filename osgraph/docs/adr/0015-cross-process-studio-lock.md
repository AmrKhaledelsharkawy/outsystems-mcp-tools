---
status: accepted
date: 2026-11-21
extends: ADR-0013 (servicestudio reads run four wide) — by closing the one failure it leaves open across processes
adds: `OSGRAPH_STUDIO_LOCK`; error code `BUSY`; `src/lock/studioLock.ts` (`StudioLock`)
superseded-by: issue #14 (machine-wide fenced lease), when it lands
---

# One osgraph process at a time may open and close tabs in Service Studio

ADR-0013 found that the only unsafe thing is closing a module tab while another read on it is still
queued. Inside one process `drain()` prevents that, and `rebuildGate` stops a second in-process
`rebuild`. Nothing stopped two *processes* — `osgraph run`, the MCP server's `rebuild`, or the
discovery job — from doing it to each other in the same Service Studio.

## Decision

A small file-based lock, taken before the first Studio call and held until the last tab action is done.

- **Lockfile** `{ pid, command, startedAt }`, created exclusively (`wx`). Default path
  `<tmpdir>/osgraph-studio.lock`; `OSGRAPH_STUDIO_LOCK` overrides it, and every osgraph process on a
  machine must agree on it (one Studio per machine, so one lock per machine, not per graph dir).
- **Fail closed, fast.** A contender never waits: it throws `BUSY`, whose message and
  `details.holder` name the holder's pid, command and start time.
- **Stale recovery.** A holder whose pid is not alive is stale and is replaced. A live holder is never
  stolen from. Recovery is serialised by a second exclusive file (`<lock>.recover`) and re-checks the
  lock under it, so two contenders cannot each delete the other's fresh lock. A lockfile that cannot be
  parsed is treated as a half-write for 10 s (BUSY), then as stale.
- **Release on every exit path.** `release()` is idempotent and only removes a file that still names
  its owner. `osgraph run` also releases on process exit and SIGINT/SIGTERM, and releases as soon as the
  Studio work is finished, so `--serve` does not keep Studio locked.
- **Who takes it:** `osgraph run` (full and `--module`), MCP `rebuild` (after the in-process gate, which
  keeps its `REBUILD_IN_PROGRESS` reply), and the discovery job unless it is a dry run. Offline commands
  (`reextract`, `getFlow`, `searchFlows`, `queryImpact`, `queryPath`, `listViolations`, `listScopes`,
  `defineScope`) never take it.
- **One interface.** Callers only see `StudioLock.acquire(command) -> handle` and `handle.release()`;
  replacing the file lock with the #14 fenced lease is a change inside `src/lock/`.

## Known limits

- A recycled pid makes a dead holder look alive. The failure is closed (BUSY, never a false steal); the
  message names the lockfile so the operator can remove it.
- This coordinates osgraph processes only. A human or osopener driven by another tool can still use
  Studio at the same time.
- Live behaviour is unverified until a person runs the procedure in the README ("Verifying the Studio
  lock live") against a real Service Studio.
