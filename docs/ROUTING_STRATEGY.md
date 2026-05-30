# GateSwarm v0.4.4 — Model Routing Strategy

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. Overview

GateSwarm routes every request to the optimal model based on prompt complexity. The routing strategy balances **cost** (use smallest capable model), **quality** (use most capable model for hard tasks), and **latency** (use fastest model for simple tasks).

---

## 2. Tier Architecture

### 2.1 Effort Levels

| Tier | Score Range | Description | Example Prompts |
|---|---|---|---|
| **trivial** | 0.00–0.1557 | Greetings, simple facts, yes/no | "hi", "2+2", "what time is it" |
| **light** | 0.1557–0.1842 | Short Q&A, summaries, formatting | "summarize this", "fix typos" |
| **moderate** | 0.1842–0.2788 | Analysis, explanations, code review | "explain this function", "review this code" |
| **heavy** | 0.2788–0.3488 | Code generation, multi-constraint | "write an API endpoint with auth", "design a schema" |
| **intensive** | 0.3488–0.4611 | Complex systems, architecture | "design a microservice architecture", "plan migration strategy" |
| **extreme** | 0.4611–1.00 | Novel generation, deep reasoning | "build a distributed system from scratch", "create a new framework" |

### 2.2 Tier → Model Mapping

| Tier | Model | Provider | Max Tokens | Thinking | Context |
|---|---|---|---|---|---|
| trivial | glm-4.5-air | zai | 256 | OFF | 200K |
| light | glm-4.7-flash | zai | 512 | OFF | 200K |
| moderate | MiniMax-M2.5 | bailian | 2048 | OFF | 131K |
| heavy | qwen3.5-plus | bailian | 4096 | ON | 1M |
| intensive | qwen3.5-plus | bailian | 4096 | ON | 1M |
| extreme | qwen3.6-plus | bailian | 8192 | ON | 1M |

### 2.3 Cost Efficiency

| Tier | Model | Relative Cost | Rationale |
|---|---|---|---|
| trivial | glm-4.5-air | Lowest | 7B model, minimal compute |
| light | glm-4.7-flash | Low | 10B model, flash variant |
| moderate | MiniMax-M2.5 | Medium | ~13B model, code-capable |
| heavy | qwen3.5-plus | Medium-high | 14B model, strong reasoning |
| intensive | qwen3.5-plus | Medium-high | Same model, longer output allowed |
| extreme | qwen3.6-plus | Highest | 32B model, flagship reasoning |

---

## 3. Scoring Engine

### 3.1 25-Feature Extraction

Each prompt is analyzed across three groups:

**Group 1: v3.3 Heuristic (9 binary signals)**
- `has_question` — contains `?`
- `has_code` — contains `function`, `class`, `def`, `import`, `const`
- `has_imperative` — starts with action verb (`write`, `create`, `build`, etc.)
- `has_arithmetic` — contains math operators
- `has_sequential` — contains `first`, `then`, `finally`, `step`
- `has_constraint` — contains `must`, `should`, `required`, `only`
- `has_context` — contains `given`, `consider`, `assume`, `suppose`
- `has_architecture` — contains `architecture`, `system design`, `microservice`
- `has_design` — contains `technical design`, `implementation plan`, `deployment`

**Group 2: v3.2 Cascade (6 structural features)**
- `sentence_count` — number of sentences
- `avg_word_length` — average word length
- `question_technical` — question with technical terms
- `technical_design` — design/architecture keyword present
- `technical_terms` — count of technical terms (api, docker, kubernetes, etc.)
- `multi_step` — multi-step instruction markers

**Group 3: v0.4 Domain (10 new features)**
- `has_negation` — `don't`, `not`, `never`, `avoid`
- `entity_count` — named entities (companies, dates, amounts)
- `code_block_size` — lines in code blocks
- `domain_finance/legal/medical/engineering` — domain keyword detection
- `temporal_references` — deadlines, urgency markers
- `output_format_spec` — JSON/XML/table format requirements
- `prior_context_needed` — references to previous discussion
- `novelty_score` — lexical diversity (unique words / total words)
- `multi_domain` — multiple domain keywords present
- `user_expertise_level` — sophisticated vocabulary detection

### 3.2 Scoring Formula

```
signals = has_question + has_code + has_imperative + has_arithmetic
        + has_sequential + has_constraint + has_context
        + has_architecture + has_design  // 0–9

heuristic = signals × 0.15 + log1p(word_count) × 0.08 + has_context × 0.10 + bonus
```

System bonus depends on word count + system-level signal count:
- High word count (≥15) + high system signals (≥5) → +0.35
- ...
- Any system signals (≥2) → +0.03

### 3.3 Ensemble Voting

```
finalScore = heuristic × 0.55 + ragSignal × 0.25 + historyBias
```

**Confidence:**
- Single method (current state) → 0.7
- Multi-method agreement (with cascade) → variance-based

**Escalation:**
- confidence > 0.8 → stay at predicted tier
- confidence 0.5–0.8 → escalate one tier (safety margin)
- confidence < 0.5 → route to intensive (safe default)

---

## 4. Fallback Chain

When the primary model fails, GateSwarm tries fallback models in order:

### 4.1 Retry Conditions

| Status Code | Meaning | Action |
|---|---|---|
| 429 | Rate limited | Try next fallback |
| 1305 | ZAI quota exceeded | Try next fallback |
| 1308 | ZAI rate limited | Try next fallback |
| 500–599 | Server error | Try next fallback |
| Timeout (120s) | Provider unresponsive | Try next fallback |

### 4.2 Fallback Models per Tier

| Tier | Primary | Fallback 1 | Fallback 2 | Fallback 3 |
|---|---|---|---|---|
| trivial | glm-4.5-air | glm-4.7-flash | glm-4.7 | kimi-k2.5 |
| light | glm-4.7-flash | glm-4.7 | glm-4.5-air | MiniMax-M2.5 |
| moderate | MiniMax-M2.5 | qwen3.5-plus | kimi-k2.5 | glm-4.7-flash |
| heavy | qwen3.5-plus | qwen3.6-plus | MiniMax-M2.5 | glm-4.7-flash |
| intensive | qwen3.5-plus | qwen3.6-plus | kimi-k2.5 | MiniMax-M2.5 |
| extreme | qwen3.6-plus | qwen3.6-max-preview | qwen3.5-plus | kimi-k2.5 |

### 4.3 Timeout Budget

Each target has a 120s timeout. Total budget = 120s × number of targets. For a tier with 4 fallbacks, the maximum time before failure is 480s (8 minutes).

---

## 5. Provider Configuration

### 5.1 Supported Providers

| Provider | ID | Base URL | Models |
|---|---|---|---|
| Bailian (Coding Plan) | `bailian` | `coding-intl.dashscope.aliyuncs.com` | qwen3.6-plus, qwen3.5-plus, MiniMax-M2.5, kimi-k2.5 |
| Z.AI (GLM Coding Lite) | `zai` | `api.z.ai` | glm-4.5-air, glm-4.7-flash, glm-4.7 |

### 5.2 Provider Detection

The router detects the provider from the model name:
- `glm-*` → zai
- `qwen*`, `kimi*`, `MiniMax*` → bailian
- `openrouter/*` → openrouter

---

## 6. Agent Tier Profiles

Each registered agent has a tier profile that maps effort levels to preferred models:

| Profile | Use Case |
|---|---|
| **cost-optimized** | default — smallest models for low tiers |
| **quality** | bmad-dev, bmad-architect — higher baseline for dev tasks |
| **balanced** | jack — cost/quality tradeoff |
| **benchmark** | Testing — OpenRouter models |

---

## 7. Routing Examples

### Example 1: Simple greeting

```
Prompt: "hi"
Features: 0 signals, 1 word
Score: 0.042
Tier: trivial
Model: glm-4.5-air
```

### Example 2: Code review request

```
Prompt: "Review this function for security vulnerabilities"
Features: has_imperative=1, has_code=1, has_constraint=0, tech_terms=2
Score: 0.218
Tier: heavy
Model: qwen3.5-plus
Confidence: 0.7 → escalate to intensive
Final model: qwen3.5-plus (intensive)
```

### Example 3: Architecture design

```
Prompt: "Design a distributed caching system with Redis, Kafka event sourcing, and circuit breaker pattern for a high-traffic e-commerce platform"
Features: has_imperative=1, has_architecture=1, has_design=1, has_context=0,
          has_code=1, has_constraint=0, has_sequential=0, has_arithmetic=0,
          has_question=0, technical_terms=5, multi_step=0, entity_count=2,
          domain_engineering=1, multi_domain=1
Score: 0.512
Tier: extreme
Model: qwen3.6-plus
```

---

## 8. Monitoring Routing Decisions

### Gateway Logs

```
🧠 [jack] Score: 0.204 → heavy → bailian/qwen3.5-plus
🔀 Routing to bailian/qwen3.5-plus
```

### Metrics Endpoint

```bash
curl http://localhost:8900/v04/status | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Version: {d[\"version\"]}')
for tier, tm in d['tierModels'].items():
    print(f'  {tier}: {tm[\"model\"]} ({tm[\"provider\"]}) thinking={tm[\"enable_thinking\"]}')
"
```

### Benchmark Logs

```bash
tail -5 data/benchmark-logs/$(date +%Y-%m-%d).jsonl | python3 -m json.tool
```

Each entry:
```json
{
  "timestamp": "2026-05-14T14:01:41.412Z",
  "tier": "moderate",
  "routed_model": "bailian/MiniMax-M2.5",
  "tokens_in": 40,
  "tokens_out": 38,
  "latency_ms": 7206,
  "provider": "bailian",
  "status": "success"
}
```
