import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from '../../src/feature-extractor-v04.js';
import { ORDINAL_FEATURE_NAMES } from '../../src/classifiers/ordinal-logistic.js';
import type { EffortLevel } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const CORPUS_PATH = join(OUT_DIR, 'corpus.jsonl');
const FEATURES_PATH = join(OUT_DIR, 'features.jsonl');
const FEATURE_ORDER_PATH = join(OUT_DIR, 'feature-order.json');

const LIVE_FEATURE_NAMES = ORDINAL_FEATURE_NAMES
  .filter((name) => name !== 'heuristic_score') as (keyof FeatureVector)[];

interface CorpusRow {
  id: string;
  text: string;
  source: 'dolly' | 'alpaca' | 'golden' | 'organic';
  label?: EffortLevel;
}

interface FeatureRow {
  id: string;
  label?: EffortLevel;
  source: CorpusRow['source'];
  score: number;
  f: number[];
}

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function textHash(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function parseJsonl(path: string): CorpusRow[] {
  const out: CorpusRow[] = [];
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = JSON.parse(line) as CorpusRow;
    if (!row.id || !row.text || !row.source) {
      throw new Error(`invalid corpus row at line ${i + 1}`);
    }
    out.push(row);
  }
  return out;
}

function main(): void {
  if (!existsSync(CORPUS_PATH)) {
    throw new Error(`missing ${CORPUS_PATH}; run npm run ssl:build-corpus first`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = parseJsonl(CORPUS_PATH);
  const ws = createWriteStream(FEATURES_PATH, { encoding: 'utf-8' });

  let written = 0;
  for (const row of rows) {
    const feats = extractFeatures(row.text);
    const score = heuristicScoreFromFeatures(feats, countWords(row.text));
    const payload: FeatureRow = {
      id: row.id,
      ...(row.label ? { label: row.label } : {}),
      source: row.source,
      score,
      f: LIVE_FEATURE_NAMES.map((name) => Number(feats[name] ?? 0)),
    };
    ws.write(JSON.stringify(payload) + '\n');
    written++;
  }
  ws.end();

  writeFileSync(FEATURE_ORDER_PATH, JSON.stringify({
    feature_order: LIVE_FEATURE_NAMES,
    excluded_dead_features: [
      'entity_count',
      'code_block_size',
      'domain_legal',
      'domain_medical',
      'domain_engineering',
      'temporal_references',
      'output_format_spec',
      'prior_context_needed',
      'multi_domain',
      'user_expertise_level',
    ],
    score: 'heuristicScoreFromFeatures(extractFeatures(text), word_count), stored separately from f',
    text_hash: 'sha256(NFKC lowercase whitespace-normalized text); recomputed by label_propagation.py',
  }, null, 2) + '\n', 'utf-8');

  ws.on('finish', () => {
    console.log(`wrote ${FEATURES_PATH}`);
    console.log(`wrote ${FEATURE_ORDER_PATH}`);
    console.log(`rows: ${written}`);
    console.log(`text hash example: ${rows[0] ? textHash(rows[0].text).slice(0, 12) : 'n/a'}`);
  });
}

main();
