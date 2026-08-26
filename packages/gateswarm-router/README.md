# gateswarm-router

Advisory model router — layer 2 of the GateSwarm split.

Scores a prompt's complexity with [gateswarm-lite](../gateswarm-lite) (zero-dependency
heuristic, 6 effort tiers) and picks the model with the best cost/benefit for that tier
from a data-driven matrix. **Advisory only:** it returns a decision — your code makes
the actual API call. No provider SDKs, no API keys, no proxying.

> **Naming note:** through the v0.6.0 line the name `gateswarm-router`
> identified the full GateSwarm gateway, which continues as `gateswarm-gateway`.
> This lightweight advisory router — extracted from that v0.6.0 codebase —
> carries version **0.6.0** deliberately, marking the release it was split from.

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
