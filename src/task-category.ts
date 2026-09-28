/**
 * Task category detection (MVP) — deterministic heuristics, no network.
 * Runs alongside detectIntentMode; low confidence → general (no benchmark reorder).
 */

import { extractFeatures } from 'gateswarm-lite';

export type TaskCategory =
  | 'code'
  | 'agentic'
  | 'reasoning'
  | 'long_context'
  | 'writing'
  | 'general';

export interface TaskCategoryResult {
  category: TaskCategory;
  confidence: number;
  signals: string[];
  lang: string | null;
}

const CONFIDENCE_THRESHOLD = 0.45;

const AGENTIC_MARKERS = [
  'mcp', 'tool call', 'terminal', 'bash', 'shell', 'kubectl', 'docker compose',
  'run command', 'execute', 'subagent', 'agent', 'workflow', 'browser',
  'playwright', 'grep ', 'curl ', 'npm run', 'git push',
];

const WRITING_MARKERS = [
  'blog post', 'release notes', 'copy', 'marketing', 'email', 'readme',
  'documentation', 'docstring', 'tone', 'headline', 'translate', 'rewrite',
  'redigir', 'escreva', 'documentação', 'texto para',
];

const REASONING_MARKERS = [
  'prove', 'theorem', 'equation', 'probability', 'architecture decision',
  'trade-off', 'tradeoff', 'compare approaches', 'design choice', 'why should',
  'evaluate options', 'math', 'algorithm complexity', 'big-o',
];

function detectLang(text: string): string | null {
  const lower = text.toLowerCase();
  const ptHits = (lower.match(/\b(não|você|preciso|corrigir|implementar|arquivo|função|por favor)\b/g) || []).length;
  const enHits = (lower.match(/\b(the|please|implement|fix|function|file|should)\b/g) || []).length;
  if (ptHits >= 2 && ptHits > enHits) return 'pt-BR';
  if (enHits >= 2) return 'en';
  return null;
}

function countMarkers(text: string, markers: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const m of markers) {
    if (lower.includes(m)) n++;
  }
  return n;
}

/**
 * Classify the prompt into an MVP task category with confidence.
 */
export function detectTaskCategory(prompt: string): TaskCategoryResult {
  const trimmed = (prompt || '').trim();
  if (!trimmed) {
    return { category: 'general', confidence: 0, signals: ['empty'], lang: null };
  }

  const features = extractFeatures(trimmed);
  const lang = detectLang(trimmed);
  const signals: string[] = [];
  const wordCount = Math.max(1, trimmed.split(/\s+/).length);

  const scores: Record<TaskCategory, number> = {
    code: 0,
    agentic: 0,
    reasoning: 0,
    long_context: 0,
    writing: 0,
    general: 0.15,
  };

  if (features.has_code > 0 || features.code_block_size > 0) {
    scores.code += 0.55;
    signals.push('code_block');
  }
  if (features.compound_tech > 0 || features.technical_terms > 2) {
    scores.code += 0.25;
    signals.push('technical_terms');
  }
  const codeKw = /\b(refactor|debug|typescript|python|rust|bug|patch|pr |pull request|unit test)\b/i.test(trimmed);
  if (codeKw) {
    scores.code += 0.2;
    signals.push('code_keywords');
  }

  const agenticHits = countMarkers(trimmed, AGENTIC_MARKERS);
  if (agenticHits > 0) {
    scores.agentic += 0.35 + Math.min(0.35, agenticHits * 0.1);
    signals.push('agentic_markers');
  }
  if (features.multi_step > 0 && features.has_imperative > 0) {
    scores.agentic += 0.15;
    signals.push('multi_step_imperative');
  }

  if (features.has_arithmetic > 0 || features.has_architecture > 0) {
    scores.reasoning += 0.25;
    signals.push('arithmetic_or_architecture');
  }
  const reasoningHits = countMarkers(trimmed, REASONING_MARKERS);
  if (reasoningHits > 0) {
    scores.reasoning += 0.3 + Math.min(0.3, reasoningHits * 0.1);
    signals.push('reasoning_markers');
  }

  if (wordCount > 800 || trimmed.length > 12000 || features.prior_context_needed > 0) {
    scores.long_context += 0.45;
    signals.push('long_prompt');
  }

  const writingHits = countMarkers(trimmed, WRITING_MARKERS);
  if (writingHits > 0) {
    scores.writing += 0.4 + Math.min(0.3, writingHits * 0.1);
    signals.push('writing_markers');
  }
  if (features.output_format_spec > 0 && features.has_code === 0) {
    scores.writing += 0.15;
    signals.push('output_format');
  }

  let best: TaskCategory = 'general';
  let bestScore = scores.general;
  const ordered: TaskCategory[] = ['code', 'agentic', 'reasoning', 'long_context', 'writing', 'general'];
  for (const cat of ordered) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      best = cat;
    }
  }

  const confidence = Math.min(1, bestScore);
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { category: 'general', confidence, signals: [...signals, 'below_threshold'], lang };
  }

  return { category: best, confidence, signals, lang };
}
