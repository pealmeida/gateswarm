import { describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX, EFFORT_RANK, route, selectModel } from 'gateswarm-router';
import type { ModelSpec } from 'gateswarm-router';
import { MAX_PROMPT_SIZE, scoreComplexity } from 'gateswarm-lite';
import { scoreIntentSync } from '../src/intent-engine-v04.js';

/**
 * Real-use-case suite: prompts shaped like actual gateway traffic (chat, QA,
 * translation, debugging, coding, incident diagnostics, architecture, CJK,
 * emoji-only). Per the testing spec Section 1, correctness here is the
 * CONTRACT — well-formed results, determinism, parity with the gateway
 * scorer, and router capability invariants — NOT whether an absolute tier
 * matches human intuition. Absolute tiers are locked by the snapshot +
 * eval pipeline instead.
 */
const CORPUS: Array<{ id: string; prompt: string }> = [
  { id: 'chat-greeting', prompt: 'hey! how was your weekend?' },
  { id: 'chat-thanks', prompt: 'thanks, that worked' },
  { id: 'qa-factual', prompt: 'What is the capital of France?' },
  { id: 'task-translate', prompt: "Translate 'good morning' to Japanese" },
  { id: 'task-summarize', prompt: 'Summarize this article in one paragraph' },
  {
    id: 'debug-hydration',
    prompt:
      "My Next.js app crashes with 'Text content does not match server-rendered HTML' during hydration after adding a locale switcher. Walk me through how to debug this and what the usual causes are.",
  },
  {
    id: 'code-csv',
    prompt:
      'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
  },
  {
    id: 'diagnose-latency',
    prompt:
      'We are seeing p99 latency spike from 120ms to 800ms after the last deploy across three regions. Figure out which change is responsible and propose a rollback plan.',
  },
  {
    id: 'arch-trading',
    prompt:
      'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.',
  },
  {
    id: 'code-with-block',
    prompt: `Review this implementation and suggest improvements:\n\`\`\`typescript\nexport async function getUser(id: string) {\n  const res = await fetch(\`\${API}/users/\${id}\`);\n  if (!res.ok) throw new Error('not found');\n  return res.json();\n}\n\`\`\`\nIt must handle rate limits, timeouts, and malformed responses.`,
  },
  { id: 'cjk-coding', prompt: '用Python写一个快速排序函数，解释时间复杂度，并给出单元测试。' },
  { id: 'emoji-only', prompt: '🚀🔥💯' },
];

const TIERS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;

describe('scoreComplexity on realistic prompts', () => {
  it.each(CORPUS.map((c) => [c.id, c.prompt]))('%s returns a well-formed result', (_id, prompt) => {
    const r = scoreComplexity(prompt);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(TIERS).toContain(r.tier);
    expect(r.wordCount).toBeGreaterThanOrEqual(0);
    expect(r.features).toBeTypeOf('object');
    expect(Object.keys(r.features).length).toBe(37);
    expect(Number.isFinite(r.latencyMs)).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each(CORPUS.map((c) => [c.id, c.prompt]))(
    '%s matches the gateway scorer exactly (parity contract)',
    (_id, prompt) => {
      const lite = scoreComplexity(prompt);
      const gateway = scoreIntentSync(prompt);
      expect(lite.score).toBe(gateway.value);
      expect(lite.tier).toBe(gateway.tier);
    },
  );

  it.each(CORPUS.map((c) => [c.id, c.prompt]))('%s scores deterministically', (_id, prompt) => {
    const a = scoreComplexity(prompt);
    const b = scoreComplexity(prompt);
    expect(a.score).toBe(b.score);
    expect(a.tier).toBe(b.tier);
    expect(a.wordCount).toBe(b.wordCount);
  });

  it('is fast enough for per-request use on every realistic prompt', () => {
    for (const { prompt } of CORPUS) {
      const start = performance.now();
      scoreComplexity(prompt);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100); // generous CI bound; typical is <1 ms
    }
  });

  it('appending requirements never lowers the score (monotone extension)', () => {
    const base = 'Write a Python script that downloads a URL';
    const extended =
      base + '. It must retry with exponential backoff, respect robots.txt, stream to disk, and log p95 timings.';
    expect(scoreComplexity(extended).score).toBeGreaterThanOrEqual(scoreComplexity(base).score);
  });

  it('truncates oversized real-world pastes at exactly 64 KiB chars', { timeout: 30_000 }, () => {
    const paste = 'lorem ipsum dolor sit amet '.repeat(20_000); // ~540 KB paste
    const r = scoreComplexity(paste);
    const truncated = scoreComplexity(paste.slice(0, MAX_PROMPT_SIZE));
    expect(r.score).toBe(truncated.score);
    expect(r.tier).toBe(truncated.tier);
    expect(MAX_PROMPT_SIZE).toBe(64 * 1024);
  });
});

describe('route() on realistic prompts', () => {
  it.each(CORPUS.filter((c) => c.prompt.trim().length > 0).map((c) => [c.id, c.prompt]))(
    '%s gets a model rated for its tier (or an explicit fallback)',
    (_id, prompt) => {
      const decision = route(prompt);
      const tierRank = EFFORT_RANK[decision.complexity.tier];
      const modelRank = EFFORT_RANK[decision.model.maxEffort];
      if (modelRank < tierRank) {
        expect(decision.reason).toContain('falling back');
      } else {
        expect(decision.reason).not.toContain('falling back');
      }
    },
  );

  it('decides in well under the request budget on every realistic prompt', () => {
    for (const { prompt } of CORPUS) {
      const start = performance.now();
      route(prompt);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50); // advisory decision; spec target is <5 ms typical
    }
  });

  it('production-style matrix with minQuality still respects capability + strategy', () => {
    const matrix: ModelSpec[] = [
      { id: 'flash', provider: 'google', maxEffort: 'moderate', costPer1MInput: 0.15, costPer1MOutput: 0.60, quality: 0.60 },
      { id: 'workhorse', provider: 'deepseek', maxEffort: 'heavy', costPer1MInput: 0.27, costPer1MOutput: 1.10, quality: 0.74 },
      { id: 'flagship', provider: 'anthropic', maxEffort: 'extreme', costPer1MInput: 3.00, costPer1MOutput: 15.00, quality: 0.92 },
    ];
    for (const { prompt } of CORPUS) {
      const decision = route(prompt, { matrix, minQuality: 0.6, strategy: 'best-value' });
      expect(matrix.some((m) => m.id === decision.model.id)).toBe(true);
      expect(decision.model.quality).toBeGreaterThanOrEqual(0.6);
    }
    // A trivial chat prompt should land on the cheap capable option under best-value.
    const casual = route('hey! how was your weekend?', { matrix, minQuality: 0.6, strategy: 'best-value' });
    expect(casual.model.id).toBe(selectModel(casual.complexity.tier, matrix, { minQuality: 0.6, strategy: 'best-value' }).model.id);
  });

  it('DEFAULT_MATRIX stays capable end-to-end for every realistic prompt', () => {
    for (const { prompt } of CORPUS) {
      const decision = route(prompt, { matrix: DEFAULT_MATRIX });
      expect(decision.reason).not.toContain('falling back');
    }
  });
});
