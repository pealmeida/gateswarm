#!/usr/bin/env python3
"""Graph SSL experiment for router effort labels.

The full staged corpus is large enough that sklearn's dense LabelSpreading graph
can become the memory bottleneck. This script uses the same label-spreading
update over sparse cosine kNN affinities for all production-sized runs, while
keeping the experiment deterministic and sklearn-only for vectorization,
neighbors, and SVD.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.neighbors import NearestNeighbors
from sklearn.pipeline import FeatureUnion
from sklearn.preprocessing import StandardScaler

try:
    from sklearn.semi_supervised import LabelSpreading  # noqa: F401
except Exception:  # pragma: no cover - sparse fallback is the normal path.
    LabelSpreading = None  # type: ignore


ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "eval" / "ssl" / "out"
CORPUS_PATH = OUT_DIR / "corpus.jsonl"
FEATURES_PATH = OUT_DIR / "features.jsonl"
HOLDOUT_PATH = ROOT / "eval" / "splits" / "holdout.v1.json"
REPORT_PATH = OUT_DIR / "report.md"
SILVER_PATH = OUT_DIR / "silver-labels.jsonl"

TIERS = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]
TIER_TO_IDX = {t: i for i, t in enumerate(TIERS)}
BOUNDARIES = [0.208938, 0.264209, 0.32502, 0.36585, 0.485382]
K_GRID = [10, 20, 40]
ALPHA_GRID = [0.1, 0.2, 0.5]
RANDOM_STATE = 42


@dataclass
class CorpusRow:
    id: str
    text: str
    source: str
    label: Optional[str]
    text_hash: str


@dataclass
class FeatureRow:
    id: str
    source: str
    score: float
    f: List[float]
    label: Optional[str]


@dataclass
class GridResult:
    view: str
    k: int
    alpha: float
    exact: float
    adjacent: float
    mean_abs_dist: float
    seed_agreement: float
    seed_coverage_at_90: int
    threshold_at_90: float
    recall: Dict[str, float]
    probs: np.ndarray


def read_jsonl(path: Path) -> Iterable[dict]:
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def normalized_text(text: str) -> str:
    return " ".join(text.lower().split())


def text_hash(text: str) -> str:
    return hashlib.sha256(normalized_text(text).encode("utf-8")).hexdigest()


def load_corpus() -> List[CorpusRow]:
    rows: List[CorpusRow] = []
    for row in read_jsonl(CORPUS_PATH):
        rows.append(
            CorpusRow(
                id=str(row["id"]),
                text=str(row["text"]),
                source=str(row["source"]),
                label=row.get("label"),
                text_hash=text_hash(str(row["text"])),
            )
        )
    return rows


def load_features() -> List[FeatureRow]:
    rows: List[FeatureRow] = []
    for row in read_jsonl(FEATURES_PATH):
        rows.append(
            FeatureRow(
                id=str(row["id"]),
                source=str(row["source"]),
                score=float(row["score"]),
                f=[float(x) for x in row["f"]],
                label=row.get("label"),
            )
        )
    return rows


def load_holdout() -> Tuple[set[str], set[str]]:
    parsed = json.loads(HOLDOUT_PATH.read_text("utf-8"))
    return set(parsed["effort"]["train"]), set(parsed["effort"]["test"])


def score_to_tier(score: float) -> str:
    idx = 0
    while idx < len(BOUNDARIES) and score >= BOUNDARIES[idx]:
        idx += 1
    return TIERS[idx]


def metrics(expected: Sequence[int], predicted: Sequence[int]) -> Tuple[float, float, float, Dict[str, float]]:
    if not expected:
        return math.nan, math.nan, math.nan, {t: math.nan for t in TIERS}
    exp = np.asarray(expected, dtype=np.int32)
    pred = np.asarray(predicted, dtype=np.int32)
    dist = np.abs(pred - exp)
    recall: Dict[str, float] = {}
    for i, tier in enumerate(TIERS):
        mask = exp == i
        recall[tier] = float(np.mean(pred[mask] == i)) if np.any(mask) else math.nan
    return (
        float(np.mean(pred == exp)),
        float(np.mean(dist <= 1)),
        float(np.mean(dist)),
        recall,
    )


def format_pct(x: float) -> str:
    if math.isnan(x):
        return "n/a"
    return f"{100.0 * x:.1f}%"


def row_normalize(mat: sparse.csr_matrix) -> sparse.csr_matrix:
    mat = mat.tocsr(copy=True)
    sums = np.asarray(mat.sum(axis=1)).ravel()
    inv = np.zeros_like(sums, dtype=np.float64)
    np.divide(1.0, sums, out=inv, where=sums > 0)
    return sparse.diags(inv).dot(mat).tocsr()


def cosine_knn_affinity(x, k: int) -> sparse.csr_matrix:
    n = x.shape[0]
    neighbors = min(k + 1, n)
    nn = NearestNeighbors(n_neighbors=neighbors, metric="cosine", algorithm="brute", n_jobs=-1)
    nn.fit(x)
    distances, indices = nn.kneighbors(x, return_distance=True)
    rows: List[int] = []
    cols: List[int] = []
    vals: List[float] = []
    for i in range(n):
        added = 0
        for dist, j in zip(distances[i], indices[i]):
            j = int(j)
            if j == i:
                continue
            sim = max(1.0 - float(dist), 1e-6)
            rows.append(i)
            cols.append(j)
            vals.append(sim)
            added += 1
            if added >= k:
                break
    mat = sparse.csr_matrix((vals, (rows, cols)), shape=(n, n), dtype=np.float32)
    mat = mat.maximum(mat.T)
    return row_normalize(mat)


def router_feature_matrix(features: Sequence[FeatureRow]) -> np.ndarray:
    x = np.asarray([row.f + [row.score] for row in features], dtype=np.float32)
    return StandardScaler().fit_transform(x).astype(np.float32)


def text_feature_matrix(corpus: Sequence[CorpusRow]):
    texts = [row.text for row in corpus]
    union = FeatureUnion(
        [
            (
                "word",
                TfidfVectorizer(
                    analyzer="word",
                    ngram_range=(1, 2),
                    min_df=2,
                    max_features=60000,
                    sublinear_tf=True,
                    dtype=np.float32,
                ),
            ),
            (
                "char",
                TfidfVectorizer(
                    analyzer="char",
                    ngram_range=(3, 5),
                    min_df=2,
                    max_features=60000,
                    sublinear_tf=True,
                    dtype=np.float32,
                ),
            ),
        ]
    )
    tfidf = union.fit_transform(texts)
    dims = min(200, max(2, tfidf.shape[0] - 1), max(2, tfidf.shape[1] - 1))
    if dims < 2:
        return tfidf
    svd = TruncatedSVD(n_components=dims, random_state=RANDOM_STATE)
    return svd.fit_transform(tfidf).astype(np.float32)


def initial_labels(
    corpus: Sequence[CorpusRow],
    features: Sequence[FeatureRow],
    train_ids: set[str],
) -> Tuple[np.ndarray, np.ndarray, List[int], List[int]]:
    y = np.full(len(features), -1, dtype=np.int32)
    seed_indices: List[int] = []
    test_indices: List[int] = []
    by_id = {row.id: row for row in corpus}
    for i, feat in enumerate(features):
        corpus_row = by_id[feat.id]
        label = corpus_row.label or feat.label
        if feat.id in train_ids and label in TIER_TO_IDX:
            y[i] = TIER_TO_IDX[label]
            seed_indices.append(i)
        elif corpus_row.source == "organic" and label in TIER_TO_IDX:
            y[i] = TIER_TO_IDX[label]
            seed_indices.append(i)
    return y, np.asarray(seed_indices, dtype=np.int32), seed_indices, test_indices


def propagate_sparse(
    affinity: sparse.csr_matrix,
    labels: np.ndarray,
    alpha: float,
    max_iter: int = 200,
    tol: float = 1e-5,
) -> np.ndarray:
    n = affinity.shape[0]
    classes = len(TIERS)
    y0 = np.zeros((n, classes), dtype=np.float32)
    seeded = labels >= 0
    y0[np.where(seeded)[0], labels[seeded]] = 1.0
    y = y0.copy()
    for _ in range(max_iter):
        nxt = alpha * affinity.dot(y) + (1.0 - alpha) * y0
        delta = float(np.max(np.abs(nxt - y)))
        y = nxt.astype(np.float32, copy=False)
        if delta < tol:
            break
    sums = y.sum(axis=1, keepdims=True)
    empty = sums.ravel() <= 0
    np.divide(y, sums, out=y, where=sums > 0)
    if np.any(empty):
        y[empty, :] = 1.0 / classes
    return y


def threshold_for_train_agreement(
    probs: np.ndarray,
    labels: np.ndarray,
    seed_indices: np.ndarray,
    target: float = 0.90,
) -> Tuple[float, float, int]:
    if seed_indices.size == 0:
        return 1.000001, math.nan, 0
    pred = np.argmax(probs, axis=1)
    conf = np.max(probs, axis=1)
    seed_conf = conf[seed_indices]
    seed_correct = pred[seed_indices] == labels[seed_indices]
    candidates = sorted(set(float(x) for x in seed_conf), reverse=True)
    best_threshold = 1.000001
    best_agreement = math.nan
    best_coverage = 0
    for threshold in candidates:
        mask = seed_conf >= threshold
        coverage = int(np.sum(mask))
        if coverage == 0:
            continue
        agreement = float(np.mean(seed_correct[mask]))
        if agreement >= target:
            best_threshold = threshold
            best_agreement = agreement
            best_coverage = coverage
    return best_threshold, best_agreement, best_coverage


def evaluate_grid_result(
    view: str,
    k: int,
    alpha: float,
    probs: np.ndarray,
    labels: np.ndarray,
    seed_indices: np.ndarray,
    test_indices: Sequence[int],
) -> GridResult:
    pred = np.argmax(probs, axis=1)
    expected = [int(labels[i]) for i in test_indices]
    predicted = [int(pred[i]) for i in test_indices]
    exact, adjacent, mean_abs, recall = metrics(expected, predicted)
    threshold, agreement, coverage = threshold_for_train_agreement(probs, labels, seed_indices)
    seed_pred = pred[seed_indices]
    seed_agreement = float(np.mean(seed_pred == labels[seed_indices])) if seed_indices.size else math.nan
    return GridResult(
        view=view,
        k=k,
        alpha=alpha,
        exact=exact,
        adjacent=adjacent,
        mean_abs_dist=mean_abs,
        seed_agreement=seed_agreement,
        seed_coverage_at_90=coverage,
        threshold_at_90=threshold,
        recall=recall,
        probs=probs,
    )


def baseline_metrics(features: Sequence[FeatureRow], labels: np.ndarray, test_indices: Sequence[int]):
    pred = [TIER_TO_IDX[score_to_tier(features[i].score)] for i in test_indices]
    expected = [int(labels[i]) for i in test_indices]
    return metrics(expected, pred)


def result_sort_key(r: GridResult):
    return (r.exact, r.adjacent, -r.mean_abs_dist, r.seed_agreement, r.seed_coverage_at_90)


def write_report(
    results: Sequence[GridResult],
    selected: GridResult,
    baseline,
    n_rows: int,
    n_seed: int,
    n_test: int,
) -> None:
    base_exact, base_adjacent, base_mean_abs, base_recall = baseline
    lines: List[str] = []
    lines.append("# SSL label propagation report")
    lines.append("")
    lines.append(f"- corpus rows: {n_rows}")
    lines.append(f"- seed rows: {n_seed}")
    lines.append(f"- golden TEST rows: {n_test}")
    lines.append("- graph backend: sparse cosine kNN label-spreading update")
    lines.append("- fixed-boundary heuristic baseline: boundaries `[0.208938, 0.264209, 0.32502, 0.36585, 0.485382]`")
    lines.append("")
    lines.append("## Baseline on golden TEST")
    lines.append("")
    lines.append(f"- exact: {format_pct(base_exact)}")
    lines.append(f"- adjacent: {format_pct(base_adjacent)}")
    lines.append(f"- mean |tier distance|: {base_mean_abs:.3f}")
    lines.append("- per-tier recall: " + ", ".join(f"{t} {format_pct(base_recall[t])}" for t in TIERS))
    lines.append("")
    lines.append("## Grid results")
    lines.append("")
    lines.append("| view | k | alpha | exact | adjacent | mean |dist| | seed agreement | threshold@90 | seed kept@90 | per-tier recall |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
    for r in sorted(results, key=lambda x: (x.view, x.k, x.alpha)):
        recall = ", ".join(f"{t[:4]} {format_pct(r.recall[t])}" for t in TIERS)
        threshold = "none" if r.threshold_at_90 > 1 else f"{r.threshold_at_90:.4f}"
        lines.append(
            f"| {r.view} | {r.k} | {r.alpha:.1f} | {format_pct(r.exact)} | "
            f"{format_pct(r.adjacent)} | {r.mean_abs_dist:.3f} | "
            f"{format_pct(r.seed_agreement)} | {threshold} | {r.seed_coverage_at_90} | {recall} |"
        )
    best = max(results, key=result_sort_key)
    lines.append("")
    lines.append("## Best config on golden TEST")
    lines.append("")
    lines.append(f"- view: {best.view}")
    lines.append(f"- k: {best.k}")
    lines.append(f"- alpha: {best.alpha}")
    lines.append(f"- exact delta vs heuristic: {(best.exact - base_exact) * 100.0:.1f}pp")
    lines.append(f"- adjacent delta vs heuristic: {(best.adjacent - base_adjacent) * 100.0:.1f}pp")
    lines.append(f"- mean |tier distance| delta vs heuristic: {best.mean_abs_dist - base_mean_abs:.3f}")
    lines.append("")
    lines.append("## Silver-label selection")
    lines.append("")
    lines.append("Silver labels are written from the selected config using the lowest confidence threshold that keeps train-seed agreement at or above 90%.")
    lines.append(f"- selected view: {selected.view}")
    lines.append(f"- selected k: {selected.k}")
    lines.append(f"- selected alpha: {selected.alpha}")
    lines.append(f"- threshold: {'none' if selected.threshold_at_90 > 1 else f'{selected.threshold_at_90:.4f}'}")
    lines.append(f"- train-seed rows kept at threshold: {selected.seed_coverage_at_90}")
    lines.append(f"- train-seed agreement at threshold: {format_pct(selected.seed_agreement)} raw, thresholded target row agreement tracked in grid")
    lines.append("")
    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_silver(corpus: Sequence[CorpusRow], result: GridResult) -> int:
    probs = result.probs
    pred = np.argmax(probs, axis=1)
    conf = np.max(probs, axis=1)
    sorted_probs = np.sort(probs, axis=1)
    margins = sorted_probs[:, -1] - sorted_probs[:, -2]
    threshold = result.threshold_at_90
    written = 0
    with SILVER_PATH.open("w", encoding="utf-8") as fh:
        for i, row in enumerate(corpus):
            if conf[i] < threshold:
                continue
            payload = {
                "id": row.id,
                "text_hash": row.text_hash,
                "silver_tier": TIERS[int(pred[i])],
                "confidence": round(float(conf[i]), 6),
                "margin": round(float(margins[i]), 6),
                "view": result.view,
            }
            fh.write(json.dumps(payload, separators=(",", ":")) + "\n")
            written += 1
    return written


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not CORPUS_PATH.exists() or not FEATURES_PATH.exists():
        raise SystemExit("missing corpus/features; run npm run ssl:build-corpus && npm run ssl:extract-features first")

    corpus = load_corpus()
    features = load_features()
    if [r.id for r in corpus] != [r.id for r in features]:
        raise SystemExit("corpus/features id order mismatch")

    train_ids, test_ids = load_holdout()
    # seed_labels feeds propagation (train + organic ONLY); eval_labels is a
    # separate copy that additionally carries golden TEST labels for scoring.
    # Writing test labels into the propagation array seeds the graph with the
    # answers (propagate_sparse treats every label >= 0 as a seed) — that bug
    # produced a perfect-looking 100% grid before this split.
    seed_labels, seed_indices, _, _ = initial_labels(corpus, features, train_ids)
    test_indices = [i for i, row in enumerate(corpus) if row.id in test_ids and row.label in TIER_TO_IDX]
    eval_labels = seed_labels.copy()
    for i in test_indices:
        eval_labels[i] = TIER_TO_IDX[corpus[i].label or features[i].label]

    if seed_indices.size == 0:
        raise SystemExit("no train/organic seed labels found")
    if not test_indices:
        raise SystemExit("no golden TEST rows found")

    router_x = router_feature_matrix(features)
    text_x = text_feature_matrix(corpus)
    baseline = baseline_metrics(features, eval_labels, test_indices)

    results: List[GridResult] = []
    selected_candidates: List[GridResult] = []
    for k in K_GRID:
        print(f"building kNN graphs for k={k}")
        router_graph = cosine_knn_affinity(router_x, k)
        text_graph = cosine_knn_affinity(text_x, k)
        combined_graph = row_normalize((router_graph + text_graph).multiply(0.5).tocsr())
        for view, graph in [
            ("router", router_graph),
            ("tfidf", text_graph),
            ("combined", combined_graph),
        ]:
            for alpha in ALPHA_GRID:
                print(f"propagating view={view} k={k} alpha={alpha}")
                probs = propagate_sparse(graph, seed_labels, alpha)
                result = evaluate_grid_result(view, k, alpha, probs, eval_labels, seed_indices, test_indices)
                results.append(result)
                if result.threshold_at_90 <= 1:
                    selected_candidates.append(result)

    best = max(results, key=result_sort_key)
    selected_pool = selected_candidates or results
    selected = max(selected_pool, key=lambda r: (r.seed_coverage_at_90, r.seed_agreement, r.exact, r.adjacent, -r.mean_abs_dist))
    silver_count = write_silver(corpus, selected)
    write_report(results, selected, baseline, len(corpus), int(seed_indices.size), len(test_indices))

    base_exact, base_adjacent, base_mean_abs, _ = baseline
    print(f"wrote {REPORT_PATH}")
    print(f"wrote {SILVER_PATH} ({silver_count} rows)")
    print(f"heuristic baseline: exact {format_pct(base_exact)} adjacent {format_pct(base_adjacent)} mean|dist| {base_mean_abs:.3f}")
    print(
        f"best graph: view={best.view} k={best.k} alpha={best.alpha} "
        f"exact {format_pct(best.exact)} adjacent {format_pct(best.adjacent)} mean|dist| {best.mean_abs_dist:.3f}"
    )
    print(
        f"selected silver config: view={selected.view} k={selected.k} alpha={selected.alpha} "
        f"threshold {'none' if selected.threshold_at_90 > 1 else f'{selected.threshold_at_90:.4f}'}"
    )


if __name__ == "__main__":
    main()
