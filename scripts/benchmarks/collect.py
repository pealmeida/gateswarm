#!/usr/bin/env python3
"""
Benchmark snapshot collector (MVP).
Public snapshot sources only:
  - LMArena via Hugging Face leaderboard dataset (CC-BY-4.0)
  - Artificial Analysis API v2 (optional, requires AA_API_KEY secret)
  - Vendor self-reported entries from calibration/benchmarks/vendor_self_reported.yaml

LiveBench and Terminal-Bench are NOT written to the public snapshot (license pending).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "calibration" / "benchmarks"
ALIASES = OUT_DIR / "aliases.yaml"
VENDOR = OUT_DIR / "vendor_self_reported.yaml"
SNAPSHOT = OUT_DIR / "snapshot.json"
META = OUT_DIR / "snapshot.meta.json"

REQUIRED_OBS_FIELDS = {
    "source",
    "benchmark",
    "benchmark_version",
    "metric",
    "source_model_alias",
    "gateswarm_model_id",
    "value",
    "source_url",
    "source_date",
    "fetched_at",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml  # type: ignore
    except ImportError:
        print("PyYAML required: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def validate_observation(obs: dict[str, Any]) -> None:
    missing = REQUIRED_OBS_FIELDS - set(obs.keys())
    if missing:
        raise ValueError(f"observation missing fields: {sorted(missing)}")
    if not obs.get("source_url") or not obs.get("source_date"):
        raise ValueError("observation requires source_url and source_date")


def validate_snapshot(doc: dict[str, Any]) -> None:
    if "snapshot_id" not in doc or "observations" not in doc:
        raise ValueError("snapshot requires snapshot_id and observations")
    for obs in doc["observations"]:
        validate_observation(obs)


def collect_lmarena(aliases: dict[str, Any], fetched_at: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Download HF dataset subsets when huggingface_hub + pandas available."""
    meta: dict[str, Any] = {
        "name": "lmarena",
        "url": "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
        "license": "CC-BY-4.0",
        "rows": 0,
    }
    observations: list[dict[str, Any]] = []
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
        import pandas as pd  # type: ignore
    except ImportError:
        print("WARN: huggingface_hub/pandas not installed — skipping LMArena download", file=sys.stderr)
        return observations, meta

    subsets = ["text_style_control", "webdev", "agent"]
    models = (aliases.get("models") or {})
    for subset in subsets:
        try:
            parquet_path = hf_hub_download(
                repo_id="lmarena-ai/leaderboard-dataset",
                filename=f"data/{subset}/latest.parquet",
                repo_type="dataset",
            )
            raw = Path(parquet_path).read_bytes()
            meta["raw_sha256"] = sha256_bytes(raw)
            df = pd.read_parquet(parquet_path)
        except Exception as exc:  # noqa: BLE001
            print(f"WARN: LMArena subset {subset} skipped: {exc}", file=sys.stderr)
            continue

        # Map alias column heuristically
        alias_col = "model" if "model" in df.columns else df.columns[0]
        rating_col = next((c for c in df.columns if "rating" in c.lower()), None)
        if rating_col is None:
            continue

        for gs_id, spec in models.items():
            sources = ((spec or {}).get("sources") or {}).get("lmarena") or []
            for src in sources:
                alias = src.get("alias")
                if not alias:
                    continue
                rows = df[df[alias_col] == alias]
                if rows.empty:
                    continue
                row = rows.iloc[0]
                benchmark = f"{subset}/coding" if subset == "text_style_control" else subset
                obs = {
                    "schema_version": 1,
                    "source": "lmarena",
                    "benchmark": benchmark,
                    "benchmark_version": str(date.today()),
                    "metric": "bt_rating",
                    "higher_is_better": True,
                    "source_model_alias": alias,
                    "gateswarm_model_id": gs_id,
                    "match": src.get("match", "family"),
                    "value": float(row[rating_col]),
                    "self_reported": False,
                    "source_url": meta["url"],
                    "source_date": str(date.today()),
                    "fetched_at": fetched_at,
                    "raw_sha256": meta.get("raw_sha256"),
                    "license": "CC-BY-4.0",
                }
                validate_observation(obs)
                observations.append(obs)
                meta["rows"] = int(meta.get("rows", 0)) + 1

    return observations, meta


def collect_aa(fetched_at: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    meta: dict[str, Any] = {
        "name": "artificial_analysis",
        "url": "https://artificialanalysis.ai/api/v2/data/llms/models",
        "license": "API attribution required",
        "rows": 0,
    }
    observations: list[dict[str, Any]] = []
    api_key = os.environ.get("AA_API_KEY")
    if not api_key:
        print("WARN: AA_API_KEY not set — skipping Artificial Analysis (no HTML scraping)", file=sys.stderr)
        return observations, meta

    try:
        import urllib.request

        req = urllib.request.Request(
            meta["url"],
            headers={"x-api-key": api_key, "User-Agent": "gateswarm-benchmark-collector/0.1"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: AA API failed: {exc}", file=sys.stderr)
        return observations, meta

    # Store only per-evaluation metrics when present; never composite index alone.
    for item in payload if isinstance(payload, list) else payload.get("data", []):
        slug = item.get("slug") or item.get("id")
        if not slug:
            continue
        evals = item.get("evaluations") or item.get("benchmarks") or []
        for ev in evals:
            name = (ev.get("name") or ev.get("benchmark") or "").lower()
            if not name:
                continue
            value = ev.get("score") or ev.get("value")
            if value is None:
                continue
            obs = {
                "schema_version": 1,
                "source": "aa",
                "benchmark": name,
                "benchmark_version": item.get("intelligence_index_version") or "api",
                "metric": ev.get("metric") or "score",
                "higher_is_better": True,
                "source_model_alias": slug,
                "gateswarm_model_id": slug,
                "match": "family",
                "value": float(value),
                "self_reported": False,
                "source_url": meta["url"],
                "source_date": str(date.today()),
                "fetched_at": fetched_at,
                "license": "Artificial Analysis API",
            }
            try:
                validate_observation(obs)
            except ValueError:
                continue
            observations.append(obs)
            meta["rows"] = int(meta.get("rows", 0)) + 1

    return observations, meta


def collect_vendor(fetched_at: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    meta: dict[str, Any] = {"name": "vendor", "rows": 0}
    observations: list[dict[str, Any]] = []
    doc = load_yaml(VENDOR)
    for entry in doc.get("entries") or []:
        if not entry.get("source_url") or not entry.get("source_date"):
            print("WARN: vendor entry missing url/date — skipped", file=sys.stderr)
            continue
        obs = {
            "schema_version": 1,
            "source": "vendor",
            "benchmark": entry.get("benchmark", "vendor"),
            "benchmark_version": entry.get("benchmark_version", "vendor"),
            "metric": entry.get("metric", "pct_resolved"),
            "higher_is_better": True,
            "source_model_alias": entry.get("source_model_alias", entry.get("gateswarm_model_id")),
            "gateswarm_model_id": entry["gateswarm_model_id"],
            "match": entry.get("match", "exact"),
            "value": float(entry["value"]),
            "self_reported": True,
            "source_url": entry["source_url"],
            "source_date": entry["source_date"],
            "fetched_at": fetched_at,
            "license": entry.get("license", "n/a"),
        }
        validate_observation(obs)
        observations.append(obs)
        meta["rows"] = int(meta.get("rows", 0)) + 1
    return observations, meta


def main() -> int:
    fetched_at = str(date.today())
    aliases = load_yaml(ALIASES)
    sources_meta: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []

    lm_obs, lm_meta = collect_lmarena(aliases, fetched_at)
    observations.extend(lm_obs)
    sources_meta.append(lm_meta)

    aa_obs, aa_meta = collect_aa(fetched_at)
    observations.extend(aa_obs)
    sources_meta.append(aa_meta)

    vendor_obs, vendor_meta = collect_vendor(fetched_at)
    observations.extend(vendor_obs)
    sources_meta.append(vendor_meta)

    snapshot = {
        "snapshot_id": fetched_at,
        "generated_at": fetched_at,
        "observations": observations,
    }
    validate_snapshot(snapshot)
    snap_raw = json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(snap_raw, encoding="utf-8")
    snap_sha = sha256_bytes(snap_raw.encode("utf-8"))

    meta_doc = {
        "snapshot_id": snapshot["snapshot_id"],
        "generated_at": fetched_at,
        "sources": sources_meta,
        "snapshot_sha256": snap_sha,
    }
    META.write_text(json.dumps(meta_doc, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(observations)} observations to {SNAPSHOT} (sha256={snap_sha[:12]}…)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
