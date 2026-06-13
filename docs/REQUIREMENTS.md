# GateSwarm MoMA Router v0.4.4 — Technical Requirements

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. System Architecture

### 1.1 Core Components

| Component | File | Purpose |
|---|---|---|
| API Gateway | `moma-gateway.ts` | HTTP server, request orchestration, endpoint routing |
| Intent Engine | `intent-engine-v04.ts` | Ensemble complexity scoring |
| Ensemble Voter | `ensemble-voter.ts` | Weighted vote with confidence + history bias |
| Feature Extractor | `feature-extractor-v04.ts` | 25-feature prompt analysis |
| Compressor | `turboquant-compressor.ts` | Context compression (Q8→Q0) |
| Routing Matrix | `routing-matrix.ts` | Effort × Device model selection |
| Config Manager | `v04-config.ts` | Tier models, weights, feedback config |
| Agent Registry | `agent-registry.ts` | Multi-agent auth, tier profiles |
| Feedback Store | `feedback-store.ts` | Persistent interaction logging |
| RAG Index | `rag-index.ts` | Persistent context retrieval |
| Self-Eval | `self-eval.ts` | LLM judge quality assessment |
| Retraining | `retraining.ts` | Weight optimization + hot-swap |
| Training Mode | `training-mode.ts` | Semi-supervised learning pipeline |
| Vote Persistence | `vote-persistence.ts` | Training votes + accuracy cache |
| Label Combiner | `label-combiner.ts` | Quality-weighted label fusion |
| Benchmark Logger | `benchmark-logger.ts` | Per-request cost/latency tracking |
| CLI | `gateswarm-cli.ts` | System configuration commands |

### 1.2 Persistence Files

| Path | Format | Content | Auto-Flush |
|---|---|---|---|
| `data/rag/index.json` | JSON array | RAG entries (interaction + compression) | 60s |
| `data/feedback/entries.json` | JSON array | All interaction feedback | 60s |
| `data/training/votes.json` | JSON array | Training votes | On write |
| `data/training/agent-configs.json` | JSON object | Per-agent training config | On write |
| `data/training/tier-accuracy.json` | JSON object | Per-tier accuracy cache | On write |
| `data/agent-registry.json` | JSON object | Agent profiles + provider creds | On write |
| `v04_config.json` | JSON object | Live tier model configuration | On CLI |

### 1.3 Dependencies

```json
{
  "dependencies": {
    "@huggingface/transformers": "^3.4.0",
    "onnxruntime-web": "^1.21.0",
    "idb-keyval": "^6.2.1"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.3.0",
    "vitest": "^3.1.0",
    "@types/node": "^22.0.0"
  }
}
```

Runtime uses `npx tsx` (TypeScript execution via Node.js). No native database drivers.

### 1.4 Environment Variables

```
BAILIAN_KEY=sk-sp-xxxxx
GLM_API_KEY=xxxxx
BAILIAN_BASE=https://coding-intl.dashscope.aliyuncs.com/v1
ZAI_BASE=https://api.z.ai/api/coding/paas/v4
```

---

## 2. API Specification

### 2.1 Authentication

Agents authenticate via `Authorization: Bearer moma-<key>` header. Keys are managed by `agent-registry.ts`.

If no valid API key is provided, the gateway falls back to the `default` agent.

### 2.2 Endpoints

#### POST /v1/chat/completions

Standard OpenAI-compatible completion endpoint.

**Request:**
```json
{
  "model": "gateswarm",
  "messages": [
    {"role": "system", "content": "You are..."},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"},
    {"role": "user", "content": "Design a caching strategy"}
  ],
  "session_id": "optional-session-id",
  "stream": false
}
```

**Response:** Standard OpenAI chat completion response with optional `_voteRequest` field (when training mode is enabled).

#### GET /v04/status

Returns current system state:
```json
{
  "version": "v0.4.4-context-aware",
  "method": "ensemble-voter-with-feedback-loop",
  "interactions": 1532,
  "ensemble": {
    "weights": {"heuristic": 0.55, "cascade": 0, "ragSignal": 0.25, "historyBias": 0.20},
    "confidenceThresholds": {"high": 0.8, "low": 0.5}
  },
  "tierModels": { ... },
  "reasoning": { "heavy": true, "intensive": true, "extreme": true, ... },
  "feedback": { ... },
  "llmJudge": "bailian/qwen3.6-plus"
}
```

#### GET /v04/training?agentId=jack

Training mode stats for a specific agent.

#### POST /v04/training/enable

Enable/disable training mode for an agent.

#### POST /v04/retrain

Trigger manual weight retraining.

---

## 3. Complexity Scoring Specification

### 3.1 Feature Extraction

Each prompt produces a 25-feature vector:

```typescript
FeatureVector = {
  // v3.3 Heuristic (binary)
  has_question: 0|1,
  has_code: 0|1,
  has_imperative: 0|1,
  has_arithmetic: 0|1,
  has_sequential: 0|1,
  has_constraint: 0|1,
  has_context: 0|1,
  has_architecture: 0|1,
  has_design: 0|1,
  // v3.2 Cascade (numeric)
  sentence_count: number,
  avg_word_length: number,
  question_technical: 0|1,
  technical_design: 0|1,
  technical_terms: number,
  multi_step: 0|1,
  // v0.4 New
  has_negation: 0|1,
  entity_count: number,
  code_block_size: number,
  domain_finance: 0|1,
  domain_legal: 0|1,
  domain_medical: 0|1,
  domain_engineering: 0|1,
  temporal_references: number,
  output_format_spec: 0|1,
  prior_context_needed: 0|1,
  novelty_score: number,
  multi_domain: 0|1,
  user_expertise_level: 0|1|2,
}
```

### 3.2 Scoring Formula

```
signals = sum(has_question + has_code + has_imperative + has_arithmetic +
              has_sequential + has_constraint + has_context +
              has_architecture + has_design)

heuristic = signals × 0.15 + log1p(word_count) × 0.08 + has_context × 0.10 + system_bonus
```

System bonus is based on word count and system-level signals:
- wc ≥ 15 AND sysCount ≥ 5 → +0.35
- wc ≥ 15 AND sysCount ≥ 4 → +0.25
- wc ≥ 12 AND sysCount ≥ 3 → +0.15
- wc ≥ 10 AND sysCount ≥ 3 → +0.10
- wc ≥ 10 AND sysCount ≥ 2 → +0.05
- sysCount ≥ 2 → +0.03

### 3.3 Ensemble Score

```
finalScore = heuristic × 0.55 + ragSignal × 0.25 + historyBias
```

Confidence:
- Single method (no cascade) → 0.7
- Multi-method agreement → variance-based

Tier escalation:
- confidence > 0.8 → predicted tier
- confidence 0.5–0.8 → escalate one tier
- confidence < 0.5 → intensive default

---

## 4. Compression Specification

### 4.1 Importance Scoring

```
radius = recency × 0.25
       + isToolResult × 0.15
       + hasToolCalls × 0.20
       + isDecision × 0.15
       + isError × 0.10
       + isSystem × 0.15
       + isUser × 0.10
       + semanticImportance × 0.25
```

### 4.2 Quantization Matrix

| Budget Ratio | Q8 | Q4 | Q2 | Q1 |
|---|---|---|---|---|
| > 0.7 | r > 0.5 | r > 0.3 | r > 0.15 | else |
| > 0.4 | r > 0.6 | r > 0.4 | r > 0.2 | else |
| > 0.2 | r > 0.7 | r > 0.5 | r > 0.3 | else |
| Critical | r > 0.8 | r > 0.5 | r > 0.3 | else |

### 4.3 Structural Invariants

These are enforced BEFORE budget-driven quantization:
- System → Q8 (never compressed)
- Last 3 messages → Q8 (always preserved)
- User → minimum Q4 (never dropped)
- Tool → Q8 (always preserved)
- Assistant with tool_calls → Q8 (always preserved)

---

## 5. Message Sanitization Specification

### 5.1 Phase Sequence

| Phase | Input | Output |
|---|---|---|
| 1. System-first | Any message order | All system messages at front |
| 2. Merge consecutive | Same-role adjacent | Merged with `---` separator |
| 3. User-first | First non-system ≠ user | First user moved to front |
| 5. Orphan filter | Tool without parent assistant | Orphan tools removed |
| 6. Leading cleanup | Leading non-system/non-user | Leading non-user removed |
| 7. User injection | No user message exists | Synthetic user injected |

Phase 4 was removed during development (merged into Phase 5).

---

## 6. RAG Index Specification

### 6.1 Entry Schema

```typescript
RagEntry = {
  id: string;          // 16-char hex
  timestamp: number;   // ms epoch
  keywords: string[];  // from interaction
  tags: string[];      // from compressor
  tier: string;        // effort tier or Q0/Q1/Q2
  modelUsed: string;   // provider/model
  originalRole: string;// system/user/assistant/tool
  adequacyScore: number; // 0.0–1.0
  summary: string;     // compressed text
  originalTokens: number;
  compressedTokens: number;
}
```

### 6.2 Query Algorithm

```
1. Filter entries by TTL (24h)
2. For each entry, compute overlap score:
   searchTerms = unique(keywords ∪ tags)
   score = count(keywords where keyword ⊆ searchTerm or searchTerm ⊆ keyword)
3. Return top N by score
```

---

## 7. Feedback Store Specification

### 7.1 Entry Schema

```typescript
FeedbackEntry = {
  id: string;
  timestamp: number;
  promptHash: string;     // first 16 chars of SHA-256
  predictedTier: string;  // router's classification
  actualTier: string|null;// LLM-judged ground truth
  modelUsed: string;      // provider/model
  responseTokens: number;
  adequacyScore: number|null;
  escalated: boolean;
  userSatisfaction: number|null;
}
```

### 7.2 Self-Evaluation

Quick heuristic score (0–1):
- Token range match: 0–0.4
- Response length: 0–0.2
- Latency sanity: 0–0.2
- Repetition penalty: 0–0.2

LLM judge (10% sampling, async):
- Model: qwen3.6-plus
- Prompt: "Evaluate whether this response adequately addresses the prompt"
- Returns: adequacy (0–1) + correct_tier

---

## 8. Training Mode Specification

### 8.1 Label Sources

| Source | Weight | Quality | Trigger |
|---|---|---|---|
| GOLD (human vote) | 1.0 | 100% | Aleatory sampling |
| SILVER (RAG) | 0.3→0.7 | 70–80% | 3+ RAG entries agree |
| BRONZE (LLM) | 0.5 | 80–85% | LLM judge async |

### 8.2 Sampling Rules

- Never on trivial/extreme
- Always when confidence < alwaysAskThreshold (0.5)
- Base rate: 10%
- 2× rate on moderate/heavy/intensive
- Fatigue decay: rate × e^(-votes/50)
- Cap: 50%

### 8.3 Calibration

- Bronze: after 10+ comparisons → weight = 0.5 × agreement_rate (clamped 0.1–0.8)
- Silver: after 10+ comparisons → weight = 0.3 × agreement_rate (clamped 0.1–0.9, only increase if agreement > 70%)

### 8.4 Phase Transitions

| Phase | Interactions | RAG Weight |
|---|---|---|
| Disabled | 0–49 | 0 |
| Low | 50–199 | 0.15 (0.3 × 0.5) |
| Full | 200+ | calibrated (≥0.15) |
