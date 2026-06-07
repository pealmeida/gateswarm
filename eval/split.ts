/**
 * Materialize the frozen, hash-pinned splits (roadmap §11.2).
 * Run: npx tsx eval/split.ts
 *
 * Writes eval/splits/{folds,holdout}.v1.json + MANIFEST.json (SHA-256 of the
 * dataset and each split file). Every model reads these — nobody re-splits.
 * Re-running with the same SEED reproduces byte-identical files.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, loadMode, loadRaw } from './lib/dataset.js';
import { stratifiedKFold, stratifiedHoldout, sha256 } from './lib/split.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_DIR = join(__dirname, 'splits');
const SEED = 42;
const K = 5;
const TEST_FRAC = 0.3;
const VERSION = 'v1';

function writeJson(path: string, obj: unknown): string {
  const s = JSON.stringify(obj, null, 2) + '\n';
  writeFileSync(path, s);
  return sha256(s);
}

function main() {
  mkdirSync(SPLIT_DIR, { recursive: true });
  const effort = loadEffort();
  const mode = loadMode();
  const { bytes } = loadRaw();

  const effortFolds = stratifiedKFold(effort, (e) => e.id, (e) => e.tier, K, SEED);
  const modeFolds = stratifiedKFold(mode, (m) => m.id, (m) => m.label, K, SEED);
  const effortHoldout = stratifiedHoldout(effort, (e) => e.id, (e) => e.tier, TEST_FRAC, SEED);
  const modeHoldout = stratifiedHoldout(mode, (m) => m.id, (m) => m.label, TEST_FRAC, SEED);

  const foldsHash = writeJson(join(SPLIT_DIR, `folds.${VERSION}.json`), {
    seed: SEED, k: K, effort: effortFolds, mode: modeFolds,
  });
  const holdoutHash = writeJson(join(SPLIT_DIR, `holdout.${VERSION}.json`), {
    seed: SEED, testFrac: TEST_FRAC, effort: effortHoldout, mode: modeHoldout,
  });

  const manifest = {
    version: VERSION, seed: SEED, k: K, testFrac: TEST_FRAC,
    counts: { effort: effort.length, mode: mode.length },
    hashes: {
      'dataset.json': sha256(bytes),
      [`folds.${VERSION}.json`]: foldsHash,
      [`holdout.${VERSION}.json`]: holdoutHash,
    },
  };
  writeFileSync(join(SPLIT_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Wrote splits ${VERSION}: ${effort.length} effort, ${mode.length} mode, ${K}-fold, seed ${SEED}`);
  console.log(`dataset.json sha256: ${manifest.hashes['dataset.json'].slice(0, 16)}…`);
}

main();
