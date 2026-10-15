import { describe, expect, it } from 'vitest';
import { aggregateVerdicts, chunkUnifiedDiff, pickR1Model } from '../src/r1-diff-chunker.js';

describe('R1 diff chunking', () => {
  it('packs complete file diffs without exceeding the configured size', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ].join('');
    const chunks = chunkUnifiedDiff(diff, 100);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks[0]).toContain('a/a.ts');
    expect(chunks[1]).toContain('a/b.ts');
  });

  it('splits an oversize file on hunks and repeats its header', () => {
    const header = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n';
    const first = '@@ -1 +1 @@\n-old\n+first replacement\n';
    const second = '@@ -10 +10 @@\n-old\n+second replacement\n';
    const chunks = chunkUnifiedDiff(header + first + second, header.length + second.length + 1);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.startsWith(header))).toBe(true);
    expect(chunks[0]).toContain(first);
    expect(chunks[1]).toContain(second);
  });

  it('hard-splits an oversize hunk as a final fallback', () => {
    const chunks = chunkUnifiedDiff('diff --git a/a b/a\n@@ -1 +1 @@\n+' + 'x'.repeat(100), 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
  });

  it('aggregates review results and degrades after the budget', () => {
    expect(aggregateVerdicts([
      { approved: true, notes: 'looks good' },
      { approved: false, notes: 'missing test' },
    ])).toEqual({ approved: false, notes: 'looks good\nmissing test' });
    expect(pickR1Model('primary', 'fallback', 99, 100)).toEqual({ model: 'primary', degraded: false });
    expect(pickR1Model('primary', 'fallback', 100, 100)).toEqual({ model: 'fallback', degraded: true });
  });
});
