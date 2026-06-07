/**
 * Feature diagnostics (roadmap §3.2): which of the 28 features carry signal?
 * Run: npx tsx eval/feature-report.ts
 *
 * Reports per feature:
 *   - Mutual information with the tier label (bits) — discretized into 4 bins
 *   - Spearman rank correlation with tier index (sign + strength)
 *   - Per-tier mean (to eyeball where tiers are indistinguishable)
 * Low-MI, near-flat features are dead weight — cut before adding a learned model.
 */
import { loadEffort, TIERS, tierIdx } from './lib/dataset.js';
import { extractFeatures, type FeatureVector } from '../src/feature-extractor-v04.js';

const FEATURE_KEYS = Object.keys(extractFeatures('seed sample prompt')) as (keyof FeatureVector)[];

function rows() {
  return loadEffort().map((e) => ({
    y: tierIdx(e.tier),
    f: extractFeatures(e.prompt),
    wc: e.prompt.split(/\s+/).filter(Boolean).length,
  }));
}

/** Mutual information I(feature;tier) in bits, feature discretized into q quantile bins. */
function mutualInfo(values: number[], labels: number[], q = 4): number {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const cuts = Array.from({ length: q - 1 }, (_, i) => sorted[Math.floor(((i + 1) * n) / q)]);
  const bin = (v: number) => { let b = 0; while (b < cuts.length && v > cuts[b]) b++; return b; };
  const joint = new Map<string, number>(), px = new Map<number, number>(), py = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const x = bin(values[i]), y = labels[i];
    joint.set(`${x},${y}`, (joint.get(`${x},${y}`) ?? 0) + 1);
    px.set(x, (px.get(x) ?? 0) + 1); py.set(y, (py.get(y) ?? 0) + 1);
  }
  let mi = 0;
  for (const [key, c] of joint) {
    const [x, y] = key.split(',').map(Number);
    const pxy = c / n, p = (px.get(x)! / n) * (py.get(y)! / n);
    if (pxy > 0 && p > 0) mi += pxy * Math.log2(pxy / p);
  }
  return mi;
}

/** Spearman ρ between feature values and tier index. */
function spearman(values: number[], labels: number[]): number {
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => (r[i as number] = k));
    return r;
  };
  const rx = rank(values), ry = rank(labels), n = values.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  return vx && vy ? cov / Math.sqrt(vx * vy) : 0;
}

function main() {
  const data = rows();
  const labels = data.map((d) => d.y);
  // Include word_count as a derived feature (the dominant signal).
  const keys: string[] = ['word_count', ...FEATURE_KEYS];
  const valuesOf = (k: string) => k === 'word_count' ? data.map((d) => d.wc) : data.map((d) => d.f[k as keyof FeatureVector]);

  const report = keys.map((k) => {
    const v = valuesOf(k);
    return { k, mi: mutualInfo(v, labels), rho: spearman(v, labels), perTier: TIERS.map((_, t) => {
      const xs = data.filter((d) => d.y === t).map((d) => k === 'word_count' ? d.wc : d.f[k as keyof FeatureVector]);
      return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    }) };
  }).sort((a, b) => b.mi - a.mi);

  console.log(`\nFeature diagnostics (n=${data.length}). Sorted by mutual information.\n`);
  console.log('feature'.padEnd(22) + 'MI'.padStart(7) + 'ρ'.padStart(8) + '   per-tier mean (triv→extr)');
  console.log('-'.repeat(78));
  for (const r of report) {
    const tiers = r.perTier.map((x) => x.toFixed(x < 10 ? 2 : 0).padStart(6)).join('');
    const flag = r.mi < 0.03 ? '  ← dead?' : '';
    console.log(r.k.padEnd(22) + r.mi.toFixed(3).padStart(7) + r.rho.toFixed(2).padStart(8) + '  ' + tiers + flag);
  }
  const dead = report.filter((r) => r.mi < 0.03).map((r) => r.k);
  console.log(`\nLow-MI (<0.03) candidates to cut: ${dead.length ? dead.join(', ') : 'none'}`);
}

main();
