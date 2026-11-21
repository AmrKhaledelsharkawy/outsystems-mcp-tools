/**
 * The element kinds a rebuild READS, the per-kind read-cost sampler, and the opt-out list (#69).
 *
 * A rebuild pays for six kinds of read per module: the whole-module `Entity` and `Structure` texts,
 * and the `Screen` / `Block` / `ClientAction` / `ServerAction` listings plus one text per element.
 * (`ServiceAction` reads are a second listing of the `ServerAction` kind and are accounted to it.)
 * `timings.json` records what each kind cost; the kind report (`src/report/kinds.ts`) joins that to
 * what each kind yielded, so a kind that costs minutes and yields nothing is visible. This file is
 * the vocabulary both halves share, plus the switch that turns a kind off.
 */

/** Every kind a module walk reads. */
export const READ_KINDS = ["Screen", "Block", "ClientAction", "ServerAction", "Entity", "Structure"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/**
 * Kinds that may be switched off. `Screen` and `Block` are deliberately NOT here: their names feed
 * the extractor's flow index (`flowsIndex`), which disambiguates bare references in the texts of
 * every other kind, so leaving them unread would change edges that other kinds contribute. The four
 * below feed nothing but their own elements, which is what lets "turning a kind off never changes
 * what the other kinds contribute" hold (tests/readKinds.test.ts).
 */
export const PRUNABLE_KINDS = ["ClientAction", "ServerAction", "Entity", "Structure"] as const;
export type PrunableKind = (typeof PRUNABLE_KINDS)[number];

/**
 * What is switched off when nothing is configured. EMPTY, on purpose: the default is meant to be
 * decided from a measured read-cost profile of a real scope (`osgraph kinds`), and that measurement
 * is a live-Studio step (#69, HUMAN). Until it is recorded, no kind is pruned by default.
 */
export const DEFAULT_SKIP_KINDS: readonly PrunableKind[] = [];

/** One kind's read cost in one module. Latencies are per logical call (retry time included). */
export interface KindReadStats {
  calls: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
}

export type ModuleKindStats = Partial<Record<ReadKind, KindReadStats>>;

/** Nearest-rank percentile over an ascending-sorted sample. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Collects call latencies per kind during one module walk. Completion order is irrelevant: it sorts. */
export class KindSampler {
  private readonly samples = new Map<ReadKind, number[]>();

  record(kind: ReadKind, ms: number): void {
    const list = this.samples.get(kind) ?? [];
    list.push(Math.max(0, ms));
    this.samples.set(kind, list);
  }

  /** Only kinds that were actually called appear; a switched-off kind has no entry. */
  summary(): ModuleKindStats {
    const out: ModuleKindStats = {};
    for (const kind of READ_KINDS) {
      const list = this.samples.get(kind);
      if (list === undefined || list.length === 0) continue;
      const sorted = [...list].sort((a, b) => a - b);
      out[kind] = {
        calls: sorted.length,
        totalMs: sorted.reduce((n, v) => n + v, 0),
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95)
      };
    }
    return out;
  }
}

/** Maps the walker's call labels onto a read kind (`ServiceAction` listings belong to `ServerAction`). */
export function readKindOf(kind: string): ReadKind | undefined {
  if (kind === "ServiceAction") return "ServerAction";
  return (READ_KINDS as readonly string[]).includes(kind) ? (kind as ReadKind) : undefined;
}

/**
 * Parses `OSGRAPH_SKIP_KINDS` (comma / space separated, case-insensitive). Returns the prunable kinds
 * in canonical order, plus every token that is not one — the caller decides whether that is an error.
 */
export function parseSkipKinds(value: string | undefined): { kinds: PrunableKind[]; rejected: string[] } {
  if (value === undefined || value.trim().length === 0) return { kinds: [...DEFAULT_SKIP_KINDS], rejected: [] };
  const wanted = new Set<PrunableKind>();
  const rejected: string[] = [];
  for (const token of value.split(/[\s,]+/).filter((t) => t.length > 0)) {
    const hit = PRUNABLE_KINDS.find((k) => k.toLowerCase() === token.toLowerCase());
    if (hit === undefined) rejected.push(token);
    else wanted.add(hit);
  }
  return { kinds: PRUNABLE_KINDS.filter((k) => wanted.has(k)), rejected };
}
