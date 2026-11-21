# Live accuracy audit - procedure

`osgraph audit` measures how accurate a scope's graph is. Its agent half runs offline; this document
is the human half, which needs Service Studio.

**Requirements.** osgraph is not standalone. The scope's snapshot and `raw/` captures come from an
`osgraph run` (which needs osopener to open the modules and the human-approved session token from the
token manager). `osgraph audit` itself only reads those files: no Service Studio, no token. The human
step below needs Service Studio open on the audited modules.

## 1. Run the automatic half

```
osgraph audit --scope <scope> --k 20 --seed 1 > audit.md
osgraph audit --scope <scope> --k 20 --seed 1 --json > audit.json
```

- Per consumer **layer** x producer **kind** it draws up to K edges and K absent pairs, deterministic
  for a given snapshot, K and seed. Re-run with the same seed to get the same pairs.
- Consumers are screens, blocks, client actions and server actions (the elements that own a text).
- For each edge it checks that the producer is referenced in the consumer's raw text; for each
  absent pair, that it is not. Every disagreement is listed with its reason:
  - `edge-not-in-text`: the graph has an edge the text does not support (a false edge, hurts precision);
  - `absent-in-text`: the text references a producer the graph has no edge to (a missing edge, hurts recall).
- Pairs whose consumer has no captured text are listed as unverifiable and left out of both ratios.
- Edges to opaque external keys cannot be compared; they are counted, never sampled.
- precision = confirmed / (confirmed + false edges). recall = confirmed edges / (confirmed edges +
  missing edges). Both are sample estimates: recall is a ratio inside the sample, not a population rate.

Raw texts can be stale relative to the live module. If the capture is older than the module's last
edit, rerun `osgraph run --scope <scope> --module <module>` first.

## 2. Pick the modules

Choose **three real modules, one per layer** (for example one `_CW`, one `_SL`, one `_BL`), each with
a current capture. Open them in Service Studio (osopener's `openModule`, or by hand).

## 3. Compare with Studio's dependency list

The report ends with a **Studio worksheet**: one row per module pair that appeared in the sample, with
what the graph says (`listed` = the sample holds an element edge between the two modules, `not listed`
= only absent pairs).

For each worksheet row whose consumer module is one of the three audited modules:

1. In Service Studio, open the consumer module and open **Manage Dependencies** (Ctrl+Q).
2. Find the producer module in the list. It is **listed** when the module appears with at least one
   dependency checked; otherwise **not listed**.
3. Write the result in the `Studio says` column of the worksheet and mark a row as a disagreement when
   it differs from `graph says`.
4. For each `edge-not-in-text` / `absent-in-text` disagreement of those modules, open the consumer
   element in Studio and decide who is right: the text, the graph, or neither (record `text stale`,
   `graph wrong` or `audit wrong`).

## 4. Record

- Keep the filled worksheet, `audit.md` and `audit.json` in the local, git-ignored `tests/live/`. They
  contain real module and element names and must not be committed.
- Post to the issue only **numbers**: scope size, K, seed, per audited layer the precision, recall,
  counts of confirmed / false / missing / unverifiable pairs, and the number of worksheet rows where
  Studio disagreed with the graph. No module or element names.
- Until that comment exists, issue #67 stays *unverified*.
