# GateSwarm v0.4.4 — Context Compression & Sharing Guide

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. Why Compression Matters

Every request to the MoMA gateway includes the **full conversation history**. After 20 turns with tool usage, a session can contain 200+ messages totaling 500K+ tokens. No single API call can send this much, and even if it could, the cost would be prohibitive.

Compression solves this by selectively reducing the conversation to fit within each model's practical input budget.

---

## 2. The Compression Pipeline

### 2.1 Input

```
messages: [
  {role: "system", content: "You are..."},
  {role: "user", content: "What's the weather?"},
  {role: "assistant", content: "Let me check..."},
  {role: "assistant", tool_calls: [{id: "tc_1", ...}]},
  {role: "tool", tool_call_id: "tc_1", content: "25°C sunny"},
  ... (100+ more messages)
  {role: "user", content: "Design a caching strategy"}  ← current prompt
]
```

### 2.2 Output

```
messages: [
  {role: "system", content: "You are... + RAG + continuity"},
  {role: "user", content: "[compressed]"},
  {role: "tool", content: "[compressed]"},
  ... (7–30 messages, depending on compression)
  {role: "user", content: "Design a caching strategy"}  ← always preserved
]
```

---

## 3. Quantization Levels

| Level | Name | Action | Data Loss |
|---|---|---|---|
| **Q8** | Full precision | Keep message as-is | None |
| **Q4** | Stripped | Remove `thinking`/`reasoning_content` blocks | Reasoning steps only |
| **Q2** | Truncated | Keep first sentence, generate summary | Body of message |
| **Q1** | Summarized | Replace with one-line summary, store full to RAG | Full content (in RAG) |
| **Q0** | Dropped | Remove from output, store summary to RAG | Full content (in RAG) |

---

## 4. Structural Invariants

These rules are **hard constraints** — no message can violate them regardless of budget pressure:

| Message Type | Minimum Level | Rationale |
|---|---|---|
| System prompt | Q8 | Essential instructions |
| Last 3 messages | Q8 | Conversation continuity |
| User messages | Q4 | User intent must be preserved |
| Tool results | Q8 | Structural anchors for tool-call chains |
| Assistant with tool_calls | Q8 | tool_calls array must be intact |

---

## 5. Importance Scoring

Each message receives an importance score (radius 0–1) based on:

### 5.1 Components

```
radius = recency × 0.25        // (1 - position/total): recent matters more
       + isToolResult × 0.15   // tool results carry execution state
       + hasToolCalls × 0.20   // assistant making tool calls = structural anchor
       + isDecision × 0.15     // "therefore", "resolved", "agreed"
       + isError × 0.10        // errors, failures, exceptions need context
       + isSystem × 0.15       // system prompts are essential
       + isUser × 0.10         // user input is ALWAYS important
       + semantic × 0.25       // multi-domain content is valuable
```

### 5.2 Semantic Importance

Semantic importance is calculated by counting keyword group coverage:

```
Groups: code, architecture, infra, security, data, decision, error

Examples:
  "The function class interface async await" → code group → 1/7 groups
  "Architecture microservice distributed scalable" → architecture → 1/7 groups
  "Kubernetes docker deployment pipeline" → architecture + infra → 2/7 groups
  "Error timeout crash bug" → error → 1/7 groups
  "Database schema redis cache" → data → 1/7 groups
  "Decision therefore resolved agreed" → decision → 1/7 groups
```

```
semantic_importance = min(1, groups_hit / 4)
// 4+ groups = max semantic importance
```

---

## 6. Budget Calculation

### 6.1 Dynamic Threshold

```
context_window = MODEL_CONTEXT_WINDOWS[target_model]
// e.g., qwen3.5-plus = 1,000,000 tokens
//       glm-4.5-air   = 200,000 tokens

budget = context_window × 0.05  // 5% proactive threshold
threshold = max(4000, min(50000, budget))
// Clamp: minimum 4K, maximum 50K
```

| Model | Context | Threshold |
|---|---|---|
| qwen3.5-plus | 1M | 50,000 |
| qwen3.6-plus | 1M | 50,000 |
| glm-4.7-flash | 200K | 10,000 |
| glm-4.5-air | 200K | 10,000 |

### 6.2 Utilization Ratio

```
utilization = original_tokens / threshold
```

- utilization > 1.0 → compression activates
- utilization 0.7 → moderate compression
- utilization 0.4 → aggressive compression
- utilization 0.2 → critical compression

### 6.3 Skip Condition

If ≤5 messages AND ≤8K tokens → **skip compression entirely**. Most short conversations don't need it.

---

## 7. Hard Caps

Additional safety limits prevent runaway sessions:

| Cap | Value | Purpose |
|---|---|---|
| MAX_MESSAGES_HARD_CAP | 60 | Never send more than 60 messages |
| PRESERVE_LAST_N | 30 | Always keep last 30 messages intact |
| MAX_INPUT_TOKENS_ABSOLUTE | 32,000 | Absolute token ceiling |
| TRUNCATE_OLD_ASSISTANT_TOOL | true | Drop old assistant+tool_call chains |

---

## 8. Compression Levels in Practice

### Example: 20-turn session → heavy tier (qwen3.5-plus, threshold 50K)

**Before compression:** 80 messages, 600K tokens

**Scoring:**
- System message → radius 0.85 → Q8 (keep)
- Messages [1–5] → radius 0.1–0.3 → Q2/Q1 (truncate/summarize)
- Messages [6–75] → radius 0.2–0.6 → mix of Q4/Q2/Q1/Q0
- Messages [76–80] → radius 0.7–1.0 → Q8 (recent, preserve)
- All user messages → minimum Q4 (never dropped)
- All tool messages → Q8 (always preserved)

**After compression:** 25 messages, 28K tokens (1.5x compression ratio)

---

## 9. Context Continuity Across Model Switches

### The Problem

Turn 5 routes to `qwen3.5-plus` (heavy). Turn 6 routes to `glm-4.5-air` (trivial). The models are different — they have different knowledge, different reasoning capabilities, different contexts.

### The Solution

GateSwarm tracks **per-session continuity**:

```typescript
SessionContinuity {
  summary: string,           // Accumulated summary
  lastTier: string,          // "heavy"
  lastModel: string,         // "bailian/qwen3.5-plus"
  keyDecisions: string[],    // ["Architecture uses event sourcing", ...]
  updatedAt: number          // timestamp
}
```

When a model switch is detected, key decisions from the previous response are injected:

```
Continuity from previous turn (heavy→bailian/qwen3.5-plus):
- Architecture uses event sourcing with Kafka
- Key point: caching layer should be Redis with TTL
- Decision: use 5-minute TTL for frequently accessed data
```

Sessions expire after 1 hour of inactivity.

---

## 10. RAG — What Gets Shared

The RAG index is the **persistent memory** across turns and across model switches.

### Storage

Messages compressed to Q0/Q1/Q2 have their summaries stored:

```json
{
  "id": "abc123def456",
  "tier": "Q1",
  "summary": "Architecture discussion: event sourcing with Kafka, Redis caching with 5min TTL",
  "tags": ["architecture", "infra"],
  "originalRole": "assistant",
  "adequacyScore": 1.0
}
```

### Retrieval

Each request queries the RAG index:

```
queryRag(["architecture", "caching"], maxResults=3)
→ returns top 3 entries by keyword overlap
```

### Injection

Retrieved entries are merged into the system message:

```
Relevant prior context (auto-retrieved):
[Retrieved context from assistant: Architecture discussion: event sourcing with Kafka, Redis caching with 5min TTL]
```

---

## 11. Post-Compression Sanitization

After compression, the message sequence is repaired through 7 phases:

| Phase | Problem | Fix |
|---|---|---|
| 1. System-first | System messages mid-conversation | Move all to front |
| 2. Merge consecutive | Same roles adjacent (compressor dropped intervening messages) | Merge with `---` |
| 3. User-first | First non-system is assistant (user was dropped) | Move first user to front |
| 5. Orphan filter | Tool without parent assistant | Skip orphaned tools |
| 6. Leading cleanup | Leading assistant/tool before user | Drop leading non-user |
| 7. User injection | No user message at all (all dropped) | Inject synthetic user |

---

## 12. What Each Model Actually Sees

### Same model (no switch):
- Full compressed history
- RAG context (if relevant)
- No continuity injection needed

### Different model (switch):
- Full compressed history
- RAG context (if relevant)
- **Continuity summary** (key decisions from previous turn)

### KV Cache:
- **Never shared** between models (API calls, not local inference)
- Each model processes the full message list from scratch
- Compression is the mechanism for managing this cost
