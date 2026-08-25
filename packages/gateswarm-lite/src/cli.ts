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

const arg = process.argv.slice(2).join(' ').trim();
let prompt = arg;
if (!prompt) {
  if (process.stdin.isTTY) fail('empty prompt: pass it as an argument or via stdin');
  prompt = await readStdin();
}
if (!prompt) fail('empty prompt: pass it as an argument or via stdin');

console.log(JSON.stringify(scoreComplexity(prompt), null, 2));
