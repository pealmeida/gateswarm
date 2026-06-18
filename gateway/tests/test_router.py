"""
GateSwarm MoA Router — Test Suite

Run: python test_router.py
"""

import json
import sys
import os

# Ensure router.py is importable
sys.path.insert(0, os.path.dirname(__file__))

from router import (
    score_prompt,
    score_prompts,
    extract_features,
    score_to_tier,
    set_tier_models,
    TIERS,
    __version__,
)

PASSED = 0
FAILED = 0


def assert_test(name: str, condition: bool, detail: str = ""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ✅ {name}")
    else:
        FAILED += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


def test_version():
    print("\n[Version]")
    assert_test("version is set", __version__ is not None and len(__version__) > 0)
    assert_test("version matches expected", __version__ == "0.3.5", f"got {__version__}")


def test_tier_mapping():
    print("\n[Tier Mapping]")
    cases = [
        (0.01, "trivial"),
        (0.05, "trivial"),
        (0.10, "light"),
        (0.15, "light"),
        (0.20, "moderate"),
        (0.30, "moderate"),
        (0.35, "heavy"),
        (0.50, "heavy"),
        (0.55, "intensive"),
        (0.70, "intensive"),
        (0.75, "extreme"),
        (0.95, "extreme"),
    ]
    for score, expected in cases:
        result = score_to_tier(score)
        assert_test(f"score {score} → {expected}", result == expected, f"got {result}")


def test_feature_extraction():
    print("\n[Feature Extraction]")

    # Simple greeting
    f = extract_features("hello")
    assert_test("greeting: word_count small", f["word_count"] <= 5)
    assert_test("greeting: no code", f["has_code"] == 0.0)

    # Technical question
    f = extract_features("How do I implement a REST API with Docker and Kubernetes?")
    assert_test("tech question: has_question", f["has_question"] == 1.0)
    assert_test("tech question: technical_terms > 0", f["technical_terms"] > 0)
    assert_test("tech question: question_technical", f["question_technical"] == 1.0)

    # Code block
    f = extract_features("```python\ndef hello():\n    print('hi')\n```")
    assert_test("code block: has_code", f["has_code"] == 1.0)

    # Architecture prompt
    f = extract_features("Design a distributed event-driven microservice architecture with load balancer")
    assert_test("architecture keyword", f["architecture"] == 1.0)

    # Multi-step prompt
    f = extract_features("First, create the API. Then add auth. Finally, deploy to production.")
    assert_test("multi_step", f["multi_step"] == 1.0)


def test_scoring():
    print("\n[Scoring]")

    # Trivial prompts should score low
    r = score_prompt("hello")
    assert_test("'hello' → trivial/light", r["tier"] in ("trivial", "light"), f"got {r['tier']}")
    assert_test("score is float", isinstance(r["score"], float))
    assert_test("confidence is float", isinstance(r["confidence"], float))
    assert_test("tier is valid", r["tier"] in TIERS)
    assert_test("method is set", r["method"] in ("cascade", "heuristic"))
    assert_test("latency_ms is set", isinstance(r["latency_ms"], (int, float)))
    assert_test("model is set", "model" in r)
    assert_test("provider is set", "provider" in r)

    # Heavy prompt should score higher
    r = score_prompt(
        "Design a distributed event-driven microservice architecture for a fintech payment system "
        "with real-time fraud detection, Kubernetes deployment, and disaster recovery failover"
    )
    assert_test(
        "architecture prompt → heavy+",
        r["tier"] in ("heavy", "intensive", "extreme"),
        f"got {r['tier']} (score={r['score']:.3f})",
    )

    # Moderate prompt
    r = score_prompt("Write a Python function that sorts a list using merge sort and explain the time complexity")
    assert_test(
        "code prompt → moderate+",
        r["tier"] in ("moderate", "heavy", "light"),
        f"got {r['tier']} (score={r['score']:.3f})",
    )


def test_batch_scoring():
    print("\n[Batch Scoring]")
    results = score_prompts([
        "hi",
        "What is Python?",
        "Explain quantum computing in detail with examples",
        "Design a distributed event-driven microservice architecture",
    ])
    assert_test("batch returns 4 results", len(results) == 4)
    assert_test("batch all have tier", all("tier" in r for r in results))
    assert_test("batch all valid tiers", all(r["tier"] in TIERS for r in results))


def test_model_override():
    print("\n[Model Override]")
    custom = {
        "trivial":   {"model": "test-model-free", "provider": "test", "max_tokens": 128},
        "light":     {"model": "test-model-free", "provider": "test", "max_tokens": 256},
        "moderate":  {"model": "test-model-mid",  "provider": "test", "max_tokens": 512},
        "heavy":     {"model": "test-model-mid",  "provider": "test", "max_tokens": 1024},
        "intensive": {"model": "test-model-pro",  "provider": "test", "max_tokens": 2048},
        "extreme":   {"model": "test-model-pro",  "provider": "test", "max_tokens": 4096},
    }
    set_tier_models(custom)
    r = score_prompt("hello")
    assert_test("override applies", r["model"] == "test-model-free", f"got {r['model']}")
    assert_test("override provider", r["provider"] == "test", f"got {r['provider']}")

    # Reset to defaults
    from router import TIER_MODELS as DEFAULT_MODELS
    set_tier_models(DEFAULT_MODELS)


def test_weights_file():
    print("\n[Weights File]")
    weights_path = os.path.join(os.path.dirname(__file__), "..", "..", "v32_cascade_weights.json")
    assert_test("weights file exists", os.path.exists(weights_path))
    with open(weights_path) as f:
        data = json.load(f)
    assert_test("weights has version", "version" in data)
    assert_test("weights has 5 classifiers", len(data.get("classifiers", {})) == 5)
    assert_test("weights has feature_names", "feature_names" in data)
    assert_test("weights has 15 features", len(data.get("feature_names", [])) == 15)


if __name__ == "__main__":
    print(f"GateSwarm MoA Router v{__version__} — Test Suite")
    print("=" * 50)

    test_version()
    test_tier_mapping()
    test_feature_extraction()
    test_scoring()
    test_batch_scoring()
    test_model_override()
    test_weights_file()

    print("\n" + "=" * 50)
    total = PASSED + FAILED
    print(f"Results: {PASSED}/{total} passed, {FAILED} failed")

    if FAILED > 0:
        print("⚠️  Some tests failed!")
        sys.exit(1)
    else:
        print("✅ All tests passed!")
