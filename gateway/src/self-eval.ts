/**
 * GateSwarm MoA Router v0.4.4 — Self-Evaluation & LLM Judge
 *
 * Post-response adequacy scoring:
 *   1. Quick heuristic: response length, token usage, error patterns
 *   2. Periodic LLM judge: bailian/qwen3.6-plus evaluates adequacy
 *
 * v0.4.4: LLM judge uses qwen3.6-plus (extreme tier) instead of qwen3.5-plus
 * to avoid circularity — the judge should be more capable than the model it's judging.
 *
 * Results feed the self-optimizing retraining loop.
 */

import type { EffortLevel } from './types.js';
import { getConfig } from './v04-config.js';

export interface SelfEvalResult {
  quickScore: number;        // 0.0–1.0 heuristic estimate
  llmScore: number | null;   // 0.0–1.0 LLM judge (async)
  shouldEscalate: boolean;
  predictedCorrectTier: EffortLevel | null;
}

// ─── Quick Heuristic Evaluation ───────────────────────────

interface EvalInput {
  prompt: string;
  response: string;
  predictedTier: EffortLevel;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string;
}

const TIER_EXPECTED_TOKEN_RANGES: Record<EffortLevel, [number, number]> = {
  trivial:   [5, 50],
  light:     [20, 200],
  moderate:  [100, 800],
  heavy:     [300, 2000],
  intensive: [500, 4000],
  extreme:   [1000, 8000],
};

export function quickEval(input: EvalInput): number {
  if (input.error) return 0.1;

  const [minTok, maxTok] = TIER_EXPECTED_TOKEN_RANGES[input.predictedTier] || [50, 1000];
  const out = input.tokensOut;

  // Token range score (0–0.4)
  let tokenScore = 0;
  if (out >= minTok && out <= maxTok) tokenScore = 0.4;
  else if (out < minTok) tokenScore = Math.max(0, 0.4 * (out / minTok));
  else tokenScore = Math.max(0.1, 0.4 * (maxTok / out));

  // Response length score (0–0.2)
  const respWords = input.response.split(/\s+/).filter(Boolean).length;
  let lengthScore = 0;
  if (respWords > 5 && respWords < 2000) lengthScore = 0.2;
  else if (respWords <= 5) lengthScore = 0.05;
  else lengthScore = 0.1;

  // Latency sanity (0–0.2) — very fast = likely shallow, very slow = likely complex
  let latencyScore = 0.2;
  if (input.latencyMs < 200 && input.predictedTier !== 'trivial') latencyScore = 0.05;
  if (input.latencyMs > 30000) latencyScore = 0.1;

  // Repetition penalty (0–0.2)
  const words = input.response.toLowerCase().split(/\s+/).filter(Boolean);
  const uniqueRatio = new Set(words).size / Math.max(words.length, 1);
  const repetitionScore = uniqueRatio > 0.7 ? 0.2 : uniqueRatio > 0.4 ? 0.1 : 0.05;

  return Math.min(1, tokenScore + lengthScore + latencyScore + repetitionScore);
}

// ─── LLM Judge ─────────────────────────────────────────────

const JUDGE_CACHE = new Map<string, { score: number; tier: string }>();

export async function llmJudge(
  prompt: string,
  response: string
): Promise<{ adequacy: number; correctTier: string }> {
  const cacheKey = `${prompt.slice(0, 100)}|${response.slice(0, 100)}`;
  const cached = JUDGE_CACHE.get(cacheKey);
  if (cached) return { adequacy: cached.score, correctTier: cached.tier };

  const config = getConfig();
  const { llmJudgeModel, llmJudgeSamplingRate } = config.feedback_loop;

  // Random sampling
  if (Math.random() > llmJudgeSamplingRate) {
    return { adequacy: -1, correctTier: '' }; // not sampled
  }

  // v0.4.4: Anti-circularity — judge uses a different, more capable model
  // than the one handling the request. Override to qwen3.6-plus (extreme tier).
  const judgeProvider = 'bailian';
  const judgeModel = 'qwen3.6-plus';

  const baseUrl = judgeProvider === 'bailian'
    ? 'https://coding-intl.dashscope.aliyuncs.com/v1'
    : judgeProvider === 'zai'
      ? 'https://api.z.ai/api/coding/paas/v4'
      : '';

  const apiKey = judgeProvider === 'bailian'
    ? process.env.BAILIAN_KEY || ''
    : judgeProvider === 'zai'
      ? process.env.GLM_API_KEY || ''
      : '';

  if (!baseUrl || !apiKey) {
    return { adequacy: -1, correctTier: '' };
  }

  try {
    const judgePrompt = `You are an AI routing quality judge. Evaluate whether this response adequately addresses the prompt.

Prompt: "${prompt.slice(0, 500)}"
Response: "${response.slice(0, 1000)}"

Consider: relevance, completeness, correctness, and appropriate depth for the predicted complexity tier.

Respond with ONLY a JSON object:
{"adequacy": 0.85, "correct_tier": "heavy"}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: 'user', content: judgePrompt }],
        max_tokens: 100,
        temperature: 0.1,
      }),
    });

    if (!res.ok) return { adequacy: -1, correctTier: '' };

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    const result = {
      adequacy: Math.max(0, Math.min(1, parsed.adequacy || 0.5)),
      correctTier: parsed.correct_tier || '',
    };

    JUDGE_CACHE.set(cacheKey, { score: result.adequacy, tier: result.correctTier });
    return result;
  } catch {
    return { adequacy: -1, correctTier: '' };
  }
}

// ─── Full Self-Eval ───────────────────────────────────────

export async function selfEvaluate(input: EvalInput): Promise<SelfEvalResult> {
  const quickScore = quickEval(input);
  let llmScore: number | null = null;
  let predictedCorrectTier: EffortLevel | null = null;
  let shouldEscalate = quickScore < 0.5;

  // LLM judge (async, sampled)
  const judgeResult = await llmJudge(input.prompt, input.response);
  if (judgeResult.adequacy >= 0) {
    llmScore = judgeResult.adequacy;
    const validTiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    if (validTiers.includes(judgeResult.correctTier as EffortLevel)) {
      predictedCorrectTier = judgeResult.correctTier as EffortLevel;
    }
    shouldEscalate = llmScore < 0.6;
  }

  return {
    quickScore,
    llmScore,
    shouldEscalate,
    predictedCorrectTier,
  };
}
