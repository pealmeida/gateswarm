/**
 * GateSwarm MoA Router v0.4 — 25-Feature Extractor
 *
 * Expands the v3.3 9-signal heuristic to 25 features
 * for significantly improved moderate/heavy tier accuracy.
 */

export interface FeatureVector {
  // v3.3 Heuristic (9 binary signals)
  has_question: number;
  has_code: number;
  has_imperative: number;
  has_arithmetic: number;
  has_sequential: number;
  has_constraint: number;
  has_context: number;
  has_architecture: number;
  has_design: number;
  // v3.2 Cascade (6 structural)
  sentence_count: number;
  avg_word_length: number;
  question_technical: number;
  technical_design: number;
  technical_terms: number;
  multi_step: number;
  // NEW v0.4 (10 features)
  has_negation: number;
  entity_count: number;
  code_block_size: number;
  domain_finance: number;
  domain_legal: number;
  domain_medical: number;
  domain_engineering: number;
  temporal_references: number;
  output_format_spec: number;
  prior_context_needed: number;
  novelty_score: number;
  multi_domain: number;
  user_expertise_level: number;
}

// ─── Domain Keywords ──────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  finance: ['wacc', 'ebitda', 'balance sheet', 'cash flow', 'npv', 'irr',
    'capm', 'beta', 'dividend', 'hedge', 'derivative', 'amortization',
    'liquidity', 'solvency', 'leverage', 'revenue', 'margin', 'forecast'],
  legal: ['gdpr', 'hipaa', 'liability', 'indemnification', 'compliance',
    'contract', 'clause', 'jurisdiction', 'arbitration', 'regulation',
    'statute', 'litigation', 'deposition', 'affidavit'],
  medical: ['clinical trial', 'diagnosis', 'treatment', 'pharmacology',
    'icd-10', 'pathology', 'biomarker', 'prognosis', 'dosage',
    'contraindication', 'adverse effect', 'therapeutic'],
  engineering: ['load bearing', 'tolerance', 'fatigue', 'stress analysis',
    'finite element', 'computational fluid', 'thermodynamic',
    'structural', 'material science', 'kinematics'],
};

const TECH_KEYWORDS = new Set([
  'api', 'http', 'rest', 'graphql', 'websocket', 'dns', 'ssl', 'tls',
  'oauth', 'jwt', 'cors', 'cdn', 'docker', 'kubernetes', 'git',
  'json', 'yaml', 'xml', 'sql', 'nosql', 'redis', 'mongodb',
  'typescript', 'python', 'rust', 'java', 'react', 'vue', 'angular',
  'svelte', 'node', 'express', 'fastapi', 'function', 'class',
  'async', 'await', 'error', 'type', 'interface', 'architecture',
  'design', 'system', 'microservice', 'container', 'deploy', 'pipeline',
  'algorithm', 'database', 'refactor', 'optimize', 'debug', 'security',
]);

// ─── Signal Keywords (v3.3) ─────────────────────────────

const SIGNAL_KEYWORDS = {
  imperativeVerbs: ['write', 'create', 'build', 'implement', 'generate', 'fix',
    'debug', 'optimize', 'explain', 'analyze', 'describe', 'design'],
  codeKeywords: ['code', 'function', 'def ', 'class ', 'import ', 'fn ', 'const '],
  sequentialMarkers: ['first ', 'then ', 'finally', 'step ', 'part ', 'section ', 'also '],
  constraintWords: ['must ', 'should ', 'required ', 'only ', 'cannot ', 'limit '],
  contextMarkers: ['given ', 'consider ', 'assume ', 'suppose ', 'based on ', 'according to '],
  architectureKeywords: ['architecture', 'design pattern', 'system design', 'microservice',
    'scalable', 'distributed'],
  designKeywords: ['technical design', 'implementation plan', 'migration strategy',
    'deployment', 'pipeline', 'schema', 'database'],
};

const NAMED_ENTITY_PATTERNS = [
  /[A-Z][a-z]+ (Inc|Corp|LLC|Ltd|Co|GmbH|SA|PLC)/g,
  /\b[A-Z]{2,}\b/g,
  /\$\d+(?:\.\d+)?[MKB]?/g,
  /\d{4}-\d{2}-\d{2}/g,
];

export function extractFeatures(prompt: string): FeatureVector {
  if (!prompt?.trim()) return zeroFeatures();

  const t = prompt.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const wc = words.length;
  const sentences = prompt.split(/[.!?]+/).filter(s => s.trim());

  // v3.3 Heuristic Signals (binary)
  const has_question = prompt.includes('?') ? 1 : 0;
  const has_code = SIGNAL_KEYWORDS.codeKeywords.some(k => t.includes(k)) ? 1 : 0;
  const has_imperative = SIGNAL_KEYWORDS.imperativeVerbs.some(v => t.startsWith(v + ' ')) ? 1 : 0;
  const has_arithmetic = /[0-9]+\s*[+\-*/=]/.test(prompt) ? 1 : 0;
  const has_sequential = SIGNAL_KEYWORDS.sequentialMarkers.some(k => t.includes(k)) ? 1 : 0;
  const has_constraint = SIGNAL_KEYWORDS.constraintWords.some(k => t.includes(k)) ? 1 : 0;
  const has_context = SIGNAL_KEYWORDS.contextMarkers.some(k => t.includes(k)) ? 1 : 0;
  const has_architecture = SIGNAL_KEYWORDS.architectureKeywords.some(k => t.includes(k)) ? 1 : 0;
  const has_design = SIGNAL_KEYWORDS.designKeywords.some(k => t.includes(k)) ? 1 : 0;

  // v3.2 Cascade
  const sentence_count = sentences.length;
  const avg_word_length = wc > 0 ? words.reduce((s, w) => s + w.length, 0) / wc : 0;
  const techTerms = words.filter(w => TECH_KEYWORDS.has(w)).length;
  const question_technical = has_question && techTerms > 0 ? 1 : 0;
  const technical_design = has_design || has_architecture ? 1 : 0;
  const technical_terms = techTerms;
  const multi_step = /(first|then|next|finally|step\s*\d+)/.test(t) ? 1 : 0;

  // v0.4 New Features
  const has_negation = /\b(don['']t|not|never|avoid|without|except|unless|nor)\b/.test(t) ? 1 : 0;

  let entity_count = 0;
  for (const p of NAMED_ENTITY_PATTERNS) {
    const m = prompt.match(p);
    if (m) entity_count += m.length;
  }

  const codeBlocks = prompt.match(/```[\s\S]*?```/g);
  const code_block_size = codeBlocks ? codeBlocks.reduce((s, b) => s + b.split('\n').length, 0) : 0;

  const domain_finance = DOMAIN_KEYWORDS.finance.some(kw => t.includes(kw)) ? 1 : 0;
  const domain_legal = DOMAIN_KEYWORDS.legal.some(kw => t.includes(kw)) ? 1 : 0;
  const domain_medical = DOMAIN_KEYWORDS.medical.some(kw => t.includes(kw)) ? 1 : 0;
  const domain_engineering = DOMAIN_KEYWORDS.engineering.some(kw => t.includes(kw)) ? 1 : 0;

  const temporal_refs = (prompt.match(/\b(by tomorrow|by next week|within \d+|last quarter|Q\d|deadline|urgent|asap|immediately|by end of)\b/gi) || []).length;

  const output_format_spec = /\b(as (json|yaml|xml|csv|markdown|table|list)|in (json|yaml|xml|csv)|format (as|like)|output (as|format))\b/.test(t) ? 1 : 0;

  const prior_context_needed = /\b(as we discussed|as mentioned|continue|from before|previous|the file|this project|my code|our system|given that|as before)\b/.test(t) ? 1 : 0;

  const wordFreq = new Map<string, number>();
  for (const w of words) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  const novelty_score = wc > 0 ? new Set(words).size / wc : 0;

  const domainCount = [domain_finance, domain_legal, domain_medical, domain_engineering].filter(d => d).length;
  const multi_domain = domainCount >= 2 ? 1 : 0;

  const sophisticated = words.filter(w =>
    (w.length > 10 && TECH_KEYWORDS.has(w)) ||
    /^(paradigm|idempotent|orthogonal|monotonic|isomorphic|polymorphic|asymptotic)\b/.test(w)
  ).length;
  const user_expertise_level = sophisticated >= 3 ? 2 : sophisticated >= 1 ? 1 : 0;

  return {
    has_question, has_code, has_imperative, has_arithmetic,
    has_sequential, has_constraint, has_context, has_architecture, has_design,
    sentence_count, avg_word_length, question_technical,
    technical_design, technical_terms, multi_step,
    has_negation, entity_count, code_block_size,
    domain_finance, domain_legal, domain_medical, domain_engineering,
    temporal_references: temporal_refs, output_format_spec, prior_context_needed,
    novelty_score, multi_domain, user_expertise_level,
  };
}

function zeroFeatures(): FeatureVector {
  return {
    has_question: 0, has_code: 0, has_imperative: 0, has_arithmetic: 0,
    has_sequential: 0, has_constraint: 0, has_context: 0, has_architecture: 0, has_design: 0,
    sentence_count: 0, avg_word_length: 0, question_technical: 0,
    technical_design: 0, technical_terms: 0, multi_step: 0,
    has_negation: 0, entity_count: 0, code_block_size: 0,
    domain_finance: 0, domain_legal: 0, domain_medical: 0, domain_engineering: 0,
    temporal_references: 0, output_format_spec: 0, prior_context_needed: 0,
    novelty_score: 0, multi_domain: 0, user_expertise_level: 0,
  };
}

/**
 * Compute v3.3 heuristic score from features.
 */
export function heuristicScoreFromFeatures(features: FeatureVector, wordCount: number): number {
  const signals = features.has_question + features.has_code + features.has_imperative +
    features.has_arithmetic + features.has_sequential + features.has_constraint +
    features.has_context + features.has_architecture + features.has_design;

  let score = signals * 0.15 + Math.log1p(wordCount) * 0.08 + (features.has_context ? 0.1 : 0);
  score += calcSystemBonus(wordCount, features);
  return Math.min(Math.max(score, 0), 1);
}

function calcSystemBonus(wc: number, f: FeatureVector): number {
  const sysCount = f.has_architecture + f.technical_design +
    (f.technical_terms > 3 ? 1 : 0) + f.multi_domain;
  if (wc >= 15 && sysCount >= 5) return 0.35;
  if (wc >= 15 && sysCount >= 4) return 0.25;
  if (wc >= 12 && sysCount >= 3) return 0.15;
  if (wc >= 10 && sysCount >= 3) return 0.10;
  if (wc >= 10 && sysCount >= 2) return 0.05;
  if (sysCount >= 2) return 0.03;
  return 0;
}
