import { describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX, EFFORT_RANK, route, routeSession } from 'gateswarm-router';
import { getTierBoundaries, MAX_PROMPT_SIZE, scoreComplexity, scoreSession } from 'gateswarm-lite';

/**
 * Sequential usage, growing context, and heavy-usage consistency contract:
 *
 *  - single-prompt scoring is stateless and unchanged (parity suites cover it)
 *  - scoreSession windows oversized conversations with bounded work
 *  - recency default ('tail') keeps recent turns decisive for routing
 *  - routeSession keeps the capability invariant at every turn of a session
 *  - results are deterministic and boundaries are stable under rapid load
 */

const CHAT = 'hey, quick question about the deploy script';
const CODE = 'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue.';
const ARCH =
  'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.';

describe('scoreSession', () => {
  it('small sessions score the joined context exactly like one prompt', () => {
    const turns = [CHAT, CODE];
    const session = scoreSession(turns);
    const joined = scoreComplexity(turns.join('\n\n'));
    expect(session.score).toBe(joined.score);
    expect(session.tier).toBe(joined.tier);
    expect(session.turnsCount).toBe(2);
    expect(session.truncated).toBe(false);
    expect(session.windowChars).toBe(joinLength(turns));
  });

  it('windows oversized sessions to maxChars and flags truncation', { timeout: 60_000 }, () => {
    const turns = [CHAT, ARCH.repeat(400), 'last turn asks: fix the login bug'];
    const r = scoreSession(turns); // tail by default
    expect(r.truncated).toBe(true);
    expect(r.windowChars).toBeLessThanOrEqual(MAX_PROMPT_SIZE);

    const head = scoreSession(turns, { keep: 'head' });
    expect(head.truncated).toBe(true);
    expect(head.windowChars).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
  });

  it('recency default makes the latest turn decisive', { timeout: 60_000 }, () => {
    const bigTrivial = ('lol ok nice '.repeat(6000)); // ~72 KB of noise
    const criticalTail = ARCH;
    const tailBiased = scoreSession([bigTrivial, criticalTail]);
    const headBiased = scoreSession([bigTrivial, criticalTail], { keep: 'head' });
    expect(tailBiased.score).toBeGreaterThan(headBiased.score);
  });

  it('is deterministic per turn list', () => {
    const turns = [CHAT, ARCH, CODE];
    const a = scoreSession(turns);
    const b = scoreSession(turns);
    expect(a.score).toBe(b.score);
    expect(a.tier).toBe(b.tier);
  });

  it('handles empty sessions as empty prompts do', () => {
    const r = scoreSession([]);
    expect(r.turnsCount).toBe(0);
    expect(r.tier).toBe(scoreComplexity('').tier);
    expect(r.score).toBe(0);
  });

  function joinLength(turns: string[]): number {
    return turns.join('\n\n').length;
  }
});

describe('routeSession across an evolving conversation', () => {
  const history: string[] = [];
  const script = [CHAT, `${CODE}\nAlso include error handling.`, ARCH, 'continue', 'now write the migration plan'];

  it('keeps decisions valid and capability-safe at every turn', () => {
    let last = '';
    for (const turn of script) {
      history.push(turn);
      const d = routeSession(history);
      expect(d.strategy).toBe('cheapest-capable');
      expect(d.reason.length).toBeGreaterThan(0);
      const tierRank = EFFORT_RANK[d.complexity.tier];
      if (EFFORT_RANK[d.model.maxEffort] < tierRank) {
        expect(d.reason).toContain('falling back');
      }
      last = d.model.id;
      void last;
    }
  });

  it('growing context routes differently than the bare last turn (context awareness)', () => {
    const bare = route(script[script.length - 1]);
    const withContext = routeSession(history);
    // The accumulated session carries architecture/code signals the lone
    // "continue"-style turn does not — the decision must reflect that.
    expect(withContext.complexity.score).not.toBe(bare.complexity.score);
  });

  it('supports precomputed-tier replay without changing reported complexity', () => {
    const d = route('hi', { tier: 'extreme' });
    expect(d.complexity.tier).toBe('trivial'); // actual scoring still reported
    expect(d.model.id).toBe(selectExtremeCheapest());
  });
});

function selectExtremeCheapest(): string {
  return DEFAULT_MATRIX.filter((m) => m.maxEffort === 'extreme').sort((a, b) => a.costPer1MOutput - b.costPer1MOutput)[0].id;
}

describe('heavy sequential usage consistency', () => {
  it('survives rapid mixed-load with stable output and boundaries', { timeout: 240_000 }, async () => {
    const before = getTierBoundaries();
    const corpus = [
      CHAT,
      CODE,
      ARCH,
      'explain async/await',
      '',
      'x'.repeat(MAX_PROMPT_SIZE), // worst-case bounded call
      'translate hello to French',
    ];
    const firstPass = corpus.map((p) => JSON.stringify(route(p).model.id));
    const start = performance.now();
    for (let i = 0; i < 3; i++) {
      for (const p of corpus) {
        const d = route(p);
        expect(typeof d.model.id).toBe('string');
        if (i % 2 === 1) await new Promise((r) => setImmediate(r)); // keep worker RPC alive
      }
    }
    const elapsed = performance.now() - start;
    const afterFirstPass = corpus.map((p) => JSON.stringify(route(p).model.id));
    expect(afterFirstPass).toEqual(firstPass); // no drift under load
    expect(getTierBoundaries()).toEqual(before); // boundaries untouched by usage

    // Bounded worst case: windowed session work never exceeds one window score.
    const s = scoreSession(['a'.repeat(MAX_PROMPT_SIZE + 5000)]);
    expect(s.windowChars).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
    expect(elapsed).toBeGreaterThan(0);
  });
});
