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
