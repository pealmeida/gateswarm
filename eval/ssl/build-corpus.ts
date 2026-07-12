import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, TIERS } from '../lib/dataset.js';
import type { EffortLevel } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(__dirname, 'data');
const OUT_DIR = join(__dirname, 'out');
const DOLLY_PATH = join(DATA_DIR, 'dolly-15k.jsonl');
const ALPACA_PATH = join(DATA_DIR, 'alpaca-52k.json');
const ORGANIC_PATH = join(ROOT, 'data', 'organic', 'labeled.jsonl');
const OUT_PATH = join(OUT_DIR, 'corpus.jsonl');

type Source = 'dolly' | 'alpaca' | 'golden' | 'organic';

interface CorpusRow {
  id: string;
  text: string;
  source: Source;
  label?: EffortLevel;
}

interface RankedRow extends CorpusRow {
  text_hash: string;
}

const SOURCE_RANK: Record<Source, number> = {
  dolly: 1,
  alpaca: 1,
  organic: 3,
  golden: 4,
};

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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanText(parts: unknown[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join('\n\n')
    .trim();
}

function isTier(x: unknown): x is EffortLevel {
  return typeof x === 'string' && (TIERS as readonly string[]).includes(x);
}

function pickOrganicTier(row: any): EffortLevel | undefined {
  if (isTier(row?.actualTier)) return row.actualTier;
  if (isTier(row?.actual_tier)) return row.actual_tier;
  if (isTier(row?.tier)) return row.tier;
  if (isTier(row?.label)) return row.label;
  if (row?.agreed === true && isTier(row?.predictedTier)) return row.predictedTier;
  return undefined;
}

function addRow(rows: Map<string, RankedRow>, row: CorpusRow): void {
  const text = row.text.trim();
  const wc = wordCount(text);
  if (wc < 3 || wc > 400) return;
  const hash = textHash(text);
  const existing = rows.get(hash);
  const candidate: RankedRow = { ...row, text, text_hash: hash };
  if (!existing) {
    rows.set(hash, candidate);
    return;
  }

  const existingRank = SOURCE_RANK[existing.source] + (existing.label ? 0.5 : 0);
  const candidateRank = SOURCE_RANK[candidate.source] + (candidate.label ? 0.5 : 0);
  if (candidateRank > existingRank) rows.set(hash, candidate);
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed staging rows; corpus construction should be best-effort.
    }
  }
  return out;
}

function addDolly(rows: Map<string, RankedRow>): number {
  let seen = 0;
  for (const row of readJsonl(DOLLY_PATH)) {
    const text = cleanText([row.instruction, row.context]);
    if (!text) continue;
    addRow(rows, { id: `dolly:${seen}`, text, source: 'dolly' });
    seen++;
  }
  return seen;
}

function addAlpaca(rows: Map<string, RankedRow>): number {
  if (!existsSync(ALPACA_PATH)) return 0;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(ALPACA_PATH, 'utf-8'));
  } catch {
    return 0;
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  let seen = 0;
  for (const row of arr) {
    const text = cleanText([row.instruction, row.input]);
    if (!text) continue;
    addRow(rows, { id: `alpaca:${seen}`, text, source: 'alpaca' });
    seen++;
  }
  return seen;
}

function addGolden(rows: Map<string, RankedRow>): number {
  let seen = 0;
  for (const row of loadEffort()) {
    addRow(rows, { id: row.id, text: row.prompt, source: 'golden', label: row.tier });
    seen++;
  }
  return seen;
}

function addOrganic(rows: Map<string, RankedRow>): number {
  let seen = 0;
  for (const row of readJsonl(ORGANIC_PATH)) {
    const text = cleanText([row.promptSnippet, row.prompt, row.text, row.input, row.user_prompt]);
    if (!text) continue;
    const label = pickOrganicTier(row);
    const stable = typeof row.promptHash === 'string' && row.promptHash.trim()
      ? row.promptHash.trim()
      : String(seen);
    addRow(rows, { id: `organic:${stable}`, text, source: 'organic', label });
    seen++;
  }
  return seen;
}

function sourceOrder(source: Source): number {
  return ['dolly', 'alpaca', 'golden', 'organic'].indexOf(source);
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = new Map<string, RankedRow>();
  const counts = {
    dolly: addDolly(rows),
    alpaca: addAlpaca(rows),
    golden: addGolden(rows),
    organic: addOrganic(rows),
  };

  const out = [...rows.values()].sort((a, b) => {
    const bySource = sourceOrder(a.source) - sourceOrder(b.source);
    if (bySource) return bySource;
    return a.id.localeCompare(b.id);
  });

  const ws = createWriteStream(OUT_PATH, { encoding: 'utf-8' });
  for (const row of out) {
    const payload: CorpusRow = {
      id: row.id,
      text: row.text,
      source: row.source,
      ...(row.label ? { label: row.label } : {}),
    };
    ws.write(JSON.stringify(payload) + '\n');
  }
  ws.end();

  ws.on('finish', () => {
    const labeled = out.filter((r) => r.label).length;
    console.log(`wrote ${OUT_PATH}`);
    console.log(`rows: ${out.length} (${labeled} labeled after dedupe/filter)`);
    console.log(`input rows: dolly ${counts.dolly}, alpaca ${counts.alpaca}, golden ${counts.golden}, organic ${counts.organic}`);
  });
}

main();
