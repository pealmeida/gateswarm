#!/usr/bin/env python3
"""
LLMFit v3.1 — Dataset Anonymizer & Generalizer

Strips and generalizes sensitive/personal information from training datasets
before training.

Anonymization layers:
1. PII Redaction: emails, phones, CPFs, IPs, names, addresses
2. Secret Redaction: API keys, tokens, passwords, private keys
3. Data Generalization: specific values → generic placeholders
4. Context Stripping: project names, org names, file paths → generic
5. Label Preservation: complexity labels remain intact
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Redaction Patterns ─────────────────────────────────────────────────────

# PII patterns
PII_PATTERNS = [
    # Email addresses
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', re.IGNORECASE),
     '[EMAIL_REDACTED]', 'pii'),

    # Brazilian phone numbers
    (re.compile(r'\+55\s*\d{2}\s*9?\d{4}[-\s]?\d{4}'),
     '[PHONE_REDACTED]', 'pii'),

    # International phone numbers
    (re.compile(r'\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,5}[\s.-]?\d{4}'),
     '[PHONE_REDACTED]', 'pii'),

    # Brazilian CPF
    (re.compile(r'\b\d{3}\.\d{3}\.\d{3}-\d{2}\b'),
     '[CPF_REDACTED]', 'pii'),

    # Brazilian CNPJ
    (re.compile(r'\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b'),
     '[CNPJ_REDACTED]', 'pii'),

    # IPv4 addresses (private + public)
    (re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b'),
     '[IP_REDACTED]', 'pii'),

    # Credit card numbers (basic pattern)
    (re.compile(r'\b(?:\d{4}[\s-]?){3}\d{4}\b'),
     '[CC_REDACTED]', 'pii'),

    # Bank account patterns (Brazilian)
    (re.compile(r'\b\d{3,4}-\d{1}\b'),
     '[BANK_ACCOUNT_REDACTED]', 'pii'),

    # PIX keys (email/phone/UUID format)
    (re.compile(r'\b[pix_key|pix]=\S+'),
     '[PIX_KEY_REDACTED]', 'pii'),

    # Dates (to generalize)
    (re.compile(r'\b(19|20)\d{2}[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b'),
     '[DATE_REDACTED]', 'generalized'),
]

# Secret patterns
SECRET_PATTERNS = [
    # API keys (generic)
    (re.compile(r'(?:api[_-]?key|apikey|api[_-]?token)\s*[=:]\s*\S+', re.IGNORECASE),
     '[API_KEY_REDACTED]', 'secret'),

    # Bearer tokens
    (re.compile(r'(?:bearer|token|auth)\s+[A-Za-z0-9_\-\.]{10,}', re.IGNORECASE),
     '[TOKEN_REDACTED]', 'secret'),

    # sk- prefixed keys (OpenAI-style)
    (re.compile(r'sk-[A-Za-z0-9_-]{20,}'),
     '[SECRET_KEY_REDACTED]', 'secret'),

    # Private keys
    (re.compile(r'-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----.*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----', re.DOTALL),
     '[PRIVATE_KEY_REDACTED]', 'secret'),

    # Password assignments
    (re.compile(r'(?:password|passwd|pwd)\s*[=:]\s*\S+', re.IGNORECASE),
     '[PASSWORD_REDACTED]', 'secret'),

    # Refresh tokens
    (re.compile(r'(?:refresh_token|rt_)[A-Za-z0-9_-]{10,}'),
     '[REFRESH_TOKEN_REDACTED]', 'secret'),

    # Session IDs
    (re.compile(r'(?:session_id|sess_)[A-Za-z0-9_-]{10,}'),
     '[SESSION_ID_REDACTED]', 'secret'),

    # JWT tokens
    (re.compile(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
     '[JWT_REDACTED]', 'secret'),

    # Hex secrets (common in configs)
    (re.compile(r'(?:secret|key|token|hash)\s*[=:]\s*[0-9a-fA-F]{32,}'),
     '[HEX_SECRET_REDACTED]', 'secret'),

    # AWS-style keys
    (re.compile(r'AKIA[0-9A-Z]{16}'),
     '[AWS_KEY_REDACTED]', 'secret'),
]

# Context patterns (generalize project/org-specific references)
CONTEXT_PATTERNS = [
    # Personal names (common patterns)
    (re.compile(r'\b(Ana|Bruno|Carla|Diego|Eduarda|Felipe|Giovana|Henrique|Iara|Joao|Karina|Lucas|Marina|Nicolas|Olivia|Paulo|Rafaela|Sofia|Tiago|Vitoria|Pedro|Maria|Jose|João|Antônio|Francisco|Carlos|Luiz|Marcos|Fernando)\b', re.IGNORECASE),
     '[PERSON]', 'context'),

    # Company/org names (detect capitalized multi-word names)
    (re.compile(r'\b[A-Z][a-z]+\s+(?:Corp|Inc|Ltd|LLC|GmbH|SA|Ltda|Tech|Labs|Systems|Services|Group|Holdings|Solutions)\b'),
     '[ORGANIZATION]', 'context'),

    # Project-specific paths (but keep generic paths)
    (re.compile(r'/root/\.openclaw/workspace/[a-zA-Z0-9_-]+/'),
     '[PROJECT_PATH]/', 'context'),

    # User home paths
    (re.compile(r'/home/[a-zA-Z0-9_-]+/'),
     '/home/[USER]/', 'context'),

    # Internal hostnames
    (re.compile(r'\b[a-zA-Z0-9-]+\.internal\b'),
     '[INTERNAL_HOST]', 'context'),

    # Internal domains
    (re.compile(r'\b[a-zA-Z0-9-]+\.(corp|local|internal|dev\.local|staging)\b'),
     '[INTERNAL_DOMAIN]', 'context'),

    # Fintech-specific terms
    (re.compile(r'(?:treasury|ops-wallet|payments-admin|core-banking)[\s:-]?\w*'),
     '[FINANCIAL_SERVICE]', 'context'),

    # Commit hashes
    (re.compile(r'\b[0-9a-f]{7,40}\b'),
     lambda m: '[COMMIT_HASH]' if len(m.group()) >= 7 else m.group(), 'context'),
]

# Data generalization patterns (replace specific with generic)
GENERALIZATION_PATTERNS = [
    # Specific numbers → generic (keep structure, change value)
    (re.compile(r'\b\d{5,}\b'),
     lambda m: f'[NUMBER_{len(m.group())}]', 'generalized'),

    # URLs with specific domains
    (re.compile(r'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}(?:/[^\s]*)?'),
     lambda m: f'[URL]', 'generalized'),

    # File paths with specific names
    (re.compile(r'/(?:Users|home|var|tmp|opt|etc)/[a-zA-Z0-9_/.-]+'),
     '[FILE_PATH]', 'generalized'),

    # Version numbers (keep structure)
    (re.compile(r'v(\d+)\.(\d+)\.(\d+)'),
     lambda m: f'v{m.group(1)}.[MINOR].[PATCH]', 'generalized'),

    # Specific percentages
    (re.compile(r'\b\d{1,2}\.\d+%\b'),
     '[PERCENTAGE]', 'generalized'),

    # Dollar amounts
    (re.compile(r'USD?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?'),
     '[AMOUNT]', 'generalized'),

    # Specific timestamps
    (re.compile(r'\d{2}:\d{2}:\d{2}'),
     '[TIME]', 'generalized'),
]


@dataclass
class AnonymizationReport:
    """Report of all redactions made."""
    source_file: str
    total_samples: int
    total_redactions: int
    pii_redactions: int
    secret_redactions: int
    context_redactions: int
    generalized_redactions: int
    redaction_breakdown: dict
    output_file: str
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def anonymize_text(text: str) -> tuple[str, dict[str, int]]:
    """
    Anonymize and generalize a text string.

    Returns:
        (anonymized_text, redaction_counts)
    """
    counts = {"pii": 0, "secret": 0, "context": 0, "generalized": 0}

    # Apply all pattern categories
    all_patterns = [
        (PII_PATTERNS, "pii"),
        (SECRET_PATTERNS, "secret"),
        (CONTEXT_PATTERNS, "context"),
        (GENERALIZATION_PATTERNS, "generalized"),
    ]

    for patterns, category in all_patterns:
        for pattern, replacement, _ in patterns:
            if callable(replacement):
                def replacer(m, rep=replacement):
                    counts[category] += 1
                    return rep(m)
            else:
                def replacer(m, rep=replacement):
                    counts[category] += 1
                    return rep

            text = pattern.sub(replacer, text)

    return text, counts


def anonymize_dataset(
    input_path: str,
    output_path: str,
    text_field: str = "text",
    max_samples: int = 50000,
) -> AnonymizationReport:
    """
    Anonymize a JSONL dataset.

    Args:
        input_path: Path to input JSONL file
        output_path: Path to output (anonymized) JSONL file
        text_field: Field name containing text to anonymize
        max_samples: Maximum samples to process

    Returns:
        AnonymizationReport with statistics
    """
    in_path = Path(input_path)
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    total_redactions = 0
    total_pii = 0
    total_secret = 0
    total_context = 0
    total_generalized = 0
    samples_processed = 0
    redaction_breakdown = Counter()

    with in_path.open("r", encoding="utf-8") as infile, \
         out_path.open("w", encoding="utf-8") as outfile:

        for line in infile:
            if samples_processed >= max_samples:
                break

            line = line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Anonymize the text field
            if text_field in record and isinstance(record[text_field], str):
                anon_text, counts = anonymize_text(record[text_field])
                record[text_field] = anon_text

                total_redactions += sum(counts.values())
                total_pii += counts["pii"]
                total_secret += counts["secret"]
                total_context += counts["context"]
                total_generalized += counts["generalized"]

                for cat, count in counts.items():
                    if count > 0:
                        redaction_breakdown[cat] += count

            # Anonymize nested text fields (e.g., in features context)
            if "context" in record and isinstance(record["context"], dict):
                for key, value in record["context"].items():
                    if isinstance(value, str) and len(value) > 10:
                        anon_val, _ = anonymize_text(value)
                        record["context"][key] = anon_val

            # Add anonymization marker
            record["anonymized"] = True
            record["anonymized_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

            outfile.write(json.dumps(record, ensure_ascii=False) + "\n")
            samples_processed += 1

    report = AnonymizationReport(
        source_file=str(in_path),
        total_samples=samples_processed,
        total_redactions=total_redactions,
        pii_redactions=total_pii,
        secret_redactions=total_secret,
        context_redactions=total_context,
        generalized_redactions=total_generalized,
        redaction_breakdown=dict(redaction_breakdown),
        output_file=str(out_path),
    )

    return report


def merge_datasets(
    paths: list[str],
    output_path: str,
    anonymize: bool = True,
    max_total: int = 50000,
) -> dict:
    """
    Merge multiple JSONL datasets and optionally anonymize.

    Args:
        paths: List of input JSONL file paths
        output_path: Output merged JSONL path
        anonymize: Whether to apply anonymization
        max_total: Maximum total samples in output
    """
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_records = []
    source_counts = Counter()

    for path in paths:
        p = Path(path)
        if not p.exists():
            print(f"  ⚠️  Skipping {path} (not found)")
            continue

        with p.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    record["_source_file"] = p.name
                    all_records.append(record)
                    source_counts[p.name] += 1
                except json.JSONDecodeError:
                    continue

    # Shuffle and limit
    import random
    random.seed(42)
    random.shuffle(all_records)
    all_records = all_records[:max_total]

    total_redactions = 0
    if anonymize:
        print(f"  Anonymizing {len(all_records)} records...")
        anonymized_records = []
        for record in all_records:
            if "text" in record and isinstance(record["text"], str):
                anon_text, counts = anonymize_text(record["text"])
                record["text"] = anon_text
                record["anonymized"] = True
                record["anonymized_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                total_redactions += sum(counts.values())
            anonymized_records.append(record)
        all_records = anonymized_records

    with out_path.open("w", encoding="utf-8") as f:
        for record in all_records:
            # Remove internal tracking fields
            record.pop("_source_file", None)
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # Label distribution
    labels = Counter()
    for record in all_records:
        label = record.get("label") or record.get("complexity_hint") or "unknown"
        labels[label] += 1

    return {
        "total_samples": len(all_records),
        "source_distribution": dict(source_counts),
        "label_distribution": dict(labels),
        "anonymized": anonymize,
        "total_redactions": total_redactions,
        "output_file": str(out_path),
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(description="LLMFit v3.1 — Dataset Anonymizer")
    subparsers = parser.add_subparsers(dest="command")

    # anonymize single file
    anon_parser = subparsers.add_parser("anonymize", help="Anonymize a single JSONL file")
    anon_parser.add_argument("--input", required=True, help="Input JSONL path")
    anon_parser.add_argument("--output", required=True, help="Output JSONL path")
    anon_parser.add_argument("--field", default="text", help="Text field to anonymize")
    anon_parser.add_argument("--max-samples", type=int, default=50000)
    anon_parser.set_defaults(func=cmd_anonymize)

    # merge multiple files
    merge_parser = subparsers.add_parser("merge", help="Merge and anonymize multiple JSONL files")
    merge_parser.add_argument("--inputs", nargs="+", required=True, help="Input JSONL paths")
    merge_parser.add_argument("--output", required=True, help="Output merged JSONL path")
    merge_parser.add_argument("--no-anonymize", action="store_true")
    merge_parser.add_argument("--max-total", type=int, default=50000)
    merge_parser.set_defaults(func=cmd_merge)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


def cmd_anonymize(args):
    print(f"Anonymizing: {args.input}")
    report = anonymize_dataset(
        args.input,
        args.output,
        text_field=args.field,
        max_samples=args.max_samples,
    )

    print(f"\n{'='*60}")
    print(f"Anonymization Report")
    print(f"{'='*60}")
    print(f"Source: {report.source_file}")
    print(f"Samples processed: {report.total_samples}")
    print(f"Total redactions: {report.total_redactions}")
    print(f"  PII: {report.pii_redactions}")
    print(f"  Secrets: {report.secret_redactions}")
    print(f"  Context: {report.context_redactions}")
    print(f"  Generalized: {report.generalized_redactions}")
    print(f"Output: {report.output_file}")


def cmd_merge(args):
    print(f"Merging {len(args.inputs)} files...")
    result = merge_datasets(
        args.inputs,
        args.output,
        anonymize=not args.no_anonymize,
        max_total=args.max_total,
    )

    print(f"\n{'='*60}")
    print(f"Merge Report")
    print(f"{'='*60}")
    print(f"Total samples: {result['total_samples']}")
    print(f"Sources: {json.dumps(result['source_distribution'], indent=2)}")
    print(f"Labels: {json.dumps(result['label_distribution'], indent=2)}")
    print(f"Anonymized: {result['anonymized']}")
    if result.get('total_redactions'):
        print(f"Total redactions: {result['total_redactions']}")
    print(f"Output: {result['output_file']}")


if __name__ == "__main__":
    main()
