# GateSwarm Lite + Advisory Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the heuristic complexity scorer into a zero-dependency `gateswarm-lite` package and build an advisory `gateswarm-router` package that picks the best cost/benefit model for the scored tier — while the existing gateway, tests, and eval pipeline keep working unchanged.

**Architecture:** npm workspaces inside the existing repo. `packages/gateswarm-lite` receives the verbatim-moved scorer core (`feature-extractor-v04.ts`, `tier-boundaries.ts`) plus a `scoreComplexity()` facade; old `src/` paths become **named** re-export shims (not `export *`) so no consumer changes and legacy module surfaces stay clean. `packages/gateswarm-router` depends only on `gateswarm-lite` and returns routing *decisions* (never executes requests). Spec: `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-design.md`. Testing/refinement: `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-testing.md`.

**Tech Stack:** TypeScript 5.7 (ES2022 modules), npm workspaces, vitest, tsx. Zero runtime dependencies in both new packages.

## Global Constraints

- Node >= 20.0.0 (matches root `engines`).
- `gateswarm-lite` has **zero** runtime dependencies; `gateswarm-router` depends **only** on `gateswarm-lite`.
- Scorer logic is moved **verbatim** — no behavior change. Parity with `scoreIntentSync` is enforced by test.
- Root package renames `gateswarm-router` → `gateswarm-gateway`; new layer-2 package takes the name `gateswarm-router` at version `0.1.0`.
- Prompt truncation guard: 64 KiB (`64 * 1024` chars), same as `src/intent-engine-v04.ts`.
- All commands below run from repo root `d:\Code\gateswarm-router` (PowerShell).
- Imports always at top of file; switch statements over unions use a `never`-checked default.
- Shims use named re-exports only. `packages/gateswarm-lite/src/index.ts` must not import Node APIs.
- Library latency uses `performance.now()`. CLIs fail immediately when there is no argv prompt and `process.stdin.isTTY` is true.

---

### Task 1: Workspace scaffolding (no file moves yet)

**Files:**
- Create: `packages/gateswarm-lite/package.json`
- Create: `packages/gateswarm-lite/tsconfig.json`
- Create: `packages/gateswarm-lite/src/index.ts` (placeholder, replaced in Task 2)
- Modify: `package.json` (root)
- Modify: `tsconfig.json` (root, lines 17-20: `baseUrl`/`paths`)
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace resolution — `import ... from 'gateswarm-lite'` works in `tsc --noEmit`, `tsx`, and `vitest`. Later tasks rely on the `gateswarm-lite` and `gateswarm-router` path/alias mappings created here.

- [x] **Step 1: Create the lite package manifest**

Create `packages/gateswarm-lite/package.json`:

```json
{
  "name": "gateswarm-lite",
  "version": "0.1.0",
  "description": "Zero-dependency prompt complexity scorer (GateSwarm layer 1). Scores a prompt 0-1 and maps it to one of 6 effort tiers.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "bin": {
    "gateswarm-lite": "./dist/cli.js"
  },
  "files": [
    "dist/"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "keywords": ["complexity-scoring", "prompt-routing", "llm-router", "zero-dependency"],
  "license": "MIT",
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [x] **Step 2: Create the lite package tsconfig**

Create `packages/gateswarm-lite/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [x] **Step 3: Create a placeholder index**

Create `packages/gateswarm-lite/src/index.ts` (replaced with the real API in Task 2):

```typescript
export const GATESWARM_LITE_VERSION = '0.1.0';
```

- [x] **Step 4: Update the root package.json**

In root `package.json` apply exactly these changes:

1. Line 2: `"name": "gateswarm-router"` → `"name": "gateswarm-gateway"`
2. After the `"type": "module"` line, add:

```json
  "workspaces": [
    "packages/*"
  ],
```

3. In `"dependencies"`, add `"gateswarm-lite": "0.1.0"` (alphabetical order):

```json
  "dependencies": {
    "dotenv": "^17.4.2",
    "gateswarm-lite": "0.1.0",
    "idb-keyval": "^6.2.1",
    "tiktoken": "^1.0.22"
  },
```

4. Replace the `"build"` script so workspaces build before the gateway:

```json
    "build": "npm run build --workspaces --if-present && tsc -p tsconfig.build.json && node scripts/copy-build-assets.mjs",
```

- [x] **Step 5: Add source-level path mappings to root tsconfig.json**

Replace the existing `"paths"` block (root `tsconfig.json`, lines 18-20):

```json
    "paths": {
      "@/*": ["src/*"],
      "gateswarm-lite": ["packages/gateswarm-lite/src/index.ts"],
      "gateswarm-router": ["packages/gateswarm-router/src/index.ts"]
    }
```

And extend `"include"` so `npm run typecheck` covers package sources:

```json
  "include": ["src/**/*.ts", "tests/**/*.ts", "packages/*/src/**/*.ts"],
```

- [x] **Step 6: Add vitest/vite aliases**

Replace `vite.config.ts` entirely with:

```typescript
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      'gateswarm-lite': fileURLToPath(new URL('./packages/gateswarm-lite/src/index.ts', import.meta.url)),
      'gateswarm-router': fileURLToPath(new URL('./packages/gateswarm-router/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'public/index.html',
        dashboard: 'public/dashboard.html',
      },
    },
  },
  server: {
    port: 4174,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live-ollama.test.ts'],
  },
});
```

- [x] **Step 7: Install to create workspace links**

Run: `npm install`
Expected: succeeds; `node_modules/gateswarm-lite` exists as a link to `packages/gateswarm-lite`.

- [x] **Step 8: Verify nothing broke**

Run: `npm run typecheck` — Expected: exit 0.
Run: `npm test` — Expected: all existing tests PASS (same count as before this task).

- [x] **Step 9: Commit**

```powershell
git add packages/gateswarm-lite package.json package-lock.json tsconfig.json vite.config.ts
git commit -m "chore: scaffold npm workspaces and gateswarm-lite package skeleton"
```

---

### Task 2: Move the scorer core into gateswarm-lite (parity-locked)

**Files:**
- Create: `tests/lite-parity.test.ts`
- Create: `packages/gateswarm-lite/src/types.ts`
- Move: `src/feature-extractor-v04.ts` → `packages/gateswarm-lite/src/feature-extractor.ts`
- Move: `src/tier-boundaries.ts` → `packages/gateswarm-lite/src/tier-boundaries.ts`
- Create (shim): `src/feature-extractor-v04.ts`
- Create (shim): `src/tier-boundaries.ts`
- Modify: `packages/gateswarm-lite/src/index.ts` (replace placeholder)
- Modify: `src/types.ts:52` (EffortLevel becomes a re-export)

**Interfaces:**
- Consumes: workspace resolution from Task 1.
- Produces: `scoreComplexity(prompt: string): ComplexityResult` where `ComplexityResult = { score: number; tier: EffortLevel; wordCount: number; features: FeatureVector; latencyMs: number }`. Also re-exports (unchanged signatures): `extractFeatures(prompt: string): FeatureVector`, `heuristicScoreFromFeatures(features: FeatureVector, wordCount: number): number`, `countPromptWords(prompt: string): number`, `scoreToEffort(score: number): EffortLevel`, `setTierBoundaries(b: number[]): boolean`, `getTierBoundaries()`, `getEffortRanges()`, `EFFORT_RANGES`, `DEFAULT_BOUNDARIES`, `tierMidpoints()`, and types `EffortLevel`, `FeatureVector`. Tasks 3-5 import from `gateswarm-lite`.

- [x] **Step 1: Write the failing parity test**

Create `tests/lite-parity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { scoreComplexity } from 'gateswarm-lite';
import { scoreIntentSync } from '../src/intent-engine-v04.js';

const FIXTURES = [
  'hi',
  'What is the capital of France?',
  'Rewrite this sentence to be more formal: we gotta ship it asap',
  'Summarize the differences between TCP and UDP in one paragraph.',
  'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
  'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.',
  'Explain async/await',
  '',
];

describe('gateswarm-lite parity with gateway scorer', () => {
  it.each(FIXTURES)('score and tier match scoreIntentSync for: %s', (prompt) => {
    const lite = scoreComplexity(prompt);
    const gateway = scoreIntentSync(prompt);
    expect(lite.score).toBe(gateway.value);
    expect(lite.tier).toBe(gateway.tier);
  });

  it('returns well-formed results', () => {
    const r = scoreComplexity('Explain quicksort');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme']).toContain(r.tier);
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.features).toBeTypeOf('object');
  });

  it('truncates prompts above 64 KiB instead of failing', () => {
    const huge = 'analyze this system '.repeat(5000); // ~100 KB
    const r = scoreComplexity(huge);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lite-parity.test.ts`
Expected: FAIL — `gateswarm-lite` has no export named `scoreComplexity`.

- [x] **Step 3: Move the two core files with git mv (verbatim, history preserved)**

```powershell
git mv src/feature-extractor-v04.ts packages/gateswarm-lite/src/feature-extractor.ts
git mv src/tier-boundaries.ts packages/gateswarm-lite/src/tier-boundaries.ts
```

Do **not** edit the file contents. `feature-extractor.ts` has zero imports. `tier-boundaries.ts` line 1 (`import type { EffortLevel } from './types.js';`) now resolves to the lite-local types file created next.

- [x] **Step 4: Create the lite-local types module**

Create `packages/gateswarm-lite/src/types.ts`:

```typescript
export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';
```

- [x] **Step 5: Write the real lite index**

Replace `packages/gateswarm-lite/src/index.ts` with:

```typescript
/**
 * gateswarm-lite — zero-dependency prompt complexity scorer.
 *
 * Layer 1 of the GateSwarm split: scores a prompt 0-1 with the production
 * heuristic (35 features, hand-tuned weights) and maps it to one of six
 * effort tiers via calibrated cut points.
 */
import {
  countPromptWords,
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from './feature-extractor.js';
import { scoreToEffort } from './tier-boundaries.js';
import type { EffortLevel } from './types.js';

export * from './feature-extractor.js';
export * from './tier-boundaries.js';
export type { EffortLevel } from './types.js';

/** Prompts longer than this are truncated before scoring (same guard as the gateway). */
export const MAX_PROMPT_SIZE = 64 * 1024;

export interface ComplexityResult {
  /** Heuristic complexity score in [0, 1]. */
  score: number;
  /** Effort tier derived from the calibrated boundaries. */
  tier: EffortLevel;
  wordCount: number;
  features: FeatureVector;
  latencyMs: number;
}

export function scoreComplexity(prompt: string): ComplexityResult {
  const start = performance.now();
  const p = prompt.length > MAX_PROMPT_SIZE ? prompt.slice(0, MAX_PROMPT_SIZE) : prompt;
  const features = extractFeatures(p);
  const wordCount = countPromptWords(p);
  const score = heuristicScoreFromFeatures(features, wordCount);
  return {
    score,
    tier: scoreToEffort(score),
    wordCount,
    features,
    latencyMs: performance.now() - start,
  };
}
```

- [x] **Step 6: Create the re-export shims at the old paths**

Create `src/feature-extractor-v04.ts`:

```typescript
/**
 * Shim — implementation moved to packages/gateswarm-lite (2026-08-25).
 * Named re-exports only: do not `export *` (that would leak scoreComplexity
 * onto this legacy module surface).
 */
export {
  countPromptWords,
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from 'gateswarm-lite';
```

Create `src/tier-boundaries.ts`:

```typescript
/**
 * Shim — implementation moved to packages/gateswarm-lite (2026-08-25).
 * Re-exports the SAME module instance, so setTierBoundaries() calls from
 * retraining/hot-reload keep affecting every consumer.
 */
export {
  DEFAULT_BOUNDARIES,
  EFFORT_RANGES,
  getEffortRanges,
  getTierBoundaries,
  scoreToEffort,
  setTierBoundaries,
  tierMidpoints,
  type TierBoundaries,
} from 'gateswarm-lite';
```

- [x] **Step 7: Make src/types.ts source EffortLevel from the lite package**

In `src/types.ts`, add at the top (after the header comment):

```typescript
import type { EffortLevel } from 'gateswarm-lite';
```

and replace line 52 (`export type EffortLevel = 'trivial' | ...;`) with:

```typescript
export type { EffortLevel } from 'gateswarm-lite';
```

- [x] **Step 8: Run the parity test to verify it passes**

Run: `npx vitest run tests/lite-parity.test.ts`
Expected: PASS (all cases).

- [x] **Step 9: Run the full suite and typecheck**

Run: `npm test` — Expected: all tests PASS (existing feature-extractor/tier-boundaries tests exercise the shims).
Run: `npm run typecheck` — Expected: exit 0.
Run: `npm run check:consistency` — Expected: exit 0 (eval pipeline still resolves the scorer).

- [x] **Step 10: Commit**

```powershell
git add -A
git commit -m "refactor: extract scorer core into gateswarm-lite with parity-locked shims"
```

---

### Task 3: gateswarm-lite CLI and standalone build

**Files:**
- Create: `packages/gateswarm-lite/src/cli.ts`
- Create: `packages/gateswarm-lite/README.md`

**Interfaces:**
- Consumes: `scoreComplexity` from Task 2.
- Produces: `gateswarm-lite` bin — prints `ComplexityResult` JSON for a prompt from argv or stdin; exits 1 with `{"error": ...}` JSON on empty input.

- [x] **Step 1: Write the CLI**

Create `packages/gateswarm-lite/src/cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * gateswarm-lite CLI — score a prompt's complexity.
 * Usage:  gateswarm-lite "your prompt here"
 *         echo "your prompt" | gateswarm-lite
 */
import { scoreComplexity } from './index.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

const arg = process.argv.slice(2).join(' ').trim();
let prompt = arg;
if (!prompt) {
  if (process.stdin.isTTY) fail('empty prompt: pass it as an argument or via stdin');
  prompt = await readStdin();
}
if (!prompt) fail('empty prompt: pass it as an argument or via stdin');

console.log(JSON.stringify(scoreComplexity(prompt), null, 2));
```

- [ ] **Step 2: Build the package standalone**

Run: `npm run build -w gateswarm-lite`
Expected: exit 0; `packages/gateswarm-lite/dist/index.js`, `dist/cli.js`, and `.d.ts` files exist.

- [x] **Step 3: Smoke-test the built CLI**

Run: `node packages/gateswarm-lite/dist/cli.js "Refactor my authentication module to support OAuth2 and add integration tests"`
Expected: JSON with `score` (0-1), `tier` (one of the 6 levels), `wordCount`, `features`, `latencyMs`.

Run: `node packages/gateswarm-lite/dist/cli.js`
Expected: exit code 1 immediately (must not hang), stderr JSON `{"error":"empty prompt: pass it as an argument or via stdin"}` because stdin is a TTY. If the shell is non-TTY, pipe empty input instead: `"" | node packages/gateswarm-lite/dist/cli.js`.

- [x] **Step 4: Write the package README**

Create `packages/gateswarm-lite/README.md`:

```markdown
# gateswarm-lite

Zero-dependency prompt complexity scorer — layer 1 of the GateSwarm split.

Scores any prompt 0-1 using the GateSwarm production heuristic (35 regex/structural
features, hand-tuned weights) and maps it to one of six effort tiers
(`trivial | light | moderate | heavy | intensive | extreme`) via calibrated cut points.
Pure TypeScript. Runs in Node >= 20, browsers, and edge runtimes. No model downloads.

## Usage

```ts
import { scoreComplexity } from 'gateswarm-lite';

const r = scoreComplexity('Design a microservices architecture for real-time trading');
// { score: 0.52, tier: 'extreme', wordCount: 8, features: {...}, latencyMs: 0 }
```

CLI:

```sh
gateswarm-lite "Summarize this article in one paragraph"
echo "prompt" | gateswarm-lite
```

## Advanced

- `extractFeatures(prompt)` / `heuristicScoreFromFeatures(features, wordCount)` — building blocks.
- `scoreToEffort(score)` / `getEffortRanges()` — tier mapping.
- `setTierBoundaries([b0..b4])` — install retrained cut points (see the GateSwarm eval pipeline).

Tier cut points are calibrated by the GateSwarm eval pipeline (`eval:refit-boundaries`)
in the parent repo and frozen here as `DEFAULT_BOUNDARIES`.

Feed the resulting `tier` into `gateswarm-router` to pick the best cost/benefit model.
```

- [x] **Step 5: Commit**

```powershell
git add packages/gateswarm-lite
git commit -m "feat(lite): add scoreComplexity CLI and package README"
```

---

### Task 4: gateswarm-router package — types, default matrix, selectModel

**Files:**
- Create: `packages/gateswarm-router/package.json`
- Create: `packages/gateswarm-router/tsconfig.json`
- Create: `packages/gateswarm-router/src/types.ts`
- Create: `packages/gateswarm-router/src/matrix.ts`
- Create: `packages/gateswarm-router/src/select.ts`
- Test: `tests/router-select.test.ts`

**Interfaces:**
- Consumes: `EffortLevel`, `ComplexityResult` types from `gateswarm-lite` (Task 2).
- Produces:
  - `ModelSpec = { id: string; provider: string; maxEffort: EffortLevel; costPer1MInput: number; costPer1MOutput: number; quality: number; avgLatencyMs?: number; tags?: string[] }`
  - `RoutingStrategy = 'cheapest-capable' | 'best-value'`
  - `RouteOptions = { strategy?: RoutingStrategy; matrix?: ModelSpec[]; minQuality?: number }`
  - `selectModel(tier: EffortLevel, matrix: ModelSpec[], opts?: RouteOptions): { model: ModelSpec; alternatives: ModelSpec[]; reason: string }`
  - `blendedCost(m: ModelSpec): number`, `valueScore(m: ModelSpec): number`, `EFFORT_RANK: Record<EffortLevel, number>`, `DEFAULT_MATRIX: ModelSpec[]`
  - Task 5 builds `route()` on top of these exact names.

- [x] **Step 1: Create the router package manifest and tsconfig**

Create `packages/gateswarm-router/package.json`:

```json
{
  "name": "gateswarm-router",
  "version": "0.1.0",
  "description": "Advisory model router (GateSwarm layer 2). Scores prompt complexity via gateswarm-lite and returns the best cost/benefit model for the tier. Does not execute requests.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "bin": {
    "gateswarm-route": "./dist/cli.js"
  },
  "files": [
    "dist/"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "gateswarm-lite": "0.1.0"
  },
  "keywords": ["llm-router", "model-routing", "cost-optimization", "complexity-scoring"],
  "license": "MIT",
  "engines": {
    "node": ">=20.0.0"
  }
}
```

NOTE: if the npm name `gateswarm-router` was previously published as the gateway, publish this package starting at a version above the last published one (e.g. `0.7.0`) and call out the repurpose in the README. Locally `0.1.0` is fine.

Create `packages/gateswarm-router/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Then run: `npm install`
Expected: `node_modules/gateswarm-router` link appears.

- [x] **Step 2: Write the failing selection tests**

Create `tests/router-select.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ModelSpec } from 'gateswarm-router';
import { blendedCost, DEFAULT_MATRIX, EFFORT_RANK, selectModel, valueScore } from 'gateswarm-router';

const M = (over: Partial<ModelSpec>): ModelSpec => ({
  id: 'm',
  provider: 'p',
  maxEffort: 'moderate',
  costPer1MInput: 1,
  costPer1MOutput: 4,
  quality: 0.7,
  ...over,
});

const FIXTURE: ModelSpec[] = [
  M({ id: 'cheap-weak', maxEffort: 'light', costPer1MInput: 0.1, costPer1MOutput: 0.4, quality: 0.5 }),
  M({ id: 'mid', maxEffort: 'heavy', costPer1MInput: 0.5, costPer1MOutput: 2.0, quality: 0.75 }),
  M({ id: 'strong', maxEffort: 'extreme', costPer1MInput: 3.0, costPer1MOutput: 15.0, quality: 0.92 }),
  M({ id: 'premium', maxEffort: 'extreme', costPer1MInput: 15.0, costPer1MOutput: 75.0, quality: 0.97 }),
];

describe('selectModel', () => {
  it('throws on an empty matrix', () => {
    expect(() => selectModel('trivial', [])).toThrow('matrix is empty');
  });

  it('cheapest-capable picks the cheapest model rated for the tier', () => {
    const { model } = selectModel('light', FIXTURE);
    expect(model.id).toBe('cheap-weak');
  });

  it('excludes models below the required tier', () => {
    const { model } = selectModel('heavy', FIXTURE);
    expect(model.id).toBe('mid'); // cheap-weak is capped at light
  });

  it('breaks cost ties by higher quality', () => {
    const tied: ModelSpec[] = [
      M({ id: 'a', quality: 0.6 }),
      M({ id: 'b', quality: 0.9 }),
    ];
    const { model } = selectModel('moderate', tied);
    expect(model.id).toBe('b');
  });

  it('best-value maximizes quality per blended cost dollar', () => {
    const { model } = selectModel('extreme', FIXTURE, { strategy: 'best-value' });
    // strong: 0.92 / (1 + 12) ≈ 0.0708 · premium: 0.97 / (1 + 60) ≈ 0.0159
    expect(model.id).toBe('strong');
  });

  it('respects minQuality', () => {
    const { model } = selectModel('light', FIXTURE, { minQuality: 0.7 });
    expect(model.id).toBe('mid');
  });

  it('falls back to the most capable model when nothing is rated for the tier', () => {
    const weak: ModelSpec[] = [
      M({ id: 'only-light', maxEffort: 'light', quality: 0.5 }),
      M({ id: 'only-heavy', maxEffort: 'heavy', quality: 0.8 }),
    ];
    const { model, reason } = selectModel('extreme', weak);
    expect(model.id).toBe('only-heavy');
    expect(reason).toContain('falling back');
  });

  it('returns up to 3 ranked alternatives', () => {
    const { alternatives } = selectModel('trivial', FIXTURE);
    expect(alternatives.length).toBeLessThanOrEqual(3);
    expect(alternatives.map((m) => m.id)).not.toContain(selectModel('trivial', FIXTURE).model.id);
  });
});

describe('cost helpers', () => {
  it('blendedCost is output-weighted 25/75', () => {
    expect(blendedCost(M({ costPer1MInput: 4, costPer1MOutput: 8 }))).toBe(4 * 0.25 + 8 * 0.75);
  });

  it('valueScore is quality / (1 + blendedCost)', () => {
    const m = M({ costPer1MInput: 4, costPer1MOutput: 8, quality: 0.8 });
    expect(valueScore(m)).toBeCloseTo(0.8 / (1 + 7), 10);
  });
});

describe('DEFAULT_MATRIX', () => {
  it('entries are well-formed', () => {
    for (const m of DEFAULT_MATRIX) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(EFFORT_RANK[m.maxEffort]).toBeGreaterThanOrEqual(0);
      expect(m.costPer1MInput).toBeGreaterThan(0);
      expect(m.costPer1MOutput).toBeGreaterThan(0);
      expect(m.quality).toBeGreaterThan(0);
      expect(m.quality).toBeLessThanOrEqual(1);
    }
  });

  it('has at least one capable model for every tier', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
    for (const tier of tiers) {
      const { reason } = selectModel(tier, DEFAULT_MATRIX);
      expect(reason).not.toContain('falling back');
    }
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/router-select.test.ts`
Expected: FAIL — `packages/gateswarm-router/src/index.ts` does not exist yet (alias resolution error).

- [x] **Step 4: Implement router types**

Create `packages/gateswarm-router/src/types.ts`:

```typescript
import type { ComplexityResult, EffortLevel } from 'gateswarm-lite';

export interface ModelSpec {
  /** Model identifier, e.g. "gpt-5-mini". */
  id: string;
  /** Provider identifier, e.g. "openai". */
  provider: string;
  /** Highest effort tier this model handles reliably. */
  maxEffort: EffortLevel;
  /** USD per 1M input tokens. */
  costPer1MInput: number;
  /** USD per 1M output tokens. */
  costPer1MOutput: number;
  /** Relative quality estimate in (0, 1]. */
  quality: number;
  avgLatencyMs?: number;
  tags?: string[];
}

export type RoutingStrategy = 'cheapest-capable' | 'best-value';

export interface RouteOptions {
  /** Default: 'cheapest-capable'. */
  strategy?: RoutingStrategy;
  /** Default: DEFAULT_MATRIX. */
  matrix?: ModelSpec[];
  /** Exclude models below this quality. Default: 0. */
  minQuality?: number;
}

export interface RouteDecision {
  model: ModelSpec;
  /** Up to 3 next-best capable models, ranked. */
  alternatives: ModelSpec[];
  complexity: ComplexityResult;
  strategy: RoutingStrategy;
  reason: string;
}
```

- [x] **Step 5: Implement the default matrix**

Create `packages/gateswarm-router/src/matrix.ts`:

```typescript
import type { ModelSpec } from './types.js';

/**
 * Default routing matrix — a reviewed starting point, NOT a source of truth.
 * Prices are USD per 1M tokens, estimated 2026-08. Review periodically or
 * pass your own matrix via RouteOptions.matrix in production.
 */
export const DEFAULT_MATRIX: ModelSpec[] = [
  { id: 'gemini-flash-lite', provider: 'google',    maxEffort: 'light',     costPer1MInput: 0.10,  costPer1MOutput: 0.40,  quality: 0.55, avgLatencyMs: 400 },
  { id: 'gpt-5-mini',        provider: 'openai',    maxEffort: 'moderate',  costPer1MInput: 0.25,  costPer1MOutput: 2.00,  quality: 0.70, avgLatencyMs: 700 },
  { id: 'gemini-flash',      provider: 'google',    maxEffort: 'moderate',  costPer1MInput: 0.30,  costPer1MOutput: 2.50,  quality: 0.72, avgLatencyMs: 600 },
  { id: 'deepseek-chat',     provider: 'deepseek',  maxEffort: 'heavy',     costPer1MInput: 0.27,  costPer1MOutput: 1.10,  quality: 0.74, avgLatencyMs: 1200 },
  { id: 'gemini-pro',        provider: 'google',    maxEffort: 'intensive', costPer1MInput: 1.25,  costPer1MOutput: 10.00, quality: 0.87, avgLatencyMs: 1400 },
  { id: 'gpt-5.2',           provider: 'openai',    maxEffort: 'intensive', costPer1MInput: 1.75,  costPer1MOutput: 14.00, quality: 0.88, avgLatencyMs: 1500 },
  { id: 'claude-sonnet',     provider: 'anthropic', maxEffort: 'extreme',   costPer1MInput: 3.00,  costPer1MOutput: 15.00, quality: 0.92, avgLatencyMs: 1600 },
  { id: 'claude-opus',       provider: 'anthropic', maxEffort: 'extreme',   costPer1MInput: 15.00, costPer1MOutput: 75.00, quality: 0.97, avgLatencyMs: 2500 },
];
```

- [x] **Step 6: Implement selection**

Create `packages/gateswarm-router/src/select.ts`:

```typescript
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec, RouteOptions, RoutingStrategy } from './types.js';

export const EFFORT_RANK: Record<EffortLevel, number> = {
  trivial: 0,
  light: 1,
  moderate: 2,
  heavy: 3,
  intensive: 4,
  extreme: 5,
};

/** Output-weighted blended cost (USD per 1M tokens): chat workloads are output-heavy. */
export function blendedCost(m: ModelSpec): number {
  return m.costPer1MInput * 0.25 + m.costPer1MOutput * 0.75;
}

/** Quality per blended-cost dollar; the +1 keeps near-free models from dividing by ~0. */
export function valueScore(m: ModelSpec): number {
  return m.quality / (1 + blendedCost(m));
}

function compare(strategy: RoutingStrategy, a: ModelSpec, b: ModelSpec): number {
  switch (strategy) {
    case 'cheapest-capable':
      return blendedCost(a) - blendedCost(b) || b.quality - a.quality;
    case 'best-value':
      return valueScore(b) - valueScore(a) || blendedCost(a) - blendedCost(b);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`gateswarm-router: unknown strategy ${String(_exhaustive)}`);
    }
  }
}

export interface Selection {
  model: ModelSpec;
  alternatives: ModelSpec[];
  reason: string;
}

export function selectModel(tier: EffortLevel, matrix: ModelSpec[], opts: RouteOptions = {}): Selection {
  if (matrix.length === 0) {
    throw new Error('gateswarm-router: matrix is empty');
  }
  const strategy: RoutingStrategy = opts.strategy ?? 'cheapest-capable';
  const minQuality = opts.minQuality ?? 0;

  const capable = matrix.filter(
    (m) => EFFORT_RANK[m.maxEffort] >= EFFORT_RANK[tier] && m.quality >= minQuality,
  );

  if (capable.length === 0) {
    const pool = [...matrix].sort(
      (a, b) => EFFORT_RANK[b.maxEffort] - EFFORT_RANK[a.maxEffort] || b.quality - a.quality,
    );
    return {
      model: pool[0],
      alternatives: pool.slice(1, 4),
      reason: `no model in the matrix is rated for tier "${tier}"; falling back to the most capable model (${pool[0].id})`,
    };
  }

  const ranked = [...capable].sort((a, b) => compare(strategy, a, b));
  const model = ranked[0];
  const reason =
    strategy === 'best-value'
      ? `tier "${tier}": best quality/cost value among ${capable.length} capable model(s) is ${model.id} (value ${valueScore(model).toFixed(3)})`
      : `tier "${tier}": cheapest capable model among ${capable.length} candidate(s) is ${model.id} ($${blendedCost(model).toFixed(2)}/1M blended)`;

  return { model, alternatives: ranked.slice(1, 4), reason };
}
```

- [x] **Step 7: Create a minimal index so the alias resolves**

Create `packages/gateswarm-router/src/index.ts` (extended with `route()` in Task 5):

```typescript
export * from './types.js';
export { DEFAULT_MATRIX } from './matrix.js';
export { blendedCost, EFFORT_RANK, selectModel, valueScore, type Selection } from './select.js';
```

- [x] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/router-select.test.ts`
Expected: PASS (all cases).

- [x] **Step 9: Commit**

```powershell
git add packages/gateswarm-router tests/router-select.test.ts package-lock.json
git commit -m "feat(router): add advisory model selection with default matrix"
```

---

### Task 5: route() end-to-end + router CLI

**Files:**
- Modify: `packages/gateswarm-router/src/index.ts`
- Create: `packages/gateswarm-router/src/cli.ts`
- Create: `packages/gateswarm-router/README.md`
- Test: `tests/router-route.test.ts`

**Interfaces:**
- Consumes: `scoreComplexity` (gateswarm-lite), `selectModel`/`DEFAULT_MATRIX` (Task 4).
- Produces: `route(prompt: string, opts?: RouteOptions): RouteDecision` and the `gateswarm-route` bin.

- [x] **Step 1: Write the failing route test**

Create `tests/router-route.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ModelSpec } from 'gateswarm-router';
import { DEFAULT_MATRIX, route, selectModel } from 'gateswarm-router';
import { scoreComplexity } from 'gateswarm-lite';

describe('route', () => {
  it('combines complexity scoring with model selection', () => {
    const prompt = 'Design a distributed cache with consistency guarantees and failover, then write the migration plan.';
    const decision = route(prompt);
    const expectedComplexity = scoreComplexity(prompt);
    const expectedSelection = selectModel(expectedComplexity.tier, DEFAULT_MATRIX);

    expect(decision.complexity.score).toBe(expectedComplexity.score);
    expect(decision.complexity.tier).toBe(expectedComplexity.tier);
    expect(decision.model.id).toBe(expectedSelection.model.id);
    expect(decision.strategy).toBe('cheapest-capable');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('passes strategy and custom matrix through', () => {
    const matrix: ModelSpec[] = [
      { id: 'only', provider: 'x', maxEffort: 'extreme', costPer1MInput: 1, costPer1MOutput: 2, quality: 0.9 },
    ];
    const decision = route('hi', { strategy: 'best-value', matrix });
    expect(decision.strategy).toBe('best-value');
    expect(decision.model.id).toBe('only');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/router-route.test.ts`
Expected: FAIL — no export named `route`.

- [x] **Step 3: Implement route() in the index**

Replace `packages/gateswarm-router/src/index.ts` with:

```typescript
/**
 * gateswarm-router — advisory model router (GateSwarm layer 2).
 *
 * Scores prompt complexity via gateswarm-lite, then picks the model with the
 * best cost/benefit for the tier from a data-driven matrix. Advisory only:
 * it returns a decision — the caller executes the request.
 */
import { scoreComplexity } from 'gateswarm-lite';
import { DEFAULT_MATRIX } from './matrix.js';
import { selectModel } from './select.js';
import type { RouteDecision, RouteOptions } from './types.js';

export * from './types.js';
export { DEFAULT_MATRIX } from './matrix.js';
export { blendedCost, EFFORT_RANK, selectModel, valueScore, type Selection } from './select.js';

export function route(prompt: string, opts: RouteOptions = {}): RouteDecision {
  const complexity = scoreComplexity(prompt);
  const matrix = opts.matrix ?? DEFAULT_MATRIX;
  const strategy = opts.strategy ?? 'cheapest-capable';
  const { model, alternatives, reason } = selectModel(complexity.tier, matrix, opts);
  return { model, alternatives, complexity, strategy, reason };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/router-route.test.ts tests/router-select.test.ts`
Expected: PASS.

- [x] **Step 5: Write the router CLI**

Create `packages/gateswarm-router/src/cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * gateswarm-route CLI — advisory routing decision for a prompt.
 * Usage:  gateswarm-route "your prompt" [--strategy cheapest-capable|best-value] [--matrix path.json]
 *         echo "your prompt" | gateswarm-route
 */
import { readFileSync } from 'node:fs';
import { route } from './index.js';
import type { ModelSpec, RoutingStrategy } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

const args = process.argv.slice(2);
let strategy: RoutingStrategy = 'cheapest-capable';
let matrix: ModelSpec[] | undefined;
const promptParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strategy') {
    const value = args[++i];
    if (value !== 'cheapest-capable' && value !== 'best-value') {
      fail(`invalid --strategy "${value}": use cheapest-capable or best-value`);
    }
    strategy = value;
  } else if (args[i] === '--matrix') {
    const path = args[++i];
    if (!path) fail('--matrix requires a JSON file path');
    try {
      matrix = JSON.parse(readFileSync(path, 'utf8')) as ModelSpec[];
    } catch (err) {
      fail(`could not read matrix file "${path}": ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  } else {
    promptParts.push(args[i]);
  }
}

const arg = promptParts.join(' ').trim();
let prompt = arg;
if (!prompt) {
  if (process.stdin.isTTY) fail('empty prompt: pass it as an argument or via stdin');
  prompt = await readStdin();
}
if (!prompt) fail('empty prompt: pass it as an argument or via stdin');

console.log(JSON.stringify(route(prompt, { strategy, matrix }), null, 2));
```

- [x] **Step 6: Build and smoke-test**

Run: `npm run build -w gateswarm-router`
Expected: exit 0 (builds against the already-built `gateswarm-lite` dist; if it fails on missing dist, run `npm run build -w gateswarm-lite` first).

Run: `node packages/gateswarm-router/dist/cli.js "Design a distributed cache with failover" --strategy best-value`
Expected: JSON `RouteDecision` with `model`, `alternatives`, `complexity`, `strategy: "best-value"`, `reason`.

- [x] **Step 7: Write the package README**

Create `packages/gateswarm-router/README.md`:

```markdown
# gateswarm-router

Advisory model router — layer 2 of the GateSwarm split.

Scores a prompt's complexity with [gateswarm-lite](../gateswarm-lite) (zero-dependency
heuristic, 6 effort tiers) and picks the model with the best cost/benefit for that tier
from a data-driven matrix. **Advisory only:** it returns a decision — your code makes
the actual API call. No provider SDKs, no API keys, no proxying.

> **Naming note:** the `gateswarm-router` npm name previously identified the full
> GateSwarm gateway (now `gateswarm-gateway`). This package is the lightweight
> advisory router extracted from it.

## Usage

```ts
import { route } from 'gateswarm-router';

const d = route('Refactor my auth module to OAuth2 with tests');
// d.model      → { id: 'deepseek-chat', provider: 'deepseek', ... }
// d.complexity → { score: 0.34, tier: 'heavy', ... }
// d.reason     → 'tier "heavy": cheapest capable model among 5 candidate(s) is ...'

// Your code executes the call:
await callProvider(d.model.provider, d.model.id, prompt);
```

Strategies: `cheapest-capable` (default — lowest blended cost among capable models)
or `best-value` (highest quality per blended-cost dollar).

Bring your own matrix (recommended for production — bundled prices are estimates):

```ts
route(prompt, { matrix: myModels, strategy: 'best-value', minQuality: 0.7 });
```

CLI:

```sh
gateswarm-route "Summarize this doc" --strategy best-value --matrix my-matrix.json
```
```

- [x] **Step 8: Commit**

```powershell
git add packages/gateswarm-router tests/router-route.test.ts
git commit -m "feat(router): add route() end-to-end API and gateswarm-route CLI"
```

---

### Task 6: Golden routing table (addressing lock)

**Files:**
- Create: `tests/router-golden.test.ts`

**Interfaces:**
- Consumes: `selectModel`, `route`, `scoreComplexity`, `ModelSpec` from Tasks 2–5.
- Produces: frozen routing assertions against `GOLDEN_MATRIX` (not `DEFAULT_MATRIX`) so model addressing stays correct when demo prices change. Matches `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-testing.md` Section 4.

- [x] **Step 1: Write the golden routing test**

Create `tests/router-golden.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { scoreComplexity } from 'gateswarm-lite';
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec } from 'gateswarm-router';
import { route, selectModel } from 'gateswarm-router';

const GOLDEN_MATRIX: ModelSpec[] = [
  { id: 'nano',  provider: 'x', maxEffort: 'light',    costPer1MInput: 0.10, costPer1MOutput: 0.40,  quality: 0.50 },
  { id: 'small', provider: 'x', maxEffort: 'moderate', costPer1MInput: 0.40, costPer1MOutput: 1.60,  quality: 0.70 },
  { id: 'mid',   provider: 'x', maxEffort: 'heavy',    costPer1MInput: 0.80, costPer1MOutput: 3.20,  quality: 0.80 },
  { id: 'big',   provider: 'x', maxEffort: 'extreme',  costPer1MInput: 5.00, costPer1MOutput: 20.00, quality: 0.95 },
];

const EXPECTED_CHEAPEST: Record<EffortLevel, string> = {
  trivial: 'nano',
  light: 'nano',
  moderate: 'small',
  heavy: 'mid',
  intensive: 'big',
  extreme: 'big',
};

describe('golden addressing table', () => {
  it.each(Object.entries(EXPECTED_CHEAPEST))(
    'cheapest-capable at %s picks %s',
    (tier, id) => {
      const { model } = selectModel(tier as EffortLevel, GOLDEN_MATRIX);
      expect(model.id).toBe(id);
    },
  );

  it('route() selection matches selectModel(scoreComplexity(prompt).tier)', () => {
    const prompts = [
      'hi',
      'What is the capital of France?',
      'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
      'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.',
    ];
    for (const prompt of prompts) {
      const decision = route(prompt, { matrix: GOLDEN_MATRIX });
      const expected = selectModel(scoreComplexity(prompt).tier, GOLDEN_MATRIX);
      expect(decision.model.id).toBe(expected.model.id);
    }
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/router-golden.test.ts`
Expected: FAIL if Task 4/5 are not done; PASS once `selectModel`/`route` exist. If this task runs after Task 5, expect PASS on first run — that is acceptable; the lock is the point.

- [x] **Step 3: Commit**

```powershell
git add tests/router-golden.test.ts
git commit -m "test(router): lock golden addressing table against a frozen matrix"
```

---

### Task 7: Full-build verification and root docs

**Files:**
- Modify: `README.md` (root — add a section after the intro)
- Verify (no edits expected): root build, tests, typecheck, consistency check
- Walk the acceptance checklist in `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-testing.md` Section 5

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: verified `npm run build` for the whole repo; root README documents the two-layer split.

- [ ] **Step 1: Run the full verification battery**

Run each and confirm:

1. `npm test` — Expected: ALL tests pass (existing suite + lite-parity + router tests).
2. `npm run typecheck` — Expected: exit 0.
3. `npm run check:consistency` — Expected: exit 0.
4. `npm run build` — Expected: exit 0; builds both packages then the gateway. Note: `dist/` may contain an inert `dist/packages/` copy emitted by the root tsc pass; the live gateway modules in `dist/src/` resolve `gateswarm-lite` through the workspace link.
5. `node packages/gateswarm-lite/dist/cli.js "hello world"` — Expected: JSON with `tier`.
6. `node packages/gateswarm-router/dist/cli.js "hello world"` — Expected: JSON `RouteDecision`.

If step 4 fails on emit collisions from `dist/packages`, add `"packages"` to the `exclude` array of `tsconfig.build.json` and re-run.

- [ ] **Step 2: Add the two-layer section to the root README**

In root `README.md`, insert this section right after the opening description/badges block (before the first existing `##` section):

```markdown
## Lightweight packages: gateswarm-lite + gateswarm-router

The complexity scorer and an advisory router are available as standalone,
dependency-free packages under `packages/`:

| Package | What it does | Dependencies |
|---------|--------------|--------------|
| [`gateswarm-lite`](packages/gateswarm-lite) | Scores prompt complexity (0-1) and maps it to 6 effort tiers. Node/browser/edge. | none |
| [`gateswarm-router`](packages/gateswarm-router) | Picks the best cost/benefit model for the scored tier from a data-driven matrix. Advisory only — your code executes the request. | gateswarm-lite |

```ts
import { route } from 'gateswarm-router';

const d = route('Design a distributed cache with failover');
// d.complexity.tier → 'intensive' · d.model.id → cheapest capable model
```

The full gateway in this repo (package `gateswarm-gateway`) builds on the same
scorer via workspace imports; tier boundaries stay calibrated by the eval
pipeline (`npm run eval:refit-boundaries`).
```

- [ ] **Step 3: Final commit**

```powershell
git add README.md tsconfig.build.json
git commit -m "docs: document gateswarm-lite + gateswarm-router two-layer split"
```

(Include `tsconfig.build.json` only if Step 1 required the exclude fix.)

---

## Plan Self-Review (completed)

- **Spec coverage:** workspaces + rename (Task 1), verbatim extraction + parity + named shims + single EffortLevel source (Task 2), lite API/CLI with TTY fail-fast (Task 3), router types/matrix/selection semantics incl. blended cost, strategies, fallback, minQuality, empty-matrix error (Task 4), route() + CLI with --strategy/--matrix (Task 5), golden addressing table (Task 6), build integration + docs (Task 7). Testing playbook `2026-08-25-gateswarm-lite-router-testing.md` is the acceptance source. Non-goals respected: no executor, no device profiles, no ML.
- **Placeholders:** none — every code step contains complete code; every command has an expected result.
- **Type consistency:** `ComplexityResult`, `ModelSpec`, `RouteOptions`, `RouteDecision`, `Selection`, `EFFORT_RANK`, `blendedCost`, `valueScore`, `selectModel`, `route`, `scoreComplexity` are named identically across tasks 2, 4, and 5.
