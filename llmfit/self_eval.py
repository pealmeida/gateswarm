#!/usr/bin/env python3
"""
MoA Gateway v3.1 — Self-Evaluation Module

Implements the closed-loop feedback system where routing decisions are
evaluated and used to continuously optimize heuristic weights.

This module:
1. Captures routing feedback after each LLM execution
2. Stores feedback in a SQLite buffer
3. Provides the optimizer with real-world routing accuracy data
4. Triggers weekly weight re-optimization

Usage (from gateway):
    from self_eval import SelfEvaluation
    se = SelfEvaluation(db_path="data/feedback.db")
    feedback = se.evaluate(prompt, response_tier, cost, latency, tokens)
    se.store(feedback)

    # Weekly optimization
    new_weights = se.optimize_weights(current_weights)
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class RoutingFeedback:
    """Single routing feedback record."""
    prompt_hash: str          # SHA-256 hash of prompt (privacy-preserving)
    predicted_tier: str       # What the router predicted
    actual_tier: str          # What tier was actually needed (from self-eval)
    self_rating: float        # LLM self-assessed fit (0.0-1.0)
    cost_actual: float        # Actual cost incurred ($)
    cost_predicted: float     # Predicted cost for predicted tier ($)
    latency_ms: int           # Actual response time
    tokens_used: int          # Actual token consumption
    was_overkill: bool        # Could a cheaper tier have handled this?
    was_underkill: bool       # Did the tier struggle?
    prompt_summary: str       # Truncated prompt (first 200 chars, sanitized)
    features: dict            # Feature vector for optimization
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


TIERS = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]

TIER_SCORES = {
    "trivial": 0.04,
    "light": 0.13,
    "moderate": 0.25,
    "heavy": 0.42,
    "intensive": 0.62,
    "extreme": 0.86,
}

# Self-evaluation prompt template
SELF_EVAL_PROMPT = """Given the following prompt and response metadata, evaluate routing accuracy.

PROMPT: {prompt_summary}
RESPONSE_TIER_USED: {tier_used}
RESPONSE_COST: ${cost:.4f}
RESPONSE_LATENCY: {latency}ms
RESPONSE_TOKENS: {tokens}

Rate how well the chosen tier matched the task difficulty:
- If the task was too easy for this tier (overkill): was_overkill=true, low rating
- If the task was too hard for this tier (underkill): was_underkill=true, low rating
- If the tier was appropriate: high rating

Respond with ONLY valid JSON:
{{"self_rating": 0.0-1.0, "was_overkill": true/false, "was_underkill": true/false, "actual_complexity": "trivial|light|moderate|heavy|intensive|extreme"}}"""


def sanitize_prompt(prompt: str) -> str:
    """Remove potentially sensitive content from prompt for self-evaluation."""
    # Redact secrets
    sanitized = re.sub(
        r'(api_key|password|token|secret|key)[=:]\s*\S+',
        r'\1=***REDACTED***',
        prompt,
        flags=re.IGNORECASE,
    )
    # Truncate to 500 chars
    return sanitized[:500]


def hash_prompt(prompt: str) -> str:
    """Create privacy-preserving hash of prompt."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]


def extract_features_for_feedback(prompt: str) -> dict:
    """Extract feature vector from prompt (same as LLMFit)."""
    words = re.findall(r'\w+', prompt.lower())
    sentences = [s.strip() for s in re.split(r'[.!?]+', prompt) if s.strip()]

    tech_keywords = {
        "api", "http", "rest", "graphql", "docker", "kubernetes", "git",
        "typescript", "python", "rust", "react", "node", "server",
        "database", "function", "class", "async", "await", "error",
        "architecture", "design", "system", "microservice",
    }
    tech_count = sum(1 for w in words if w in tech_keywords)

    architecture_kws = {"architecture", "design pattern", "system design", "microservice"}
    design_kws = {"technical design", "implementation plan", "migration strategy"}

    return {
        "word_count": len(words),
        "sentence_count": len(sentences),
        "avg_word_length": round(sum(len(w) for w in words) / max(len(words), 1), 2),
        "has_code": bool(re.search(r'```|`[^`]+`|def\s+\w+|const\s+\w+|function\s+\w+', prompt)),
        "has_question": "?" in prompt,
        "has_imperative": bool(re.match(r'^(read|summarize|format|explain|add|rename|write|check|find|replace|show|make|fix|extract|parse|validate|sort|filter|calculate|create|build|run|test|implement|refactor|optimize|deploy|configure)', prompt.lower())),
        "technical_terms": tech_count,
        "question_technical": "?" in prompt and tech_count > 0,
        "architecture": any(kw in prompt.lower() for kw in architecture_kws),
        "technical_design": any(kw in prompt.lower() for kw in design_kws),
        "multi_step": bool(re.search(r'(first|then|next|after that|finally|step\s*\d+)', prompt.lower())),
        "requires_context": bool(re.search(r'(the file|this project|my code|our system)', prompt.lower())),
        "domain_specificity": round(min(tech_count / max(len(words), 1), 1.0), 3),
        "ambiguity_score": 0.1,
    }


class FeedbackBuffer:
    """SQLite-backed feedback buffer for routing decisions."""

    def __init__(self, db_path: str = "data/feedback.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self):
        """Initialize database schema."""
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    prompt_hash TEXT NOT NULL,
                    predicted_tier TEXT NOT NULL,
                    actual_tier TEXT NOT NULL,
                    self_rating REAL NOT NULL,
                    cost_actual REAL NOT NULL,
                    cost_predicted REAL NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    tokens_used INTEGER NOT NULL,
                    was_overkill INTEGER NOT NULL,
                    was_underkill INTEGER NOT NULL,
                    prompt_summary TEXT,
                    features TEXT,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON feedback(timestamp)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_predicted ON feedback(predicted_tier)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_actual ON feedback(actual_tier)")

    def store(self, feedback: RoutingFeedback) -> int:
        """Store a feedback record. Returns row ID."""
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                INSERT INTO feedback (
                    prompt_hash, predicted_tier, actual_tier, self_rating,
                    cost_actual, cost_predicted, latency_ms, tokens_used,
                    was_overkill, was_underkill, prompt_summary, features, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                feedback.prompt_hash,
                feedback.predicted_tier,
                feedback.actual_tier,
                feedback.self_rating,
                feedback.cost_actual,
                feedback.cost_predicted,
                feedback.latency_ms,
                feedback.tokens_used,
                int(feedback.was_overkill),
                int(feedback.was_underkill),
                feedback.prompt_summary,
                json.dumps(feedback.features),
                feedback.timestamp,
            ))
            return cursor.lastrowid

    def get_records(
        self,
        since: Optional[str] = None,
        limit: int = 10000,
    ) -> list[dict]:
        """Get feedback records, optionally filtered by time."""
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            if since:
                query = "SELECT * FROM feedback WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?"
                rows = conn.execute(query, (since, limit)).fetchall()
            else:
                query = "SELECT * FROM feedback ORDER BY timestamp DESC LIMIT ?"
                rows = conn.execute(query, (limit,)).fetchall()

            return [dict(row) for row in rows]

    def get_count(self, since: Optional[str] = None) -> int:
        """Get total feedback record count."""
        with sqlite3.connect(str(self.db_path)) as conn:
            if since:
                row = conn.execute(
                    "SELECT COUNT(*) FROM feedback WHERE timestamp >= ?",
                    (since,)
                ).fetchone()
            else:
                row = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()
            return row[0] if row else 0

    def get_accuracy(self, since: Optional[str] = None) -> dict:
        """Calculate routing accuracy metrics."""
        records = self.get_records(since=since, limit=100000)
        if not records:
            return {"total": 0, "accuracy": 0.0, "overkill_rate": 0.0, "underkill_rate": 0.0}

        total = len(records)
        correct = sum(1 for r in records if r["predicted_tier"] == r["actual_tier"])
        overkill = sum(1 for r in records if r["was_overkill"])
        underkill = sum(1 for r in records if r["was_underkill"])

        avg_rating = sum(r["self_rating"] for r in records) / total
        total_cost = sum(r["cost_actual"] for r in records)
        total_predicted_cost = sum(r["cost_predicted"] for r in records)
        savings = (1 - total_cost / total_predicted_cost) * 100 if total_predicted_cost > 0 else 0

        # Per-tier accuracy
        tier_accuracy = {}
        for tier in TIERS:
            tier_records = [r for r in records if r["predicted_tier"] == tier]
            if tier_records:
                tier_correct = sum(1 for r in tier_records if r["predicted_tier"] == r["actual_tier"])
                tier_accuracy[tier] = {
                    "count": len(tier_records),
                    "accuracy": round(tier_correct / len(tier_records), 3),
                }

        return {
            "total": total,
            "accuracy": round(correct / total, 3),
            "overkill_rate": round(overkill / total, 3),
            "underkill_rate": round(underkill / total, 3),
            "avg_self_rating": round(avg_rating, 3),
            "total_cost": round(total_cost, 4),
            "predicted_cost": round(total_predicted_cost, 4),
            "cost_savings_pct": round(savings, 1),
            "tier_accuracy": tier_accuracy,
        }

    def to_training_samples(self, limit: int = 10000) -> list[dict]:
        """Convert feedback records to LLMFit-compatible training samples."""
        records = self.get_records(limit=limit)
        samples = []

        for r in records:
            features = json.loads(r["features"]) if r["features"] else {}
            samples.append({
                "id": f"fb_{r['prompt_hash']}_{r['id']}",
                "source": "feedback-loop",
                "text": r["prompt_summary"] or "",
                "label": r["actual_tier"],
                "features": features,
                "confidence": r["self_rating"],
                "created_at": r["timestamp"],
            })

        return samples

    def purge(self, keep_days: int = 90) -> int:
        """Purge old feedback records. Returns count of purged records."""
        cutoff = datetime.now(timezone.utc).replace(
            year=datetime.now(timezone.utc).year
        )
        # Simple: delete records older than keep_days
        cutoff_ts = datetime.now(timezone.utc)
        from datetime import timedelta
        cutoff_ts = cutoff_ts - timedelta(days=keep_days)
        cutoff_str = cutoff_ts.isoformat()

        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                "DELETE FROM feedback WHERE timestamp < ?",
                (cutoff_str,)
            )
            return cursor.rowcount


class SelfEvaluation:
    """High-level self-evaluation interface."""

    def __init__(self, db_path: str = "data/feedback.db"):
        self.buffer = FeedbackBuffer(db_path)

    def evaluate(
        self,
        prompt: str,
        predicted_tier: str,
        cost_actual: float,
        cost_predicted: float,
        latency_ms: int,
        tokens_used: int,
        response_text: str = "",
    ) -> RoutingFeedback:
        """
        Evaluate a routing decision and create a feedback record.

        This is called after each LLM execution to assess whether
        the predicted tier was appropriate.
        """
        prompt_hash = hash_prompt(prompt)
        prompt_summary = sanitize_prompt(prompt)
        features = extract_features_for_feedback(prompt)

        # Heuristic self-evaluation (no LLM call for cost efficiency)
        actual_tier, self_rating, was_overkill, was_underkill = \
            self._heuristic_evaluation(
                prompt, predicted_tier, response_text, latency_ms, tokens_used, features
            )

        feedback = RoutingFeedback(
            prompt_hash=prompt_hash,
            predicted_tier=predicted_tier,
            actual_tier=actual_tier,
            self_rating=self_rating,
            cost_actual=cost_actual,
            cost_predicted=cost_predicted,
            latency_ms=latency_ms,
            tokens_used=tokens_used,
            was_overkill=was_overkill,
            was_underkill=was_underkill,
            prompt_summary=prompt_summary[:200],
            features=features,
        )

        return feedback

    def store(self, feedback: RoutingFeedback) -> int:
        """Store feedback in the buffer."""
        return self.buffer.store(feedback)

    def evaluate_and_store(
        self,
        prompt: str,
        predicted_tier: str,
        cost_actual: float,
        cost_predicted: float,
        latency_ms: int,
        tokens_used: int,
        response_text: str = "",
    ) -> int:
        """Evaluate and store in one step. Returns row ID."""
        feedback = self.evaluate(
            prompt, predicted_tier, cost_actual, cost_predicted,
            latency_ms, tokens_used, response_text
        )
        return self.store(feedback)

    @staticmethod
    def _heuristic_evaluation(
        prompt: str,
        predicted_tier: str,
        response_text: str,
        latency_ms: int,
        tokens_used: int,
        features: dict,
    ) -> tuple[str, float, bool, bool]:
        """
        Heuristic self-evaluation without LLM call.

        Uses response characteristics to estimate whether the tier was appropriate:
        - Very short responses to heavy tiers → overkill
        - Very long responses to light tiers → underkill
        - Long latency → possible underkill
        - Low token count to heavy tiers → overkill
        """
        predicted_score = TIER_SCORES.get(predicted_tier, 0.25)

        # Estimate actual complexity from response characteristics
        response_words = len(response_text.split()) if response_text else 0

        # Indicators of overkill: high tier but short response
        if predicted_score > 0.4 and response_words < 50:
            actual_tier = "trivial" if response_words < 20 else "light"
            self_rating = 0.3
            was_overkill = True
            was_underkill = False

        # Indicators of underkill: low tier but long response or high latency
        elif predicted_score < 0.2 and (response_words > 500 or latency_ms > 5000):
            actual_tier = "moderate" if response_words < 1000 else "heavy"
            self_rating = 0.4
            was_overkill = False
            was_underkill = True

        # Moderate fit: response length matches tier expectations
        else:
            # Map response length to estimated complexity
            if response_words < 30:
                estimated_tier = "trivial"
            elif response_words < 100:
                estimated_tier = "light"
            elif response_words < 300:
                estimated_tier = "moderate"
            elif response_words < 800:
                estimated_tier = "heavy"
            elif response_words < 2000:
                estimated_tier = "intensive"
            else:
                estimated_tier = "extreme"

            actual_tier = estimated_tier
            was_overkill = TIER_SCORES.get(predicted_tier, 0) > TIER_SCORES.get(estimated_tier, 0) + 0.2
            was_underkill = TIER_SCORES.get(predicted_tier, 0) < TIER_SCORES.get(estimated_tier, 0) - 0.1

            # Self-rating based on tier distance
            tier_distance = abs(TIER_SCORES.get(predicted_tier, 0) - TIER_SCORES.get(estimated_tier, 0))
            self_rating = max(0.0, 1.0 - tier_distance * 3)

        return actual_tier, round(self_rating, 2), was_overkill, was_underkill

    def get_metrics(self, since: Optional[str] = None) -> dict:
        """Get routing accuracy metrics."""
        return self.buffer.get_accuracy(since=since)

    def export_for_optimization(self, output_path: str, limit: int = 10000):
        """Export feedback records as LLMFit-compatible JSONL for weight optimization."""
        samples = self.buffer.to_training_samples(limit=limit)
        with open(output_path, "w", encoding="utf-8") as f:
            for s in samples:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
        print(f"Exported {len(samples)} feedback records to {output_path}")


def main():
    """CLI for self-evaluation module."""
    import argparse

    parser = argparse.ArgumentParser(description="MoA Gateway v3.1 — Self-Evaluation")
    subparsers = parser.add_subparsers(dest="command")

    # metrics
    metrics_parser = subparsers.add_parser("metrics", help="Show routing accuracy metrics")
    metrics_parser.add_argument("--db", default="data/feedback.db", help="Database path")
    metrics_parser.add_argument("--since", help="Filter records since ISO timestamp")

    # export
    export_parser = subparsers.add_parser("export", help="Export feedback for optimization")
    export_parser.add_argument("--db", default="data/feedback.db", help="Database path")
    export_parser.add_argument("--output", required=True, help="Output JSONL path")
    export_parser.add_argument("--limit", type=int, default=10000, help="Max records to export")

    # purge
    purge_parser = subparsers.add_parser("purge", help="Purge old feedback records")
    purge_parser.add_argument("--db", default="data/feedback.db", help="Database path")
    purge_parser.add_argument("--keep-days", type=int, default=90, help="Keep records newer than N days")

    args = parser.parse_args()

    if args.command == "metrics":
        se = SelfEvaluation(args.db)
        metrics = se.get_metrics(since=args.since)
        print(json.dumps(metrics, indent=2))

    elif args.command == "export":
        se = SelfEvaluation(args.db)
        se.export_for_optimization(args.output, args.limit)

    elif args.command == "purge":
        se = SelfEvaluation(args.db)
        purged = se.buffer.purge(keep_days=args.keep_days)
        print(f"Purged {purged} old records")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
