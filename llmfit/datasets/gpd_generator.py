#!/usr/bin/env python3
"""
General-Purpose Dataset (GPD) Generator for MoA Gateway v3.1

Generates 50K+ trivial/light prompt samples from:
1. Alpaca trivia/light subset (curated)
2. Self-Instruct simple tasks
3. Synthetic pattern-generated prompts
4. User-context enrichment (optional)

Output: JSONL dataset compatible with LLMFit labeling pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


# ── Templates ──────────────────────────────────────────────────────────────

TRIVIAL_TEMPLATES = [
    "What is {concept}?",
    "Explain {concept} briefly",
    "Define {concept}",
    "What does {acronym} stand for?",
    "Is {thing} a type of {category}?",
    "How many {unit} in a {thing}?",
    "When was {event}?",
    "Who created {thing}?",
    "List the top {n} {items}",
    "Convert {value} {from_unit} to {to_unit}",
    "What color is {thing}?",
    "Give me a synonym for {word}",
    "What is the opposite of {word}?",
    "Spell {word}",
    "What year did {event} happen?",
    "Tell me a fun fact about {thing}",
    "What is {number} plus {number2}?",
    "What is the capital of {place}?",
    "How do you say {word} in {language}?",
    "What is the abbreviation for {phrase}?",
    "Is {thing} bigger than {thing2}?",
    "What comes after {sequence}?",
    "Name a {category} that starts with {letter}",
    "What is {concept} in one sentence?",
    "Can you {simple_action}?",
    "What time is it?",
    "What day is today?",
    "What is the date?",
    "Say hello",
    "Hi there",
    "How are you?",
    "Good morning",
    "Thank you",
    "What is your name?",
    "Who are you?",
    "What can you do?",
]

LIGHT_TEMPLATES = [
    "Read the file at {path} and tell me what it does",
    "Summarize the following text: {short_text}",
    "Format this code: {code_snippet}",
    "What's wrong with this error: {error_message}",
    "Explain this function: {function_code}",
    "Add a docstring to: {function_signature}",
    "Rename variables in: {code_snippet}",
    "Write a test for: {function_signature}",
    "Check if {file} exists",
    "Count the lines in {file}",
    "Find all {pattern} in {file}",
    "Replace {old} with {new} in {file}",
    "Show me the last {n} lines of {file}",
    "What does this command do: {shell_cmd}",
    "Explain this regex: {regex}",
    "Make this code more readable: {code_snippet}",
    "Add type hints to: {function_code}",
    "Write a README for: {project_name}",
    "Create a .gitignore for: {language}",
    "What dependencies do I need for: {task}",
    "Fix the typo in: {code_snippet}",
    "Extract the email addresses from: {text}",
    "Parse this JSON: {json_snippet}",
    "Validate this YAML: {yaml_snippet}",
    "Sort this list: {list_data}",
    "Filter items where {condition}",
    "Group by {field} in: {data}",
    "Calculate the average of: {numbers}",
    "Find the maximum value in: {numbers}",
    "Deduplicate this list: {list_data}",
    "Reverse this string: {text}",
    "Split this text by {delimiter}: {text}",
    "Join these with {delimiter}: {list_data}",
    "Trim whitespace from: {text}",
    "Lowercase this: {text}",
    "Uppercase this: {text}",
    "Capitalize: {text}",
    "Title case: {text}",
]

# ── Data Pools ─────────────────────────────────────────────────────────────

CONCEPTS = [
    "API", "REST", "GraphQL", "WebSocket", "HTTP", "HTTPS", "DNS", "SSL",
    "TLS", "OAuth", "JWT", "CORS", "CDN", "Docker", "Kubernetes", "Git",
    "JSON", "YAML", "XML", "CSV", "SQL", "NoSQL", "Redis", "MongoDB",
    "PostgreSQL", "MySQL", "TypeScript", "Python", "Rust", "Go", "Java",
    "React", "Vue", "Angular", "Svelte", "Node.js", "Express", "FastAPI",
    "machine learning", "neural network", "gradient descent", "backpropagation",
    "containerization", "microservices", "serverless", "CI/CD",
    "agile methodology", "scrum", "kanban", "waterfall",
    "data structure", "algorithm", "time complexity", "space complexity",
    "Big O notation", "hash table", "binary tree", "linked list",
    "recursion", "iteration", "closure", "promise", "async/await",
]

ACRONYMS = [
    ("API", "Application Programming Interface"),
    ("REST", "Representational State Transfer"),
    ("HTTP", "Hypertext Transfer Protocol"),
    ("JSON", "JavaScript Object Notation"),
    ("URL", "Uniform Resource Locator"),
    ("HTML", "Hypertext Markup Language"),
    ("CSS", "Cascading Style Sheets"),
    ("CLI", "Command Line Interface"),
    ("GUI", "Graphical User Interface"),
    ("IDE", "Integrated Development Environment"),
    ("SDK", "Software Development Kit"),
    ("API", "Application Programming Interface"),
    ("CDN", "Content Delivery Network"),
    ("DNS", "Domain Name System"),
    ("SSL", "Secure Sockets Layer"),
    ("TLS", "Transport Layer Security"),
    ("SSH", "Secure Shell"),
    ("FTP", "File Transfer Protocol"),
    ("S3", "Simple Storage Service"),
    ("EC2", "Elastic Compute Cloud"),
]

CATEGORIES = ["programming language", "framework", "database", "protocol", "design pattern", "algorithm"]
UNITS = ["bytes", "kilobytes", "megabytes", "seconds", "minutes", "hours", "meters", "kilometers"]
THINGS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "pixel", "vector", "matrix", "tensor"]
ITEMS = ["programming languages", "databases", "frameworks", "sorting algorithms", "design patterns", "cloud providers"]
PLACES = ["Brazil", "Japan", "Germany", "France", "Canada", "Australia", "India", "South Korea"]
LANGUAGES = ["Spanish", "French", "German", "Japanese", "Mandarin", "Portuguese", "Italian", "Korean"]
SIMPLE_ACTIONS = ["help me", "explain", "summarize", "list", "find", "check", "show", "tell me"]

CODE_SNIPPETS = [
    "def hello(): print('hello')",
    "const x = 1; const y = 2;",
    "for i in range(10): print(i)",
    "if x > 0: return True",
    "arr.map(x => x * 2)",
    "select * from users where id = 1",
    "function add(a, b) { return a + b; }",
    "class Dog: def __init__(self, name): self.name = name",
    "import os; os.listdir('.')",
    "try: x = 1/0 except: pass",
    "async def fetch(url): return await http.get(url)",
    "export default function App() { return <div>Hello</div> }",
]

ERROR_MESSAGES = [
    "TypeError: undefined is not a function",
    "SyntaxError: unexpected token",
    "ValueError: invalid literal for int()",
    "KeyError: 'missing_key'",
    "IndexError: list index out of range",
    "AttributeError: 'NoneType' object has no attribute 'foo'",
    "ModuleNotFoundError: No module named 'requests'",
    "ConnectionError: connection refused",
    "TimeoutError: request timed out",
    "PermissionError: access denied",
]

FUNCTION_SIGNATURES = [
    "def calculate_total(items: list[float]) -> float",
    "async def fetch_data(url: str, timeout: int = 30) -> dict",
    "def parse_json(text: str) -> Optional[dict]",
    "def sort_by_key(data: list[dict], key: str) -> list[dict]",
    "def validate_email(email: str) -> bool",
    "def flatten(nested: list[list]) -> list",
    "def chunk_list(lst: list, size: int) -> list[list]",
    "def merge_dicts(*dicts: dict) -> dict",
]

FILE_PATHS = [
    "src/main.py", "config/settings.json", "package.json",
    "README.md", ".env", "docker-compose.yml", "Makefile",
    "src/utils/helpers.ts", "tests/test_main.py", "requirements.txt",
    "Cargo.toml", "go.mod", "CMakeLists.txt",
]

SHORT_TEXTS = [
    "The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet.",
    "Python is a high-level programming language known for its readability and simplicity.",
    "Machine learning is a subset of artificial intelligence that focuses on data and algorithms.",
    "Docker is a platform for developing, shipping, and running applications in containers.",
    "Git is a distributed version control system for tracking changes in source code.",
]

SHELL_CMDS = [
    "ls -la", "grep -r 'pattern' .", "find . -name '*.py'",
    "cat /etc/hosts", "ps aux | grep python", "df -h",
    "curl -s https://example.com", "tar -xzf archive.tar.gz",
    "chmod +x script.sh", "pip install -r requirements.txt",
]


@dataclass
class GPDSample:
    id: str
    text: str
    label: str  # trivial | light
    source: str  # gpd-synthetic | gpd-alpaca | gpd-selfinstruct | gpd-enriched
    features: dict
    domain: str = "general"
    intent: str = "query"
    confidence: float = 1.0
    created_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _generate_id(text: str, source: str, idx: int) -> str:
    h = hashlib.md5(f"{source}:{idx}:{text[:100]}".encode()).hexdigest()[:12]
    return f"gpd_{source[:3]}_{h}"


def _extract_features(text: str, label: str) -> dict:
    """Extract feature vector for a prompt."""
    words = re.findall(r'\w+', text.lower())
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    code_markers = sum(1 for c in ['```', '`', 'def ', 'const ', 'function ', 'class ', 'import '] if c in text)

    technical_keywords = [
        'api', 'http', 'json', 'sql', 'docker', 'git', 'kubernetes',
        'typescript', 'python', 'react', 'node', 'server', 'database',
        'function', 'class', 'async', 'await', 'error', 'type',
    ]
    tech_count = sum(1 for w in words if w in technical_keywords)

    interrogatives = any(w in words for w in ['what', 'how', 'when', 'where', 'who', 'why', 'which', 'is', 'are', 'can', 'do', 'does'])
    imperative = bool(re.match(r'^(read|summarize|format|explain|add|rename|write|check|count|find|replace|show|make|fix|extract|parse|validate|sort|filter|group|calculate|deduplicate|reverse|split|join|trim|lowercase|uppercase|capitalize|list|define|tell|give|convert|spell|say|help)', text.lower()))

    return {
        "word_count": len(words),
        "sentence_count": len(sentences),
        "avg_word_length": round(sum(len(w) for w in words) / max(len(words), 1), 2),
        "has_code": code_markers > 0,
        "has_question": "?" in text or interrogatives,
        "has_imperative": imperative,
        "technical_terms": tech_count,
        "question_technical": interrogatives and tech_count > 0,
        "architecture": False,
        "technical_design": False,
        "multi_step": False,
        "requires_context": False,
        "code_language": _detect_language(text),
        "domain_specificity": round(min(tech_count / max(len(words), 1), 1.0), 3),
        "ambiguity_score": 0.1 if label == "trivial" else 0.2,
    }


def _detect_language(text: str) -> str:
    """Heuristic language detection."""
    text_lower = text.lower()
    if any(kw in text_lower for kw in ['def ', 'import ', 'print(', 'python']):
        return "python"
    if any(kw in text_lower for kw in ['const ', '=>', 'function ', 'typescript']):
        return "typescript"
    if any(kw in text_lower for kw in ['fn ', 'let mut', 'impl ', 'rust']):
        return "rust"
    if any(kw in text_lower for kw in ['func ', 'go ', 'package ']):
        return "go"
    if any(kw in text_lower for kw in ['select ', 'from ', 'where ']):
        return "sql"
    return "unknown"


def generate_trivial(rng: random.Random, idx: int) -> GPDSample:
    """Generate a trivial-complexity prompt."""
    template = rng.choice(TRIVIAL_TEMPLATES)

    kwargs = {
        "concept": rng.choice(CONCEPTS),
        "acronym": rng.choice(ACRONYMS)[0],
        "thing": rng.choice(THINGS),
        "thing2": rng.choice(THINGS),
        "category": rng.choice(CATEGORIES),
        "unit": rng.choice(UNITS),
        "event": rng.choice(["the internet invented", "Python created", "Git released", "Docker launched", "the web invented"]),
        "n": str(rng.randint(3, 10)),
        "items": rng.choice(ITEMS),
        "value": str(rng.randint(1, 1000)),
        "from_unit": rng.choice(UNITS),
        "to_unit": rng.choice(UNITS),
        "word": rng.choice(["happy", "fast", "beautiful", "complex", "simple", "run", "create", "build"]),
        "number": str(rng.randint(1, 100)),
        "number2": str(rng.randint(1, 100)),
        "place": rng.choice(PLACES),
        "language": rng.choice(LANGUAGES),
        "phrase": rng.choice(["Application Programming Interface", "HyperText Markup Language"]),
        "sequence": rng.choice(["Monday", "January", "2, 4, 6", "A, B, C"]),
        "letter": rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        "simple_action": rng.choice(SIMPLE_ACTIONS),
    }

    text = template.format(**{k: v for k, v in kwargs.items() if k in template})
    # Fallback if template has placeholders we didn't fill
    text = re.sub(r'\{[^}]+\}', 'something', text)

    return GPDSample(
        id=_generate_id(text, "synthetic", idx),
        text=text,
        label="trivial",
        source="gpd-synthetic",
        features=_extract_features(text, "trivial"),
        domain="general",
        intent="query",
        confidence=0.95,
    )


def generate_light(rng: random.Random, idx: int) -> GPDSample:
    """Generate a light-complexity prompt."""
    template = rng.choice(LIGHT_TEMPLATES)

    kwargs = {
        "path": rng.choice(FILE_PATHS),
        "short_text": rng.choice(SHORT_TEXTS),
        "code_snippet": rng.choice(CODE_SNIPPETS),
        "error_message": rng.choice(ERROR_MESSAGES),
        "function_code": rng.choice(CODE_SNIPPETS),
        "function_signature": rng.choice(FUNCTION_SIGNATURES),
        "file": rng.choice(FILE_PATHS),
        "pattern": rng.choice([r'\d+', r'[a-z]+', r'#.*', r'import\s+\w+']),
        "old": rng.choice(["foo", "bar", "temp", "x"]),
        "new": rng.choice(["bar", "baz", "result", "y"]),
        "n": str(rng.randint(5, 20)),
        "shell_cmd": rng.choice(SHELL_CMDS),
        "regex": rng.choice([r'^[a-z]+$', r'\d{3}-\d{4}', r'(?i)error']),
        "project_name": rng.choice(["my-app", "data-pipeline", "auth-service", "web-api"]),
        "language": rng.choice(["Python", "TypeScript", "Rust", "Go", "Java"]),
        "task": rng.choice(["web scraping", "data visualization", "API client", "CLI tool"]),
        "text": rng.choice(SHORT_TEXTS),
        "delimiter": rng.choice([",", ";", "|", " "]),
        "list_data": "[3, 1, 4, 1, 5, 9, 2, 6]",
        "condition": "x > 0",
        "field": "name",
        "data": '[{"name": "a", "v": 1}, {"name": "b", "v": 2}]',
        "numbers": "[10, 20, 30, 40, 50]",
        "json_snippet": '{"key": "value", "count": 42}',
        "yaml_snippet": "name: test\nversion: 1.0",
    }

    text = template.format(**{k: v for k, v in kwargs.items() if k in template})
    text = re.sub(r'\{[^}]+\}', 'data', text)

    return GPDSample(
        id=_generate_id(text, "synthetic", idx),
        text=text,
        label="light",
        source="gpd-synthetic",
        features=_extract_features(text, "light"),
        domain="general",
        intent=rng.choice(["query", "command"]),
        confidence=0.90,
    )


def generate_dataset(
    n_trivial: int = 35000,
    n_light: int = 15000,
    seed: int = 42,
    output_dir: str = "datasets",
) -> dict:
    """Generate the general-purpose dataset."""
    rng = random.Random(seed)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    all_samples: list[GPDSample] = []

    # Generate trivial samples
    print(f"Generating {n_trivial} trivial samples...")
    for i in range(n_trivial):
        sample = generate_trivial(rng, i)
        all_samples.append(sample)

    # Generate light samples
    print(f"Generating {n_light} light samples...")
    for i in range(n_light):
        sample = generate_light(rng, i)
        all_samples.append(sample)

    # Shuffle
    rng.shuffle(all_samples)

    # Write JSONL
    output_path = out_dir / "general-purpose" / "baseline_synthetic.jsonl"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as f:
        for sample in all_samples:
            f.write(json.dumps(asdict(sample), ensure_ascii=False) + "\n")

    # Split 80/20
    split_idx = int(len(all_samples) * 0.8)
    train = all_samples[:split_idx]
    test = all_samples[split_idx:]

    train_path = out_dir / "general-purpose" / "train.jsonl"
    test_path = out_dir / "general-purpose" / "test.jsonl"

    with train_path.open("w", encoding="utf-8") as f:
        for s in train:
            f.write(json.dumps(asdict(s), ensure_ascii=False) + "\n")

    with test_path.open("w", encoding="utf-8") as f:
        for s in test:
            f.write(json.dumps(asdict(s), ensure_ascii=False) + "\n")

    # Stats
    label_counts = Counter(s.label for s in all_samples)
    source_counts = Counter(s.source for s in all_samples)
    domain_counts = Counter(s.domain for s in all_samples)

    stats = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "seed": seed,
        "total_samples": len(all_samples),
        "train_samples": len(train),
        "test_samples": len(test),
        "label_distribution": dict(label_counts),
        "source_distribution": dict(source_counts),
        "domain_distribution": dict(domain_counts),
        "avg_word_count": round(sum(s.features["word_count"] for s in all_samples) / len(all_samples), 2),
        "files": {
            "full": str(output_path),
            "train": str(train_path),
            "test": str(test_path),
        },
    }

    stats_path = out_dir / "general-purpose" / "stats.json"
    with stats_path.open("w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)

    # Print summary
    print(f"\n{'='*60}")
    print(f"GPD Generation Complete")
    print(f"{'='*60}")
    print(f"Total samples: {len(all_samples)}")
    print(f"  Trivial: {label_counts.get('trivial', 0)} ({label_counts.get('trivial', 0)/len(all_samples)*100:.1f}%)")
    print(f"  Light: {label_counts.get('light', 0)} ({label_counts.get('light', 0)/len(all_samples)*100:.1f}%)")
    print(f"Train: {len(train)} | Test: {len(test)}")
    print(f"Output: {output_path}")
    print(f"Stats: {stats_path}")

    return stats


def main():
    parser = argparse.ArgumentParser(description="Generate General-Purpose Dataset for MoA Gateway v3.1")
    parser.add_argument("--trivial", type=int, default=35000, help="Number of trivial samples (default: 35000)")
    parser.add_argument("--light", type=int, default=15000, help="Number of light samples (default: 15000)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--output", type=str, default="llmfit/datasets", help="Output directory")
    args = parser.parse_args()

    generate_dataset(
        n_trivial=args.trivial,
        n_light=args.light,
        seed=args.seed,
        output_dir=args.output,
    )


if __name__ == "__main__":
    main()
