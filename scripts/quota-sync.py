#!/usr/bin/env python3
"""
Quota Sync Script v0.1.0
Reads real quota/usage data from provider CLI files and APIs.
Runs as a cron job every 5 minutes.

Data sources:
  - Codex CLI: ~/.codex/sessions/*.jsonl (token counts per session)
  - Claude CLI: session limit messages + ~/.claude/ files
  - ZAI, Bailian: GateSwarm consumption history (data/consumption-history.json)
    Plan limits come from env vars (GATESWARM_QUOTA_*); unknown limits report usedPct=null.
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
            "usedPct": buckets[w] / LIMITS[w]["tokens"] * 100 if LIMITS[w]["tokens"] else None,
            "usedTokens": buckets[w],
            "limitTokens": LIMITS[w]["tokens"],
            "usedRequests": req_counts[w],
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
            "usedPct": None,  # plan limit unknown; use /status in the CLI for real remaining quota
            "usedTokens": buckets[w],
            "resetAt": "rolling",
            "resetType": "rolling",
        }

    return {
        "provider": "claude-cli",
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "claude-cli-sessions",
        "windows": windows,
    }

# ─── HTTP providers (from GateSwarm consumption history) ──

def _env_limit(name):
    """Optional plan limit from the environment (tokens). Unset/invalid => unknown (None)."""
    raw = os.environ.get(name, "").strip()
    try:
        v = float(raw)
        return v if v > 0 else None
    except ValueError:
        return None

def scrape_from_history(provider, limits):
    """
    Sum GateSwarm's own tracked tokens per window for `provider`.
    `limits` maps window ("5h"/"7d"/"30d") -> token limit or None. When a limit is unknown
    usedPct is null (NOT 0), so consumers never mistake "unknown" for "idle".
    Plan limits are plan-specific; set them via environment, e.g.
      GATESWARM_QUOTA_ZAI_5H_TOKENS, GATESWARM_QUOTA_ZAI_7D_TOKENS,
      GATESWARM_QUOTA_BAILIAN_30D_TOKENS
    """
    history_file = Path(__file__).parent.parent / "data" / "consumption-history.json"
    if not history_file.exists():
        return None
    try:
        history = json.loads(history_file.read_text())
    except Exception:
        return None

    buckets = history.get("providers", {}).get(provider, {}).get("buckets", {})
    now_ms = int(time.time() * 1000)

    windows_data = {}
    for name, window_s in [("5h", WINDOW_5H), ("7d", WINDOW_7D), ("30d", WINDOW_30D)]:
        start_ms = now_ms - window_s * 1000
        total_tokens = 0
        total_requests = 0
        for bucket_hour, bucket in buckets.items():
            if int(bucket_hour) > start_ms:
                total_tokens += bucket.get("tokensIn", 0) + bucket.get("tokensOut", 0)
                total_requests += bucket.get("requests", 0)
        limit = limits.get(name)
        windows_data[name] = {
            "usedPct": round(total_tokens / limit * 100, 1) if limit else None,
            "usedTokens": total_tokens,
            "limitTokens": limit,
            "usedRequests": total_requests,
            "resetAt": "rolling" if name != "30d" else "plan cycle",
            "resetType": "rolling",
        }

    return {
        "provider": provider,
        "syncedAt": datetime.now(tz=timezone.utc).isoformat() + "Z",
        "source": "consumption-history",
        "windows": windows_data,
    }

def scrape_zai():
    return scrape_from_history("zai", {
        "5h": _env_limit("GATESWARM_QUOTA_ZAI_5H_TOKENS"),
        "7d": _env_limit("GATESWARM_QUOTA_ZAI_7D_TOKENS"),
    })

def scrape_bailian():
    return scrape_from_history("bailian", {
        "30d": _env_limit("GATESWARM_QUOTA_BAILIAN_30D_TOKENS"),
    })

# ─── Main ────────────────────────────────────────────────

def main():
    state = load_sync()

    scrapers = [
        ("codex-cli", scrape_codex),
        ("claude-cli", scrape_claude),
        ("zai", scrape_zai),
        ("bailian", scrape_bailian),
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
