import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TOKENS,
  loadEvalRuntimeConfig,
  maxTokensFromConfigValue,
  rubricPassFloor,
} from '../eval/lib/hybrid-eval-helpers.js';

describe('rubricPassFloor', () => {
  it('scales the 25/30 pass ratio to the actual live denominator', () => {
    expect(rubricPassFloor(30)).toBe(25);
    expect(rubricPassFloor(60)).toBe(50);
    expect(rubricPassFloor(31)).toBe(26);
    expect(rubricPassFloor(0)).toBe(0);
  });
});

describe('maxTokensFromConfigValue', () => {
  it('uses tier_models max_tokens and falls back per tier when malformed', () => {
    const maxTokens = maxTokensFromConfigValue({
      tier_models: {
        trivial: { max_tokens: 111 },
        light: { max_tokens: 'bad' },
        moderate: { max_tokens: 333.9 },
        heavy: {},
        intensive: { max_tokens: 555 },
      },
    });

    expect(maxTokens.trivial).toBe(111);
    expect(maxTokens.light).toBe(DEFAULT_MAX_TOKENS.light);
    expect(maxTokens.moderate).toBe(333);
    expect(maxTokens.heavy).toBe(DEFAULT_MAX_TOKENS.heavy);
    expect(maxTokens.intensive).toBe(555);
    expect(maxTokens.extreme).toBe(DEFAULT_MAX_TOKENS.extreme);
  });
});

describe('loadEvalRuntimeConfig', () => {
  it('loads max_tokens and judge provider from v04_config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hybrid-eval-'));
    const configPath = join(dir, 'v04_config.json');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          tier_models: {
            trivial: { max_tokens: 123 },
            extreme: { max_tokens: 9876 },
          },
          feedback_loop: {
            llmJudgeModel: 'openai/gpt-4.1-mini',
          },
        }),
      );

      const loaded = loadEvalRuntimeConfig({ cwd: dir });

      expect(loaded.configPath).toBe(configPath);
      expect(loaded.maxTokens.trivial).toBe(123);
      expect(loaded.maxTokens.light).toBe(DEFAULT_MAX_TOKENS.light);
      expect(loaded.maxTokens.extreme).toBe(9876);
      expect(loaded.judgeProvider).toBe('openai');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
