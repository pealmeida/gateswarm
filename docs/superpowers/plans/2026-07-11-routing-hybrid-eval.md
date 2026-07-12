# Routing Hybrid Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a hybrid routing eval (offline 90 + ablation + 30 live spot-checks + final agent verdict) that proves or falsifies best-decision quality across all six tiers.

**Architecture:** One orchestrator script (`eval/hybrid-routing-eval.ts`) hits live `/v1/score` and `/v1/chat/completions`, ablates ensemble signals in-process, writes JSON + `summary.md` under `eval/reports/`, then a final evaluator pass writes `verdict.md`.

**Tech Stack:** TypeScript (tsx), existing `eval/lib/{dataset,metrics}.ts`, GateSwarm gateway on `:8900`, Vitest for unit helpers, `zai/glm-4.7-flash` as LLM judge.

**Spec:** `docs/superpowers/specs/2026-07-11-routing-hybrid-eval-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `eval/lib/hybrid-sample.ts` | Seeded stratified 5-per-tier sampler |
| `eval/lib/hybrid-http.ts` | HTTP helpers for `/v1/score`, chat, judge |
| `eval/lib/hybrid-rubric.ts` | Rubric hard-fail checks |
| `eval/lib/hybrid-ablation.ts` | In-process ensemble ablation modes |
| `eval/hybrid-routing-eval.ts` | CLI orchestrator Phases 1–3 + `summary.md` |
| `eval/reports/` | Runtime artifacts (gitignored) |
| `package.json` | `eval:hybrid` (+ wire assess/calibrate/gate) |
| `.gitignore` | Ignore `eval/reports/` |
| `docs/superpowers/specs/2026-07-11-routing-hybrid-eval-design.md` | Approved design (already written) |

---

### Task 1: Gitignore reports + npm scripts

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Ignore eval reports**

Append to `.gitignore`:

```
# Hybrid / calibration eval reports (regenerated)
eval/reports/
```

- [ ] **Step 2: Add npm scripts**

In `package.json` `scripts`, add next to existing `eval:*` entries:

```json
"eval:hybrid": "tsx eval/hybrid-routing-eval.ts",
"eval:assess": "tsx eval/assess.ts",
"eval:calibrate": "tsx eval/calibrate.ts",
"eval:gate": "tsx eval/calibration-gate.ts"
```

- [ ] **Step 3: Commit (only if user asked)**

Skip unless user explicitly requests a commit.

---

### Task 2: Stratified sampler helper

**Files:**
- Create: `eval/lib/hybrid-sample.ts`
- Test: `tests/hybrid-sample.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { loadEffort } from '../eval/lib/dataset.js';
import { samplePerTier } from '../eval/lib/hybrid-sample.js';

describe('samplePerTier', () => {
  it('returns exactly 5 prompts per tier with seed 42, deterministic', () => {
    const all = loadEffort();
    const a = samplePerTier(all, 5, 42);
    const b = samplePerTier(all, 5, 42);
    expect(a).toHaveLength(30);
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id));
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    for (const t of tiers) {
      expect(a.filter((x) => x.tier === t)).toHaveLength(5);
    }
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
cd /root/.openclaw/workspace/gateswarm-moma-router
npx vitest run tests/hybrid-sample.test.ts
```

Expected: FAIL cannot find module / `samplePerTier` undefined.

- [ ] **Step 3: Implement sampler**

```ts
// eval/lib/hybrid-sample.ts
import type { EffortExample } from './dataset.js';
import { TIERS } from './dataset.js';

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Stratified sample: `n` examples per effort tier, deterministic for seed. */
export function samplePerTier(all: EffortExample[], n: number, seed: number): EffortExample[] {
  const rand = mulberry32(seed);
  const out: EffortExample[] = [];
  for (const tier of TIERS) {
    const pool = shuffle(all.filter((e) => e.tier === tier), rand);
    if (pool.length < n) {
      throw new Error(`tier ${tier} has only ${pool.length} prompts; need ${n}`);
    }
    out.push(...pool.slice(0, n));
  }
  return out;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/hybrid-sample.test.ts
```

Expected: 1 passed.

---

### Task 3: HTTP + rubric helpers

**Files:**
- Create: `eval/lib/hybrid-http.ts`
- Create: `eval/lib/hybrid-rubric.ts`
- Test: `tests/hybrid-rubric.test.ts`

- [ ] **Step 1: Write rubric tests**

```ts
import { describe, it, expect } from 'vitest';
import { rubricHardFail } from '../eval/lib/hybrid-rubric.js';

describe('rubricHardFail', () => {
  it('fails on non-200', () => {
    expect(rubricHardFail({ status: 500, content: 'ok', reasoning: '' }).fail).toBe(true);
  });
  it('fails on empty content+reasoning', () => {
    expect(rubricHardFail({ status: 200, content: '', reasoning: '' }).fail).toBe(true);
  });
  it('passes on content present', () => {
    expect(rubricHardFail({ status: 200, content: '4', reasoning: '' }).fail).toBe(false);
  });
  it('passes when only reasoning present', () => {
    expect(rubricHardFail({ status: 200, content: '', reasoning: 'answer is 4' }).fail).toBe(false);
  });
});
```

- [ ] **Step 2: Implement rubric**

```ts
// eval/lib/hybrid-rubric.ts
export interface RubricInput {
  status: number;
  content: string;
  reasoning: string;
  timedOut?: boolean;
}

export function rubricHardFail(input: RubricInput): { fail: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.timedOut) reasons.push('timeout');
  if (input.status !== 200) reasons.push(`http_${input.status}`);
  const text = `${input.content || ''}${input.reasoning || ''}`.trim();
  if (!text) reasons.push('empty_body');
  const refusal = /i can'?t help with|i'?m unable to assist|against my guidelines/i.test(text);
  if (refusal) reasons.push('refusal');
  return { fail: reasons.length > 0, reasons };
}
```

- [ ] **Step 3: Implement HTTP helpers**

```ts
// eval/lib/hybrid-http.ts
import http from 'node:http';

export interface ScoreResp {
  score: number;
  tier: string;
  confidence: number;
  selected?: { model: string; provider: string };
  latencyMs?: number;
}

function requestJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer moma-default',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(data); } catch { json = { raw: data }; }
          resolve({ status: res.statusCode || 0, headers: res.headers, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(Object.assign(new Error('timeout'), { timedOut: true }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function postScore(port: number, prompt: string): Promise<ScoreResp> {
  const t0 = Date.now();
  const { status, json } = await requestJson(port, '/v1/score', { prompt }, {}, 30_000);
  if (status !== 200) throw new Error(`/v1/score HTTP ${status}: ${JSON.stringify(json)}`);
  return { ...json, latencyMs: Date.now() - t0 };
}

export async function postChatAuto(
  port: number,
  prompt: string,
  maxTokens: number,
): Promise<{ status: number; headers: Record<string, string>; content: string; reasoning: string; raw: any }> {
  try {
    const { status, headers, json } = await requestJson(port, '/v1/chat/completions', {
      model: 'auto',
      stream: false,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const msg = json?.choices?.[0]?.message || {};
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') flat[k.toLowerCase()] = v;
      else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(',');
    }
    return {
      status,
      headers: flat,
      content: msg.content || '',
      reasoning: msg.reasoning_content || msg.reasoning || '',
      raw: json,
    };
  } catch (e: any) {
    if (e?.timedOut) return { status: 0, headers: {}, content: '', reasoning: '', raw: { error: 'timeout' } };
    throw e;
  }
}

export async function judgeAdequacy(
  port: number,
  prompt: string,
  answer: string,
  goldTier: string,
): Promise<{ adequacy: number; on_tier: boolean; reason: string; available: boolean }> {
  const judgePrompt =
    `You are a strict grading JSON API. Score the assistant answer for the user prompt.\n` +
    `Gold effort tier (expected sophistication): ${goldTier}\n` +
    `Return ONLY JSON: {"adequacy":1-5,"on_tier":true|false,"reason":"<=200 chars"}\n\n` +
    `USER PROMPT:\n${prompt}\n\nASSISTANT ANSWER:\n${answer.slice(0, 4000)}`;
  const { status, json } = await requestJson(port, '/v1/chat/completions', {
    model: 'zai/glm-4.7-flash',
    stream: false,
    max_tokens: 200,
    messages: [{ role: 'user', content: judgePrompt }],
  }, {}, 60_000);
  if (status !== 200) return { adequacy: 0, on_tier: false, reason: `judge_http_${status}`, available: false };
  const text = json?.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { adequacy: 0, on_tier: false, reason: 'judge_parse_fail', available: false };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      adequacy: Number(parsed.adequacy) || 0,
      on_tier: Boolean(parsed.on_tier),
      reason: String(parsed.reason || '').slice(0, 200),
      available: true,
    };
  } catch {
    return { adequacy: 0, on_tier: false, reason: 'judge_json_fail', available: false };
  }
}

export async function healthOrThrow(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
      res.resume();
      if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) resolve();
      else reject(new Error(`health HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('health timeout')); });
    req.end();
  });
}
```

- [ ] **Step 4: Run rubric tests**

```bash
npx vitest run tests/hybrid-rubric.test.ts
```

Expected: PASS.

---

### Task 4: Ablation helper

**Files:**
- Create: `eval/lib/hybrid-ablation.ts`

- [ ] **Step 1: Implement four modes using production scoring primitives**

```ts
// eval/lib/hybrid-ablation.ts
import { extractFeatures, heuristicScoreFromFeatures } from '../../src/feature-extractor-v04.js';
import { ensembleVote, setEnsembleWeights } from '../../src/ensemble-voter.js';
import { scoreToEffort } from '../../src/intent-engine.js';
import type { EffortLevel } from '../../src/types.js';
import type { EffortExample } from './dataset.js';
import { effortMetrics } from './metrics.js';

export type AblationMode = 'heuristic' | 'heuristic+rag' | 'heuristic+history' | 'full';

export function scoreAblation(prompt: string, mode: AblationMode): { score: number; tier: EffortLevel } {
  const features = extractFeatures(prompt);
  const heuristic = heuristicScoreFromFeatures(features);

  if (mode === 'heuristic') {
    // Force voter to ignore rag/history by omitting them and zeroing history path
    const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
    // Prefer raw heuristic tier for pure mode:
    return { score: heuristic, tier: scoreToEffort(heuristic) };
  }

  if (mode === 'heuristic+rag') {
    const vote = ensembleVote({
      prompt,
      heuristicScore: heuristic,
      ragSignal: undefined, // cold eval: no RAG hits forced; document as no-op unless store warm
      enableCascade: false,
    });
    // Use vote without history: recompute from vote.rawScore if exported
    return { score: vote.rawScore, tier: scoreToEffort(vote.rawScore) };
  }

  if (mode === 'heuristic+history') {
    const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
    return { score: vote.finalScore, tier: vote.tier };
  }

  // full
  const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
  return { score: vote.finalScore, tier: vote.tier };
}

export function runAblation(examples: EffortExample[]): Record<AblationMode, ReturnType<typeof effortMetrics>> {
  const modes: AblationMode[] = ['heuristic', 'heuristic+rag', 'heuristic+history', 'full'];
  const out = {} as Record<AblationMode, ReturnType<typeof effortMetrics>>;
  for (const mode of modes) {
    const rows = examples.map((e) => {
      const r = scoreAblation(e.prompt, mode);
      return { expected: e.tier, predicted: r.tier };
    });
    out[mode] = effortMetrics(rows);
  }
  return out;
}
```

Note: On a cold RAG/feedback store, `heuristic+rag` and `heuristic+history` may collapse toward heuristic — `summary.md` must state cold-store caveat explicitly (spec risk table).

---

### Task 5: Orchestrator `eval/hybrid-routing-eval.ts`

**Files:**
- Create: `eval/hybrid-routing-eval.ts`

- [ ] **Step 1: Implement CLI**

Behavior:

1. Parse `--port` (8900), `--seed` (42), `--out` (default `eval/reports/routing-hybrid-<YYYYMMDD-HHMM>`).
2. `healthOrThrow(port)` — on failure `process.exit(2)`.
3. `mkdirSync(out, { recursive: true })`.
4. Phase 1: score all `loadEffort()` via `postScore`; write `scores.json`; compute `effortMetrics` + critical probes.
5. Phase 2: `runAblation(all)`; write `ablation.json`.
6. Phase 3: `samplePerTier(all, 5, seed)`; for each:
   - `maxTokens` map: trivial 256, light 512, moderate 1024, heavy 2048, intensive 4096, extreme 4096
   - `postChatAuto` → rubric → judge (answer = content || reasoning)
   - 500ms delay between calls; on 429 sleep 5s and retry once
   - Soft policy: if `goldTier` in `{trivial,light}` and routed provider not in `{opencode-free,zai}`, set `policyViolation: true`
7. Write `live.json`.
8. Write `summary.md` with floors vs actual, confusion matrix, ablation table, live means, list of worst misroutes (|Δtier|≥2).
9. Exit 0 if offline floors met AND live rubric ≥25/30; else exit 1. (Judge floors reported but do not alone force exit 1 if judge unavailable >20% — then print `JUDGE_DEGRADED` and exit 0 only if offline+rubric ok; Phase 4 still decides INCONCLUSIVE.)

Critical probes (Phase 1 extras):

```ts
const CRITICAL = [
  { prompt: 'Explain async/await', minTier: 'light' },
  { prompt: 'hi', expect: 'trivial' },
  { prompt: 'hey, good morning', expect: 'trivial' },
];
```

- [ ] **Step 2: Smoke-run help path**

```bash
npx tsx eval/hybrid-routing-eval.ts --help || true
# then full run when gateway up:
systemctl is-active moa-gateway
npm run eval:hybrid -- --port 8900 --seed 42
```

Expected: creates `eval/reports/routing-hybrid-*/{scores,ablation,live,summary}.md` and prints pass/fail floors.

---

### Task 6: Execute hybrid run + final verdict

**Files:**
- Create (runtime): `eval/reports/routing-hybrid-<ts>/verdict.md`

- [ ] **Step 1: Ensure gateway + providers healthy**

```bash
systemctl is-active moa-gateway
gateswarm health
gateswarm models
```

- [ ] **Step 2: Run hybrid eval**

```bash
cd /root/.openclaw/workspace/gateswarm-moma-router
npm run eval:hybrid -- --port 8900 --seed 42
```

- [ ] **Step 3: Final evaluator (agent) writes verdict.md**

Read `summary.md`, `scores.json`, `ablation.json`, `live.json`. Write:

```md
# Verdict

VERIFIED | NOT VERIFIED | INCONCLUSIVE

## Per-tier
| Tier | Offline recall | Live rubric | Live judge | Status |
...

## Evidence
...

## Recommendations
...
```

Use floors from the design spec. Do not claim VERIFIED without meeting floors or without reading live transcripts for WEAK tiers.

---

### Task 7: Spec coverage self-check

- [ ] Confirm design Phase 1–4 each have a task (1–6 cover them).
- [ ] Confirm no TBD/placeholder left in this plan.
- [ ] Confirm `glm-4.7-flash` judge and free-only soft policy for trivial/light are encoded in Task 5.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-routing-hybrid-eval.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — run tasks in this session with checkpoints  

Which approach?
