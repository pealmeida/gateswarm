#!/usr/bin/env node
/**
 * gateswarm-lite CLI — score a prompt's complexity.
 * Usage:  gateswarm-lite "your prompt here"
 *         echo "your prompt" | gateswarm-lite
 */
import { scoreComplexity } from './index.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`gateswarm-lite — prompt complexity scorer

Usage:
  gateswarm-lite "your prompt"      score a prompt (args joined with spaces)
  echo "prompt" | gateswarm-lite    score from stdin
  gateswarm-lite --help             this help

Output: ComplexityResult JSON { score, tier, wordCount, features, latencyMs }`);
  process.exit(0);
}

const arg = argv.join(' ').trim();
let prompt = arg;
if (!prompt) {
  if (process.stdin.isTTY) fail('empty prompt: pass it as an argument or via stdin');
  prompt = await readStdin();
}
if (!prompt) fail('empty prompt: pass it as an argument or via stdin');

console.log(JSON.stringify(scoreComplexity(prompt), null, 2));
