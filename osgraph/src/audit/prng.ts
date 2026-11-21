/**
 * Seeded randomness for the accuracy audit (#67). A sample must be reproducible: the same snapshot,
 * seed and K draw the same pairs on any machine, so a human re-running the Studio procedure checks
 * the same pairs the agent half listed.
 */

/** FNV-1a over UTF-16 code units, folded to an unsigned 32-bit integer. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well-distributed 32-bit generator returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function nextInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * Draws `count` distinct items (or all of them when fewer exist) by a partial Fisher-Yates over a copy.
 * The input order is the caller's canonical order, so the draw is deterministic for a given rng.
 */
export function drawWithoutReplacement<T>(items: readonly T[], count: number, rng: () => number): T[] {
  const pool = items.slice();
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + nextInt(rng, pool.length - i);
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}
