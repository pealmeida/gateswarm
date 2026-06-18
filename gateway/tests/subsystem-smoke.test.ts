/**
 * Subsystem smoke tests — exercise v0.4 internals standalone.
 * Verifies each subsystem instantiates and runs its happy path.
 */
import { describe, it, expect } from 'vitest';
import { scoreIntent, scoreIntentSync } from '../src/intent-engine-v04.js';
import { extractFeatures } from '../src/feature-extractor-v04.js';
import { turboQuantCompress } from '../src/turboquant-compressor.js';
import { initRagIndex, addRagEntry, queryRag } from '../src/rag-index.js';
import { initFeedbackStore, getInteractionCount } from '../src/feedback-store.js';
import { getCalibrationStats, calibrateBronze } from '../src/label-combiner.js';
import { scoreToEffort } from '../src/intent-engine.js';

describe('v0.4 subsystems', () => {
  it('feature-extractor v04 returns feature vector', () => {
    const f = extractFeatures('Build a kernel scheduler with priority queues');
    const keys = Object.keys(f);
    expect(keys.length).toBeGreaterThan(0);
    expect(typeof f).toBe('object');
  });

  it('scoreToEffort maps boundaries correctly', () => {
    expect(scoreToEffort(0.05)).toBe('trivial');
    expect(scoreToEffort(0.16)).toBe('light');
    expect(scoreToEffort(0.25)).toBe('moderate');
    expect(scoreToEffort(0.30)).toBe('heavy');
    expect(scoreToEffort(0.40)).toBe('intensive');
    expect(scoreToEffort(0.80)).toBe('extreme');
  });

  it('intent-engine-v04 scoreIntent returns ComplexityScore shape', async () => {
    const r = await scoreIntent('Write a quick hello world');
    expect(r).toHaveProperty('value');
    expect(r).toHaveProperty('method');
    expect(r).toHaveProperty('latencyMs');
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThanOrEqual(1);
  });

  it('intent-engine-v04 scoreIntentSync works', () => {
    const r = scoreIntentSync('Hello');
    expect(typeof r.value).toBe('number');
  });

  it('turboquant accepts compression options', () => {
    const msgs = Array.from({length: 6}, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i} with moderately long content.`,
    }));
    const r = turboQuantCompress({ messages: msgs as any, targetModel: 'glm-4.7' });
    expect(r).toHaveProperty('messages');
    expect(Array.isArray(r.messages)).toBe(true);
  });

  it('rag-index init + add + query', async () => {
    await initRagIndex();
    addRagEntry({
      keywords: ['rag', 'smoke', 'test'],
      tier: 'light' as any,
      modelUsed: 'test-model',
      adequacyScore: 1.0,
      summary: 'subsystem smoke test entry',
      originalTokens: 50,
      compressedTokens: 20,
    } as any);
    const r = queryRag(['rag', 'smoke'], 3);
    expect(Array.isArray(r)).toBe(true);
  });

  it('feedback-store init + count', async () => {
    await initFeedbackStore();
    const n = getInteractionCount();
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('label-combiner calibration stats', () => {
    calibrateBronze(true);
    const stats = getCalibrationStats();
    expect(stats).toHaveProperty('ragPhase');
  });
});
