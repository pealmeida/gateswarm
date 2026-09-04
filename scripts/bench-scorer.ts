/**
 * Scorer latency/consistency benchmark — documents the performance envelope
 * of scoreComplexity and the bounded-work guarantee of scoreSession.
 *
 *   npm run bench:scorer
 */
import { getTierBoundaries, MAX_PROMPT_SIZE, scoreComplexity, scoreSession } from 'gateswarm-lite';
import { route } from 'gateswarm-router';

const UNIT = 'Review the authentication module and fix the token refresh race condition. ';

function time(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

console.log('scoreComplexity — latency vs input size (truncation caps work at 64 KiB):');
for (const kb of [1, 4, 16, 32, 64]) {
  const text = UNIT.repeat(Math.ceil((kb * 1024) / UNIT.length));
  const ms = time(() => scoreComplexity(text));
  const bar = '#'.repeat(Math.max(1, Math.round(ms / 40)));
  console.log(`  ${String(kb).padStart(3)} KB → ${ms.toFixed(0).padStart(5)} ms ${bar}`);
}

// Prompts WITHOUT a question mark used to hit a catastrophic-backtracking path
// in question_count (`/[^?]+\?/g` consumed to the end at every start position),
// making scoring quadratic: 64 KiB took ~3.4 SECONDS. This row exists so that
// pathology is visible here rather than only in a CI timeout. Most real prompts
// contain no question mark, so this is the common case, not a corner one.
console.log('\nscoreComplexity — question-mark-free input (the old quadratic path):');
for (const kb of [16, 32, 64]) {
  const text = 'analyze this system '.repeat(Math.ceil((kb * 1024) / 20));
  const ms = time(() => scoreComplexity(text));
  console.log(`  ${String(kb).padStart(3)} KB, no "?" → ${ms.toFixed(0).padStart(5)} ms`);
}

console.log('\nscoreSession — bounded window work on an unbounded conversation:');
for (const totalKb of [64, 256, 1024]) {
  const turns = [UNIT.repeat(Math.ceil((totalKb * 1024) / UNIT.length)), 'final question: fix login bug'];
  const ms = time(() => scoreSession(turns));
  console.log(`  session ~${String(totalKb).padStart(4)} KB (2 turns) → scored window only: ${ms.toFixed(0).padStart(5)} ms`);
}

console.log('\nroute() — advisory decision overhead over scoring:');
{
  const prompt = UNIT.repeat(50); // ~5 KB
  const scoreMs = time(() => scoreComplexity(prompt));
  const routeMs = time(() => route(prompt));
  console.log(`  score ${scoreMs.toFixed(2)} ms | route ${routeMs.toFixed(2)} ms | selection ≈ ${(routeMs - scoreMs).toFixed(3)} ms`);
}

const b = getTierBoundaries();
console.log(`\nBoundaries snapshot (stability fingerprint): [${b.map((x) => x.toFixed(6)).join(', ')}] | MAX_PROMPT_SIZE=${MAX_PROMPT_SIZE}`);
