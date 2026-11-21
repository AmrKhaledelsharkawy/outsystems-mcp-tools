/**
 * Did-you-mean ranking for the offline query tools (#70). Pure and offline: a near-miss name gets
 * ranked candidates instead of a dead end. Suggestions are advice only - a lookup still requires the
 * exact name, so success never depends on this module.
 */

/** Default number of suggestions an UNKNOWN_NODE / SCOPE_NOT_FOUND error carries. */
export const DEFAULT_SUGGESTION_LIMIT = 5;

/** Levenshtein distance, abandoned early (returns `max + 1`) once it must exceed `max`. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The last path segment of an id (`osgraph://M/Kind/Name` -> `Name`); the whole string when none. */
function bareName(id: string): string {
  const stripped = id.split("#")[0];
  const i = stripped.lastIndexOf("/");
  return i === -1 ? stripped : stripped.slice(i + 1);
}

/**
 * Up to `limit` candidates ranked best-first: case-insensitive equal, then prefix, then substring,
 * then small edit distance (against the whole candidate and against its last `/` segment). Ties break
 * on distance and then on the candidate text, so the answer is deterministic. A candidate identical
 * to `input` is never suggested (that is the exact match the caller already failed to find).
 */
export function suggestNames(input: string, candidates: Iterable<string>, limit: number = DEFAULT_SUGGESTION_LIMIT): string[] {
  const q = input.toLowerCase();
  if (q.length === 0 || limit <= 0) return [];
  const maxEdit = Math.min(8, Math.max(2, Math.floor(q.length / 4)));
  const scored: Array<{ c: string; tier: number; dist: number }> = [];
  for (const c of candidates) {
    if (c === input) continue;
    const lc = c.toLowerCase();
    const name = bareName(lc);
    let tier: number;
    let dist = 0;
    if (lc === q || name === q) tier = 0;
    else if (lc.startsWith(q) || name.startsWith(q)) tier = 1;
    else if (lc.includes(q) || name.includes(q)) tier = 2;
    else {
      dist = Math.min(boundedEditDistance(q, lc, maxEdit), boundedEditDistance(q, name, maxEdit));
      if (dist > maxEdit) continue;
      tier = 3;
    }
    scored.push({ c, tier, dist });
  }
  scored.sort((x, y) => x.tier - y.tier || x.dist - y.dist || x.c.length - y.c.length || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.c);
}

/** Message tail for an error that has suggestions: ` Did you mean: a, b?` (empty when none). */
export function didYouMean(suggestions: readonly string[]): string {
  return suggestions.length === 0 ? "" : ` Did you mean: ${suggestions.join(", ")}?`;
}
