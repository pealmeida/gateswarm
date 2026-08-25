#!/usr/bin/env node
/**
 * Build the MLJAR AI-prompts corpus fixture used to simulate real user
 * interactions with the GateSwarm scorer/router.
 *
 * Source: https://mljar.com/ai-prompts/ (index: /ai-prompts-index.json)
 * Output: tests/fixtures/mljar-prompts.json
 *
 * Usage:
 *   node scripts/build-mljar-corpus.mjs                 # fetch live index
 *   node scripts/build-mljar-corpus.mjs <index.json>    # rebuild from local copy
 */
import { readFileSync, writeFileSync } from 'node:fs';

const INDEX_URL = 'https://mljar.com/ai-prompts-index.json';
const OUT = new URL('../tests/fixtures/mljar-prompts.json', import.meta.url);

let raw;
if (process.argv[2]) {
  raw = readFileSync(process.argv[2], 'utf8');
  console.log(`reading local index ${process.argv[2]}`);
} else {
  const res = await fetch(INDEX_URL, { headers: { 'user-agent': 'gateswarm-corpus-builder/1.0' } });
  if (!res.ok) {
    console.error(`fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  raw = await res.text();
  console.log(`fetched ${INDEX_URL} (${raw.length} bytes)`);
}

const index = JSON.parse(raw);
const prompts = index.prompts
  .map((p) => ({
    id: p.id,
    title: p.title,
    role: p.role,
    role_slug: p.role_slug,
    category: p.category,
    level: p.level,
    type: p.type,
    prompt: p.prompt_text,
  }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const corpus = {
  source: 'https://mljar.com/ai-prompts/',
  index_url: INDEX_URL,
  upstream_generated_at: index.generated_at,
  fetched_at: new Date().toISOString(),
  count: prompts.length,
  prompts,
};

writeFileSync(OUT, JSON.stringify(corpus, null, 1) + '\n');
console.log(`wrote ${OUT.pathname}: ${prompts.length} prompts`);
