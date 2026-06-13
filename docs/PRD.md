# GateSwarm MoMA Router v0.4.4 — Product Requirements Document

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14
**Status:** Production

---

## 1. Problem Statement

LLM providers offer models with vastly different capabilities and costs. A trivial greeting shouldn't use the most expensive model, and a complex architecture question shouldn't be handled by a lightweight one. Manually selecting the right model for every request is impractical.

Additionally, long conversations exceed context windows and API costs grow linearly with conversation length.

---

## 2. Product Vision

GateSwarm is an **intelligent routing layer** that automatically:
- Scores prompt complexity and routes to the right model
- Compresses long conversations to fit within budget
- Learns from every interaction to improve routing accuracy
- Maintains conversation context across model switches

---

## 3. Goals

| Goal | Metric | Target |
|---|---|---|
| Routing accuracy | Per-tier correct classification | ≥85% overall, ≥80% moderate+ |
| Cost efficiency | Baseline cost vs actual cost | 100% savings (Coding Plan) |
| Latency | P50 response time | <5s for light, <30s for heavy+ |
| Context preservation | No context loss during model switches | 0 data loss incidents |
| Learning effectiveness | Retraining trigger accuracy | ≥500 interactions |

---

## 4. User Personas

### Product Owner (Primary User)
- Uses GateSwarm via Pi agent terminal
- Wants: automatic routing, no manual model selection, cost control
- Technical: reads logs, understands architecture, adjusts config

### Primary Agent (Digital Twin)
- Uses GateSwarm as its MoMA provider
- Wants: reliable routing, persistent context, self-improvement
- Technical: configures tiers, monitors feedback, enables training

### Self-Improving Agent
- Uses GateSwarm for self-improving tasks
- Wants: consistent routing, feedback loop data
- Technical: reads v04/status endpoint

### BMAD Agents (dev, architect, pm, qa, ux)
- Registered agents with tier profiles
- Wants: quality-appropriate routing per role
- Technical: tierConfig maps role to model preferences

---

## 5. Functional Requirements

### 5.1 Complexity Scoring
- FR-1: Score every incoming prompt on a 0–1 complexity scale
- FR-2: Use 25-feature extraction (binary + structural + domain)
- FR-3: Combine heuristic (55%), RAG signal (25%), history bias (20%)
- FR-4: Apply confidence-based escalation (escalate if confidence 0.5–0.8)
- FR-5: Safe default to intensive if confidence < 0.5

### 5.2 Model Routing
- FR-6: Map complexity score to effort tier (6 tiers)
- FR-7: Each tier maps to a specific provider + model
- FR-8: enable_thinking toggle per tier
- FR-9: Fallback chain for each tier (3–4 fallback models)

### 5.3 Context Compression
- FR-10: Compress conversations exceeding dynamic threshold
- FR-11: 5-level quantization (Q8, Q4, Q2, Q1, Q0)
- FR-12: Structural invariants: user min Q4, tool Q8, system Q8
- FR-13: Skip compression for short conversations (≤5 msgs, ≤8K tokens)
- FR-14: Hard cap at 60 messages

### 5.4 Message Sanitization
- FR-15: 7-phase structural repair after compression
- FR-16: Support Bailian (Qwen) and ZAI (GLM) message format rules
- FR-17: Inject synthetic user message if none exists after compression

### 5.5 RAG Context
- FR-18: Store compressed message summaries to RAG index
- FR-19: Retrieve relevant context for each request by keyword overlap
- FR-20: Inject retrieved context into system message
- FR-21: Persistent RAG index (survives restarts)
- FR-22: 24-hour TTL, 10K max entries

### 5.6 Context Continuity
- FR-23: Track per-session summaries across model switches
- FR-24: Extract key decisions from responses
- FR-25: Inject continuity summary when model changes between turns
- FR-26: 1-hour session expiry

### 5.7 Feedback & Learning
- FR-27: Record every interaction to persistent feedback store
- FR-28: Async self-evaluation with quick heuristic + LLM judge
- FR-29: Wire LLM judge results back to feedback store (actualTier)
- FR-30: LLM judge uses different model than routing (anti-circularity)
- FR-31: Training mode: gold (human), silver (RAG), bronze (LLM) labels
- FR-32: Aleatory sampling with fatigue decay
- FR-33: Weight calibration after 10+ comparisons per label source

### 5.8 Resilience
- FR-34: 120s timeout per provider target
- FR-35: Retry on rate limits (429, 1305, 1308) and server errors (5xx)
- FR-36: 30s streaming idle timeout
- FR-37: Auto-restart with exponential backoff (start-gateway.sh)

### 5.9 Multi-Agent
- FR-38: Agent authentication via API keys
- FR-39: Per-agent tier profiles (cost-optimized, quality, balanced)
- FR-40: Per-agent benchmark tracking

---

## 6. Non-Functional Requirements

| NFR | Requirement |
|---|---|
| NFR-1 | TypeScript, ESM modules, runs on Node.js 18+ |
| NFR-2 | No external database dependencies (JSON-file persistence) |
| NFR-3 | Memory: in-memory stores capped (10K entries max) |
| NFR-4 | Persistence: auto-flush every 60 seconds |
| NFR-5 | Port: 8900 (configurable via --port flag) |
| NFR-6 | OpenAI-compatible API (/v1/chat/completions) |
| NFR-7 | Zero downtime config hot-reload (v04-config.ts) |
| NFR-8 | Structured logging (emoji-prefixed console.log) |

---

## 7. Tier Model Configuration

| Tier | Model | Provider | Max Tokens | Thinking |
|---|---|---|---|---|
| trivial | glm-4.5-air | zai | 256 | OFF |
| light | glm-4.7-flash | zai | 512 | OFF |
| moderate | MiniMax-M2.5 | bailian | 2048 | OFF |
| heavy | qwen3.5-plus | bailian | 4096 | ON |
| intensive | qwen3.5-plus | bailian | 4096 | ON |
| extreme | qwen3.6-plus | bailian | 8192 | ON |

---

## 8. Success Criteria

GateSwarm v0.4.4 is considered successful when:
1. All requests route without manual intervention
2. No context loss during model switches
3. Feedback store accumulates data across restarts
4. Training mode can be enabled/disabled per agent
5. Fallback chains handle provider degradation gracefully
6. Compression keeps conversations within provider limits
