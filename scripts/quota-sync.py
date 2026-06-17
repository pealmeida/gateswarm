#!/usr/bin/env python3
"""
Quota Sync Script v0.1.0
Reads real quota/usage data from provider CLI files and APIs.
Runs as a cron job every 5 minutes.

Data sources:
  - Codex CLI: ~/.codex/sessions/*.jsonl (token counts per session)
  - Claude CLI: session limit messages + ~/.claude/ files
  - OpenCode Go: API usage metadata (cumulative from chat responses)
  - ZAI: API usage metadata
  - Ollama Cloud: API + ~/.ollama/ files
"""

import json
import os
import sys
import glob
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

SYNC_FILE = Path(__file__).parent.parent / "data" / "quota-sync.json"
WINDOW_5H = 5 * 3600  # seconds
WINDOW_7D = 7 * 24 * 3600
WINDOW_30D = 30 * 24 * 3600

def load_sync():
    try:
        return json.loads(SYNC_FILE.read_text())
    except:
        return {"version": "0.1.0", "updatedAt": "", "snapshots": {}}

def save_sync(state):
    state["updatedAt"] = datetime.now(tz=timezone.utc).isoformat() + "Z"
    SYNC_FILE.parent.mkdir(parents=True, exist_ok=True)
    SYNC_FILE.write_text(json.dumps(state, indent=2))

# ─── Codex CLI ───────────────────────────────────────────

def scrape_codex():
    """Read Codex session files for token usage in last 5h/7d/30d."""
    sessions_dir = Path.home() / ".codex" / "sessions"
    if not sessions_dir.exists():
        return None

    now = time.time()
    buckets = {"5h": 0, "7d": 0, "30d": 0}
    req_counts = {"5h": 0, "7d": 0, "30d": 0}

    for jsonl in sessions_dir.rglob("*.jsonl"):
        mtime = jsonl.stat().st_mtime
        age = now - mtime

        # Determine which windows this file falls into
        active_windows = []
        if age < WINDOW_5H: active_windows.append("5h")
        if age < WINDOW_7D: active_windows.append("7d")
        if age < WINDOW_30D: active_windows.append("30d")
        if not active_windows:
            continue

        # Parse the file for token usage
        try:
            for line in jsonl.read_text().splitlines():
                try:
                    entry = json.loads(line)
                    usage = entry.get("usage") or entry.get("tokens")
                    if usage and isinstance(usage, dict):
                        tokens = usage.get("total_tokens") or (
                            usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
                        )
                        if tokens:
                            for w in active_windows:
                                buckets[w] += tokens
                                req_counts[w] += 1
                        break  # Only need first usage entry per session
                    # Also check for "tokens used" in content
                    content = str(entry.get("content", ""))
                    if "tokens used" in content.lower():
                        import re
                        match = re.search(r'tokens used[:\s]*([0-9,]+)', content, re.I)
                        if match:
                            tokens = int(match.group(1).replace(",", ""))
                            for w in active_windows:
                                buckets[w] += tokens
                                req_counts[w] += 1
                            break
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            print(f"  codex: error reading {jsonl}: {e}", file=sys.stderr)

    # Codex Plus plan: ~33K tokens per 5h session
    # Weekly limit varies, monthly is larger
    # These are approximate based on observed usage patterns
    LIMITS = {
        "5h": {"tokens": None, "requests": None},
        "7d": {"tokens": None, "requests": None},
        "30d": {"tokens": None, "requests": None},
    }

    windows = {}
    for w in ["5h", "7d", "30d"]:
        windows[w] = {
            "usedTokens": buckets[w],
            "usedRequests": req_counts[w],
            "limitTokens": LIMITS[w]["tokens"],
            "limitRequests": LIMITS[w]["requests"],
            "usedPctTokens": None,
            "usedPctRequests": None,
            "resetAt": "rolling" if w == "5h" else ("rolling" if w == "7d" else "fixed"),
            "resetType": "rolling" if w != "30d" else "fixed",
        }

    return {
        "provider": "codex-cli",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "codex-cli-sessions",
        "windows": windows,
    }

# ─── Claude CLI ──────────────────────────────────────────

def scrape_claude():
    """Read Claude session files for token usage."""
    sessions_dir = Path.home() / ".claude" / "sessions"
    if not sessions_dir.exists():
        # Try alternate paths
        return None

    now = time.time()
    buckets = {"5h": 0, "7d": 0, "30d": 0}
    req_counts = {"5h": 0, "7d": 0, "30d": 0}

    for session_file in sessions_dir.rglob("*"):
        if not session_file.is_file():
            continue
        mtime = session_file.stat().st_mtime
        age = now - mtime

        active_windows = []
        if age < WINDOW_5H: active_windows.append("5h")
        if age < WINDOW_7D: active_windows.append("7d")
        if age < WINDOW_30D: active_windows.append("30d")
        if not active_windows:
            continue

        try:
            content = session_file.read_text()
            # Look for token counts in JSON files
            if session_file.suffix == ".json":
                data = json.loads(content)
                usage = data.get("usage") or data.get("tokens")
                if usage and isinstance(usage, dict):
                    tokens = usage.get("total_tokens") or sum(
                        v for v in usage.values() if isinstance(v, (int, float))
                    )
                    if tokens:
                        for w in active_windows:
                            buckets[w] += tokens
                            req_counts[w] += 1
            elif "token" in content.lower():
                import re
                matches = re.findall(r'(\d+)\s*tokens?', content, re.I)
                if matches:
                    tokens = sum(int(m) for m in matches)
                    for w in active_windows:
                        buckets[w] += tokens
                        req_counts[w] += 1
        except:
            continue

    windows = {}
    for w in ["5h", "7d", "30d"]:
        windows[w] = {
            "usedTokens": buckets[w],
            "usedRequests": req_counts[w],
            "limitTokens": None,
            "limitRequests": None,
            "usedPctTokens": None,
            "usedPctRequests": None,
            "resetAt": "rolling",
            "resetType": "rolling",
        }

    return {
        "provider": "claude-cli",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "claude-cli-sessions",
        "windows": windows,
    }

# ─── OpenCode Go (from API usage + consumption history) ──

def scrape_opencodego():
    """
    OpenCode Go doesn't expose a quota API.
    We read the GateSwarm consumption history for actual token counts.
    """
    history_file = Path(__file__).parent.parent / "data" / "consumption-history.json"
    if not history_file.exists():
        return None

    try:
        history = json.loads(history_file.read_text())
    except:
        return None

    provider_data = history.get("providers", {}).get("opencodego", {})
    buckets = provider_data.get("buckets", {})

    now_ms = int(time.time() * 1000)
    hour_ms = 3600 * 1000

    windows_data = {}
    for name, window_s in [("5h", WINDOW_5H), ("7d", WINDOW_7D), ("30d", WINDOW_30D)]:
        window_ms = window_s * 1000
        start_ms = now_ms - window_ms

        total_tokens = 0
        total_requests = 0

        for bucket_hour, bucket in buckets.items():
            bh = int(bucket_hour)
            if bh > start_ms:
                total_tokens += bucket.get("tokensIn", 0) + bucket.get("tokensOut", 0)
                total_requests += bucket.get("requests", 0)

        windows_data[name] = {
            "usedTokens": total_tokens,
            "usedRequests": total_requests,
            "limitTokens": 50000 if name == "5h" else (300000 if name == "7d" else 500000),
            "limitRequests": None,
            "usedPctTokens": round(total_tokens / 50000 * 100, 1) if name == "5h" else (
                round(total_tokens / 300000 * 100, 1) if name == "7d" else
                round(total_tokens / 500000 * 100, 1)
            ),
            "usedPctRequests": None,
            "resetAt": "rolling" if name != "30d" else "1st of month UTC",
            "resetType": "rolling" if name != "30d" else "fixed",
        }

    return {
        "provider": "opencodego",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "consumption-history",
        "windows": windows_data,
    }

# ─── ZAI (from consumption history) ──────────────────────

def scrape_zai():
    """Read ZAI usage from GateSwarm consumption history."""
    history_file = Path(__file__).parent.parent / "data" / "consumption-history.json"
    if not history_file.exists():
        return None

    try:
        history = json.loads(history_file.read_text())
    except:
        return None

    provider_data = history.get("providers", {}).get("zai", {})
    buckets = provider_data.get("buckets", {})

    now_ms = int(time.time() * 1000)

    windows_data = {}
    limits = {"5h": 30000, "7d": 200000, "30d": None}

    for name, window_s in [("5h", WINDOW_5H), ("7d", WINDOW_7D), ("30d", WINDOW_30D)]:
        window_ms = window_s * 1000
        start_ms = now_ms - window_ms

        total_tokens = 0
        total_requests = 0

        for bucket_hour, bucket in buckets.items():
            bh = int(bucket_hour)
            if bh > start_ms:
                total_tokens += bucket.get("tokensIn", 0) + bucket.get("tokensOut", 0)
                total_requests += bucket.get("requests", 0)

        limit = limits[name]
        windows_data[name] = {
            "usedTokens": total_tokens,
            "usedRequests": total_requests,
            "limitTokens": limit,
            "limitRequests": None,
            "usedPctTokens": round(total_tokens / limit * 100, 1) if limit else None,
            "usedPctRequests": None,
            "resetAt": "rolling" if name == "5h" else ("Monday 00:00 UTC" if name == "7d" else "never"),
            "resetType": "rolling" if name == "5h" else ("fixed" if name == "7d" else "rolling"),
        }

    return {
        "provider": "zai",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "consumption-history",
        "windows": windows_data,
    }

# ─── Ollama Cloud (from consumption history) ─────────────

def scrape_ollama_cloud():
    """Read Ollama Cloud usage from GateSwarm consumption history."""
    history_file = Path(__file__).parent.parent / "data" / "consumption-history.json"
    if not history_file.exists():
        return None

    try:
        history = json.loads(history_file.read_text())
    except:
        return None

    provider_data = history.get("providers", {}).get("ollama-cloud", {})
    buckets = provider_data.get("buckets", {})

    now_ms = int(time.time() * 1000)

    windows_data = {}
    limits_tokens = {"5h": 50000, "7d": 500000, "30d": None}
    limits_req = {"5h": 200, "7d": 2000, "30d": None}

    for name, window_s in [("5h", WINDOW_5H), ("7d", WINDOW_7D), ("30d", WINDOW_30D)]:
        window_ms = window_s * 1000
        start_ms = now_ms - window_ms

        total_tokens = 0
        total_requests = 0

        for bucket_hour, bucket in buckets.items():
            bh = int(bucket_hour)
            if bh > start_ms:
                total_tokens += bucket.get("tokensIn", 0) + bucket.get("tokensOut", 0)
                total_requests += bucket.get("requests", 0)

        lt = limits_tokens[name]
        lr = limits_req[name]
        windows_data[name] = {
            "usedTokens": total_tokens,
            "usedRequests": total_requests,
            "limitTokens": lt,
            "limitRequests": lr,
            "usedPctTokens": round(total_tokens / lt * 100, 1) if lt else None,
            "usedPctRequests": round(total_requests / lr * 100, 1) if lr else None,
            "resetAt": "01:00 UTC (session)" if name == "5h" else ("Monday 01:00 UTC" if name == "7d" else "never"),
            "resetType": "rolling" if name == "5h" else ("fixed" if name == "7d" else "rolling"),
        }

    return {
        "provider": "ollama-cloud",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "consumption-history",
        "windows": windows_data,
    }

# ─── Main ────────────────────────────────────────────────

def main():
    state = load_sync()

    scrapers = [
        ("codex-cli", scrape_codex),
        ("claude-cli", scrape_claude),
        ("opencodego", scrape_opencodego),
        ("zai", scrape_zai),
        ("ollama-cloud", scrape_ollama_cloud),
    ]

    for name, scraper in scrapers:
        try:
            result = scraper()
            if result:
                state["snapshots"][name] = result
                tok_5h = result["windows"].get("5h", {}).get("usedTokens", 0)
                req_5h = result["windows"].get("5h", {}).get("usedRequests", 0)
                print(f"✅ {name}: 5h={tok_5h} tok / {req_5h} req")
            else:
                print(f"⏭️  {name}: no data")
        except Exception as e:
            print(f"❌ {name}: {e}", file=sys.stderr)

    save_sync(state)
    print(f"\n💾 Saved to {SYNC_FILE}")

if __name__ == "__main__":
    main()
