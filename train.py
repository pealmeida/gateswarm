"""GateSwarm MoA Router v0.3 — Tier-Pair Binary Classifier Cascade

Instead of one global regression for 6 tiers, trains 5 independent
binary classifiers per boundary:

  trivial? → light? → moderate? → heavy? → intensive? → (else: extreme)

Each classifier:
1. Gets its own balanced training set (1:1 ratio)
2. Optimizes feature weights independently
3. Uses its own decision threshold

Expected: Better per-tier accuracy by avoiding class imbalance.
"""
from __future__ import annotations

import argparse, os, sys, json, time, re, math, subprocess, random
from datetime import datetime, timezone
from typing import Optional
from collections import Counter

def ensure_deps():
    missing = []
    for pkg, mod in [("scipy", "scipy"), ("numpy", "numpy"), ("datasets", "datasets"), ("scikit-learn", "sklearn")]:
        try: __import__(mod)
        except ImportError: missing.append(pkg)
    if missing:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet"] + missing)

np = None
minimize = None
load_dataset = None
LogisticRegression = None
accuracy_score = None


def load_training_deps():
    """Import training-only dependencies lazily after CLI parsing."""
    global np, minimize, load_dataset, LogisticRegression, accuracy_score
    if all(dep is not None for dep in (np, minimize, load_dataset, LogisticRegression, accuracy_score)):
        return

    import numpy as np_module
    from scipy.optimize import minimize as minimize_fn
    from datasets import load_dataset as load_dataset_fn
    from sklearn.linear_model import LogisticRegression as logistic_regression_cls
    from sklearn.metrics import accuracy_score as accuracy_score_fn

    np = np_module
    minimize = minimize_fn
    load_dataset = load_dataset_fn
    LogisticRegression = logistic_regression_cls
    accuracy_score = accuracy_score_fn

# ── Constants ──
FEATURE_NAMES = [
    "sentence_count", "avg_word_length", "has_question", "question_technical",
    "technical_design", "code", "architecture", "word_count",
    "four_plus", "has_imperative", "technical_terms", "multi_step",
    "requires_context", "domain_specificity", "ambiguity_score",
]

TIERS = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]
TIER_SCORES = {
    "trivial": 0.04, "light": 0.13, "moderate": 0.25,
    "heavy": 0.42, "intensive": 0.62, "extreme": 0.86,
}

DEFAULT_WEIGHTS = {
    "sentence_count": 0.29, "avg_word_length": 0.19, "has_question": 0.12,
    "question_technical": 0.05, "technical_design": 0.12, "code": 0.10,
    "architecture": 0.07, "word_count": 0.00, "four_plus": 0.00,
    "has_imperative": 0.06, "technical_terms": 0.00, "multi_step": 0.00,
    "requires_context": 0.00, "domain_specificity": 0.00, "ambiguity_score": 0.00,
}

# ── Feature Extraction ──
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
ARCH_KEYWORDS = {"architecture", "design pattern", "system design", "microservice",
    "distributed", "scalable", "load balancer", "event-driven", "service mesh",
    "api gateway", "serverless", "cloud-native", "infrastructure"}
DESIGN_KEYWORDS = {"technical design", "implementation plan", "migration strategy",
    "deployment strategy", "disaster recovery", "failover"}
IMPERATIVE_STARTS = {
    "read", "summarize", "format", "explain", "add", "rename", "write",
    "check", "count", "find", "replace", "show", "make", "fix",
    "extract", "parse", "validate", "sort", "filter", "calculate",
    "create", "build", "run", "test", "implement", "refactor",
    "optimize", "deploy", "configure",
}


def extract_features(text: str) -> dict:
    """Extract 15-feature complexity vector."""
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

    domain_spec = min(tech_terms / max(wc, 1), 1.0)
    vague = {'something', 'stuff', 'thing', 'things', 'it', 'this', 'that'}
    ambiguity = min(sum(1 for w in words if w in vague) / max(wc, 1), 1.0)

    active = sum(1 for v in [has_code, has_question, has_imperative, tech_terms >= 3] if v)
    four_plus = 1.0 if active >= 4 else 0.0

    return {
        "word_count": wc, "sentence_count": sc, "avg_word_length": awl,
        "has_code": float(has_code), "has_question": float(has_question),
        "has_imperative": float(has_imperative), "technical_terms": tech_terms,
        "question_technical": float(question_technical),
        "architecture": float(architecture), "technical_design": float(technical_design),
        "multi_step": float(multi_step), "requires_context": float(requires_context),
        "domain_specificity": domain_spec, "ambiguity_score": ambiguity,
        "four_plus": four_plus,
    }


def features_to_vector(f: dict) -> list[float]:
    return [float(f.get(n, 0)) for n in FEATURE_NAMES]


def score_to_tier(score: float) -> str:
    if score < 0.08: return "trivial"
    if score < 0.18: return "light"
    if score < 0.32: return "moderate"
    if score < 0.52: return "heavy"
    if score < 0.72: return "intensive"
    return "extreme"


def compute_score(f: dict, weights: dict) -> float:
    """Compute complexity score from features and weights."""
    s = 0.0
    s += weights.get("sentence_count", 0) * min(f.get("sentence_count", 0), 10) / 10.0
    s += weights.get("avg_word_length", 0) * f.get("avg_word_length", 0) / 10.0
    s += weights.get("has_question", 0) * f.get("has_question", 0)
    s += weights.get("question_technical", 0) * f.get("question_technical", 0)
    s += weights.get("technical_design", 0) * f.get("technical_design", 0)
    s += weights.get("code", 0) * f.get("has_code", 0)
    s += weights.get("architecture", 0) * f.get("architecture", 0)
    s += weights.get("word_count", 0) * math.log1p(f.get("word_count", 0)) / 6.0
    s += weights.get("four_plus", 0) * f.get("four_plus", 0)
    s += weights.get("has_imperative", 0) * f.get("has_imperative", 0)
    s += weights.get("technical_terms", 0) * min(f.get("technical_terms", 0), 10) / 10.0
    s += weights.get("multi_step", 0) * f.get("multi_step", 0)
    s += weights.get("requires_context", 0) * f.get("requires_context", 0)
    s += weights.get("domain_specificity", 0) * f.get("domain_specificity", 0)
    s += weights.get("ambiguity_score", 0) * f.get("ambiguity_score", 0)
    if f.get("word_count", 0) < 10 and f.get("architecture", 0) == 0:
        s *= 0.7
    return min(max(s, 0.0), 1.0)


# ── Labeling: Signal-based for HF datasets ──
def label_from_explicit_signals(text: str) -> str:
    """Label based on word count + signal counting for even tier distribution."""
    t = text.lower()
    words = t.split()
    wc = len(words)
    signals = 0
    if '?' in text: signals += 1
    if any(k in t for k in ["code", "function", "def ", "class ", "import ", "``", "fn ", "const "]): signals += 1
    if any(t.startswith(k) for k in ["write ", "create ", "build ", "implement ", "generate ", "fix ", "debug ", "optimize ", "explain ", "analyze ", "describe ", "design "]): signals += 1
    if re.search(r'[0-9]+[\s]*[+\-*/=]', text): signals += 1
    if any(k in t for k in ["first ", "then ", "finally", "step ", "part ", "section ", "also ", "and also"]): signals += 1
    if any(k in t for k in ["must ", "should ", "required ", "only ", "don't", "cannot ", "limit ", "maximum ", "minimum "]): signals += 1
    if any(k in t for k in ["given ", "consider ", "assume ", "suppose ", "based on ", "according to ", "using the ", "from the ", "in the context "]): signals += 1
    if any(k in t for k in ["architecture", "design pattern", "system design", "microservice", "scalable", "distributed"]): signals += 1
    if any(k in t for k in ["technical design", "implementation plan", "migration strategy", "deployment", "pipeline", "schema", "database"]): signals += 1
    has_context = 1.0 if any(k in t for k in ["given ", "consider ", "assume ", "suppose ", "based on ", "according to ", "using the ", "from the ", "in the context "]) else 0.0
    score = signals * 0.15 + math.log1p(wc) * 0.08 + has_context * 0.1
    if score < 0.10: return "trivial"
    if score < 0.20: return "light"
    if score < 0.35: return "moderate"
    if score < 0.50: return "heavy"
    if score < 0.65: return "intensive"
    return "extreme"



# ── GPD Synthetic Generator ──
GPD_TRIVIAL = [
    "What is {concept}?", "Explain {concept} briefly", "Define {concept}",
    "What does {acronym} stand for?", "Is {thing} a type of {category}?",
    "How many {unit} in a {thing}?", "When was {event}?",
    "List the top {n} {items}", "Convert {value} {from_unit} to {to_unit}",
    "What is the capital of {place}?", "How do you say {word} in {language}?",
    "Spell {word}", "What is {number} plus {number2}?",
    "Say hello", "Hi there", "How are you?", "What time is it?",
]
GPD_LIGHT = [
    "Read the file at {path} and tell me what it does",
    "Summarize the following text: {short_text}",
    "Format this code: {code_snippet}",
    "What's wrong with this error: {error_message}",
    "Add a docstring to: {function_signature}",
    "Write a test for: {function_signature}",
    "What does this command do: {shell_cmd}",
    "Fix the typo in: {code_snippet}",
    "Parse this JSON: {json_snippet}",
    "Sort this list: {list_data}",
]
GPD_CONCEPTS = ["API", "REST", "GraphQL", "Docker", "Git", "JSON", "SQL", "Redis", "React", "Python", "TypeScript", "Rust"]
GPD_ACRONYMS = [("API", "Application Programming Interface"), ("HTTP", "Hypertext Transfer Protocol"), ("JSON", "JavaScript Object Notation"), ("SQL", "Structured Query Language"), ("DNS", "Domain Name System")]
GPD_PATHS = ["src/main.py", "config/settings.json", "README.md", ".env", "package.json"]
GPD_ERRORS = ["TypeError: undefined is not a function", "SyntaxError: unexpected token", "ValueError: invalid literal", "KeyError: 'missing_key'", "ModuleNotFoundError: No module named 'requests'"]
GPD_FUNCS = ["def calculate_total(items: list[float]) -> float", "async def fetch_data(url: str) -> dict", "def parse_json(text: str) -> Optional[dict]"]
GPD_CMDS = ["ls -la", "grep -r 'pattern' .", "find . -name '*.py'", "ps aux | grep python", "curl -s https://example.com"]


def _gen_gpd_trivial(rng, idx):
    t = rng.choice(GPD_TRIVIAL)
    kw = {"concept": rng.choice(GPD_CONCEPTS), "acronym": rng.choice(GPD_ACRONYMS)[0],
          "thing": rng.choice(["byte", "kilobyte", "pixel", "vector"]),
          "category": rng.choice(["programming language", "framework", "database"]),
          "unit": rng.choice(["bytes", "seconds", "meters"]),
          "event": rng.choice(["the internet invented", "Python created", "Git released"]),
          "n": str(rng.randint(3, 10)), "items": rng.choice(["databases", "frameworks"]),
          "value": str(rng.randint(1, 1000)), "from_unit": rng.choice(["bytes", "KB"]),
          "to_unit": rng.choice(["KB", "MB"]), "place": rng.choice(["Brazil", "Japan", "Germany"]),
          "language": rng.choice(["Spanish", "French", "German"]),
          "word": rng.choice(["happy", "fast", "beautiful"]),
          "number": str(rng.randint(1, 100)), "number2": str(rng.randint(1, 100))}
    text = t.format(**kw)
    return re.sub(r'\{[^}]+\}', 'something', text)


def _gen_gpd_light(rng, idx):
    t = rng.choice(GPD_LIGHT)
    kw = {"path": rng.choice(GPD_PATHS), "short_text": "Python is a high-level programming language known for readability.",
          "code_snippet": "def hello(): print('hello')", "error_message": rng.choice(GPD_ERRORS),
          "function_signature": rng.choice(GPD_FUNCS), "shell_cmd": rng.choice(GPD_CMDS),
          "json_snippet": '{"key": "value", "count": 42}', "list_data": "[3, 1, 4, 1, 5, 9]"}
    text = t.format(**kw)
    return re.sub(r'\{[^}]+\}', 'data', text)


def generate_gpd_samples(n_trivial: int, n_light: int, seed: int = 42) -> list[dict]:
    rng = random.Random(seed)
    samples = []
    for i in range(n_trivial):
        text = _gen_gpd_trivial(rng, i)
        samples.append({"text": text, "label": "trivial", "features": extract_features(text), "source": "gpd-synthetic"})
    for i in range(n_light):
        text = _gen_gpd_light(rng, i)
        samples.append({"text": text, "label": "light", "features": extract_features(text), "source": "gpd-synthetic"})
    return samples


# ── Dataset Loaders ──
def load_hf(name: str, max_per: int) -> list[dict]:
    catalogs = {
        "alpaca": {"hf": "tatsu-lab/alpaca", "key": "instruction"},
        "openorca": {"hf": "Open-Orca/OpenOrca", "key": "question"},
    }
    if name not in catalogs:
        return []
    c = catalogs[name]
    try:
        ds = load_dataset(c["hf"], split=f"train[:{max_per}]")
        prompts = []
        for x in ds:
            txt = x.get(c["key"], "")
            if isinstance(txt, str) and len(txt) > 10:
                txt = txt.strip()
                feats = extract_features(txt)
                lab = label_from_explicit_signals(txt)
                prompts.append({"text": txt, "features": feats, "label": lab, "source": name})
        return prompts[:max_per]
    except Exception as e:
        print(f"  Failed {name}: {e}")
        return []


def load_jsonl_dataset(path: str) -> list[dict]:
    """Load a custom JSONL dataset with text/label records."""
    prompts = []
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  Skipping malformed JSONL line {line_no} in {path}: {e}")
                continue

            text = record.get("text") or record.get("prompt") or record.get("instruction")
            if not isinstance(text, str) or not text.strip():
                continue

            text = text.strip()
            prompts.append({
                "text": text,
                "features": record.get("features") or extract_features(text),
                "label": record.get("label") or label_from_explicit_signals(text),
                "source": record.get("source", "custom-jsonl"),
            })
    return prompts


# ── Binary Classifier Optimizer ──
def optimize_binary_classifier(X_pos: np.ndarray, X_neg: np.ndarray,
                                 y_pos: np.ndarray, y_neg: np.ndarray) -> dict:
    """
    Train a binary classifier using sklearn LogisticRegression.

    Returns:
        dict with model, weights, and metrics
    """
    # Balance: equal positive and negative samples
    n_min = min(len(X_pos), len(X_neg))
    if n_min < 10:
        return {"error": f"Too few samples: pos={len(X_pos)}, neg={len(X_neg)}", "success": False}

    rng = np.random.RandomState(42)
    pos_idx = rng.permutation(len(X_pos))[:n_min]
    neg_idx = rng.permutation(len(X_neg))[:n_min]

    X = np.vstack([X_pos[pos_idx], X_neg[neg_idx]])
    y = np.concatenate([y_pos[pos_idx], y_neg[neg_idx]])

    # Train logistic regression
    model = LogisticRegression(C=1.0, max_iter=1000, solver='lbfgs', random_state=42)
    model.fit(X, y)

    # Predictions on balanced set
    y_pred = model.predict(X)
    acc = accuracy_score(y, y_pred)

    # Extract weights
    weights = dict(zip(FEATURE_NAMES, model.coef_[0].tolist()))
    intercept = float(model.intercept_[0])

    return {
        "success": True,
        "accuracy": round(float(acc), 4),
        "n_pos": int(n_min),
        "n_neg": int(n_min),
        "weights": {k: round(v, 6) for k, v in weights.items()},
        "intercept": round(intercept, 6),
        "feature_importance": sorted(
            [{"feature": k, "weight": round(float(v), 6), "abs_weight": round(abs(float(v)), 6)}
             for k, v in weights.items()],
            key=lambda x: -x["abs_weight"]
        )[:5],  # Top 5 features
    }


# ── Cascade Classifier ──
class TierCascade:
    """
    Cascade of 5 binary classifiers:
      trivial? → light? → moderate? → heavy? → intensive? → (else: extreme)

    Each classifier is optimized independently on balanced data.
    """

    BOUNDARIES = [
        ("trivial", "non-trivial"),
        ("light", "non-light"),
        ("moderate", "non-moderate"),
        ("heavy", "non-heavy"),
        ("intensive", "non-intensive"),
    ]

    def __init__(self):
        self.models = {}
        self.thresholds = {}

    def train(self, train_data: list[dict]):
        """Train all 5 binary classifiers."""
        by_tier = {}
        for s in train_data:
            tier = s.get("label", "moderate")
            by_tier.setdefault(tier, []).append(s)

        all_features = np.array([features_to_vector(s["features"]) for s in train_data], dtype=np.float64)
        all_labels = np.array([s.get("label", "moderate") for s in train_data])

        results = {}

        # Classifier 1: trivial vs non-trivial
        mask_trivial = all_labels == "trivial"
        results["trivial"] = optimize_binary_classifier(
            all_features[mask_trivial], all_features[~mask_trivial],
            np.ones(mask_trivial.sum()), np.zeros((~mask_trivial).sum())
        )
        if results["trivial"].get("success"):
            self.models["trivial"] = results["trivial"]

        # Classifier 2: light vs non-light (excluding trivial)
        non_trivial_mask = all_labels != "trivial"
        mask_light = all_labels == "light"
        results["light"] = optimize_binary_classifier(
            all_features[non_trivial_mask & mask_light],
            all_features[non_trivial_mask & ~mask_light],
            np.ones((non_trivial_mask & mask_light).sum()),
            np.zeros((non_trivial_mask & ~mask_light).sum())
        )
        if results["light"].get("success"):
            self.models["light"] = results["light"]

        # Classifier 3: moderate vs non-moderate (excluding trivial, light)
        non_tl_mask = (all_labels != "trivial") & (all_labels != "light")
        mask_moderate = all_labels == "moderate"
        results["moderate"] = optimize_binary_classifier(
            all_features[non_tl_mask & mask_moderate],
            all_features[non_tl_mask & ~mask_moderate],
            np.ones((non_tl_mask & mask_moderate).sum()),
            np.zeros((non_tl_mask & ~mask_moderate).sum())
        )
        if results["moderate"].get("success"):
            self.models["moderate"] = results["moderate"]

        # Classifier 4: heavy vs non-heavy (excluding trivial, light, moderate)
        non_tlm_mask = (all_labels != "trivial") & (all_labels != "light") & (all_labels != "moderate")
        mask_heavy = all_labels == "heavy"
        results["heavy"] = optimize_binary_classifier(
            all_features[non_tlm_mask & mask_heavy],
            all_features[non_tlm_mask & ~mask_heavy],
            np.ones((non_tlm_mask & mask_heavy).sum()),
            np.zeros((non_tlm_mask & ~mask_heavy).sum())
        )
        if results["heavy"].get("success"):
            self.models["heavy"] = results["heavy"]

        # Classifier 5: intensive vs non-intensive (excluding trivial, light, moderate, heavy)
        non_tlmh_mask = ((all_labels != "trivial") & (all_labels != "light") &
                        (all_labels != "moderate") & (all_labels != "heavy"))
        mask_intensive = all_labels == "intensive"
        results["intensive"] = optimize_binary_classifier(
            all_features[non_tlmh_mask & mask_intensive],
            all_features[non_tlmh_mask & ~mask_intensive],
            np.ones((non_tlmh_mask & mask_intensive).sum()),
            np.zeros((non_tlmh_mask & ~mask_intensive).sum())
        )
        if results["intensive"].get("success"):
            self.models["intensive"] = results["intensive"]

        return results

    def predict(self, features: dict) -> str:
        """Predict tier using cascade."""
        X = np.array([features_to_vector(features)], dtype=np.float64)

        # 1. Trivial?
        if "trivial" in self.models:
            m = self.models["trivial"]
            w = np.array([m["weights"].get(f, 0) for f in FEATURE_NAMES])
            prob = 1 / (1 + np.exp(-(X @ w + m["intercept"])))
            if prob[0] > 0.5:
                return "trivial"

        # 2. Light?
        if "light" in self.models:
            m = self.models["light"]
            w = np.array([m["weights"].get(f, 0) for f in FEATURE_NAMES])
            prob = 1 / (1 + np.exp(-(X @ w + m["intercept"])))
            if prob[0] > 0.5:
                return "light"

        # 3. Moderate?
        if "moderate" in self.models:
            m = self.models["moderate"]
            w = np.array([m["weights"].get(f, 0) for f in FEATURE_NAMES])
            prob = 1 / (1 + np.exp(-(X @ w + m["intercept"])))
            if prob[0] > 0.5:
                return "moderate"

        # 4. Heavy?
        if "heavy" in self.models:
            m = self.models["heavy"]
            w = np.array([m["weights"].get(f, 0) for f in FEATURE_NAMES])
            prob = 1 / (1 + np.exp(-(X @ w + m["intercept"])))
            if prob[0] > 0.5:
                return "heavy"

        # 5. Intensive?
        if "intensive" in self.models:
            m = self.models["intensive"]
            w = np.array([m["weights"].get(f, 0) for f in FEATURE_NAMES])
            prob = 1 / (1 + np.exp(-(X @ w + m["intercept"])))
            if prob[0] > 0.5:
                return "intensive"

        # Default: extreme
        return "extreme"


def evaluate_cascade(cascade: TierCascade, test_data: list[dict]) -> dict:
    """Evaluate cascade classifier on test set."""
    total = len(test_data)
    correct = 0
    tier_correct = Counter()
    tier_total = Counter()

    y_pred = []
    y_true = []

    for s in test_data:
        actual = s.get("label", "moderate")
        predicted = cascade.predict(s["features"])

        tier_total[actual] += 1
        if predicted == actual:
            correct += 1
            tier_correct[actual] += 1

        y_pred.append(predicted)
        y_true.append(actual)

    tier_accuracy = {}
    for tier in TIERS:
        n = tier_total.get(tier, 0)
        tier_accuracy[tier] = {
            "total": n,
            "correct": tier_correct.get(tier, 0),
            "accuracy": round(tier_correct.get(tier, 0) / n, 4) if n > 0 else None,
        }

    # Also compute with sklearn for confusion matrix
    if len(set(y_true)) > 1 and len(set(y_pred)) > 1:
        # Macro accuracy
        unique_tiers = sorted(set(y_true) | set(y_pred))
        per_tier_acc = []
        for t in unique_tiers:
            tp = sum(1 for yt, yp in zip(y_true, y_pred) if yt == t and yp == t)
            fn = sum(1 for yt, yp in zip(y_true, y_pred) if yt == t and yp != t)
            if tp + fn > 0:
                per_tier_acc.append(tp / (tp + fn))
        macro_acc = sum(per_tier_acc) / len(per_tier_acc) if per_tier_acc else 0
    else:
        macro_acc = correct / total if total > 0 else 0

    return {
        "total": total,
        "correct": correct,
        "accuracy": round(correct / total, 4) if total > 0 else 0,
        "macro_accuracy": round(macro_acc, 4),
        "tier_accuracy": tier_accuracy,
        "y_pred": y_pred,
        "y_true": y_true,
    }


# ── Baseline Evaluation (default weights) ──
def evaluate_baseline(test_data: list[dict]) -> dict:
    """Evaluate using default weights + score-to-tier mapping."""
    total = len(test_data)
    correct = 0
    tier_correct = Counter()
    tier_total = Counter()

    for s in test_data:
        actual = s.get("label", "moderate")
        score = compute_score(s["features"], DEFAULT_WEIGHTS)
        predicted = score_to_tier(score)

        tier_total[actual] += 1
        if predicted == actual:
            correct += 1
            tier_correct[actual] += 1

    tier_accuracy = {}
    for tier in TIERS:
        n = tier_total.get(tier, 0)
        tier_accuracy[tier] = {
            "total": n,
            "correct": tier_correct.get(tier, 0),
            "accuracy": round(tier_correct.get(tier, 0) / n, 4) if n > 0 else None,
        }

    return {
        "total": total,
        "correct": correct,
        "accuracy": round(correct / total, 4) if total > 0 else 0,
        "tier_accuracy": tier_accuracy,
    }


# ── Main Handler ──
def handler(event):
    load_training_deps()
    inp = event.get("input", {})
    print(f"GateSwarm MoA Router v0.3 Tier-Pair Cascade — {datetime.now(timezone.utc).isoformat()}")

    datasets = inp.get("datasets", ["gpd", "alpaca"])
    max_per = inp.get("max_per", 20000)
    gpd_trivial = inp.get("gpd_trivial", 25000)
    gpd_light = inp.get("gpd_light", 10000)
    dataset_path = inp.get("dataset")

    all_samples = []

    # 1. Generate GPD
    if "gpd" in datasets:
        print(f"  Generating GPD ({gpd_trivial} trivial + {gpd_light} light)...")
        gpd = generate_gpd_samples(gpd_trivial, gpd_light)
        all_samples.extend(gpd)
        print(f"  ✅ {len(gpd)} GPD samples")

    # 2. Load Alpaca
    if "alpaca" in datasets:
        print(f"  Loading Alpaca (max {max_per})...")
        alpaca = load_hf("alpaca", max_per)
        all_samples.extend(alpaca)
        print(f"  ✅ {len(alpaca)} Alpaca samples")

    # 3. Load OpenOrca
    if "openorca" in datasets:
        print(f"  Loading OpenOrca (max {max_per})...")
        orca = load_hf("openorca", max_per)
        all_samples.extend(orca)
        print(f"  ✅ {len(orca)} OpenOrca samples")

    # 4. Load custom JSONL dataset
    if dataset_path:
        print(f"  Loading custom dataset: {dataset_path}...")
        custom = load_jsonl_dataset(dataset_path)
        all_samples.extend(custom)
        print(f"  ✅ {len(custom)} custom samples")

    if not all_samples:
        return {"error": "No prompts loaded", "status": "failed"}

    print(f"\n  Total samples: {len(all_samples)}")

    # Label distribution
    label_dist = Counter(s.get("label", "unknown") for s in all_samples)
    print(f"  Label distribution: {dict(label_dist)}")

    # Stratified split
    random.seed(42)
    by_label = {}
    for s in all_samples:
        lab = s.get("label", "unknown")
        by_label.setdefault(lab, []).append(s)

    train_data, test_data = [], []
    for lab, samples in by_label.items():
        random.shuffle(samples)
        split = int(len(samples) * 0.8)
        train_data.extend(samples[:split])
        test_data.extend(samples[split:])

    random.shuffle(train_data)
    random.shuffle(test_data)

    print(f"  Train: {len(train_data)} | Test: {len(test_data)}")

    # Test tier distribution
    test_tier_dist = Counter(s.get("label", "moderate") for s in test_data)
    print(f"  Test tier distribution: {dict(test_tier_dist)}")

    # ── Baseline Evaluation (default weights) ──
    print(f"\n  Evaluating baseline (default weights)...")
    baseline_result = evaluate_baseline(test_data)
    print(f"  Baseline accuracy: {baseline_result['accuracy']:.1%}")
    for tier in TIERS:
        ta = baseline_result["tier_accuracy"].get(tier, {})
        if ta.get("total", 0) > 0:
            print(f"    {tier}: {ta['accuracy']:.1%} ({ta['correct']}/{ta['total']})")

    # ── Train Tier-Pair Cascade ──
    print(f"\n  Training tier-pair binary classifiers...")
    cascade = TierCascade()
    classifier_results = cascade.train(train_data)

    # ── Evaluate Cascade ──
    print(f"\n  Evaluating cascade classifier...")
    cascade_result = evaluate_cascade(cascade, test_data)
    print(f"  Cascade accuracy: {cascade_result['accuracy']:.1%}")
    print(f"  Macro accuracy: {cascade_result['macro_accuracy']:.1%}")
    for tier in TIERS:
        ta = cascade_result["tier_accuracy"].get(tier, {})
        if ta.get("total", 0) > 0:
            print(f"    {tier}: {ta['accuracy']:.1%} ({ta['correct']}/{ta['total']})")

    # ── Build classifier summaries ──
    classifier_summaries = {}
    for name, result in classifier_results.items():
        if result.get("success"):
            classifier_summaries[name] = {
                "accuracy": result["accuracy"],
                "n_samples": result["n_pos"] * 2,  # balanced
                "top_features": result["feature_importance"],
                "intercept": result["intercept"],
                "weights": result["weights"],
            }

    # ── Comparison ──
    comparison = {}
    for tier in TIERS:
        bl = baseline_result["tier_accuracy"].get(tier, {})
        cs = cascade_result["tier_accuracy"].get(tier, {})
        bl_acc = bl.get("accuracy")
        cs_acc = cs.get("accuracy")
        if bl_acc is not None and cs_acc is not None:
            comparison[tier] = {
                "baseline": bl_acc,
                "cascade": cs_acc,
                "delta": round(cs_acc - bl_acc, 4),
                "baseline_correct": bl.get("correct", 0),
                "cascade_correct": cs.get("correct", 0),
                "total": bl.get("total", 0),
            }

    # ── Result ──
    result = {
        "version": "v0.3-cascade",
        "status": "completed",
        "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        "config": {
            "datasets": datasets,
            "max_per": max_per,
            "gpd_trivial": gpd_trivial,
            "gpd_light": gpd_light,
            "method": "tier-pair-binary-cascade",
        },
        "dataset_stats": {
            "total_samples": len(all_samples),
            "train_samples": len(train_data),
            "test_samples": len(test_data),
            "label_distribution": dict(label_dist),
            "test_tier_distribution": dict(test_tier_dist),
        },
        "baseline": {
            "accuracy": baseline_result["accuracy"],
            "correct": baseline_result["correct"],
            "total": baseline_result["total"],
            "tier_accuracy": baseline_result["tier_accuracy"],
        },
        "cascade": {
            "accuracy": cascade_result["accuracy"],
            "macro_accuracy": cascade_result["macro_accuracy"],
            "correct": cascade_result["correct"],
            "total": cascade_result["total"],
            "tier_accuracy": cascade_result["tier_accuracy"],
        },
        "comparison": comparison,
        "classifiers": classifier_summaries,
        "improvement": round(cascade_result["accuracy"] - baseline_result["accuracy"], 4),
        "macro_improvement": round(cascade_result["macro_accuracy"] - baseline_result["accuracy"], 4),
    }

    return result


def parse_args():
    parser = argparse.ArgumentParser(description="Train the GateSwarm tier-pair cascade")
    parser.add_argument("--datasets", default="gpd,alpaca", help="Comma-separated built-in datasets to load")
    parser.add_argument("--max-per", type=int, default=10000, help="Maximum samples per built-in dataset")
    parser.add_argument("--gpd-trivial", type=int, default=25000, help="Number of synthetic trivial GPD samples")
    parser.add_argument("--gpd-light", type=int, default=10000, help="Number of synthetic light GPD samples")
    parser.add_argument("--output", help="Optional path to write the full training result JSON")
    parser.add_argument("--dataset", help="Optional custom JSONL dataset path")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    ensure_deps()
    load_training_deps()

    result = handler({
        "input": {
            "datasets": [d.strip() for d in args.datasets.split(",") if d.strip()],
            "max_per": args.max_per,
            "gpd_trivial": args.gpd_trivial,
            "gpd_light": args.gpd_light,
            "dataset": args.dataset,
        }
    })

    rendered = json.dumps(result, indent=2)
    print(rendered)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(rendered)
            f.write("\n")
