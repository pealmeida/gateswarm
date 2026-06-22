import { describe, it, expect } from 'vitest';
import {
  resolveOpenRouterId,
  priceUsd,
  costPer1kUsd,
  getOpenRouterPricing,
  normalizeModelToken,
  OPENROUTER_PRICING,
  PROVIDER_MODEL_EQUIVALENTS,
  BASELINE_MODEL,
} from '../src/openrouter-pricing.js';

describe('OpenRouter pricing — single source of truth', () => {
  describe('normalizeModelToken', () => {
    it('strips CLI agent prefixes', () => {
      expect(normalizeModelToken('cc/claude-opus-4-8')).toBe('claude-opus-4-8');
      expect(normalizeModelToken('cx/gpt-5.4-codex')).toBe('gpt-5.4-codex');
    });
    it('strips provider prefixes, including nested oc/ form', () => {
      expect(normalizeModelToken('openrouter/z-ai/glm-5')).toBe('z-ai/glm-5');
      expect(normalizeModelToken('oc/bailian/qwen3.5-plus')).toBe('qwen3.5-plus');
    });
  });

  describe('resolveOpenRouterId', () => {
    it('passes through a known OpenRouter ID', () => {
      expect(resolveOpenRouterId('anthropic/claude-opus-4.6')).toBe('anthropic/claude-opus-4.6');
    });
    it('resolves benchmark-logger "openrouter/" prefixed IDs', () => {
      expect(resolveOpenRouterId('openrouter/z-ai/glm-4.7-flash')).toBe('z-ai/glm-4.7-flash');
      expect(resolveOpenRouterId('openrouter/owl-alpha')).toBe('openrouter/owl-alpha');
    });
    it('maps provider/model executions to their OpenRouter equivalent', () => {
      expect(resolveOpenRouterId('glm-5.1', 'zai')).toBe('z-ai/glm-5.1');
      expect(resolveOpenRouterId('cc/claude-opus-4-8', 'claude-cli')).toBe('anthropic/claude-opus-4.8');
      expect(resolveOpenRouterId('cx/gpt-5.4-codex', 'codex-cli')).toBe('openai/gpt-5.4');
      expect(resolveOpenRouterId('deepseek-v4-pro', 'opencodego')).toBe('deepseek/deepseek-v4-pro');
    });
    it('returns null for local-only models with no equivalent', () => {
      expect(resolveOpenRouterId('qwen2.5:0.5b', 'ollama')).toBeNull();
    });
  });

  describe('priceUsd', () => {
    it('prices a CLI Codex request at OpenRouter openai rates', () => {
      // openai/gpt-5.4 = 4.00 in / 24.00 out per 1M
      const cost = priceUsd('cx/gpt-5.4-codex', 'codex-cli', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(28.0, 6);
    });
    it('prices a Z.AI request at OpenRouter z-ai rates', () => {
      // z-ai/glm-5.1 = 0.40 in / 1.60 out per 1M
      const cost = priceUsd('glm-5.1', 'zai', 500_000, 500_000);
      expect(cost).toBeCloseTo(1.0, 6);
    });
    it('treats a model with no equivalent as free', () => {
      expect(priceUsd('qwen2.5:0.5b', 'ollama', 1000, 1000)).toBe(0);
    });
  });

  describe('costPer1kUsd', () => {
    it('returns per-1K cost derived from the per-1M table', () => {
      const c = costPer1kUsd('glm-5.1', 'zai');
      expect(c.input).toBeCloseTo(0.0004, 9);
      expect(c.output).toBeCloseTo(0.0016, 9);
    });
    it('returns zero for models with no equivalent', () => {
      expect(costPer1kUsd('qwen2.5:0.5b', 'ollama')).toEqual({ input: 0, output: 0 });
    });
  });

  describe('table integrity', () => {
    it('baseline model is present and priced', () => {
      expect(getOpenRouterPricing(BASELINE_MODEL)).not.toBeNull();
    });
    it('every equivalence target exists in the pricing table', () => {
      for (const [token, orId] of Object.entries(PROVIDER_MODEL_EQUIVALENTS)) {
        expect(OPENROUTER_PRICING[orId], `${token} → ${orId}`).toBeDefined();
      }
    });
  });
});
