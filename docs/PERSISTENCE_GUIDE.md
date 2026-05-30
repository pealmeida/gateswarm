# GateSwarm v0.4.4 — Persistence & RAG Lifecycle Guide

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. Overview

GateSwarm v0.4.4 introduced **persistent storage** for RAG, feedback, and training data. All persistence uses JSON files — no external databases required.

---

## 2. File Structure

```
gateswarm-moma-router/data/
├── rag/
│   └── index.json              ← RAG entries (interaction + compression)
├── feedback/
│   └── entries.json            ← All interaction feedback
└── training/
    ├── votes.json              ← Training votes (gold/silver/bronze)
    ├── agent-configs.json      ← Per-agent training config
    └── tier-accuracy.json      ← Per-tier accuracy cache
```

---

## 3. RAG Index (`data/rag/index.json`)

### 3.1 Entry Types

**Interaction entries** — stored after each request:
```json
{
  "id": "abc123def456",
  "timestamp": 1715697600000,
  "keywords": ["architecture", "caching", "redis"],
  "tags": [],
  "tier": "heavy",
  "modelUsed": "bailian/qwen3.5-plus",
  "originalRole": "",
  "adequacyScore": 1,
  "summary": "User asked about caching strategy...",
  "originalTokens": 28000,
  "compressedTokens": 15000
}
```

**Compression entries** — stored when messages are Q0/Q1/Q2:
```json
{
  "id": "789xyz",
  "timestamp": 1715697600000,
  "keywords": ["code", "architecture"],
  "tags": ["code", "architecture"],
  "tier": "Q1",
  "modelUsed": "",
  "originalRole": "assistant",
  "adequacyScore": 1.0,
  "summary": "Assistant proposed event sourcing with Kafka",
  "originalTokens": 0,
  "compressedTokens": 0
}
```

### 3.2 Lifecycle

| Event | Action |
|---|---|
| Gateway starts | Load from disk into memory |
| Request completes | `addRagEntry()` → push to in-memory array |
| Message compressed Q0/Q1/Q2 | `storeToRag()` → push to in-memory array |
| Auto-flush (60s) | Write in-memory array to disk |
| Entry expires (24h) | Shifted out during query/filter |
| Array exceeds 10K | Shift oldest 30% |

### 3.3 Query

```
queryRag(["architecture", "caching"], maxResults=3)
```

Algorithm:
1. Filter entries by TTL (24h)
2. For each entry, compute overlap score:
   - `searchTerms = unique(keywords ∪ tags)`
   - `score = count(query_keywords where keyword matches searchTerm)`
3. Return top 3 by score

---

## 4. Feedback Store (`data/feedback/entries.json`)

### 4.1 Entry Schema

```json
{
  "id": "f4951dbb37c72427",
  "timestamp": 1715697600000,
  "promptHash": "ec039025530af42b",
  "predictedTier": "heavy",
  "actualTier": null,
  "modelUsed": "bailian/qwen3.5-plus",
  "responseTokens": 835,
  "adequacyScore": null,
  "escalated": false,
  "userSatisfaction": null
}
```

### 4.2 Lifecycle

| Event | Action |
|---|---|
| Gateway starts | Load from disk into memory |
| Request completes | `recordFeedback()` → push to in-memory array |
| Self-eval completes | `updateAdequacy()` → set adequacyScore + actualTier |
| Auto-flush (60s) | Write last 10K entries to disk |
| Array exceeds 10K | Shift oldest |

### 4.3 Usage

```bash
# Check entry count
curl http://localhost:8900/v04/status | python3 -c "
import json,sys;d=json.load(sys.stdin);print(f'Interactions: {d[\"interactions\"]}')
"

# View tier accuracy
curl http://localhost:8900/v04/feedback | python3 -c "
import json,sys;d=json.load(sys.stdin);print(json.dumps(d['perTierAccuracy'],indent=2))
"
```

---

## 5. Training Data (`data/training/`)

### 5.1 Votes (`votes.json`)

```json
{
  "id": "v1a2b3c4d5e6f",
  "agentId": "jack",
  "promptHash": "abc123",
  "promptSnippet": "Design a caching...",
  "predictedTier": "heavy",
  "actualTier": "intensive",
  "source": "gold",
  "weight": 1.0,
  "timestamp": 1715697600000,
  "expiresAt": 1715697900000,
  "voted": true,
  "userAgreed": false,
  "userCorrectTier": "intensive"
}
```

Max: 5,000 votes. Expired votes (5 min) cleaned automatically.

### 5.2 Agent Configs (`agent-configs.json`)

```json
{
  "jack": {
    "agentId": "jack",
    "enabled": false,
    "aleatoryRate": 0.10,
    "alwaysAskBelowConfidence": 0.5,
    "neverAskTiers": ["trivial", "extreme"],
    "weightedTiers": ["moderate", "heavy", "intensive"],
    "weightedRateMultiplier": 2.0,
    "retrainAfterVotes": 10
  }
}
```

### 5.3 Tier Accuracy (`tier-accuracy.json`)

```json
{
  "jack:heavy": {
    "agentId": "jack",
    "tier": "heavy",
    "correct": 5,
    "total": 6,
    "updatedAt": 1715697600000
  }
}
```

---

## 6. Persistence Guarantees

| Store | Flush Interval | Data Loss Window | Max Entries |
|---|---|---|---|
| RAG index | 60s | ≤60s + in-memory buffer | 10,000 |
| Feedback entries | 60s | ≤60s + in-memory buffer | 10,000 |
| Training votes | On every write | 0 | 5,000 |
| Agent configs | On every write | 0 | N (per agent) |
| Tier accuracy | On every write | 0 | 6 per agent |

---

## 7. What Survives Restarts

| Data | Survives? | Notes |
|---|---|---|
| RAG index | ✅ Yes | Loaded on startup |
| Feedback entries | ✅ Yes | Loaded on startup |
| Training votes | ✅ Yes | Loaded on startup |
| Agent configs | ✅ Yes | Loaded on startup |
| Tier accuracy | ✅ Yes | Loaded on startup |
| Context continuity | ❌ No | In-memory, 1h expiry |
| History bias cache | ✅ Eventually | Reloads from feedback store |
| Calibration state | ❌ No | In-memory, resets on restart |
| Benchmark logs | ✅ Yes | JSONL files on disk |

---

## 8. Manual Management

### Backup

```bash
tar czf gateswarm-data-backup.tar.gz \
  data/rag/ \
  data/feedback/ \
  data/training/ \
  v04_config.json \
  data/agent-registry.json
```

### Clear RAG Index

```bash
curl -X POST http://localhost:8900/v04/retrain  # or
echo '[]' > data/rag/index.json
# Restart gateway
```

### Clear Feedback

```bash
echo '[]' > data/feedback/entries.json
# Restart gateway
```

### Inspect Files

```bash
# RAG stats
python3 -c "
import json
data = json.load(open('data/rag/index.json'))
print(f'Total RAG entries: {len(data)}')
tiers = {}
for e in data:
    tiers[e['tier']] = tiers.get(e['tier'], 0) + 1
print(f'By tier: {tiers}')
"

# Feedback stats
python3 -c "
import json
data = json.load(open('data/feedback/entries.json'))
print(f'Total feedback entries: {len(data)}')
tiers = {}
for e in data:
    tiers[e['predictedTier']] = tiers.get(e['predictedTier'], 0) + 1
print(f'By tier: {tiers}')
judged = sum(1 for e in data if e['actualTier'] is not None)
print(f'Judged (actualTier set): {judged}')
"
```

---

## 9. Auto-Flush Implementation

Both RAG and feedback stores use `setInterval` for periodic flushing:

```typescript
// RAG index
setInterval(() => {
  clearExpiredEntries();  // Remove entries older than 24h
  flushRagIndex();        // Write to disk
}, 60000);

// Feedback store
setInterval(() => {
  flushFeedbackStore();   // Write last 10K entries to disk
}, 60000);
```

This ensures data is persisted even if the gateway crashes unexpectedly.
