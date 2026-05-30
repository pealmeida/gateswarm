# GateSwarm v0.4.4 — Training Mode Guide

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. Overview

Training mode enables semi-supervised learning where GateSwarm improves its routing accuracy over time using three sources of labeled data:

| Source | How | Quality | Volume |
|---|---|---|---|
| **GOLD** | Manual user votes (`✅` or `❌ <tier>`) | 100% | 5–15% of requests |
| **SILVER** | RAG consensus (3+ entries agree on tier) | 70–80% | 30–50% of requests |
| **BRONZE** | LLM judge (qwen3.6-plus async evaluation) | 80–85% | 100% of requests |

---

## 2. How It Works

### 2.1 The Flow

```
Request arrives → Router predicts tier → Response generated
                                               │
                        ┌──────────────────────┼──────────────────────┐
                        │                      │                      │
                        ▼                      ▼                      ▼
                   GOLD vote?              SILVER label?         BRONZE label?
                   (aleatory              (RAG consensus)       (LLM judge)
                   sampling)
                        │                      │                      │
                        ▼                      ▼                      ▼
                   Store vote              Compare with           Compare with
                   (weight 1.0)            predicted tier         predicted tier
                                              │                      │
                                              ▼                      ▼
                                         Calibrate silver       Calibrate bronze
                                         weight                 weight
```

### 2.2 Aleatory Sampling (GOLD)

Not every request asks for a vote. Sampling protects UX:

| Condition | Ask Rate | Rationale |
|---|---|---|
| Tier = trivial | 0% | Always correct, no value in asking |
| Tier = extreme | 5% | Rarely wrong, expensive if wrong |
| Confidence < 0.5 | 80% | Very uncertain → user input most valuable |
| Confidence 0.5–0.8 | 10% | Default aleatory rate |
| Confidence > 0.8 | 2% | High confidence → rarely ask |
| Tier = moderate/heavy/intensive | 2× base | Accuracy gaps → need more labels |

**Fatigue decay:**
```
effective_rate = base_rate × e^(-votes/50)
```
After 50 votes, the rate drops to 37% of base. After 100, to 14%.

### 2.3 RAG Consensus (SILVER)

```
1. Extract keywords from prompt
2. Query RAG index for top 10 entries
3. Count tier agreement among entries
4. If ≥3 entries agree AND >60% consensus → SILVER label
```

**Phase-based activation:**
- Phase 1 (0–50 interactions): disabled
- Phase 2 (50–200): low weight (0.15)
- Phase 3 (200+): full calibrated weight

### 2.4 LLM Judge (BRONZE)

The LLM judge runs asynchronously on 10% of responses:

```python
prompt = f"""Evaluate whether this response adequately addresses the prompt.
Prompt: "{prompt[:500]}"
Response: "{response[:1000]}"
Respond with ONLY JSON: {{"adequacy": 0.85, "correct_tier": "heavy"}}"""
```

Model: `bailian/qwen3.6-plus` (extreme tier — anti-circularity)

---

## 3. Weight Calibration

After enough comparisons, label weights are adjusted:

### Bronze Calibration

```
agreement_rate = bronze_agreements / bronze_comparisons
bronze_weight = 0.5 × agreement_rate  # clamped 0.1–0.8
```

After 10+ comparisons, the weight is recalculated.

### Silver Calibration

```
agreement_rate = silver_agreements / silver_comparisons
silver_weight = 0.3 × agreement_rate  # clamped 0.1–0.9
# Only increase if agreement_rate > 0.7
```

After 10+ comparisons with >70% agreement, the weight increases.

---

## 4. Vote Protocol

### 4.1 Vote Request Format

When training mode triggers a vote:

```
🎯 [vote:abc123] Router chose: heavy (62% confidence).
Reply: ✅ correct | ❌ trivial|light|moderate|heavy|intensive|extreme
```

### 4.2 Vote Reply Format

User replies in one of these formats:

| Reply | Meaning |
|---|---|
| `✅` | Router was correct |
| `correct` | Router was correct |
| `👍` | Router was correct |
| `❌ light` | Router was wrong, correct tier is light |
| `wrong heavy` | Router was wrong, correct tier is heavy |

### 4.3 Detection

The vote parser matches:
```regex
^(✅|yes|correct|👍|❌|no|wrong|nah)\s*(trivial|light|moderate|heavy|intensive|extreme)?$
```

---

## 5. API Reference

### Enable Training Mode

```bash
curl -X POST http://localhost:8900/v04/training/enable \
  -H "Content-Type: application/json" \
  -d '{"agentId":"jack","enabled":true}'
```

### Check Training Stats

```bash
curl "http://localhost:8900/v04/training?agentId=jack"
```

Response:
```json
{
  "agentId": "jack",
  "stats": {
    "enabled": true,
    "totalVotes": 15,
    "correctVotes": 12,
    "overallAccuracy": 0.80,
    "perTierAccuracy": {
      "moderate": {"correct": 3, "total": 4, "accuracy": 0.75},
      "heavy": {"correct": 5, "total": 5, "accuracy": 1.0},
      "intensive": {"correct": 4, "total": 6, "accuracy": 0.67}
    },
    "goldLabels": 15,
    "silverLabels": 42,
    "bronzeLabels": 153,
    "fatigueDecay": 0.74,
    "ragPhase": "full"
  },
  "calibration": {
    "bronzeAgreementRate": 0.82,
    "silverAgreementRate": 0.71,
    "bronzeWeight": 0.41,
    "silverWeight": 0.21,
    "ragPhase": "full",
    "totalInteractions": 200
  },
  "retraining": {
    "should": true,
    "reason": "15 gold votes, 3 tiers with ≥3 votes"
  }
}
```

### Record a Vote

```bash
curl -X POST http://localhost:8900/v04/training/vote \
  -H "Content-Type: application/json" \
  -d '{"voteId":"abc123","agentId":"jack","reply":"✅"}'
```

### Detect Vote Reply

```bash
curl -X POST http://localhost:8900/v04/training/vote/reply \
  -H "Content-Type: application/json" \
  -d '{"agentId":"jack","message":"❌ moderate"}'
```

---

## 6. Retraining Trigger

Retraining triggers when:

1. **Gold votes:** ≥10 votes AND ≥2 tiers with ≥3 votes each
2. **Total labeled:** ≥100 labeled interactions (any source)

When triggered:
1. Generate candidate weight sets via grid search
2. Simulate accuracy against feedback data
3. A/B test new weights (10% holdout)
4. Hot-swap weights without gateway restart

---

## 7. Data Persistence

| File | Content |
|---|---|
| `data/training/votes.json` | All votes (gold/silver/bronze) |
| `data/training/agent-configs.json` | Per-agent training config |
| `data/training/tier-accuracy.json` | Per-tier accuracy cache |

---

## 8. When to Enable Training Mode

| Scenario | Recommendation |
|---|---|
| **First deployment** | OFF — let the system stabilize for 100+ interactions |
| **After 100+ interactions** | ON — start collecting gold labels |
| **During heavy usage** | ON — more interactions → faster calibration |
| **When accuracy degrades** | ON — collect more gold labels for retraining |
| **Production with no human oversight** | OFF — SILVER and BRONZE labels still run |
