import { describe, it, expect } from 'vitest';
import { heuristicScore, v33Score } from '../src/intent-engine.js';
import { extractFeatures, heuristicScoreFromFeatures } from '../src/feature-extractor-v04.js';

describe('IntentEngine (heuristic)', () => {
  it('scores simple greetings as low complexity', () => {
    const score = heuristicScore('Hello!');
    expect(score).toBeLessThan(0.3);
  });

  it('scores factual questions as low-moderate', () => {
    const score = heuristicScore('What is the capital of France?');
    expect(score).toBeLessThan(0.5);
  });

  it('scores code generation as high complexity', () => {
    const score = heuristicScore('Write a Python function that implements quicksort with type hints and tests');
    // Unified scorer (v0.5.8): browser path now shares the server formula.
    // Assert the score lands at or above the heavy band (0.32) rather than a
    // magic number from the retired 9-signal formula.
    expect(score).toBeGreaterThan(0.32);
  });

  it('scores multi-part prompts as higher complexity', () => {
    const simple = heuristicScore('Hello');
    const complex = heuristicScore('Write a FastAPI microservice with auth, then deploy it to AWS, and also write integration tests');
    expect(complex).toBeGreaterThan(simple);
  });

  it('detects code patterns', () => {
    const score = heuristicScore('function add(a, b) { return a + b; }');
    expect(score).toBeGreaterThan(0.2);
  });

  it('returns scores between 0 and 1', () => {
    const scores = [
      'Hi',
      '',
      'a',
      'Write a novel about AI and robots and humans and society and then analyze it',
      '```python\nimport os\nos.system("ls")\n```',
    ].map(heuristicScore);

    scores.forEach((s) => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    });
  });

  it('longer prompts score higher (up to limit)', () => {
    const short = heuristicScore('Hello world');
    const long = heuristicScore('Analyze the following text and provide a comprehensive summary. Consider the main themes, supporting arguments, rhetorical devices, and overall effectiveness of the piece. Additionally, suggest improvements and highlight the strongest paragraphs.');
    expect(long).toBeGreaterThan(short);
  });

  it('v33Score delegates to the canonical v0.4 heuristic scorer', () => {
    const prompt = 'Write a FastAPI microservice with auth, retries, and deployment notes';
    const features = extractFeatures(prompt);
    const wordCount = prompt.split(/\s+/).filter(Boolean).length;
    const expected = heuristicScoreFromFeatures(features, wordCount);
    const result = v33Score(prompt);
    expect(result.score).toBeCloseTo(expected, 8);
  });
});
