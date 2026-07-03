/**
 * v0.5.2 regression tests for plan/act routing correctness:
 *   - plan mode resolves to a dispatchable {provider, model} target per tier
 *   - mode detection improvements (act recall, plan inflections, no substring FPs)
 *   - ensemble no longer force-escalates (over-routing fix)
 *   - every routing-config model maps to a configured provider catalog entry
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadConfig, getTierModelForMode, getTierModel, detectIntentMode } from '../src/v04-config.js';
import { ensembleVote, scoreToEffort } from '../src/ensemble-voter.js';
import { runConsistencyCheck } from '../eval/consistency-check.js';
import type { EffortLevel } from '../src/types.js';

describe('plan-mode dispatch target resolution (gateway contract)', () => {
  beforeAll(() => loadConfig());
  const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

  it('every tier with a plan_model yields a non-empty {provider, model} in plan mode', () => {
    for (const tier of tiers) {
      const raw = getTierModel(tier);
      if (!raw?.plan_model) continue;
      const cfg = getTierModelForMode(tier, 'plan')!;
      expect(cfg.provider, `${tier} plan provider`).toBeTruthy();
      expect(cfg.model, `${tier} plan model`).toBeTruthy();
    }
  });

  it('plan targets are dispatchable: CLI plan models keep their provider prefix, HTTP plan models are bare', () => {
    // The dispatch contract, independent of which provider each tier currently
    // points at: CLI providers resolve models via prefix notation (cc/, cx/, …)
    // so the prefix must be preserved; HTTP providers receive the bare model id.
    const CLI_PREFIX: Record<string, string> = {
      'claude-cli': 'cc/', 'codex-cli': 'cx/', 'pi-agent': 'pi/',
      'hermes-agent': 'hm/', 'openclaw-agent': 'oc/',
    };
    for (const tier of tiers) {
      if (!getTierModel(tier)?.plan_model) continue;
      const cfg = getTierModelForMode(tier, 'plan')!;
      const prefix = CLI_PREFIX[cfg.provider];
      if (prefix) {
        expect(cfg.model.startsWith(prefix),
          `${tier} plan model "${cfg.model}" must carry the ${prefix} prefix for ${cfg.provider}`).toBe(true);
      } else {
        expect(cfg.model.includes('/'),
          `${tier} plan model "${cfg.model}" must be a bare model id for HTTP provider ${cfg.provider}`).toBe(false);
      }
    }
  });

  it('act mode never returns a plan_* model (keeps the tier default)', () => {
    for (const tier of tiers) {
      const act = getTierModelForMode(tier, 'act')!;
      const def = getTierModel(tier)!;
      expect(act.model).toBe(def.model);
      expect(act.provider).toBe(def.provider);
    }
  });
});

describe('mode detection v0.5.2 — act recall + plan inflections + no substring FPs', () => {
  const act = [
    'Spin up a new Redis cache instance and point the session store at it',
    'Replace all the inline styles in the header component with Tailwind classes',
    "Users on Safari can't upload images, the file picker just closes silently",
    'checkout page is blank on mobile, console says Maximum call stack size exceeded',
    "Cart total shows $0 when there's exactly one item but works fine with two",
    'our nightly cron job stopped firing after the last release',
  ];
  for (const p of act) {
    it(`act: ${p.slice(0, 40)}…`, () => expect(detectIntentMode(p).mode).toBe('act'));
  }

  const plan = [
    "I'm weighing whether to build our own feature flag system or pay for LaunchDarkly",
    'Considering how to split this 4000-line component, where would the natural break be',
    'Before I write any code, I want to map out the data model',
  ];
  for (const p of plan) {
    it(`plan: ${p.slice(0, 40)}…`, () => expect(detectIntentMode(p).mode).toBe('plan'));
  }

  it('does not score "explanation" or "codebase" as keyword hits (substring FP guard)', () => {
    const r = detectIntentMode('give me an explanation of the codebase');
    expect(r.planScore).toBe(0);
    expect(r.actScore).toBe(0);
    expect(r.mode).toBe('auto');
  });
});

describe('ensemble voter — no force-escalation (over-routing fix)', () => {
  it('tier always equals scoreToEffort(finalScore); escalated is always false', () => {
    for (const h of [0.05, 0.19, 0.25, 0.30, 0.345, 0.40, 0.55, 0.8]) {
      const v = ensembleVote({ prompt: 'x', heuristicScore: h });
      expect(v.escalated).toBe(false);
      expect(v.tier).toBe(scoreToEffort(v.finalScore));
    }
  });
});

describe('provider/model consistency — all routing models exist in a provider catalog', () => {
  it('v04_config tier_models + agent tierConfigs all resolve to a catalog entry', () => {
    const { errors } = runConsistencyCheck();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
