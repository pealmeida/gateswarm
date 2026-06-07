/**
 * Deterministic, seeded, stratified splitting — the fairness backbone of the
 * model-agnostic harness (ACCURACY_ROADMAP.md §11.2).
 *
 * Every model evaluates on byte-identical folds because the split is a function
 * of (data, seed) only and is materialized to checked-in files under
 * eval/splits/ with a SHA-256 MANIFEST. The harness asserts those hashes before
 * any run, so "same test set / same dataset" is enforced, not assumed.
 *
 * Math.random is NOT used (non-reproducible). Seeded mulberry32 instead.
 */
import { createHash } from 'crypto';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** mulberry32 — tiny deterministic PRNG. Same seed → same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates using a seeded RNG. Returns a new shuffled copy. */
export function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Stratified k-fold over items grouped by `classOf`. Each fold gets a balanced
 * slice of every class. Returns arrays of item ids per fold.
 */
export function stratifiedKFold<T>(
  items: T[],
  idOf: (t: T) => string,
  classOf: (t: T) => string,
  k: number,
  seed: number,
): string[][] {
  const rng = mulberry32(seed);
  const byClass = new Map<string, T[]>();
  for (const it of items) {
    const c = classOf(it);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c)!.push(it);
  }
  const folds: string[][] = Array.from({ length: k }, () => []);
  // Deterministic class order, then shuffle within class.
  for (const c of [...byClass.keys()].sort()) {
    const shuffled = seededShuffle(byClass.get(c)!, rng);
    shuffled.forEach((it, i) => folds[i % k].push(idOf(it)));
  }
  return folds;
}

/** Stratified train/test holdout. testFrac of each class goes to test. */
export function stratifiedHoldout<T>(
  items: T[],
  idOf: (t: T) => string,
  classOf: (t: T) => string,
  testFrac: number,
  seed: number,
): { train: string[]; test: string[] } {
  const rng = mulberry32(seed);
  const byClass = new Map<string, T[]>();
  for (const it of items) {
    const c = classOf(it);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c)!.push(it);
  }
  const train: string[] = [], test: string[] = [];
  for (const c of [...byClass.keys()].sort()) {
    const shuffled = seededShuffle(byClass.get(c)!, rng);
    const nTest = Math.max(1, Math.round(shuffled.length * testFrac));
    shuffled.forEach((it, i) => (i < nTest ? test : train).push(idOf(it)));
  }
  return { train, test };
}
