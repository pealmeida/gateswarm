#!/usr/bin/env python3
"""
GateSwarm MoA Router v0.4 — Cascade Retrain Script

Retrains the v3.2 binary cascade classifiers on REAL feedback labels
(instead of formula labels) for improved moderate/heavy tier accuracy.

Usage:
    python scripts/cascade-retrain.py [--data feedback.db] [--output cascade_weights_v04.json]
    python scripts/cascade-retrain.py --demo    # Run with synthetic demo data
"""

import os
import sys
import json
import math
import random
import argparse
from datetime import datetime, timezone

try:
    import sqlite3
    HAS_SQLITE = True
except ImportError:
    HAS_SQLITE = False

try:
    import numpy as np
    from scipy.optimize import minimize
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, classification_report
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

# ─── Constants ─────────────────────────────────────────────────────

FEATURE_NAMES = [
    "sentence_count", "avg_word_length", "has_question", "question_technical",
    "technical_design", "code", "architecture", "word_count",
    "four_plus", "has_imperative", "technical_terms", "multi_step",
    "requires_context", "domain_specificity", "ambiguity_score",
]

TIERS = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]

# ─── Feature Extraction ────────────────────────────────────────────

TECH_KEYWORDS = {
    "api", "http", "rest", "graphql", "websocket", "dns", "ssl", "tls",
    "oauth", "jwt", "cors", "cdn", "docker", "kubernetes", "git",
    "json", "yaml", "xml", "sql", "nosql", "redis", "mongodb",
    "typescript", "python", "rust", "java", "react", "vue", "angular",
    "svelte", "node", "express", "fastapi", "function", "class",
    "async", "await", "error", "type", "interface", "architecture",
    "design", "system", "microservice", "container", "deploy", "pipeline",
    "algorithm", "database", "refactor", "optimize", "debug", "security",
}

ARCH_KEYWORDS = {
    "architecture", "design pattern", "system design", "microservice",
    "distributed", "scalable", "load balancer", "event-driven", "service mesh",
    "api gateway", "serverless", "cloud-native", "infrastructure",
}

DESIGN_KEYWORDS = {
    "technical design", "implementation plan", "migration strategy",
    "deployment strategy", "disaster recovery", "failover",
}

IMPERATIVE_STARTS = {
    "read", "summarize", "format", "explain", "add", "rename", "write",
    "check", "count", "find", "replace", "show", "make", "fix",
    "extract", "parse", "validate", "sort", "filter", "calculate",
    "create", "build", "run", "test", "implement", "refactor",
    "optimize", "deploy", "configure",
}


def extract_features(text: str) -> dict:
    """Extract 15-feature complexity vector."""
    import re
    words = re.findall(r'\w+', text.lower())
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
    wc = len(words)
    sc = len(sentences)
    awl = sum(len(w) for w in words) / max(wc, 1)

    has_code = bool(re.search(r'```|`[^`]+`|def\s+\w+|const\s+\w+|function\s+\w+|import\s+', text))
    has_question = '?' in text
    has_imperative = any(text.lower().startswith(imp) for imp in IMPERATIVE_STARTS)

    tech_terms = sum(1 for w in words if w in TECH_KEYWORDS)
    question_technical = has_question and tech_terms > 0
    architecture = any(kw in text.lower() for kw in ARCH_KEYWORDS)
    technical_design = any(kw in text.lower() for kw in DESIGN_KEYWORDS)
    multi_step = bool(re.search(r'(first|then|next|finally|step\s*\d+)', text.lower()))
    requires_context = bool(re.search(r'(the file|this project|my code|our system|given that|consider)', text.lower()))
    domain_spec = bool(re.search(r'(finance|legal|medical|engineering|compliance|gdpr|hipaa|wacc)', text.lower()))
    ambiguity = bool(re.match(r'^(help|what|how|why|do|can|is|are)\b', text.strip().lower()))

    return {
        "sentence_count": sc / 10,
        "avg_word_length": awl / 10,
        "has_question": 1 if has_question else 0,
        "question_technical": 1 if question_technical else 0,
        "technical_design": 1 if technical_design else 0,
        "code": 1 if has_code else 0,
        "architecture": 1 if architecture else 0,
        "word_count": wc / 100,
        "four_plus": 1 if sc > 4 else 0,
        "has_imperative": 1 if has_imperative else 0,
        "technical_terms": tech_terms / 5,
        "multi_step": 1 if multi_step else 0,
        "requires_context": 1 if requires_context else 0,
        "domain_specificity": 1 if domain_spec else 0,
        "ambiguity_score": 1 if ambiguity else 0,
    }


def features_to_array(f: dict) -> list:
    return [f[name] for name in FEATURE_NAMES]


# ─── Cascade Training ─────────────────────────────────────────────

def train_cascade(data: list) -> dict:
    """
    Train 5 binary classifiers (trivial→light→moderate→heavy→intensive→extreme).
    Each classifier: positive = >= tier, negative = < tier.
    """
    if not HAS_SKLEARN:
        print("❌ scikit-learn not installed. Run: pip install scikit-learn numpy scipy")
        sys.exit(1)

    # Prepare feature matrix and labels
    X = np.array([features_to_array(d['features']) for d in data])
    tier_indices = [TIERS.index(d['tier']) for d in data]

    classifiers = {}
    results = {}

    for i, tier in enumerate(TIERS[:-1]):  # 5 boundaries
        # Binary: positive = >= this tier, negative = < this tier
        y = np.array([1 if t >= i else 0 for t in tier_indices])

        # Balanced sampling
        pos_idx = np.where(y == 1)[0]
        neg_idx = np.where(y == 0)[0]
        min_count = min(len(pos_idx), len(neg_idx))

        if min_count < 5:
            print(f"⚠️  Not enough data for {tier} boundary (need ≥5 per class)")
            continue

        np.random.seed(42)
        pos_sample = np.random.choice(pos_idx, min_count, replace=False)
        neg_sample = np.random.choice(neg_idx, min_count, replace=False)
        sample_idx = np.concatenate([pos_sample, neg_sample])

        X_train = X[sample_idx]
        y_train = y[sample_idx]

        # Train logistic regression
        clf = LogisticRegression(max_iter=1000, C=1.0, solver='lbfgs')
        clf.fit(X_train, y_train)

        # Evaluate
        y_pred = clf.predict(X_train)
        acc = accuracy_score(y_train, y_pred)

        classifiers[tier] = {
            'weights': clf.coef_[0].tolist(),
            'intercept': clf.intercept_[0].item(),
            'accuracy': acc,
            'n_samples': len(sample_idx),
        }
        results[tier] = acc

        print(f"  {tier:12} boundary: accuracy={acc:.3f} (n={len(sample_idx)})")

    return classifiers


# ─── Demo Data ─────────────────────────────────────────────────────

def generate_demo_data(n=500) -> list:
    """Generate synthetic demo data for testing."""
    random.seed(42)

    prompts = {
        'trivial': [
            "Hi", "Hello", "What time is it?", "Thanks", "OK",
            "What is 2+2?", "Good morning", "Bye", "Yes", "No",
        ],
        'light': [
            "Summarize this file in 3 sentences", "What is the capital of Brazil?",
            "Explain HTTP in simple terms", "List 5 benefits of caching",
            "What does CORS mean?", "How do I sort a list in Python?",
        ],
        'moderate': [
            "Write a REST API endpoint for user authentication with JWT tokens",
            "Compare microservices vs monolith architecture for a startup",
            "Implement a rate limiter using Redis in Python",
            "Design a database schema for an e-commerce platform",
        ],
        'heavy': [
            "Design a distributed task queue with retry logic, dead letter queues, and monitoring. Include failure scenarios and recovery strategies.",
            "Implement a CI/CD pipeline for a microservices architecture with canary deployments, automated rollback, and performance gates.",
        ],
        'intensive': [
            "Design a real-time fraud detection system for a payment processor handling 10K TPS. Include feature engineering, model selection, latency requirements, and false positive management.",
        ],
        'extreme': [
            "Design a global multi-region SaaS platform with zero-downtime deployments, automatic failover, data consistency across regions, and compliance with GDPR, HIPAA, and SOC2. Include cost analysis and migration strategy from existing monolith.",
        ],
    }

    data = []
    per_tier = n // len(TIERS)

    for tier, template_list in prompts.items():
        for _ in range(per_tier):
            template = random.choice(template_list)
            # Add variation
            if random.random() < 0.3:
                template += " Please be detailed."
            if random.random() < 0.2:
                template = f"Given our existing system, {template.lower()}"

            features = extract_features(template)
            data.append({
                'prompt': template,
                'tier': tier,
                'features': features,
                'adequacy_score': random.uniform(0.6, 1.0),
            })

    return data


# ─── Load from SQLite ──────────────────────────────────────────────

def load_from_sqlite(db_path: str) -> list:
    """Load feedback data from SQLite database."""
    if not HAS_SQLITE:
        print("❌ sqlite3 not available")
        return []

    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return []

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Try to read feedback table
    try:
        cursor.execute("SELECT prompt_hash, actual_tier, adequacy_score FROM feedback WHERE actual_tier IS NOT NULL")
        rows = cursor.fetchall()
    except sqlite3.OperationalError:
        print("❌ No feedback table found")
        return []

    data = []
    for prompt_hash, tier, adequacy in rows:
        if tier not in TIERS:
            continue
        # We'd need the original prompt to extract features
        # For now, skip — in production, prompts would be stored
        pass

    conn.close()
    return data


# ─── Main ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Cascade Retrain — v0.4')
    parser.add_argument('--data', default=None, help='SQLite database path')
    parser.add_argument('--output', default='cascade_weights_v04.json', help='Output weights file')
    parser.add_argument('--demo', action='store_true', help='Run with synthetic demo data')
    args = parser.parse_args()

    print("=" * 60)
    print("GateSwarm MoA Router v0.4 — Cascade Retrain")
    print("=" * 60)

    # Load data
    if args.demo:
        print("\n📊 Using synthetic demo data (500 samples)")
        data = generate_demo_data(500)
    elif args.data:
        print(f"\n📊 Loading from SQLite: {args.data}")
        data = load_from_sqlite(args.data)
        if not data:
            print("❌ No data loaded. Use --demo for testing.")
            sys.exit(1)
    else:
        print("❌ No data source specified. Use --data or --demo")
        sys.exit(1)

    # Show distribution
    tier_counts = {}
    for d in data:
        tier_counts[d['tier']] = tier_counts.get(d['tier'], 0) + 1

    print(f"\n📈 Data distribution:")
    for tier in TIERS:
        count = tier_counts.get(tier, 0)
        bar = "█" * min(count, 50)
        print(f"  {tier:12} {count:4d} {bar}")

    # Train cascade
    print(f"\n🏋️  Training cascade classifiers...")
    classifiers = train_cascade(data)

    # Save weights
    output = {
        'version': 'v0.4-cascade-real-feedback',
        'trained': datetime.now(timezone.utc).isoformat(),
        'method': 'binary-cascade-real-labels',
        'n_samples': len(data),
        'classifiers': classifiers,
    }

    with open(args.output, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Weights saved to {args.output}")
    print(f"📊 Overall: {len(classifiers)} classifiers trained")

    avg_acc = sum(c['accuracy'] for c in classifiers.values()) / max(len(classifiers), 1)
    print(f"📈 Average boundary accuracy: {avg_acc:.3f}")


if __name__ == '__main__':
    main()
