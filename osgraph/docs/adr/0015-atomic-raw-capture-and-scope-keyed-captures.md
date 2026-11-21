---
status: accepted
date: 2026-11-21
extends: ADR-0012 (flows are built offline from raw texts)
adds: per-text `sha256` in the raw manifest; `RAW_FILE_CORRUPT`; `recoverRawDir`
---

# A raw capture is written atomically, and captures stay scope-keyed

osgraph requires osopener (to open the modules it reads) and the token manager (the
human-approved session token). Nothing here changes that.

## Problem

`raw/<module>/` was written file by file in place. A read that aborted (exception, cancel,
process killed during `osgraph run --module`) left a directory holding a mix of old and new
element texts. Because `manifest.json` already existed from the previous capture, `reextract`
trusted the mix.

## Decision 1: atomic swap

1. Every text is written into a sibling staging directory `raw/%tmp-<module>-<pid>-<n>/`.
   `%` is always followed by two hex digits in an encoded module name, so `%t` / `%o` can never
   collide with a real capture directory.
2. `writeManifest` builds the manifest (with `bytes` and `sha256` per text), re-reads every listed
   text from the staging directory and checks size and hash, writes `manifest.json` into the
   staging directory **last**, then swaps.
3. Swap (rename-over-existing-directory fails on Windows): live capture renamed to
   `raw/%old-<module>`, staging renamed to the live name, aside directory removed. If the second
   rename fails, the first is undone.
4. Recovery (`recoverRawDir`, run by every reader, by `listRawModules` and by each new writer):
   an `%old-` directory with no live capture is renamed back (the previous capture was
   complete); one beside a live capture is the leftover of a finished swap and is removed.
5. Staging directories are never promoted and never listed or read. A new writer for the same
   module removes that module's stale staging directories.
6. Readers (`readRawModule`) also size/hash-check every text and refuse a corrupt capture with
   `RAW_FILE_CORRUPT`. A manifest without `sha256` (written before this ADR) is checked by size
   only, so existing captures remain readable with no migration and no schema bump.

Consequence: an aborted run no longer leaves its partial texts (ADR-0007's "keeps what it paid
for" is traded for "the previous capture is always whole"). The previous complete capture is kept.

Limits: the swap is atomic per module, not per scope. Concurrent writers of the *same* module in
different processes are not supported (the staging cleanup assumes one writer per module).

## Decision 2: keying stays scope-keyed

Options: **module-keyed** (`raw/<module>`, a module in two scopes is read once) vs **scope-keyed**
(`<scope>/raw/<module>`, today).

Kept scope-keyed:

- Everything that consumes captures (`reextract`, `run --module`, `listRawModules`, the flows
  artifact, progress) is already keyed by scope; a shared store needs a second index telling which
  scopes reference which capture, plus garbage collection when a scope stops listing a module.
- Scopes are independent snapshots by ADR-0005. A shared capture would let a refresh in scope A
  silently change scope B's inputs between its own rebuilds, breaking "`graph.json` and
  `flows.json` are byte-identical to a rebuild of that scope".
- The cost of scope keying is re-reading a module that belongs to two scopes. Acceptable: scopes
  overlapping on a module is the exception, and a one-module refresh per scope is cheap.

Revisit if overlapping scopes become common. A move to module-keying would add a new root
(`<graphDir>/raw/<module>`), keep reading the scope-keyed layout as a fallback, and migrate by
re-capture (nothing is rewritten in place). No layout change is made now, so no migration is
needed.

## Live check (HUMAN, not done)

Needs Service Studio open with a real module `<module-A>`:

1. `osgraph run --module <module-A>` once to completion; note `raw/<module-A>` file listing and
   hashes (`manifest.json` `sha256` values).
2. Run it again and kill the process (or cancel) while the progress site shows the module still
   reading.
3. Confirm `raw/` holds the unchanged `<module-A>` directory (identical hashes) and at most a
   `%tmp-<module-A>-*` directory that nothing reads; `osgraph reextract --scope <scope>` succeeds.
4. Optionally rename `raw/<module-A>` to `raw/%old-<module-A>` and run `reextract`; the
   directory is restored.

Until a person records this, the live behaviour is **unverified**.
