#!/usr/bin/env node
/**
 * gateswarm-route CLI — advisory routing decision for a prompt.
 * Usage:  gateswarm-route "your prompt" [--strategy cheapest-capable|best-value] [--matrix path.json]
 *         echo "your prompt" | gateswarm-route
 */
import { readFileSync } from 'node:fs';
import { route } from './index.js';
import type { ModelSpec, RoutingStrategy } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

const args = process.argv.slice(2);
let strategy: RoutingStrategy = 'cheapest-capable';
let matrix: ModelSpec[] | undefined;
const promptParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strategy') {
    const value = args[++i];
    if (value !== 'cheapest-capable' && value !== 'best-value') {
      fail(`invalid --strategy "${value}": use cheapest-capable or best-value`);
    }
    strategy = value;
  } else if (args[i] === '--matrix') {
    const path = args[++i];
    if (!path) fail('--matrix requires a JSON file path');
    try {
      matrix = JSON.parse(readFileSync(path, 'utf8')) as ModelSpec[];
    } catch (err) {
      fail(`could not read matrix file "${path}": ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  } else {
    promptParts.push(args[i]);
  }
}

const arg = promptParts.join(' ').trim();
let prompt = arg;
if (!prompt) {
  if (process.stdin.isTTY) fail('empty prompt: pass it as an argument or via stdin');
  prompt = await readStdin();
}
if (!prompt) fail('empty prompt: pass it as an argument or via stdin');

console.log(JSON.stringify(route(prompt, { strategy, matrix }), null, 2));
