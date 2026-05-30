# Quick Start — MoMA Gateway Router

## Option 1: Browser (WebGPU)

```bash
cd moma-gateway-router
npm install
npm run dev
# Open http://localhost:3000 in Chrome 113+
```

## Option 2: Ollama CLI (Server/Desktop)

```bash
# 1. Start Ollama
ollama serve

# 2. Pull a model (if not already)
ollama pull qwen2.5:7b-instruct-q4_K_M

# 3. Run interactive
npx tsx src/bin.ts --interactive

# 4. Or single query
npx tsx src/bin.ts "What is the capital of France?"

# 5. Or pipeline test
npx tsx src/bin.ts --test

# 6. List available models
npx tsx src/bin.ts --models
```

## Option 3: Programmatic (Node.js)

```typescript
import { OllamaAdapter } from './src/adapters/ollama-adapter.js';
import { heuristicScore } from './src/intent-engine.js';
import { scoreToEffort, lookupMatrix, classifyDevice } from './src/routing-matrix.js';
import { LearningLoop } from './src/learning/learning-loop.js';

// Setup
const adapter = new OllamaAdapter({
  id: 'main', modelId: 'qwen2.5:7b-instruct-q4_K_M',
  displayName: 'Qwen', baseUrl: 'http://localhost:11434',
  maxTokens: 1024, costPer1kTokens: 0,
});
await adapter.initialize();

const learning = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

// Process
const prompt = 'Explain quantum computing';
const score = heuristicScore(prompt);
const effort = scoreToEffort(score);
const device = classifyDevice('wasm', 8, false);
const cell = lookupMatrix(effort, device);

console.log(`Routing: ${effort} (score: ${score.toFixed(2)})`);

const tokens = [];
for await (const chunk of adapter.generate({ prompt })) {
  if (chunk.token) tokens.push(chunk.token);
}
console.log(tokens.join(''));

// Record for learning
learning.recordOutcome({ prompt, score, effort, tier: 'local', model: 'qwen', latencyMs: 0, tokenCount: tokens.length, costCents: 0, userSatisfied: null, timestamp: Date.now() });
```

## Tests

```bash
# Unit tests (75 tests, instant)
npm test

# Live Ollama tests (requires ollama serve)
npx vitest run tests/live-ollama.test.ts --testTimeout=120000
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | Model to use |

## Live Test Results

| Prompt | Effort | Latency | Tokens |
|--------|--------|---------|--------|
| "Hello!" | trivial | 9.5s | 30 |
| "What is the capital of France?" | trivial | 4.9s | 8 |
| "Explain HTTP in 2 paragraphs" | light | 39.8s | 128 |
| "Write a Python function that reverses a string" | heavy | 42.2s | 128 |

> Note: Latency depends on hardware. Smaller models (qwen2.5:0.5b) will be 10-20x faster.
