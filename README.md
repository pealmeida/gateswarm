# GateSwarm MoMA Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

**Self-optimizing complexity classifier for Mixture-of-Agents routing.**

6-tier prompt scoring → cheapest capable model. Zero GPU, 74.7% accuracy.

### Why use it

- **Cut costs 90%+** — send 60% of traffic to free/cheap models without degrading quality
- **Zero-latency routing** — 12ms classification, no extra LLM calls
- **Drop-in proxy** — OpenAI-compatible endpoint, any agent connects in seconds
- **Self-optimizing** — learns from every interaction, recalibrates over time
- **No GPU needed** — runs on any CPU with pre-trained weights

### How it works

```text
Prompt → Score complexity → Pick cheapest capable model → Forward → Learn
```

A lightweight classifier (5 binary cascades, 15 features) scores each prompt into one of 6 tiers — trivial to extreme — in ~12ms. Each tier maps to a specific model, balancing cost and capability. A full HTTP gateway (TypeScript) adds fallback chains, RAG context, conversation compression, and a feedback loop that continuously improves routing decisions.

---

## Quick Start

### Option A: Scoring engine (Python, 30 seconds)

```bash
pip install numpy
python router.py "Write a REST API in Python"
```

Output:
```json
{"tier": "heavy", "score": 0.42, "confidence": 0.82, "model": "glm-5.1", "provider": "zai"}
```

That's it. No GPU, no heavy ML frameworks. The pre-trained weights ship with the repo.

### Option B: Full gateway (TypeScript, 2 minutes)

```bash
cd gateway
cp .env.example .env   # Edit with your API keys
npm install
npx tsx src/moma-gateway.ts --port 8900
```

Connect any agent:
```bash
curl http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gateswarm","messages":[{"role":"user","content":"Hello"}]}'
```

### Option C: Use as a library

```python
from router import score_prompt, score_prompts

# Single prompt
result = score_prompt("Write a REST API in Python")
# → {"tier": "heavy", "score": 0.42, "model": "glm-5.1", "provider": "zai"}

# Batch score
results = score_prompts(["hello", "Explain quantum computing", "Design a distributed architecture"])
```

---

## How It Works

### 6-Tier Complexity Classification

| Tier | Score Range | Typical Prompt | Routed Model |
|------|-------------|----------------|--------------|
| **trivial** | 0.00 – 0.08 | Greetings, simple facts | glm-4.5-air (FREE) |
| **light** | 0.08 – 0.18 | Definitions, formatting | glm-4.7-flash ($0.02/M) |
| **moderate** | 0.18 – 0.32 | Code help, explanations | glm-4.7 ($0.10/M) |
| **heavy** | 0.32 – 0.52 | API design, refactoring | glm-5.1 ($0.13/M) |
| **intensive** | 0.52 – 0.72 | Architecture, deep analysis | qwen3.6-plus ($0.26/M) |
| **extreme** | 0.72 – 1.00 | Strategic thinking, research | qwen3.6-plus ($0.26/M) |

### 15-Feature Complexity Vector

Each prompt is scored on 15 features extracted locally (no LLM calls):

| Feature | Type | What it measures |
|---------|------|-----------------|
| `word_count` | int | Prompt length |
| `sentence_count` | int | Structural complexity |
| `avg_word_length` | float | Vocabulary sophistication |
| `has_code` | bool | Contains code blocks |
| `has_question` | bool | Is a question |
| `has_imperative` | bool | Starts with a command verb |
| `technical_terms` | int | Tech keyword density |
| `question_technical` | bool | Technical question |
| `architecture` | bool | System design keywords |
| `technical_design` | bool | Implementation plan keywords |
| `multi_step` | bool | Multiple steps implied |
| `requires_context` | bool | Needs external context |
| `domain_specificity` | float | Domain jargon density |
| `ambiguity_score` | float | Vague language density |
| `four_plus` | bool | ≥4 complexity signals active |

### Binary Cascade Classifier

Instead of one global model for 6 tiers, the cascade trains 5 independent binary classifiers:

```
trivial? ──Yes──→ TRIVIAL (100% acc)
    │ No
    ▼
light? ──Yes──→ LIGHT (93% acc)
    │ No
    ▼
moderate? ──Yes──→ MODERATE (42% acc)
    │ No
    ▼
heavy? ──Yes──→ HEAVY (39% acc)
    │ No
    ▼
intensive? ──Yes──→ INTENSIVE (19% acc)
    │ No
    ▼
EXTREME (69% acc)
```

Each classifier is trained on balanced 1:1 data and finds its own optimal feature weights. This avoids class imbalance and lets each tier specialize independently.

---

## Customization

### Override Model Assignments

The default model routing uses cost-optimized Chinese LLM providers. Override with your own:

```python
from router import set_tier_models, score_prompt

set_tier_models({
    "trivial":   {"model": "gpt-4o-mini",      "provider": "openai",    "max_tokens": 256},
    "light":     {"model": "gpt-4o-mini",      "provider": "openai",    "max_tokens": 512},
    "moderate":  {"model": "gpt-4o",           "provider": "openai",    "max_tokens": 1024},
    "heavy":     {"model": "claude-sonnet-4-6", "provider": "anthropic", "max_tokens": 2048},
    "intensive": {"model": "claude-sonnet-4-6", "provider": "anthropic", "max_tokens": 4096},
    "extreme":   {"model": "claude-opus-4-6",   "provider": "anthropic", "max_tokens": 8192},
})

result = score_prompt("Design a microservice architecture")
# → {"model": "claude-sonnet-4-6", "provider": "anthropic", ...}
```

### Retrain with Your Data

Use the training pipeline to optimize weights on your own prompts:

```bash
# Install training dependencies
pip install scipy numpy scikit-learn datasets

# Train on public datasets (Alpaca + OpenOrca)
python train.py

# Train with custom data
python train.py --dataset your_prompts.jsonl --output my_weights.json
```

Then load custom weights:

```python
from router import _cascade
_cascade.load("my_weights.json")
```

### Build a Personalized Dataset

LLMFit is the built-in dataset factory that creates training data from your own workspace:

```bash
# Extract prompts from your codebase / chat logs
python -m llmfit generate --path . --output datasets/raw.jsonl

# Label with rule-based complexity estimation
python -m llmfit label --input datasets/raw.jsonl --output datasets/labeled.jsonl --mode rule

# Validate dataset quality
python -m llmfit validate --input datasets/labeled.jsonl

# Anonymize PII/secrets before sharing
python -m llmfit.anonymizer anonymize --input datasets/raw.jsonl --output datasets/clean.jsonl
```

See `llmfit/` for the full dataset factory toolkit.

---

## Integrations

### Use as a Sidecar Service

Run as a sidecar service alongside any LLM agent:

```bash
# Terminal 1: Start the router API
python router.py --serve --port 8080

# In a custom skill, call the router before model selection:
# curl -s -X POST http://localhost:8080/score \
#   -H "Content-Type: application/json" \
#   -d '{"prompt": "'"$PROMPT"'"}' | jq -r '.model'
```

Or import directly in a skill:

```python
import sys; sys.path.insert(0, "/path/to/gateswarm-moma-router")
from router import score_prompt, set_tier_models

result = score_prompt(user_prompt)
# result["model"] → use this for model selection
```

### Use with Pi Agent

```python
# ~/.pi/agent/skills/router_skill.py
from gateswarm.router import score_prompt

def before_model_call(prompt: str, default_model: str) -> str:
    result = score_prompt(prompt)
    return result["model"] if result["confidence"] > 0.7 else default_model
```

### Self-Improvement Integration

```python
# Integrate the feedback loop for continuous improvement
from router import score_prompt

def select_model_for_task(task_description: str) -> str:
    result = score_prompt(task_description)
    return result["model"]
```

### Use with OpenCode / Codex

```bash
# Pre-route before calling your coding agent
TIER=$(python /path/to/router.py "$PROMPT" --json | jq -r .tier)

case $TIER in
  trivial|light)   MODEL="opencode/minimax-m2.5-free" ;;
  moderate|heavy)  MODEL="opencode/kimi-k2.5-free" ;;
  intensive)       MODEL="zai/glm-5.1" ;;
  extreme)         MODEL="claude-opus-4-6" ;;
esac

opencode --model "$MODEL" --prompt "$PROMPT"
```

### Use with LangChain / LiteLLM / any LLM Framework

```python
from router import score_prompt
import litellm

result = score_prompt(user_prompt)
response = litellm.completion(model=result["model"], messages=[...])
```

---

## Model Recommendations

### Cloud API Models

| Tier | Cost-Optimized | Balanced | Premium |
|------|----------------|----------|---------|
| **trivial** | `glm-4.5-air` (ZAI, FREE) | `gpt-4o-mini` (OpenAI) | `gemini-3-flash` (Google) |
| **light** | `glm-4.7-flash` (ZAI, $0.02/M) | `gpt-4o-mini` (OpenAI) | `gemini-3-flash` (Google) |
| **moderate** | `glm-4.7` (ZAI, $0.10/M) | `qwen3.5-9b` (OpenRouter) | `gpt-4o` (OpenAI) |
| **heavy** | `glm-5.1` (ZAI, $0.13/M) | `qwen3.6-plus` (Bailian) | `claude-sonnet-4.6` (Anthropic) |
| **intensive** | `qwen3.6-plus` (Bailian) | `claude-sonnet-4.6` (Anthropic) | `gpt-5.5` (OpenAI) |
| **extreme** | `qwen3.6-plus` (Bailian) | `claude-opus-4.6` (Anthropic) | `gpt-5.5` (OpenAI) |

### Local Models (Ollama / vLLM / llama.cpp)

| Tier | Fast (4-bit) | Balanced (8-bit) | Best (FP16) |
|------|-------------|------------------|------------|
| **trivial** | `qwen3-0.6b` | `phi-4-mini` | `qwen3-1.7b` |
| **light** | `qwen3-1.7b` | `gemma-3-4b` | `llama-4-scout-17b` |
| **moderate** | `qwen3-4b` | `llama-4-scout-17b` | `qwen3-8b` |
| **heavy** | `qwen3-8b` | `llama-4-maverick-17b` | `deepseek-r1-14b` |
| **intensive** | `deepseek-r1-14b` | `qwen3-14b` | `qwen3-32b` |
| **extreme** | `qwen3-32b` | `deepseek-r1-32b` | `qwen3-72b` |

> **Tip:** Override defaults with `set_tier_models()` to match your provider and budget. See [Customization](#customization).

### Docker

```bash
# Build (full: training + routing)
docker build -t gateswarm-moma-router .

# Build (inference only, minimal)
docker build -f Dockerfile.inference -t gateswarm-moma-router:infer .

# Run the API server
docker run -p 8080:8080 gateswarm-moma-router python router.py --serve --port 8080
```

---

## Documentation

Start here and go deeper:

### Getting Started
| Document | What's Inside |
|----------|---------------|
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | System overview, component diagram, data flow |
| **[GATEWAY_QUICKSTART.md](docs/GATEWAY_QUICKSTART.md)** | Full gateway setup with agent connection guides |
| **[ROUTING_STRATEGY.md](docs/ROUTING_STRATEGY.md)** | Model selection, fallback chains, confidence escalation |

### Deep Dive
| Document | What's Inside |
|----------|---------------|
| **[CONTEXT_COMPRESSION_GUIDE.md](docs/CONTEXT_COMPRESSION_GUIDE.md)** | TurboQuant compression (Q8→Q0), conversation sharing |
| **[PERSISTENCE_GUIDE.md](docs/PERSISTENCE_GUIDE.md)** | RAG lifecycle, feedback store, data persistence |
| **[TRAINING_MODE_GUIDE.md](docs/TRAINING_MODE_GUIDE.md)** | Semi-supervised learning, gold/silver/bronze labels |

### Reference
| Document | What's Inside |
|----------|---------------|
| **[PRD.md](docs/PRD.md)** | Product requirements and user stories |
| **[REQUIREMENTS.md](docs/REQUIREMENTS.md)** | Technical specifications |
| **[SAFETY.md](docs/SAFETY.md)** | Security guidelines, API key management |
| **[INTEGRATION.md](docs/INTEGRATION.md)** | How to connect agents and frameworks |
| **[docs/research/](docs/research/)** | Training reports, cascade analysis, routing strategy |

## Project Structure

```
gateswarm-moma-router/
│
├── ─── Scoring Engine (Python) ───
├── router.py                    # Production scorer (standalone, ~450 LOC)
├── train.py                     # Training pipeline (cascade + optimization)
├── v32_cascade_weights.json     # Pre-trained weights (5 classifiers)
├── requirements.txt             # Full deps (training)
├── Dockerfile                   # Full build
├── Dockerfile.inference         # Minimal inference build
│
├── llmfit/                      # Dataset Factory
│   ├── llmfit.py                # Core: extract → label → validate → optimize
│   ├── anonymizer.py            # 35-rule PII/secret redaction
│   ├── self_eval.py             # Self-evaluation + SQLite feedback buffer
│   └── datasets/
│       └── gpd_generator.py     # 50K synthetic prompt generator
│
├── ─── Gateway (TypeScript) ───
├── gateway/
│   ├── src/
│   │   ├── moma-gateway.ts       # HTTP proxy server (OpenAI-compatible)
│   │   ├── feature-extractor-v04.ts  # 25-feature prompt analysis
│   │   ├── ensemble-voter.ts    # Heuristic + RAG + history voting
│   │   ├── rag-index.ts         # Persistent RAG context retrieval
│   │   ├── feedback-store.ts    # Self-optimizing feedback loop
│   │   ├── agent-registry.ts    # Multi-agent config management
│   │   ├── turboquant-compressor.ts  # Conversation compression
│   │   ├── training-mode.ts     # Semi-supervised learning pipeline
│   │   ├── self-eval.ts         # LLM judge + accuracy tracking
│   │   ├── retraining.ts        # Auto-retrain + hot-swap weights
│   │   ├── gateswarm-cli.ts     # 11 CLI commands
│   │   ├── intent-engine*.ts    # Intent scoring
│   │   ├── vote-persistence.ts  # Training vote tracking
│   │   ├── benchmark-logger.ts  # Cost savings tracking
│   │   └── types.ts             # Shared type definitions
│   ├── public/                  # Dashboard, ONNX models, tokenizer
│   ├── scripts/                 # cascade-retrain, start gateway
│   ├── tests/                   # Unit + integration tests (8 files)
│   ├── package.json
│   ├── tsconfig.json
│   └── v04_config.json          # Tier models + ensemble config
│
├── docs/
│   ├── ARCHITECTURE.md           # System architecture
│   ├── GATEWAY_QUICKSTART.md     # Gateway setup guide
│   ├── ROUTING_STRATEGY.md       # Model routing decisions
│   ├── CONTEXT_COMPRESSION_GUIDE.md
│   ├── PERSISTENCE_GUIDE.md
│   ├── TRAINING_MODE_GUIDE.md
│   ├── PRD.md
│   ├── REQUIREMENTS.md
│   ├── SAFETY.md                 # Security guidelines
│   ├── INTEGRATION.md            # How to connect agents
│   └── research/                 # Technical reports
│       ├── V3_2_CASCADE_REPORT.md
│       └── V3_3_MODEL_ROUTING_STRATEGY.md
│
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE                       # MIT
```

## Cost Savings

With proper tier routing, you send each prompt to the cheapest capable model:

| Scenario | 10K req/day | 100K req/day | 1M req/day |
|----------|-------------|--------------|------------|
| **Always Opus** | $6.36 | $63.59 | $635.94 |
| **Routed** | $0.24 | $2.35 | $23.54 |
| **Savings** | **96.3%** | **96.3%** | **96.3%** |

Training cost: **~$0.01** per run. No GPU needed — runs on any CPU in under a minute.

## Research Foundations

This router implements patterns validated by the following papers:

### RouteMoMA: Dynamic Routing without Pre-Inference (Wang et al., 2026)

The most directly related work. RouteMoMA proves that lightweight pre-inference scoring is the key to efficient MoMA:

- **Lightweight scorer:** An SLM (mDeBERTaV3-base) predicts coarse-grained performance per model from the query alone — no inference needed. Our regressor follows this exact pattern but targets continuous complexity scoring.
- **No pre-inference:** The scorer narrows candidates before any LLM runs. This eliminates the #1 cost driver in MoMA systems.
- **89.8% cost reduction, 63.6% latency reduction** validated on large-scale pools (10+ models).
- **Mixture of judges:** Post-hoc self/cross-assessment refines scores using actual outputs (posterior correction at no extra cost). This is a future extension for our router.
- **Model ranking:** Balances performance, cost, and latency — exactly our tier→model mapping.

### MoMA: Mixture of Models and Agents (Guo et al., 2025)

Generalized model-agent routing framework:

- **Pareto-optimal routing:** Don't just pick the cheapest — pick the cheapest that meets a quality threshold.
- **Capability profiling:** 2.25M-instance training corpus proves small models outperform large ones on their sweet-spot tasks.
- **Unified routing:** First framework to route across both LLMs and agents, enabling full MoMA orchestration.

### Mixture of Agents (Wang et al., 2024)

Original MoMA architecture — multi-round parallel reasoning among medium models surpasses GPT-4 Omni. Our router makes MoMA practical by eliminating unnecessary model invocations.

### RouteLLM (Ong et al., 2024)

Binary routing between strong/weak models. We generalize to 6 tiers instead of 2, enabling finer-grained cost optimization. Their preference-data training approach also informs our complexity labeling.

### RouterDC (Chen et al., 2024)

Dual contrastive learning for routing accuracy. RouteMoMA adopts this approach (sample-LLM + sample-sample contrastive loss). Future versions of our regressor may incorporate contrastive training.

---

## Version Progression

GateSwarm evolved from a hand-tuned heuristic to a self-optimizing routing engine. Here's the journey:

### v0.1 — The First Heuristic (May 5, 2026)

**What it was:** A static, hand-tuned 13-feature complexity scorer.

| Aspect | Detail |
|--------|--------|
| Features | 13 hand-picked signals (word count, code, question, imperative, etc.) |
| Weights | Manually assigned, no training data |
| Architecture | Single linear score → 6-tier bucket |
| Accuracy | 53% on 15 manual prompts |
| Runtime | Python, zero dependencies |

**Key limitation:** No training data. Weights were guesses — they worked on some prompts, failed on others. No way to know which.

---

### v0.2 — Manual Tuning & Bonuses (May 6, 2026)

**What changed:** Added bonus multipliers for specific signal patterns.

| Aspect | v0.1 → v0.2 |
|--------|-------------|
| New signals | `question_technical` (+0.12), `architecture` (+0.15–0.28), `technical_design` (+0.18) |
| Length dampener | Skip dampening for architecture-heavy prompts |
| Accuracy | 53% → 67% (15 prompts), but dropped to 40% on 30 prompts |
| Problem | **Confirmed overfitting** — manual tuning worked on known prompts, failed on new ones |

**Key lesson:** Manual tuning doesn't scale. We needed data-driven optimization.

---

### v0.3 — Data-Driven Training Pipeline (May 7–11, 2026)

**What changed:** Full ML pipeline with scipy optimization, 75K training samples, and the binary cascade architecture.

| Sub-version | Key innovation | Accuracy |
|-------------|---------------|----------|
| **v0.3.0** | scipy MSE optimization, 13→15 features, synthetic labels | 87.2% (Alpaca 10K) |
| **v0.3.1** | Multi-dataset (Alpaca + GPD 50K synthetic + workspace) | 99.6% (GPD), 87.2% (Alpaca) |
| **v0.3.2** | Binary cascade — 5 independent classifiers instead of one global model | **74.7%** (all 6 tiers, 75K) |
| **v0.3.3** | LLM-as-Judge labeling, label correction, Chief Scientist evaluation | 99% heuristic validation |
| **v0.3.4** | Label correction pipeline, production inference handler, Docker specialization | Production-ready |
| **v0.3.5** | Rebrand to GateSwarm, standalone `router.py`, HTTP API, CLI, LLMFit toolkit | **Stable release** |

**Key innovations in v0.3:**

1. **Binary cascade classifier** — Instead of one model guessing 6 tiers, 5 binary classifiers each specialize in one boundary. Trivial: 100%, Light: 93%, but moderate/heavy struggle (39–42%).
2. **75K training samples** — Alpaca (10K) + GPD synthetic (50K) + workspace data (15K)
3. **LLM-as-Judge** — qwen3.6-plus validates labels empirically, breaking the circularity of formula-based labels
4. **LLMFit dataset factory** — Extract → label → validate → anonymize your own training data
5. **Chief Scientist evaluation** — Independent review found formula labels had 2.0/10 validity, prompting the pivot to empirical labeling

**v0.3 per-tier accuracy:**

| Tier | Accuracy | Status |
|------|----------|--------|
| Trivial | 100.0% | ✅ Solved |
| Light | 93.1% | ✅ Good |
| Moderate | 42.4% | ⚠️ Needs work |
| Heavy | 38.7% | ⚠️ Needs work |
| Intensive | 19.3% | ❌ Poor |
| Extreme | 68.8% | ⚠️ Moderate |

**What ships in the stable repo (v0.3.5):**
- `router.py` — Standalone scorer (HTTP API + CLI + batch)
- `train.py` — Full training pipeline
- `llmfit/` — Dataset factory with anonymizer
- `v32_cascade_weights.json` — Pre-trained weights

---

### v0.4 — Self-Optimizing Gateway (May 11–14, 2026)

**What changed:** Rewrote as a TypeScript API gateway with ensemble scoring, persistent RAG, context continuity, and a self-improving feedback loop.

| Aspect | v0.3 (Python classifier) | v0.4 (TypeScript gateway) |
|--------|--------------------------|---------------------------|
| **Language** | Python (standalone) | TypeScript (gateway server) |
| **Scoring** | Cascade (5 binary classifiers) | **Ensemble** — heuristic 55% + RAG 25% + history 20% |
| **Features** | 15 | **25** — added domain detection, entity count, code block size, expertise level |
| **Context** | Stateless | **TurboQuant compression** — Q8/Q4/Q2/Q1/Q0 conversation summaries |
| **Memory** | None | **Persistent RAG** — JSON-file backed, survives restarts |
| **Learning** | Retrain manually | **Feedback loop** — auto-logs, LLM judge (10%), hot-swap weights |
| **Routing** | Fixed model assignments | **Confidence-based** — escalate when uncertain, fallback chains |
| **Continuity** | None | **Context anchor** — key decisions survive model switches |
| **Training** | Formula labels | **Semi-supervised** — gold (LLM) + silver (RAG) + bronze (heuristic) labels |
| **CLI** | Score prompts | **11 commands** — status, models, reasoning, retrain, feedback, rag, etc. |

**v0.4 sub-versions:**

| Version | Focus |
|---------|-------|
| **v0.4.0** | Ensemble voter, RAG index, feedback loop, 25 features, reasoning toggle, CLI |
| **v0.4.3** | Timeout hardening (120s provider timeout, 30s SSE idle), auto-restart loop |
| **v0.4.4** | Context continuity, RAG/feedback persistence, training mode wired, LLM judge anti-circularity |

**Architecture:**

```
Client (any LLM agent)
    │
    ▼
┌─────────────────────────────────────────┐
│           GateSwarm v0.4.4              │
│                                         │
│  1. Score complexity (ensemble vote)    │
│  2. Route to optimal tier/model         │
│  3. Compress long conversations         │
│  4. Retrieve RAG context                │
│  5. Inject continuity across switches   │
│  6. Sanitize → Forward → Fallback       │
│  7. Self-eval + feedback + training     │
└─────────────┬───────────────────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
Bailian (Qwen)     Z.AI (GLM)
qwen3.6-plus       glm-4.5-air
qwen3.5-plus       glm-4.7-flash
MiniMax-M2.5       glm-4.7
kimi-k2.5
```

---

### Summary: What Changed Between Generations

| Generation | Core Idea | Strength | Weakness |
|------------|-----------|----------|----------|
| **v0.1** | Hand-tuned heuristic | Zero dependencies | Guesswork, 53% |
| **v0.2** | Bonus multipliers | Better on edge cases | Overfitting confirmed |
| **v0.3** | Data-driven training + cascade | 74.7% on 75K, no GPU | Moderate/heavy tiers weak (39–42%) |
| **v0.4** | Ensemble + RAG + feedback loop | Self-optimizing, context-aware | Requires gateway infra |

---

## Version Channels

Both components live in this single repo:

| Component | Version | Status | Use for |
|-----------|---------|--------|--------|
| **Scoring Engine** (`router.py`) | v0.3.5 | ✅ Stable | Library usage, CLI, training pipeline |
| **Gateway** (`gateway/`) | v0.4.4 | 🧪 Beta | Full HTTP proxy, RAG, ensemble scoring |

## Safety

Read [docs/SAFETY.md](docs/SAFETY.md) before deploying in production. GateSwarm is a routing tool — it does not filter or moderate content.

---

## License

MIT License — see [LICENSE](LICENSE).

## Citation

```bibtex
@misc{gateswarm-moma-router,
  title={GateSwarm MoMA Router: Self-Optimizing Complexity Classification for Model Routing},
  author={Pedro Almeida},
  year={2026},
  url={https://github.com/pealmeida/gateswarm-moma-router}
}
```
