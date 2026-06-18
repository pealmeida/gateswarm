"""
GateSwarm MoA Router v0.3.5 — Production Complexity Scorer & Model Router

Classifies prompt complexity into 6 tiers using a pre-trained binary cascade,
then recommends the cheapest model that can handle it.

Usage:
    # As a Python library
    from router import score_prompt
    result = score_prompt("Write a REST API in Python")
    # {"tier": "heavy", "confidence": 0.82, "score": 0.42, "model": "glm-5.1", ...}

    # From the command line
    python router.py "Write a REST API in Python"

    # As an HTTP API server
    python router.py --serve --port 8080

    # Batch scoring
    python router.py --file prompts.jsonl --output scored.jsonl
"""

import json
import math
import re
import os
import sys
import time
import argparse
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler

import numpy as np

__version__ = "0.3.5"

# ── Constants ────────────────────────────────────────────────────────────────

FEATURE_NAMES = [
    "sentence_count", "avg_word_length", "has_question", "question_technical",
    "technical_design", "code", "architecture", "word_count",
    "four_plus", "has_imperative", "technical_terms", "multi_step",
    "requires_context", "domain_specificity", "ambiguity_score",
]

TIERS = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]

TIER_MODELS = {
    "trivial":   {"model": "glm-4.5-air",       "provider": "zai",      "max_tokens": 256},
    "light":     {"model": "glm-4.7-flash",      "provider": "zai",      "max_tokens": 512},
    "moderate":  {"model": "glm-4.7",            "provider": "zai",      "max_tokens": 1024},
    "heavy":     {"model": "glm-5.1",            "provider": "zai",      "max_tokens": 2048},
    "intensive": {"model": "qwen3.6-plus",       "provider": "bailian",  "max_tokens": 4096},
    "extreme":   {"model": "qwen3.6-plus",       "provider": "bailian",  "max_tokens": 8192},
}

TIER_BOUNDARIES = [
    (0.08, "trivial"),
    (0.18, "light"),
    (0.32, "moderate"),
    (0.52, "heavy"),
    (0.72, "intensive"),
    (1.01, "extreme"),
]

# ── Keyword Sets ─────────────────────────────────────────────────────────────

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

# ── Feature Extraction ───────────────────────────────────────────────────────

def extract_features(text: str) -> dict:
    """Extract 15-feature complexity vector from prompt text."""
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
        "word_count": wc, "sentence_count": sc, "avg_word_length": round(awl, 3),
        "has_code": float(has_code), "has_question": float(has_question),
        "has_imperative": float(has_imperative), "technical_terms": tech_terms,
        "question_technical": float(question_technical),
        "architecture": float(architecture), "technical_design": float(technical_design),
        "multi_step": float(multi_step), "requires_context": float(requires_context),
        "domain_specificity": round(domain_spec, 3), "ambiguity_score": round(ambiguity, 3),
        "four_plus": four_plus,
    }


def _features_to_vector(f: dict) -> np.ndarray:
    return np.array([float(f.get(n, 0)) for n in FEATURE_NAMES], dtype=np.float64)


def score_to_tier(score: float) -> str:
    """Map continuous score [0, 1] to tier label."""
    for boundary, tier in TIER_BOUNDARIES:
        if score < boundary:
            return tier
    return "extreme"


# ── Heuristic Scoring (fallback, no weights file needed) ─────────────────────

def _heuristic_score(features: dict) -> float:
    """Weighted feature sum — used as base score or fallback."""
    f = features
    w = {
        "sentence_count": 0.29, "avg_word_length": 0.19, "has_question": 0.12,
        "question_technical": 0.05, "technical_design": 0.12, "code": 0.10,
        "architecture": 0.07, "word_count": 0.00, "four_plus": 0.00,
        "has_imperative": 0.06, "technical_terms": 0.00, "multi_step": 0.00,
        "requires_context": 0.00, "domain_specificity": 0.00, "ambiguity_score": 0.00,
    }
    s = 0.0
    s += w["sentence_count"] * min(f.get("sentence_count", 0), 10) / 10.0
    s += w["avg_word_length"] * f.get("avg_word_length", 0) / 10.0
    s += w["has_question"] * f.get("has_question", 0)
    s += w["question_technical"] * f.get("question_technical", 0)
    s += w["technical_design"] * f.get("technical_design", 0)
    s += w["code"] * f.get("has_code", 0)
    s += w["architecture"] * f.get("architecture", 0)
    s += w["word_count"] * math.log1p(f.get("word_count", 0)) / 6.0
    s += w["four_plus"] * f.get("four_plus", 0)
    s += w["has_imperative"] * f.get("has_imperative", 0)
    s += w["technical_terms"] * min(f.get("technical_terms", 0), 10) / 10.0
    s += w["multi_step"] * f.get("multi_step", 0)
    s += w["requires_context"] * f.get("requires_context", 0)
    s += w["domain_specificity"] * f.get("domain_specificity", 0)
    s += w["ambiguity_score"] * f.get("ambiguity_score", 0)
    if f.get("word_count", 0) < 10 and f.get("architecture", 0) == 0:
        s *= 0.7
    return min(max(s, 0.0), 1.0)


# ── Cascade Classifier ──────────────────────────────────────────────────────

class TierCascade:
    """Cascade of 5 binary logistic classifiers for tier prediction."""

    CASCADE_ORDER = ["trivial", "light", "moderate", "heavy", "intensive"]
    TIER_MIDPOINTS = {
        "trivial": 0.04, "light": 0.13, "moderate": 0.25,
        "heavy": 0.42, "intensive": 0.62, "extreme": 0.86,
    }

    def __init__(self):
        self.weights = {}
        self.intercepts = {}
        self._loaded = False

    def load(self, path: str):
        """Load pre-trained cascade weights from JSON."""
        with open(path) as f:
            data = json.load(f)

        for tier in self.CASCADE_ORDER:
            c = data.get("classifiers", {}).get(tier)
            if c:
                self.weights[tier] = np.array(
                    [c["weights"].get(fn, 0.0) for fn in FEATURE_NAMES],
                    dtype=np.float64,
                )
                self.intercepts[tier] = float(c.get("intercept", 0.0))

        self._loaded = len(self.weights) == 5
        return self._loaded

    def predict(self, features: dict) -> tuple:
        """
        Predict (tier, confidence, score) using pairwise logit analysis.

        Each classifier k is trained: positive=tier_k, negative=higher tiers.
        logit_k - logit_{k+1} > 0 means the prompt looks more like tier_k.
        The transition from positive to negative diff identifies the boundary.
        """
        if not self._loaded:
            return "moderate", 0.5, 0.25

        x = _features_to_vector(features)

        # Compute all logits
        logits = []
        for tier in self.CASCADE_ORDER:
            if tier in self.weights:
                logits.append(float(x @ self.weights[tier] + self.intercepts[tier]))
            else:
                logits.append(0.0)

        # Pairwise diffs: logit[i] - logit[i+1]
        pairwise = [logits[i] - logits[i + 1] for i in range(len(logits) - 1)]

        # First tier where pairwise diff is positive
        predicted_idx = len(self.CASCADE_ORDER)  # default: extreme
        for i, pw in enumerate(pairwise):
            if pw > 0:
                predicted_idx = i
                break

        tier = self.CASCADE_ORDER[predicted_idx] if predicted_idx < len(self.CASCADE_ORDER) else "extreme"

        # Confidence from sigmoid of winning pairwise diff
        if predicted_idx < len(pairwise):
            confidence = min(1.0 / (1.0 + math.exp(-pairwise[predicted_idx])), 0.99)
        else:
            confidence = 0.5

        # Score: blend heuristic base with cascade midpoint
        base_score = _heuristic_score(features)
        cascade_mid = self.TIER_MIDPOINTS.get(tier, 0.5)
        score = round(min(max(0.6 * base_score + 0.4 * cascade_mid, 0.0), 1.0), 4)

        # Re-derive tier from blended score (more stable)
        tier = score_to_tier(score)

        return tier, round(confidence, 4), score


# ── Public API ───────────────────────────────────────────────────────────────

# Module-level cascade (lazy-loaded)
_cascade = TierCascade()
_weights_loaded = False


def _ensure_weights():
    global _weights_loaded
    if _weights_loaded:
        return True
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "v32_cascade_weights.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights", "v32_cascade_weights.json"),
        "v32_cascade_weights.json",
    ]
    for path in candidates:
        if os.path.exists(path):
            _weights_loaded = _cascade.load(path)
            return _weights_loaded
    return False


def score_prompt(text: str, include_features: bool = False, include_routing: bool = True) -> dict:
    """
    Score a single prompt for complexity and model routing.

    Args:
        text: The prompt text to classify.
        include_features: Include the 15-feature vector in output.
        include_routing: Include recommended model/provider.

    Returns:
        dict with tier, confidence, score, and optional model/features.

    Example:
        >>> from router import score_prompt
        >>> score_prompt("hello")
        {'tier': 'trivial', 'confidence': 0.95, 'score': 0.03, 'model': 'glm-4.5-air', ...}
    """
    t0 = time.time()
    features = extract_features(text)

    has_weights = _ensure_weights()
    if has_weights:
        tier, confidence, score = _cascade.predict(features)
        method = "cascade"
    else:
        score = _heuristic_score(features)
        tier = score_to_tier(score)
        confidence = round(score, 4)
        method = "heuristic"

    result = {
        "tier": tier,
        "confidence": confidence,
        "score": score,
        "method": method,
    }

    if include_routing:
        routing = TIER_MODELS.get(tier, TIER_MODELS["moderate"])
        result["model"] = routing["model"]
        result["provider"] = routing["provider"]
        result["max_tokens"] = routing["max_tokens"]

    if include_features:
        result["features"] = features

    result["latency_ms"] = round((time.time() - t0) * 1000, 2)
    return result


def score_prompts(texts: list[str], **kwargs) -> list[dict]:
    """Score multiple prompts."""
    return [score_prompt(t, **kwargs) for t in texts]


# ── Custom Tier Models ──────────────────────────────────────────────────────

def set_tier_models(models: dict):
    """
    Override the default model assignments per tier.

    Args:
        models: Dict mapping tier names to {"model": ..., "provider": ..., "max_tokens": ...}

    Example:
        >>> from router import set_tier_models
        >>> set_tier_models({
        ...     "trivial": {"model": "gpt-4o-mini", "provider": "openai", "max_tokens": 256},
        ...     "heavy":   {"model": "claude-sonnet-4-6", "provider": "anthropic", "max_tokens": 4096},
        ... })
    """
    for tier, config in models.items():
        if tier in TIER_MODELS:
            TIER_MODELS[tier] = config


# ── HTTP API Server ─────────────────────────────────────────────────────────

class _RouterHandler(BaseHTTPRequestHandler):
    """Minimal JSON API for prompt scoring."""

    def do_POST(self):
        if self.path != "/score":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        prompts = body.get("prompts", [])
        if body.get("prompt") and not prompts:
            prompts = [body["prompt"]]

        if not prompts:
            self._json({"error": "No prompt provided. Send {\"prompt\": \"...\"}"}, 400)
            return

        results = score_prompts(
            prompts,
            include_features=body.get("include_features", False),
            include_routing=body.get("include_routing", True),
        )

        if len(results) == 1:
            output = results[0]
        else:
            output = {"results": results, "total_prompts": len(prompts)}

        output["version"] = __version__
        self._json(output)

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "version": __version__, "weights_loaded": _weights_loaded})
        else:
            self._json({
                "name": "gateswarm-moa-router",
                "version": __version__,
                "endpoints": {"POST /score": "Score prompt(s)", "GET /health": "Health check"},
            })

    def _json(self, data, code=200):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {fmt % args}")


def serve(host: str = "0.0.0.0", port: int = 8080):
    """Start the HTTP scoring API."""
    _ensure_weights()
    server = HTTPServer((host, port), _RouterHandler)
    print(f"GateSwarm MoA Router v{__version__}")
    print(f"  Weights: {'loaded' if _weights_loaded else 'heuristic fallback'}")
    print(f"  Listening: http://{host}:{port}")
    print(f"  Endpoints: POST /score | GET /health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GateSwarm MoA Router v0.3.5")
    parser.add_argument("prompt", nargs="?", help="Prompt text to score")
    parser.add_argument("--serve", action="store_true", help="Start HTTP API server")
    parser.add_argument("--host", default="0.0.0.0", help="Server host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Server port (default: 8080)")
    parser.add_argument("--file", help="Score prompts from a JSONL file (one per line)")
    parser.add_argument("--output", help="Output file for batch results")
    parser.add_argument("--features", action="store_true", help="Include feature vector in output")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")

    args = parser.parse_args()

    if args.serve:
        serve(args.host, args.port)
        return

    if args.file:
        # Batch mode
        with open(args.file) as f:
            prompts = [json.loads(line).get("prompt", line.strip()) for line in f if line.strip()]

        results = score_prompts(prompts, include_features=args.features)

        output_lines = "\n".join(json.dumps(r, indent=None) for r in results)
        if args.output:
            with open(args.output, "w") as f:
                f.write(output_lines + "\n")
            print(f"Scored {len(results)} prompts → {args.output}")
        else:
            print(output_lines)
        return

    if args.prompt:
        result = score_prompt(args.prompt, include_features=args.features)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"  Tier:       {result['tier']}")
            print(f"  Score:      {result['score']}")
            print(f"  Confidence: {result['confidence']}")
            print(f"  Method:     {result['method']}")
            if "model" in result:
                print(f"  Model:      {result['model']} ({result['provider']})")
            print(f"  Latency:    {result['latency_ms']}ms")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
