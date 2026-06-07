/**
 * Model-agnostic classifier contract (ACCURACY_ROADMAP.md §11.1).
 *
 * Any tier/mode model — rule-based, learned-ML, or a real LLM provider — that
 * implements this interface drops into eval/leaderboard.ts and competes on the
 * identical frozen split + eval battery. The current scorer is wrapped as the
 * `heuristic-linear` baseline; it is a row, not a special case.
 */
import type { EffortLevel, IntentMode } from '../types.js';
import type { FeatureVector as FV } from '../feature-extractor-v04.js';

export type ClassifierKind = 'rule' | 'learned' | 'llm';

export interface TierPrediction {
  tier: EffortLevel;
  probs?: Partial<Record<EffortLevel, number>>; // probabilistic models
  score?: number;                                // scalar models (0..1)
  confidence: number;
  latencyMs: number;
  costUsd?: number;                              // LLM backends
}

export interface ModePrediction {
  mode: IntentMode;
  confidence: number;
  latencyMs: number;
  costUsd?: number;
}

/** A labeled training example handed to fit(). */
export interface LabeledPrompt {
  id: string;
  prompt: string;
  tier?: EffortLevel;
  features?: FV;
}

export interface TierClassifier {
  id: string;                 // 'heuristic-linear' | 'ordinal-logistic' | 'llm:groq-llama' …
  kind: ClassifierKind;
  version: string;            // bump invalidates any prediction cache
  requiresTraining: boolean;
  /** Train on a fold's training split. No-op for rule/llm zero-shot models. */
  fit?(train: LabeledPrompt[]): Promise<void> | void;
  predictEffort(prompt: string, feats?: FV): Promise<TierPrediction> | TierPrediction;
  predictMode?(prompt: string): Promise<ModePrediction> | ModePrediction;
}

// Re-export for convenience so adapters import a single module.
export type { EffortLevel, IntentMode, FV };
