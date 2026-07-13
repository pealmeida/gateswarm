/**
 * Gateway calibration gate on the frozen holdout. Invalid score responses and
 * transport failures are infrastructure failures, never scored misses.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EffortLevel } from '../src/types.js';
import { loadEffort, loadRaw, TIERS, tierIdx } from './lib/dataset.js';
import { effortMetrics, pct } from './lib/metrics.js';
import { sha256 } from './lib/split.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_DIR = join(__dirname, 'splits');
const MANIFEST_PATH = join(SPLIT_DIR, 'MANIFEST.json');
const HOLDOUT_PATH = join(SPLIT_DIR, 'holdout.v1.json');
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_COVERAGE = 0.95;
const MIN_RECALL = 0.4;
const MAX_WORST_DISTANCE = 1;

interface Manifest { hashes: Record<string, string> }
interface Holdout { effort: { test: string[] } }
interface Args { port: number; timeoutMs: number; help: boolean }
interface ScoreResponse { tier?: unknown }

function usage(): string {
  return `Usage: npx tsx eval/calibration-gate.ts [--port 8900] [--timeout-ms 15000]`;
}

function parseArgs(argv: string[]): Args {
  let port = 8900;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') help = true;
    else if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--timeout-ms') timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid --port');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid --timeout-ms');
  return { port, timeoutMs, help };
}

function assertHash(name: string, bytes: string, manifest: Manifest): void {
  const expected = manifest.hashes[name];
  if (!expected) throw new Error(`${name} is not listed in eval/splits/MANIFEST.json`);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${name} hash drift: manifest ${expected.slice(0, 12)} vs actual ${actual.slice(0, 12)}`);
}

function loadFrozenHoldout(): Set<string> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const { bytes } = loadRaw();
  assertHash('dataset.json', bytes, manifest);
  const holdoutBytes = readFileSync(HOLDOUT_PATH, 'utf8');
  assertHash('holdout.v1.json', holdoutBytes, manifest);
  const holdout = JSON.parse(holdoutBytes) as Holdout;
  if (!Array.isArray(holdout.effort?.test) || !holdout.effort.test.every((id) => typeof id === 'string')) {
    throw new Error('invalid holdout.v1.json effort.test');
  }
  return new Set(holdout.effort.test);
}

function isTier(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (TIERS as string[]).includes(value);
}

function postScore(port: number, prompt: string, timeoutMs: number): Promise<EffortLevel> {
  const payload = JSON.stringify({ prompt });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/score', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer moma-default',
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer | string) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`/v1/score HTTP ${res.statusCode ?? 0}`));
          return;
        }
        try {
          const tier = (JSON.parse(body) as ScoreResponse).tier;
          if (!isTier(tier)) reject(new Error(`invalid /v1/score tier: ${JSON.stringify(tier)}`));
          else resolve(tier);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export function evaluateCalibrationVerdict(rows: Array<{ expected: EffortLevel; predicted: EffortLevel }>): { passed: boolean; reasons: string[] } {
  const metrics = effortMetrics(rows);
  const reasons: string[] = [];
  for (const tier of TIERS) {
    const recall = metrics.recall[tier];
    if (!Number.isNaN(recall) && recall < MIN_RECALL) reasons.push(`recall[${tier}] ${pct(recall)} < ${pct(MIN_RECALL)}`);
  }
  const worstDistance = rows.reduce((worst, row) => Math.max(worst, Math.abs(tierIdx(row.expected) - tierIdx(row.predicted))), 0);
  if (worstDistance > MAX_WORST_DISTANCE) reasons.push(`worst tier distance ${worstDistance} > ${MAX_WORST_DISTANCE}`);
  return { passed: reasons.length === 0, reasons };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const holdoutIds = loadFrozenHoldout();
  const rows = loadEffort().filter((row) => holdoutIds.has(row.id));
  if (rows.length !== holdoutIds.size) throw new Error('holdout references ids missing from dataset');

  const scored: Array<{ expected: EffortLevel; predicted: EffortLevel }> = [];
  const infraFailures: string[] = [];
  for (const row of rows) {
    try {
      scored.push({ expected: row.tier, predicted: await postScore(args.port, row.prompt, args.timeoutMs) });
    } catch (error) {
      infraFailures.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const coverage = rows.length ? scored.length / rows.length : 0;
  if (infraFailures.length || coverage < MIN_COVERAGE) {
    console.error(`INFRA: coverage ${pct(coverage)} (${scored.length}/${rows.length}); failures=${infraFailures.length}`);
    for (const failure of infraFailures) console.error(`- ${failure}`);
    process.exitCode = 2;
    return;
  }

  const verdict = evaluateCalibrationVerdict(scored);
  const metrics = effortMetrics(scored);
  console.log(`Frozen-holdout exact=${pct(metrics.exact)} adjacent=${pct(metrics.adjacent)} coverage=${pct(coverage)}`);
  if (!verdict.passed) {
    console.error(`FAIL: ${verdict.reasons.join('; ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
