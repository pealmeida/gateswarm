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
import subprocess
import sys
import glob
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

SYNC_FILE = Path(__file__).parent.parent / "data" / "quota-sync.json"
WINDOW_5H = 5 * 3600  # seconds
WINDOW_7D = 7 * 24 * 3600
WINDOW_30D = 30 * 24 * 3600

def _now_iso():
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")

def load_sync():
    try:
        return json.loads(SYNC_FILE.read_text())
    except:
        return {"version": "0.1.0", "updatedAt": "", "snapshots": {}}

def save_sync(state):
    state["updatedAt"] = _now_iso()
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
        "syncedAt": _now_iso(),
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
        "syncedAt": _now_iso(),
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
        "syncedAt": _now_iso(),
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


# ─── CodexBar (real plan usage %, headless CLI) ───────────
#
# CodexBar is a third-party MIT binary (pinned + SHA256-checked by scripts/install-codexbar.sh, kept
# OUTSIDE the repo). Path comes from GATESWARM_CODEXBAR_BIN. We only use `--source cli` for Claude/Codex
# (the already-logged-in CLIs; CodexBar does not read cookies/tokens in that mode) and `--source api` for
# Z.AI when Z_AI_API_KEY is in the environment (never printed, never stored). E-mails/account ids are dropped.
# NOTE: each Claude collection opens a short Claude CLI session (~30 s) and costs a little quota.

CODEXBAR_BIN = os.environ.get("GATESWARM_CODEXBAR_BIN", "")
CODEXBAR_TIMEOUT_S = int(os.environ.get("GATESWARM_CODEXBAR_TIMEOUT_S", "120"))

def _cb_window(w):
    if not isinstance(w, dict):
        return {"usedPct": None, "resetAt": None, "resetType": "unknown", "windowMinutes": None}
    pct = w.get("usedPercent")
    return {
        "usedPct": float(pct) if isinstance(pct, (int, float)) else None,
        "resetAt": w.get("resetsAt"),
        "resetType": "fixed" if w.get("resetsAt") else "unknown",
        "windowMinutes": w.get("windowMinutes"),
    }

def codexbar_available():
    return bool(CODEXBAR_BIN) and os.path.isfile(CODEXBAR_BIN) and os.access(CODEXBAR_BIN, os.X_OK)

def scrape_codexbar(name, cb_provider, source):
    """Returns a snapshot, or None when CodexBar is not configured. Failure => snapshot with `error` and null windows."""
    if not codexbar_available():
        return None
    base = {"provider": name, "syncedAt": _now_iso(), "source": f"codexbar-{source}"}
    try:
        r = subprocess.run([CODEXBAR_BIN, "usage", "--provider", cb_provider, "--source", source, "--format", "json"],
                           capture_output=True, text=True, timeout=CODEXBAR_TIMEOUT_S, stdin=subprocess.DEVNULL)
        d = json.loads(r.stdout)[0]
        if d.get("error"):
            raise RuntimeError("codexbar-reported-error")
        u = d["usage"]
        return {**base, "plan": u.get("loginMethod"),
                "windows": {"5h": _cb_window(u.get("primary")), "7d": _cb_window(u.get("secondary"))}}
    except Exception as e:  # never include stderr/stdout (may hold account info)
        return {**base, "error": type(e).__name__, "_failed": True,
                "windows": {"5h": _cb_window(None), "7d": _cb_window(None)}}

# provider name in GateSwarm -> (codexbar provider, source, needs-env)
CODEXBAR_MAP = {
    "claude-cli": ("claude", "cli", None),
    "codex-cli": ("codex", "cli", None),
    "zai": ("zai", "api", "Z_AI_API_KEY"),
    # Alibaba Token Plan has no API-key source in CodexBar (needs the `bl` CLI login or cookies): opt-in only.
    "bailian": ("alibaba-token-plan", "cli", "GATESWARM_CODEXBAR_BAILIAN"),
}

def scrape_ollama():
    """Local Ollama has no quota: report gateway request counts only, flagged unmetered (usedPct stays null)."""
    snap = scrape_from_history("ollama", {})
    if snap:
        snap["unmetered"] = True
        snap["note"] = "local model, unmetered"
    return snap

# ─── Main ────────────────────────────────────────────────

def merge_codexbar(name, local):
    """Prefer CodexBar's real plan % over the local-token fallback; keep local token counts as extras."""
    cb_provider, source, env_needed = CODEXBAR_MAP[name]
    if env_needed and not os.environ.get(env_needed):
        return local, "not-configured"
    snap = scrape_codexbar(name, cb_provider, source)
    if snap is None:
        return local, "codexbar-missing"
    if snap.pop("_failed", False):
        return None, snap["error"]  # caller keeps the previous snapshot; it ages into "unknown"
    if local:  # keep local token counts (never used as %)
        for w in ("5h", "7d"):
            lw = local["windows"].get(w, {})
            for k in ("usedTokens", "usedRequests"):
                if k in lw:
                    snap["windows"][w][k] = lw[k]
    return snap, "ok"

def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    state = load_sync()

    scrapers = [
        ("codex-cli", scrape_codex),
        ("claude-cli", scrape_claude),
        ("zai", scrape_zai),
        ("bailian", scrape_bailian),
        ("ollama", scrape_ollama),
    ]

    for name, scraper in scrapers:
        if only and name not in only:
            continue
        try:
            result = scraper()
            if name in CODEXBAR_MAP:
                result, status = merge_codexbar(name, result)
                if result is None:
                    prev = state["snapshots"].get(name)
                    if prev is not None:
                        prev["lastError"] = {"at": _now_iso(), "code": status}
                    print(f"⚠️  {name}: codexbar failed ({status}); previous snapshot kept (goes stale)")
                    continue
                if status in ("not-configured", "codexbar-missing") and name in ("claude-cli", "codex-cli"):
                    for w in result["windows"].values() if result else []:
                        w["usedPct"] = None  # unknown, never 0
                if result and name in ("zai", "bailian") and status == "not-configured":
                    has_limit = any(w.get("usedPct") is not None for w in result["windows"].values())
                    result["note"] = ("ESTIMATE: gateway token counts vs configured GATESWARM_QUOTA_* limits (no provider-side source)"
                                      if has_limit else "no provider-side source and no configured limits: usedPct unknown")
                elif result and status != "ok":
                    result["note"] = {"not-configured": "no usage source configured for this provider (usedPct unknown)",
                                      "codexbar-missing": "CodexBar not installed (GATESWARM_CODEXBAR_BIN); usedPct unknown"}.get(status, status)
            if result:
                state["snapshots"][name] = result
                w5 = result["windows"].get("5h", {})
                print(f"✅ {name}: 5h={w5.get('usedPct')}% 7d={result['windows'].get('7d', {}).get('usedPct')}% tok5h={w5.get('usedTokens')}")
            else:
                print(f"⏭️  {name}: no data")
        except Exception as e:
            print(f"❌ {name}: {type(e).__name__}", file=sys.stderr)

    save_sync(state)
    print(f"\n💾 Saved to {SYNC_FILE}")

if __name__ == "__main__":
    main()
