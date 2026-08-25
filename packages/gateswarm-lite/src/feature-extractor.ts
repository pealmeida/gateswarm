/**
 * GateSwarm MoMA Router v0.4 — 25-Feature Extractor
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
  compound_tech: number;
  // Phase 2 mid-band separation features
  requirement_count: number;
  distinct_imperative_verbs: number;
  question_count: number;
  conjunction_enumeration: number;
  scale_quantity_mentions: number;
  diagnostic_causal_markers: number;
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
  'consensus', 'saga', 'idempotent', 'idempotency', 'replication',
  'sharding', 'partition', 'failover', 'circuit-breaker', 'cluster',
  'middleware', 'broker', 'cache', 'limiter', 'rate-limit', 'lua',
  'palindrome', 'lru', 'brotli', 'gzip', 'compression',
  // v0.5.6-bug6: common JS/TS/Python idioms that show up as compound tokens
  // (split by whitespace in extractFeatures, so 'async/await' is one token).
  // Adding the compound form here is enough — the word match is exact-token.
  'async/await', 'event-loop', 'call-stack', 'arrow-function', 'arrow-functions',
  'higher-order', 'higher-order-function', 'destructuring', 'spread-operator',
  'template-literal', 'template-literals', 'ternary-operator', 'short-circuit',
  'closure', 'closures', 'hoisting', 'currying', 'iife', 'iifes',
  'promise', 'promises', 'callback', 'callbacks', 'thenable', 'thenables',
  'generator', 'generators', 'iterator', 'iterators', 'iterable', 'iterables',
  'recursion', 'recursive', 'memoization', 'memoize', 'polymorphism',
  'inheritance', 'encapsulation', 'abstraction', 'composition', 'dependency-injection',
  'singleton', 'factory', 'observer', 'observer-pattern', 'pub-sub', 'pubsub',
  'mutex', 'semaphore', 'deadlock', 'livelock', 'race-condition', 'race-conditions',
  'coroutine', 'coroutines', 'thread', 'threads', 'threading', 'multithreading',
  'lambda', 'lambdas', 'comprehension', 'list-comprehension', 'dictionary',
  'list-comprehensions', 'generator-expression',
  'decorator', 'decorators', 'context-manager', 'context-managers',
  // Domain patterns
  'machine-learning', 'deep-learning', 'neural-network', 'neural-networks',
  'transformer', 'transformers', 'embedding', 'embeddings', 'rag', 'fine-tuning',
  'tokenization', 'prompt-engineering', 'agentic', 'multi-agent',
]);

// ─── Signal Keywords (v3.3) ─────────────────────────────

const SIGNAL_KEYWORDS = {
  imperativeVerbs: ['write', 'create', 'build', 'implement', 'generate', 'fix',
    'debug', 'optimize', 'explain', 'analyze', 'describe', 'design', 'architect',
    'engineer', 'develop', 'construct', 'compose', 'formulate', 'devise'],
  codeKeywords: ['code', 'function', 'def ', 'class ', 'import ', 'fn ', 'const ',
    'async/await', 'await ', 'await(', 'await.', 'async ', 'async(',
    'promise', 'callback', '=>', '=>{', 'return ', 'let ', 'var ', 'yield '],
  sequentialMarkers: ['first ', 'then ', 'finally', 'step ', 'part ', 'section ', 'also '],
  constraintWords: ['must ', 'should ', 'required ', 'only ', 'cannot ', 'limit '],
  contextMarkers: ['given ', 'consider ', 'assume ', 'suppose ', 'based on ', 'according to '],
  architectureKeywords: ['architecture', 'design pattern', 'system design', 'microservice',
    'scalable', 'distributed', 'consensus', 'saga', 'eventual consistency',
    'idempotent', 'idempotency', 'multi-region', 'multi-tenant', 'cluster',
    'sharding', 'partition', 'replication', 'failover', 'circuit breaker',
    'service mesh', 'api gateway', 'event sourcing', 'cqrs', 'raft', 'paxos'],
  designKeywords: ['technical design', 'implementation plan', 'migration strategy',
    'deployment', 'pipeline', 'schema', 'database', 'rate limit', 'rate limiter',
    'cache', 'load balancer', 'queue', 'broker', 'middleware', 'saga pattern',
    'consensus', 'eventual consistency', 'payment system', 'multi-region'],
};

const IMPERATIVE_VERBS = new Set([
  ...SIGNAL_KEYWORDS.imperativeVerbs,
  'add', 'audit', 'change', 'compare', 'consolidate', 'convert', 'deduplicate',
  'deploy', 'diagnose', 'emit', 'evaluate', 'export', 'find', 'generate',
  'group', 'help', 'isolate', 'lay', 'map', 'merge', 'migrate', 'model',
  'outline', 'plan', 'profile', 'propose', 'rank', 'recommend', 'redesign',
  'refactor', 'replace', 'resolve', 'restructure', 'retry', 'rewrite',
  'sequence', 'shard', 'ship', 'sketch', 'split', 'stage', 'summarize',
  'synthesize', 'test', 'untangle', 'update', 'validate', 'walk', 'work',
]);

function countRegex(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

interface TextSpan {
  start: number;
  end: number;
}

function spansOverlap(a: TextSpan, b: TextSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function countMergedMatches(patterns: RegExp[], text: string): number {
  const spans: TextSpan[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged.length;
}

function keywordSpans(text: string, keywords: Iterable<string>): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const keyword of keywords) {
    let start = text.indexOf(keyword);
    while (start >= 0) {
      const end = start + keyword.length;
      const before = text[start - 1] ?? '';
      const after = text[end] ?? '';
      if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) spans.push({ start, end });
      start = text.indexOf(keyword, start + keyword.length);
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

function claimKeywordSpans(spans: TextSpan[], claimed: TextSpan[]): number {
  let count = 0;
  for (const span of spans) {
    if (!claimed.some((other) => spansOverlap(span, other))) {
      claimed.push(span);
      count++;
    }
  }
  return count;
}

function segmentText(prompt: string, granularity: 'word' | 'sentence'): string[] {
  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter(undefined, { granularity });
    const segments = Array.from(segmenter.segment(prompt));
    if (granularity === 'word') {
      // Keep established compound technical tokens (for example async/await)
      // together while using Segmenter everywhere else. This preserves their
      // semantic signal and avoids changing established English scores.
      const compounds = Array.from(prompt.matchAll(/[a-z][a-z0-9]*[-/][a-z][a-z0-9]*/gi))
        .map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0] }));
      const seenCompounds = new Set<number>();
      const words = segments.flatMap((segment) => {
        const compoundIndex = compounds.findIndex((compound) =>
          segment.index >= compound.start && segment.index < compound.end,
        );
        if (compoundIndex >= 0) {
          if (seenCompounds.has(compoundIndex)) return [];
          seenCompounds.add(compoundIndex);
          return [compounds[compoundIndex].text];
        }
        return segment.isWordLike ? [segment.segment] : [];
      });
      // Emoji-only prompts do not contain word-like segments, but should still
      // contribute meaningful input size instead of looking empty.
      if (words.length > 0) return words;
      return segments
        .map((segment) => segment.segment)
        .filter((segment) => /\S/u.test(segment) && !/^\p{P}+$/u.test(segment));
    }
    return segments.map((segment) => segment.segment).filter((segment) => segment.trim());
  }
  return granularity === 'word'
    ? prompt.split(/\s+/).filter(Boolean)
    : prompt.split(/[.!?]+/).filter((sentence) => sentence.trim());
}

/** Unicode-aware word count shared by the heuristic and ordinal scorer. */
export function countPromptWords(prompt: string): number {
  return segmentText(prompt, 'word').length;
}

function countScaleQuantityMentions(text: string): number {
  return countMergedMatches([
    /\bsub-\d+(?:\.\d+)?\s*(?:ms|milliseconds|s|sec|secs|seconds)\b/g,
    /\b\d+(?:\.\d+)?\s*(?:mb|gb|tb|kb|ms|milliseconds|qps|rps)\b/g,
    /\b\d+(?:\.\d+)?\s*(?:million|billion|thousand)\s+(?:events|requests|rows|users|services|microservices|hospitals|records|transactions)\b/g,
    /\b\d+(?:\.\d+)?(?:k|m|b)\s*(?:events|requests|users|rows|qps|rps)?\b/g,
    /\b\d+(?:\.\d+)?-(?:billion|million|thousand|row|rows|microservice|microservices|tenant|tenants|region|regions|user|users)[a-z-]*\b/g,
    /\bp(?:90|95|99|999)\b/g,
    /\b(?:qps|rps|events\/sec|events per second|requests per second|concurrent users|tail latency)\b/g,
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|hundred|thousand|million|billion)\s+(?:separate\s+)?(?:regions|repos|repositories|services|microservices|hospitals|users|events|rows|product lines|years|teams)\b/g,
    /\b(?:hundred|thousand|million|billion)-[a-z-]*(?:microservice|microservices|user|users|row|rows|tenant|tenants|region|regions)[a-z-]*\b/g,
  ], text);
}

function countDiagnosticCausalMarkers(text: string): number {
  const patterns = [
    /\bfigure out (?:which|why|whether|what)\b/g,
    /\bnot sure if\b[^.?!]*\bor\b/g,
    /\bspiked from\b[^.?!]*\bto\b/g,
    /\bafter the last (?:deploy|deployment|release)\b/g,
    /\bregress(?:ed|ion|ions)?\b/g,
    /\broot cause\b/g,
    /\bisolate the cause\b/g,
    /\bdiagnos(?:e|ing|is)\b/g,
    /\bprofile why\b/g,
    /\bintermittent data corruption\b/g,
  ];
  return patterns.reduce((sum, re) => sum + countRegex(text, re), 0);
}

const NAMED_ENTITY_PATTERNS = [
  /[A-Z][a-z]+ (Inc|Corp|LLC|Ltd|Co|GmbH|SA|PLC)/g,
  /\b[A-Z]{2,}\b/g,
  /\$\d+(?:\.\d+)?[MKB]?/g,
  /\d{4}-\d{2}-\d{2}/g,
];

export function extractFeatures(prompt: string): FeatureVector {
  if (!prompt?.trim()) return zeroFeatures();

  const t = prompt.toLowerCase();
  const words = segmentText(t, 'word');
  const wc = words.length;
  const sentences = segmentText(prompt, 'sentence');
  const normalizedWords = t.match(/[a-z][a-z0-9-]*/g) || [];

  // v3.3 Heuristic Signals (binary)
  const has_question = prompt.includes('?') ? 1 : 0;
  const has_code = SIGNAL_KEYWORDS.codeKeywords.some(k => t.includes(k)) ? 1 : 0;
  const has_imperative = SIGNAL_KEYWORDS.imperativeVerbs.some(v => t.startsWith(v + ' ')) ? 1 : 0;
  const has_arithmetic = /[0-9]+\s*[+\-*/=]/.test(prompt) ? 1 : 0;
  const has_sequential = SIGNAL_KEYWORDS.sequentialMarkers.some(k => t.includes(k)) ? 1 : 0;
  const has_constraint = SIGNAL_KEYWORDS.constraintWords.some(k => t.includes(k)) ? 1 : 0;
  const has_context = SIGNAL_KEYWORDS.contextMarkers.some(k => t.includes(k)) ? 1 : 0;
  const claimedKeywordSpans: TextSpan[] = [];
  const has_architecture = claimKeywordSpans(
    keywordSpans(t, SIGNAL_KEYWORDS.architectureKeywords), claimedKeywordSpans,
  ) > 0 ? 1 : 0;
  const has_design = claimKeywordSpans(
    keywordSpans(t, SIGNAL_KEYWORDS.designKeywords), claimedKeywordSpans,
  ) > 0 ? 1 : 0;

  // v3.2 Cascade
  const sentence_count = sentences.length;
  const avg_word_length = wc > 0 ? words.reduce((s, w) => s + w.length, 0) / wc : 0;
  const techTerms = claimKeywordSpans(keywordSpans(t, TECH_KEYWORDS), claimedKeywordSpans);
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

  // v0.5.6-bug6: Compound technical tokens (async/await, event-loop, etc.)
  // are single words in the feature extractor (split on whitespace) and
  // would otherwise get the same weight as a single short keyword. Give
  // them a discrete bump — explaining a named concept warrants at least
  // the light tier, not trivial.
  const COMPOUND_TECH_PATTERNS = [
    /^[a-z][a-z0-9]*[-/][a-z][a-z0-9]*$/i,  // async/await, event-loop, call-stack
    /^[a-z]+_(function|method|pattern|handler|provider|controller|service|component|module|interface|api)$/i,
  ];
  const compound_tech = words.filter(w =>
    COMPOUND_TECH_PATTERNS.some(p => p.test(w)) && w.length >= 6
  ).length;

  // Phase 2: decomposition, scale, and diagnostic markers for the
  // moderate/heavy/intensive band where length alone collapses.
  const listItemCount = countMergedMatches([
    /^\s*(?:[-*]|\d+[.)])\s+\S/gm,
    /\b\d+[.)]\s+\S/g,
  ], prompt);
  const requirementPhraseCount = countRegex(
    t,
    /\b(?:must|should|shall|required|requires?|needs? to|have to|cannot|without|under|within|supports?|handles?|including|with|while|keeping|stays? under|ranked by)\b/g,
  );
  const requirement_count = requirementPhraseCount + listItemCount;
  const distinct_imperative_verbs = new Set(
    normalizedWords.filter(w => IMPERATIVE_VERBS.has(w)),
  ).size;
  const question_count = countRegex(prompt, /[^?]+\?/g);
  const commaEnumerationCount = sentences.reduce((sum, sentence) => {
    const commas = countRegex(sentence, /,/g);
    return sum + (commas >= 2 ? commas : 0);
  }, 0);
  const conjunction_enumeration =
    countRegex(t, /\b(?:as well as|along with|and|plus)\b/g) +
    commaEnumerationCount + listItemCount;
  const scale_quantity_mentions = countScaleQuantityMentions(t);
  const diagnostic_causal_markers = countDiagnosticCausalMarkers(t);

  return {
    has_question, has_code, has_imperative, has_arithmetic,
    has_sequential, has_constraint, has_context, has_architecture, has_design,
    sentence_count, avg_word_length, question_technical,
    technical_design, technical_terms, multi_step,
    has_negation, entity_count, code_block_size,
    domain_finance, domain_legal, domain_medical, domain_engineering,
    temporal_references: temporal_refs, output_format_spec, prior_context_needed,
    novelty_score, multi_domain, user_expertise_level, compound_tech,
    requirement_count, distinct_imperative_verbs, question_count,
    conjunction_enumeration, scale_quantity_mentions, diagnostic_causal_markers,
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
    novelty_score: 0, multi_domain: 0, user_expertise_level: 0, compound_tech: 0,
    requirement_count: 0, distinct_imperative_verbs: 0, question_count: 0,
    conjunction_enumeration: 0, scale_quantity_mentions: 0,
    diagnostic_causal_markers: 0,
  };
}

/**
 * Compute heuristic complexity score from features.
 *
 * v0.5.2 recalibration: the previous formula relied almost entirely on
 * architecture/design lexicon and produced near-zero scores for natural-language
 * prompts, leaving moderate/heavy/intensive indistinguishable (all ≈0.04). The
 * dominant, most reliable complexity signal — prompt length/structure — was unused
 * except as a gate on the system bonus.
 *
 * This version makes length + structure first-class while keeping the lexical
 * signals as secondary discriminators. Calibrated against a labeled golden set
 * (see eval/): monotonic per-tier medians, ~48% exact / ~86% adjacent accuracy.
 * Tier boundaries that pair with this score live in scoreToEffort()/v04_config.json.
 */
export function heuristicScoreFromFeatures(features: FeatureVector, wordCount: number): number {
  const t = features;

  // Length remains the anchor, but Phase 2 makes room for decomposition signals
  // that separate heavy implementation tasks from intensive diagnostic tasks.
  const lengthScore = Math.min(Math.log1p(wordCount) / Math.log1p(45), 1) * 0.30;
  const structScore = (Math.min(t.sentence_count + Math.floor(t.conjunction_enumeration / 4), 5) / 5) * 0.08;
  // Architecture & design lexicon (max 0.20)
  const archScore = Math.min((t.has_architecture + t.has_design) * 0.09, 0.18);
  // Technical terms, saturating. Keep lexical density secondary; it was flat
  // across the mid-band and over-rewarded implementation-keyword prompts.
  const techScore = Math.min(t.technical_terms * 0.020, 0.10);
  // Code presence only. code_block_size is intentionally zero-weighted as dead MI.
  const codeScore = t.has_code * 0.04;
  // Reasoning / constraint signals
  const reasonScore =
    t.has_constraint * 0.04 + t.has_context * 0.03 + t.multi_step * 0.03 +
    t.has_negation * 0.02 + t.has_sequential * 0.02;
  const decompositionScore = Math.min(
    t.requirement_count * 0.012 +
    t.distinct_imperative_verbs * 0.014 +
    t.question_count * 0.014 +
    t.conjunction_enumeration * 0.005,
    0.12,
  );
  const scaleScore = Math.min(t.scale_quantity_mentions * 0.035, 0.14);
  const diagnosticScore = Math.min(t.diagnostic_causal_markers * 0.050, 0.13);
  // Keep the only non-dead domain signal; the legal/medical/engineering,
  // multi_domain, and user_expertise_level fields remain for compatibility only.
  const domainScore = t.domain_finance * 0.02;
  // v0.5.6-bug6: compound technical tokens (async/await, event-loop, etc.) signal
  // that the user is asking about a named concept worth at least a light-tier
  // explanation. Without this, a 2-word prompt like 'Explain async/await' can land
  // below the light boundary, and the 0.5B model can't write a coherent
  // technical explanation. Each compound term adds a small, capped boost.
  const compoundScore = Math.min(t.compound_tech * 0.035, 0.10);
  // System-design bonus: compound complexity using live Phase 2 signals.
  const sysCount = t.has_architecture + t.technical_design +
    (t.technical_terms > 3 ? 1 : 0) + (t.requirement_count >= 3 ? 1 : 0) +
    (t.scale_quantity_mentions > 0 ? 1 : 0) + (t.diagnostic_causal_markers > 0 ? 1 : 0);
  const systemBonus = wordCount >= 12 && sysCount >= 4 ? 0.10
    : wordCount >= 10 && sysCount >= 3 ? 0.05 : 0;

  const score = lengthScore + structScore + archScore + techScore + codeScore +
    reasonScore + decompositionScore + scaleScore + diagnosticScore +
    domainScore + compoundScore + systemBonus;

  return Math.min(Math.max(score, 0), 1);
}

function calcSystemBonus(wc: number, f: FeatureVector): number {
  const sysCount = f.has_architecture + f.technical_design +
    (f.technical_terms > 3 ? 1 : 0) + (f.requirement_count >= 3 ? 1 : 0) +
    (f.scale_quantity_mentions > 0 ? 1 : 0) + (f.diagnostic_causal_markers > 0 ? 1 : 0);
  if (wc >= 15 && sysCount >= 5) return 0.35;
  if (wc >= 15 && sysCount >= 4) return 0.25;
  if (wc >= 12 && sysCount >= 3) return 0.15;
  if (wc >= 10 && sysCount >= 3) return 0.10;
  if (wc >= 10 && sysCount >= 2) return 0.05;
  if (sysCount >= 2) return 0.03;
  return 0;
}
