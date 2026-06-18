#!/usr/bin/env python3
"""
LLMFit — RAG-Based Personalized Dataset Factory

Core engine for extracting, labeling, and packaging user context
into fine-tuning datasets for MoA Gateway routing optimization.

Usage:
    python llmfit.py generate --source workspace --output datasets/custom/my-dataset/raw.jsonl
    python llmfit.py label --input datasets/custom/my-dataset/raw.jsonl --mode hybrid
    python llmfit.py validate --input datasets/custom/my-dataset/labeled.jsonl
    python llmfit.py optimize --input datasets/custom/my-dataset/labeled.jsonl --output weights.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Add parent dir for imports ─────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent / "llmfit"))

# ── Data Model ─────────────────────────────────────────────────────────────

@dataclass
class TrainingSample:
    """Standard LLMFit training sample."""
    id: str
    source: str
    raw_text: str
    context: dict = field(default_factory=dict)
    complexity_hint: str = ""  # trivial|light|moderate|heavy|intensive|extreme
    intent_type: str = "query"
    domain: str = "general"
    features: dict = field(default_factory=dict)
    label: str = ""  # Final assigned label
    confidence: float = 1.0
    created_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if not self.features:
            self.features = extract_features(self.raw_text)
        if not self.complexity_hint:
            self.complexity_hint = estimate_complexity(self.raw_text, self.features)


# ── Feature Extraction ─────────────────────────────────────────────────────

TECHNICAL_KEYWORDS = {
    "api", "http", "rest", "graphql", "websocket", "dns", "ssl", "tls",
    "oauth", "jwt", "cors", "cdn", "docker", "kubernetes", "git",
    "json", "yaml", "xml", "csv", "sql", "nosql", "redis", "mongodb",
    "postgresql", "mysql", "typescript", "python", "rust", "java", "golang",
    "react", "vue", "angular", "svelte", "node", "express", "fastapi",
    "function", "class", "async", "await", "error", "type", "interface",
    "architecture", "design", "system", "microservice", "container",
    "deploy", "pipeline", "ci/cd", "agile", "scrum",
    "algorithm", "data structure", "big o", "complexity",
    "security", "authentication", "authorization", "encryption",
    "database", "cache", "queue", "broker", "proxy", "gateway",
    "refactor", "migrate", "optimize", "benchmark", "profile",
    "debug", "trace", "log", "monitor", "alert",
}

ARCHITECTURE_KEYWORDS = {
    "architecture", "design pattern", "system design", "microservice",
    "distributed", "scalable", "high availability", "load balancer",
    "event-driven", "message queue", "service mesh", "api gateway",
    "monolith", "serverless", "cloud-native", "infrastructure",
}

DESIGN_KEYWORDS = {
    "technical design", "implementation plan", "migration strategy",
    "deployment strategy", "release plan", "rollback plan",
    "capacity planning", "disaster recovery", "failover",
}

IMPERATIVE_STARTS = {
    "read", "summarize", "format", "explain", "add", "rename", "write",
    "check", "count", "find", "replace", "show", "make", "fix", "extract",
    "parse", "validate", "sort", "filter", "group", "calculate",
    "deduplicate", "reverse", "split", "join", "trim", "lowercase",
    "uppercase", "capitalize", "list", "define", "tell", "give",
    "convert", "spell", "say", "help", "create", "build", "run",
    "test", "compile", "install", "update", "delete", "remove",
    "implement", "refactor", "optimize", "deploy", "configure",
    "set up", "integrate", "migrate", "debug", "trace",
}


def extract_features(text: str) -> dict:
    """Extract standardized feature vector from a prompt."""
    words = re.findall(r'\w+', text.lower())
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    word_count = len(words)
    sentence_count = len(sentences)
    avg_word_length = round(sum(len(w) for w in words) / max(word_count, 1), 2)

    has_code = bool(re.search(r'```|`[^`]+`|def\s+\w+|const\s+\w+|function\s+\w+|class\s+\w+|import\s+[\w.]+', text))
    has_question = '?' in text
    has_imperative = any(text.lower().startswith(imp) for imp in IMPERATIVE_STARTS)

    tech_terms = sum(1 for w in words if w in TECHNICAL_KEYWORDS)
    question_technical = has_question and tech_terms > 0
    architecture = any(kw in text.lower() for kw in ARCHITECTURE_KEYWORDS)
    technical_design = any(kw in text.lower() for kw in DESIGN_KEYWORDS)
    multi_step = bool(re.search(r'(first|then|next|after that|finally|step\s*\d+|\band also\b|\bplus\b)', text.lower()))
    requires_context = bool(re.search(r'(the file|this project|my code|our system|the config|the database)', text.lower()))

    # Detect code language
    code_language = "unknown"
    text_lower = text.lower()
    if re.search(r'\bdef\s+\w+', text_lower) or 'python' in text_lower:
        code_language = "python"
    elif re.search(r'\b(const|let|var)\s+\w+', text_lower) or 'typescript' in text_lower:
        code_language = "typescript"
    elif re.search(r'\bfn\s+\w+', text_lower) or 'rust' in text_lower:
        code_language = "rust"
    elif re.search(r'\bfunc\s+\w+', text_lower) or 'golang' in text_lower:
        code_language = "go"
    elif re.search(r'\bselect\b.*\bfrom\b', text_lower):
        code_language = "sql"

    domain_specificity = round(min(tech_terms / max(word_count, 1), 1.0), 3)

    # Ambiguity: vague words, incomplete sentences
    vague_words = {'something', 'stuff', 'thing', 'things', 'it', 'this', 'that', 'whatever'}
    ambiguity_score = round(min(sum(1 for w in words if w in vague_words) / max(word_count, 1), 1.0), 3)

    return {
        "word_count": word_count,
        "sentence_count": sentence_count,
        "avg_word_length": avg_word_length,
        "has_code": has_code,
        "has_question": has_question,
        "has_imperative": has_imperative,
        "technical_terms": tech_terms,
        "question_technical": question_technical,
        "architecture": architecture,
        "technical_design": technical_design,
        "multi_step": multi_step,
        "requires_context": requires_context,
        "code_language": code_language,
        "domain_specificity": domain_specificity,
        "ambiguity_score": ambiguity_score,
    }


# ── Complexity Estimation (Rule-Based) ──────────────────────────────────────

def estimate_complexity(text: str, features: Optional[dict] = None) -> str:
    """Estimate complexity tier using rule-based heuristics."""
    if features is None:
        features = extract_features(text)

    wc = features["word_count"]
    code = features["has_code"]
    tech = features["technical_terms"]
    multi = features["multi_step"]
    arch = features["architecture"]
    design = features["technical_design"]
    context = features["requires_context"]

    # Trivial: short, no code, no tech terms, single step
    if wc < 50 and not code and tech == 0 and not multi:
        return "trivial"

    # Extreme: architecture + design + multi-step
    if arch and design and multi:
        return "extreme"

    # Intensive: architecture + (multi-step or needs context)
    if arch and (multi or context):
        return "intensive"

    # Heavy: long + (multi-step or design hints)
    if wc > 300 and (multi or design):
        return "heavy"

    # Moderate: has code or 3+ tech terms
    if code or tech >= 3:
        return "moderate"

    # Light: medium length, simple
    if wc < 200 and not multi and not arch and tech <= 2:
        return "light"

    # Default to moderate
    return "moderate"


# ── Source Connectors ───────────────────────────────────────────────────────

def scan_workspace(
    root_path: str,
    exclude: Optional[list] = None,
    max_file_size_kb: int = 512,
) -> list[TrainingSample]:
    """Scan workspace directory and extract training samples."""
    exclude = exclude or ["node_modules", ".git", "coverage", "__pycache__"]
    root = Path(root_path)
    samples = []
    idx = 0

    for filepath in root.rglob("*"):
        if not filepath.is_file():
            continue

        # Skip excluded dirs
        if any(part in exclude for part in filepath.parts):
            continue

        # Skip non-text files
        if filepath.suffix in {'.png', '.jpg', '.gif', '.ico', '.exe', '.dll', '.so', '.pyc'}:
            continue

        # Skip large files
        try:
            size_kb = filepath.stat().st_size / 1024
            if size_kb > max_file_size_kb:
                continue
        except OSError:
            continue

        # Read and chunk
        try:
            content = filepath.read_text(encoding="utf-8", errors="ignore")
        except (OSError, UnicodeDecodeError):
            continue

        # Extract text chunks
        chunks = _chunk_content(content, filepath.suffix)
        for chunk in chunks:
            sample = TrainingSample(
                id=f"ws_{hashlib.md5(str(filepath).encode()).hexdigest()[:8]}_{idx:04d}",
                source="workspace-scanner",
                raw_text=chunk[:4000],
                context={"file": str(filepath.relative_to(root)), "chunk": idx},
                intent_type="query",
                domain="general",
            )
            samples.append(sample)
            idx += 1

    return samples


def _chunk_content(content: str, suffix: str) -> list[str]:
    """Chunk file content at natural boundaries."""
    chunks = []

    if suffix in {'.py', '.ts', '.js', '.rs', '.go'}:
        # Split at function/class definitions
        pattern = r'(?=(?:def |async def |function |class |fn |func |const\s+\w+\s*=\s*(?:async\s+)?\())'
        parts = re.split(pattern, content)
        for part in parts:
            if part.strip() and len(part) > 50:
                chunks.append(part.strip())
    elif suffix in {'.md', '.txt', '.rst'}:
        # Split at headers
        parts = re.split(r'^#{1,3}\s+', content, flags=re.MULTILINE)
        for part in parts:
            if part.strip() and len(part) > 50:
                chunks.append(part.strip())
    else:
        # Fixed-size windows with overlap
        window_size = 4000
        overlap = 500
        for i in range(0, len(content), window_size - overlap):
            chunk = content[i:i + window_size]
            if chunk.strip() and len(chunk) > 50:
                chunks.append(chunk.strip())

    return chunks if chunks else [content[:4000]]


def extract_session_turns(
    session_file: str,
    max_turns: int = 500,
) -> list[TrainingSample]:
    """Extract user turns from a session transcript file."""
    path = Path(session_file)
    if not path.exists():
        return []

    samples = []
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return []

    # Extract user messages
    for i, msg in enumerate(data.get("messages", [])[:max_turns]):
        if msg.get("role") != "user":
            continue

        text = msg.get("content", "")
        if not text or len(text) < 10:
            continue

        sample = TrainingSample(
            id=f"sess_{path.stem}_{i:04d}",
            source="session-miner",
            raw_text=text[:4000],
            context={"session": path.stem, "turn": i},
        )
        samples.append(sample)

    return samples


# ── Quality Gate ────────────────────────────────────────────────────────────

@dataclass
class ValidationResult:
    passed: bool
    issues: list[str]
    sample_count: int
    class_distribution: dict
    duplicate_rate: float
    avg_word_count: float


def validate_dataset(samples: list[TrainingSample], min_samples: int = 100) -> ValidationResult:
    """Run quality validation on a dataset."""
    issues = []

    if len(samples) < min_samples:
        issues.append(f"Too few samples: {len(samples)} < {min_samples}")

    # Check labels
    labels = [s.label or s.complexity_hint for s in samples]
    label_counts = Counter(labels)
    total = len(samples)

    for label, count in label_counts.items():
        pct = count / total
        if pct < 0.05:
            issues.append(f"Class '{label}' underrepresented: {pct:.1%} < 5%")

    if len(label_counts) < 2:
        issues.append("Dataset has only one class — needs variety for optimization")

    # Check duplicates
    texts = [s.raw_text for s in samples]
    unique_texts = set(texts)
    dup_rate = 1 - (len(unique_texts) / max(len(texts), 1))

    if dup_rate > 0.10:
        issues.append(f"High duplicate rate: {dup_rate:.1%} > 10%")

    # Check text quality
    short = sum(1 for s in samples if len(s.raw_text) < 5)
    long_ = sum(1 for s in samples if len(s.raw_text) > 4000)
    if short > 0:
        issues.append(f"{short} samples too short (<5 chars)")
    if long_ > 0:
        issues.append(f"{long_} samples too long (>4000 chars)")

    # Check feature variance
    if samples:
        wc_values = [s.features.get("word_count", 0) for s in samples]
        if len(set(wc_values)) <= 1:
            issues.append("word_count has zero variance — feature is useless")

    avg_wc = sum(s.features.get("word_count", 0) for s in samples) / max(len(samples), 1)

    return ValidationResult(
        passed=len(issues) == 0,
        issues=issues,
        sample_count=len(samples),
        class_distribution=dict(label_counts),
        duplicate_rate=round(dup_rate, 3),
        avg_word_count=round(avg_wc, 1),
    )


def deduplicate(samples: list[TrainingSample]) -> list[TrainingSample]:
    """Remove exact duplicate samples."""
    seen = set()
    unique = []
    for s in samples:
        if s.raw_text not in seen:
            seen.add(s.raw_text)
            unique.append(s)
    return unique


# ── Weight Optimizer ────────────────────────────────────────────────────────

def tier_to_score(tier: str) -> float:
    """Map complexity tier to numeric score for optimization."""
    mapping = {
        "trivial": 0.04,
        "light": 0.13,
        "moderate": 0.25,
        "heavy": 0.42,
        "intensive": 0.62,
        "extreme": 0.86,
    }
    return mapping.get(tier, 0.25)


FEATURE_WEIGHT_NAMES = [
    "sentence_count", "avg_word_length", "has_question", "question_technical",
    "technical_design", "code", "architecture", "word_count",
    "four_plus", "has_imperative", "technical_terms", "multi_step",
    "requires_context", "domain_specificity", "ambiguity_score",
]


def optimize_weights(
    samples: list[TrainingSample],
    current_weights: Optional[dict] = None,
    method: str = "scipy_mse",
) -> dict[str, float]:
    """
    Optimize heuristic weights from labeled samples.

    Uses scipy minimize to find weights that minimize misrouting MSE.
    """
    try:
        import numpy as np
        from scipy.optimize import minimize
    except ImportError:
        print("ERROR: scipy and numpy required for weight optimization.")
        print("Install with: pip install scipy numpy")
        return current_weights or _default_weights()

    # Build feature matrix
    X = np.array([_sample_to_feature_vector(s) for s in samples], dtype=np.float64)
    y_true = np.array([tier_to_score(s.label or s.complexity_hint) for s in samples])

    # Default starting weights (from v3.0 optimized)
    if current_weights is None:
        current_weights = _default_weights()

    x0 = np.array([current_weights.get(f, 0.0) for f in FEATURE_WEIGHT_NAMES], dtype=np.float64)

    def mse_objective(weights):
        scores = X @ weights
        return np.mean((scores - y_true) ** 2)

    # Optimize with constraints
    bounds = [(0, 0.35)] * len(FEATURE_WEIGHT_NAMES)
    result = minimize(mse_objective, x0, bounds=bounds, method="L-BFGS-B")

    # Normalize to sum=1
    optimized = result.x
    total = optimized.sum()
    if total > 0:
        optimized = optimized / total

    weights_dict = dict(zip(FEATURE_WEIGHT_NAMES, optimized.tolist()))

    # Report improvement
    mse_before = mse_objective(x0)
    mse_after = mse_objective(optimized)
    improvement = (1 - mse_after / mse_before) * 100 if mse_before > 0 else 0

    print(f"Weight optimization complete:")
    print(f"  MSE before: {mse_before:.6f}")
    print(f"  MSE after:  {mse_after:.6f}")
    print(f"  Improvement: {improvement:.1f}%")
    print(f"  Iterations: {result.nit}")

    return weights_dict


def _sample_to_feature_vector(sample: TrainingSample) -> list[float]:
    """Convert a TrainingSample to a feature vector matching weight names."""
    f = sample.features
    return [
        f.get("sentence_count", 0),
        f.get("avg_word_length", 0),
        float(f.get("has_question", False)),
        float(f.get("question_technical", False)),
        float(f.get("technical_design", False)),
        float(f.get("has_code", False)),
        float(f.get("architecture", False)),
        f.get("word_count", 0),
        float(sum(1 for k in ["has_code", "has_question", "has_imperative", "technical_terms"] if f.get(k, False) or f.get(k, 0) >= 3)),
        float(f.get("has_imperative", False)),
        f.get("technical_terms", 0),
        float(f.get("multi_step", False)),
        float(f.get("requires_context", False)),
        f.get("domain_specificity", 0),
        f.get("ambiguity_score", 0),
    ]


def _default_weights() -> dict[str, float]:
    """Default weights from v3.0 optimization."""
    return {
        "sentence_count": 0.29,
        "avg_word_length": 0.19,
        "has_question": 0.12,
        "question_technical": 0.05,
        "technical_design": 0.12,
        "code": 0.10,
        "architecture": 0.07,
        "word_count": 0.00,
        "four_plus": 0.00,
        "has_imperative": 0.06,
        "technical_terms": 0.00,
        "multi_step": 0.00,
        "requires_context": 0.00,
        "domain_specificity": 0.00,
        "ambiguity_score": 0.00,
    }


# ── CLI Commands ────────────────────────────────────────────────────────────

def cmd_generate(args):
    """Generate dataset from workspace."""
    print(f"Scanning workspace: {args.path}")
    samples = scan_workspace(
        root_path=args.path,
        exclude=args.exclude.split(",") if args.exclude else None,
        max_file_size_kb=args.max_size,
    )
    print(f"Extracted {len(samples)} samples from workspace")

    if args.deduplicate:
        before = len(samples)
        samples = deduplicate(samples)
        print(f"Deduplicated: {before} → {len(samples)} samples")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(asdict(s), ensure_ascii=False) + "\n")

    print(f"Saved to {output_path}")


def cmd_label(args):
    """Label a raw dataset."""
    print(f"Loading raw samples: {args.input}")
    samples = load_samples(args.input)
    print(f"Loaded {len(samples)} samples")

    if args.mode in ("rule", "hybrid"):
        for s in samples:
            if not s.label:
                s.label = estimate_complexity(s.raw_text, s.features)
                s.confidence = 0.85  # Rule-based confidence

    output_path = args.output or args.input.replace("raw.jsonl", "labeled.jsonl")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(asdict(s), ensure_ascii=False) + "\n")

    print(f"Labeled {len(samples)} samples → {output_path}")


def cmd_validate(args):
    """Validate a labeled dataset."""
    print(f"Validating: {args.input}")
    samples = load_samples(args.input)
    result = validate_dataset(samples)

    print(f"\n{'='*50}")
    print(f"Validation Result: {'✅ PASSED' if result.passed else '❌ FAILED'}")
    print(f"{'='*50}")
    print(f"Samples: {result.sample_count}")
    print(f"Distribution: {json.dumps(result.class_distribution, indent=2)}")
    print(f"Duplicate rate: {result.duplicate_rate:.1%}")
    print(f"Avg word count: {result.avg_word_count:.0f}")

    if result.issues:
        print(f"\nIssues ({len(result.issues)}):")
        for issue in result.issues:
            print(f"  ⚠️  {issue}")
    else:
        print("\n✅ No issues found")


def cmd_optimize(args):
    """Optimize weights from labeled dataset."""
    print(f"Loading samples: {args.input}")
    samples = load_samples(args.input)

    # Filter to samples with labels
    labeled = [s for s in samples if s.label]
    print(f"Labeled samples: {len(labeled)}")

    current_weights = None
    if args.init:
        with open(args.init) as f:
            current_weights = json.load(f)
        print(f"Starting from weights: {args.init}")

    weights = optimize_weights(labeled, current_weights, method="scipy_mse")

    output_path = args.output
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(weights, f, indent=2)

    print(f"\nOptimized weights saved to: {output_path}")
    print(f"\nWeight values:")
    for name, value in sorted(weights.items(), key=lambda x: -x[1]):
        bar = "█" * int(value * 50)
        print(f"  {name:25s} {value:.4f}  {bar}")


def load_samples(path: str) -> list[TrainingSample]:
    """Load samples from a JSONL file."""
    samples = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            samples.append(TrainingSample(**data))
    return samples


def main():
    parser = argparse.ArgumentParser(description="LLMFit — RAG-Based Personalized Dataset Factory")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # generate
    gen_parser = subparsers.add_parser("generate", help="Generate dataset from workspace")
    gen_parser.add_argument("--path", default=".", help="Workspace path")
    gen_parser.add_argument("--output", required=True, help="Output JSONL path")
    gen_parser.add_argument("--exclude", default="node_modules,.git,coverage,__pycache__", help="Comma-separated exclude patterns")
    gen_parser.add_argument("--max-size", type=int, default=512, help="Max file size in KB")
    gen_parser.add_argument("--deduplicate", action="store_true", help="Remove duplicates")
    gen_parser.set_defaults(func=cmd_generate)

    # label
    label_parser = subparsers.add_parser("label", help="Label a raw dataset")
    label_parser.add_argument("--input", required=True, help="Input JSONL path")
    label_parser.add_argument("--output", help="Output JSONL path (default: same dir, labeled.jsonl)")
    label_parser.add_argument("--mode", choices=["rule", "hybrid"], default="rule", help="Labeling mode")
    label_parser.set_defaults(func=cmd_label)

    # validate
    val_parser = subparsers.add_parser("validate", help="Validate a labeled dataset")
    val_parser.add_argument("--input", required=True, help="Input JSONL path")
    val_parser.set_defaults(func=cmd_validate)

    # optimize
    opt_parser = subparsers.add_parser("optimize", help="Optimize heuristic weights")
    opt_parser.add_argument("--input", required=True, help="Labeled dataset JSONL path")
    opt_parser.add_argument("--output", default="weights.json", help="Output weights JSON path")
    opt_parser.add_argument("--init", help="Starting weights JSON file (optional)")
    opt_parser.add_argument("--method", default="scipy_mse", help="Optimization method")
    opt_parser.set_defaults(func=cmd_optimize)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
