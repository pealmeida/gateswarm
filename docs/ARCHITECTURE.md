# GateSwarm MoMA Router v0.4.4 — Architecture

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14
**Status:** Production — running on port 8900

---

## 1. Overview

GateSwarm MoMA Router is a **multi-agent API gateway** that sits between any LLM client (any LLM client) and multiple LLM providers (Bailian/Qwen, ZAI/GLM, OpenRouter). It intercepts every request, scores prompt complexity, routes to the optimal model per effort tier, compresses long conversations, and continuously learns from feedback.

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────────────┐
│             │     │         GateSwarm v0.4.4              │     │                  │
│  Pi Agent   │────▶│                                       │────▶│  Bailian (Qwen)  │
│  Agent A    │     │  1. Score complexity (ensemble)       │     │  zai/glm-4.5-air │
│  Agent B    │────▶│  2. Route to optimal tier/model       │────▶│  zai/glm-4.7     │
│  BMAD       │     │  3. TurboQuant compression            │     │  bailian/MiniMax  │
│             │────▶│  4. RAG context retrieval             │────▶│  bailian/qwen3.5  │
│             │     │  5. Sanitize → Forward → Fallback     │     │  bailian/qwen3.6  │
│             │     │  6. Self-eval + feedback + training   │     │                  │
└─────────────┘     └──────────────────────────────────────┘     └──────────────────┘
```

### Core Principles

1. **Right model for the right task** — trivial prompts use small/cheap models, complex prompts use capable ones
2. **Compression is mandatory** — long conversations are compressed before forwarding, never rejected
3. **Learn from every interaction** — feedback loop, RAG persistence, training mode
4. **Resilient by design** — fallback chains, timeouts, message sanitization, graceful degradation

---

## 2. System Components

```
gateswarm-moma-router/
├── src/
│   ├── moma-gateway.ts          ← HTTP server, request pipeline, orchestration
│   ├── intent-engine-v04.ts    ← Ensemble scoring (heuristic + RAG + history)
│   ├── ensemble-voter.ts       ← Weighted ensemble vote with confidence
│   ├── feature-extractor-v04.ts← 25-feature prompt complexity extractor
│   ├── turboquant-compressor.ts← Context compression (Q8/Q4/Q2/Q1/Q0)
│   ├── routing-matrix.ts       ← Effort × Device routing matrix
│   ├── v04-config.ts           ← Tier models, weights, feedback config
│   ├── agent-registry.ts       ← Multi-agent auth, tier profiles
│   ├── feedback-store.ts       ← Persistent feedback (JSON file)
│   ├── rag-index.ts            ← Persistent RAG index (JSON file)
│   ├── self-eval.ts            ← LLM judge (qwen3.6-plus)
│   ├── retraining.ts           ← Weight optimization + hot-swap
│   ├── training-mode.ts        ← Semi-supervised learning (gold/silver/bronze)
│   ├── vote-persistence.ts     ← Training votes (JSON file)
│   ├── label-combiner.ts       ← Label quality calibration
│   ├── benchmark-logger.ts     ← Per-request benchmark logging
│   ├── gateswarm-cli.ts        ← CLI for status/config/retraining
│   └── adapters/               ← Local (WebGPU), Cloud API, Ollama
├── data/
│   ├── rag/index.json          ← Persistent RAG entries
│   ├── feedback/entries.json   ← Persistent feedback entries
│   └── training/               ← Training votes + configs
├── v04_config.json             ← Live tier model configuration
└── logs/gateway.log            ← Runtime logs
```

---

## 3. Request Pipeline

Every request flows through these stages:

```
Request arrives
    │
    ▼
┌─────────────────────────────────┐
│ 1. Parse & extract prompt       │
│    - Last user message text     │
│    - Handle array content       │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 2. Score complexity (ensemble)  │
│    - 25-feature extractor       │
│    - Heuristic score (55%)      │
│    - RAG signal (25%)           │
│    - History bias (20%)         │
│    - Confidence-based routing   │
│    → score (0-1), tier, method  │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 3. Route to model               │
│    - Tier → provider + model    │
│    - enable_thinking per tier   │
│    - Fallback chain             │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 4. TurboQuant compression       │
│    - Pre-merge consecutive      │
│    - Score importance (radius)  │
│    - Quantize Q8→Q0             │
│    - Store compressed to RAG    │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 5. RAG retrieval                │
│    - Keyword overlap query      │
│    - Inject into system message │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 6. Continuity injection         │
│    - Model switch?              │
│    - Add key decisions from prev│
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 7. Sanitize messages (7-phase)  │
│    - System-first ordering      │
│    - Merge consecutive same-role│
│    - User-first                 │
│    - Orphan tool filter         │
│    - Leading cleanup            │
│    - Synthetic user injection   │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 8. Forward to provider          │
│    - Retry on 429/5xx/timeout   │
│    - Fallback chain per tier    │
│    - 120s timeout per target    │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 9. Post-response                │
│    - Record feedback            │
│    - Self-eval (async)          │
│    - SILVER label (RAG)         │
│    - BRONZE calibration         │
│    - Training vote (if enabled) │
│    - RAG index update           │
│    - Continuity update          │
│    - Benchmark log              │
└─────────────────────────────────┘
```

---

## 4. Complexity Scoring — Ensemble Voter

### 25-Feature Extractor

Each prompt is analyzed across 25 features:

| Group | Features | Purpose |
|---|---|---|
| **v3.3 Heuristic (9)** | has_question, has_code, has_imperative, has_arithmetic, has_sequential, has_constraint, has_context, has_architecture, has_design | Binary signals for complexity |
| **v3.2 Cascade (6)** | sentence_count, avg_word_length, question_technical, technical_design, technical_terms, multi_step | Structural complexity |
| **v0.4 NEW (10)** | has_negation, entity_count, code_block_size, domain_finance, domain_legal, domain_medical, domain_engineering, temporal_references, output_format_spec, prior_context_needed, novelty_score, multi_domain, user_expertise_level | Domain + nuance signals |

### Scoring Formula

```
heuristic_score = signals × 0.15 + log1p(word_count) × 0.08 + has_context × 0.10 + system_bonus
```

### Ensemble Weights

| Component | Weight | Status |
|---|---|---|
| Heuristic | 55% | ✅ Active |
| Cascade | 0% | ⏸️ Disabled (no trained weights) |
| RAG signal | 25% | ✅ Active (from persistent index) |
| History bias | 20% | ✅ Active (from persistent feedback) |

### Tier Boundaries

| Score Range | Tier | Model | Provider |
|---|---|---|---|
| 0.00 – 0.1557 | trivial | glm-4.5-air | zai |
| 0.1557 – 0.1842 | light | glm-4.7-flash | zai |
| 0.1842 – 0.2788 | moderate | MiniMax-M2.5 | bailian |
| 0.2788 – 0.3488 | heavy | qwen3.5-plus | bailian |
| 0.3488 – 0.4611 | intensive | qwen3.5-plus | bailian |
| 0.4611 – 1.00 | extreme | qwen3.6-plus | bailian |

---

## 5. TurboQuant Compression

### Quantization Levels

| Level | Action | Used For |
|---|---|---|
| Q8 | Keep intact | System, recent (last 3), tool messages, assistant+tool_calls |
| Q4 | Strip thinking/reasoning blocks | User messages (minimum), important assistant messages |
| Q2 | Keep first sentence, store summary | Moderate importance messages |
| Q1 | One-line summary, store to RAG | Low importance messages |
| Q0 | Drop entirely, store summary to RAG | Least important messages |

### Structural Invariants

- **System messages** → always Q8
- **User messages** → minimum Q4 (never dropped, thinking stripped)
- **Tool messages** → always Q8
- **Assistant with tool_calls** → always Q8
- **Last 3 messages** → always Q8

### Dynamic Thresholds

```
context_window = MODEL_CONTEXT_WINDOWS[target_model]
threshold = max(4000, min(50000, context_window × 0.05))
```

- 1M context (qwen3.5-plus) → threshold = 50,000 tokens
- 200K context (glm-4.5-air) → threshold = 10,000 tokens

### Compression Skip

Conversations with ≤5 messages AND ≤8K tokens bypass compression entirely.

### Importance Scoring

```
radius = recency × 0.25        // recent messages matter more
       + tool_result × 0.15    // tool results carry state
       + tool_calls × 0.20     // assistant with tool_calls = anchor
       + is_decision × 0.15    // decisions are critical
       + is_error × 0.10       // errors need context
       + is_system × 0.15      // system prompts essential
       + is_user × 0.10        // user input always important
       + semantic × 0.25       // multi-domain content valuable

semantic_importance = keyword_groups_hit / 4
// Groups: code, architecture, infra, security, data, decision, error
```

---

## 6. Message Sanitization (7-Phase)

After compression, the message sequence is repaired for provider compatibility:

| Phase | Purpose | Root Cause Addressed |
|---|---|---|
| 1. System-first | Move all system messages to front | RAG injection mid-conversation |
| 2. Merge consecutive | Merge same-role messages with `---` separator | Compressor drops messages → adjacent same roles |
| 3. User-first ordering | Ensure first non-system is user | Ordering correctness |
| 5. Orphan tool filter | Skip tool without parent assistant; skip null-content assistants | Orphaned tool results |
| 6. Leading cleanup | Drop leading non-system/non-user messages | Ordering correctness |
| 7. User injection | Inject synthetic user if none exists | ZAI/Bailian require ≥1 user message |

---

## 7. RAG Index

### Architecture

Unified in-memory index backed by JSON-file persistence:

```
data/rag/index.json ← survives restarts
```

### Entry Types

1. **Interaction entries** — stored after each request (keywords, tier, model, adequacy, summary)
2. **Compression entries** — stored when messages are Q0/Q1/Q2 (tags, summary, quant level)

### Query

Keyword overlap matching against both `keywords` and `tags` fields:
```
queryRag(["architecture", "caching"], maxResults=3)
→ returns top 3 entries by keyword overlap score
```

### Lifecycle

- **TTL:** 24 hours
- **Max entries:** 10,000
- **Auto-flush:** every 60 seconds
- **Eviction:** shift oldest when full

---

## 8. Feedback Store & Self-Evaluation

### Persistent Feedback

```
data/feedback/entries.json ← survives restarts
```

Every interaction records:
- `predictedTier` — router's classification
- `actualTier` — LLM-judged ground truth (populated async)
- `adequacyScore` — 0.0–1.0 quality estimate
- `modelUsed` — provider/model that handled the request
- `responseTokens` — output token count

### Self-Evaluation Pipeline

1. **Quick heuristic** (synchronous) — token range, length, latency, repetition → score 0–1
2. **LLM judge** (async, 10% sampling) — qwen3.6-plus evaluates prompt/response → adequacy + correct tier
3. **Wire back** — `updateAdequacy()` populates `actualTier` in feedback store

### LLM Judge Anti-Circularity

The judge uses `qwen3.6-plus` (extreme tier) rather than `qwen3.5-plus` (intensive tier) to avoid the same model judging its own routing decisions.

---

## 9. Training Mode

### Label Sources

| Source | Quality | Volume | How |
|---|---|---|---|
| **GOLD** | 100% (human) | 5–15% (sampled) | Manual user votes via `✅ correct` or `❌ <tier>` |
| **SILVER** | 70–80% (pattern) | 30–50% (free) | RAG consensus — 3+ entries agree on tier |
| **BRONZE** | 80–85% (LLM) | 100% (async) | LLM judge quality assessment |

### Aleatory Sampling

Not every request triggers a vote. Sampling rules:
- Never on `trivial` or `extreme` (high-confidence tiers)
- Always when confidence < 0.5
- Base rate 10% on moderate/heavy/intensive (accuracy gaps)
- Fatigue decay: rate decreases with `e^(-votes/50)`

### Weight Calibration

- After 10+ bronze comparisons → adjust bronze weight
- After 10+ silver comparisons → adjust silver weight (only if agreement > 70%)
- Phase transitions: disabled (0–50) → low (50–200) → full (200+)

---

## 10. Context Continuity

### Purpose

When the router switches models between turns (e.g., heavy→qwen3.5-plus → trivial→glm-4.5-air), the new model needs to know what the previous model discussed.

### Implementation

In-memory per-session tracking (1-hour expiry):

```typescript
SessionContinuity = {
  summary: string,           // LLM-agnostic summary
  lastTier: string,          // tier of last response
  lastModel: string,         // model used
  keyDecisions: string[],    // extracted decisions/conclusions
  updatedAt: number          // timestamp
}
```

### Key Decision Extraction

Regex patterns extract important statements:
- `decision|conclusion|therefore|resolved|agreed|final`
- `the answer is|key point|important|note that`

### Injection

When a model switch is detected, continuity is merged into the system message:

```
Continuity from previous turn (heavy→bailian/qwen3.5-plus):
- Architecture uses event sourcing with Kafka
- Key point: caching layer should be Redis with TTL
```

---

## 11. Fallback Chain

### Retry Conditions

- Rate limits: 429, 1305, 1308
- Server errors: 5xx
- Timeouts: 120s per target

### Fallback Models per Tier

| Tier | Primary | Fallbacks |
|---|---|---|
| trivial | glm-4.5-air | glm-4.7-flash, glm-4.7, kimi-k2.5 |
| light | glm-4.7-flash | glm-4.7, glm-4.5-air, MiniMax-M2.5 |
| moderate | MiniMax-M2.5 | qwen3.5-plus, kimi-k2.5, glm-4.7-flash |
| heavy | qwen3.5-plus | qwen3.6-plus, MiniMax-M2.5, glm-4.7-flash, glm-4.7 |
| intensive | qwen3.5-plus | qwen3.6-plus, kimi-k2.5, MiniMax-M2.5 |
| extreme | qwen3.6-plus | qwen3.6-max-preview, qwen3.5-plus, kimi-k2.5 |

---

## 12. HTTP API

### Standard Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/chat/completions` | Main completion endpoint |
| GET | `/v1/models` | List available models |
| GET | `/v1/agents` | List registered agents |
| POST | `/v1/agents/register` | Register new agent |
| GET | `/health` | Health check |
| GET | `/metrics` | Benchmark metrics |

### v0.4 Management Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/v04/status` | Ensemble/feedback/RAG status |
| GET | `/v04/feedback` | Feedback buffer stats |
| POST | `/v04/retrain` | Trigger manual retraining |
| GET | `/v04/training?agentId=jack` | Training mode stats |
| POST | `/v04/training/enable` | Enable/disable training |
| POST | `/v04/training/vote` | Record a vote reply |
| POST | `/v04/training/vote/reply` | Detect vote reply in message |

---

## 13. Agent Connection

Any agent connects via:

```yaml
base_url: http://localhost:8900/v1
api_key:  moma-<agent-key>  # from agent registry
```

Pi agent config (`~/.pi/agent/models.json`):
```json
{
  "providers": {
    "moma": {
      "baseUrl": "http://localhost:8900/v1",
      "apiKey": "moma-<jack-key>",
      "api": "openai-completions",
      "models": [{
        "id": "gateswarm",
        "name": "GateSwarm MoMA v0.4.4 (TurboQuant v3.6 + Context-Aware)"
      }]
    }
  }
}
```

---

## 14. Persistence Files

| File | Content | Flush Interval |
|---|---|---|
| `data/rag/index.json` | RAG entries (interaction + compression) | 60s |
| `data/feedback/entries.json` | Feedback entries (all interactions) | 60s |
| `data/training/votes.json` | Training votes (gold/silver/bronze) | On write |
| `data/training/agent-configs.json` | Per-agent training config | On write |
| `data/training/tier-accuracy.json` | Per-tier accuracy cache | On write |
| `v04_config.json` | Live tier model configuration | On CLI change |
| `data/agent-registry.json` | Agent registry + provider creds | On auth/register |

---

## 15. Key Design Decisions

1. **JSON-file persistence over SQLite** — No native dependencies, same pattern as vote-persistence.ts
2. **Single RAG injection point** — Gateway only, not compressor (eliminates duplicates)
3. **History bias from feedback store** — Not a separate buffer (was always 0)
4. **Anti-circular LLM judge** — Different model for judging than routing
5. **enable_thinking per tier** — Only for heavy+ (cost control)
6. **Confidence-based escalation** — Uncertain → escalate one tier, very uncertain → intensive default
