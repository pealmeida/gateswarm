# GateSwarm MoMA Router — Operations Guide

> **Status:** v0.5.6-routing-fix · **Generated:** 2026-06-20
> **Scope:** Updates · Debugging · Analysis · Versioning
> **Audience:** Pedro (owner) + any future contributor who has shell access to the router host

This is the single source of truth for keeping the router healthy and shipping clean updates. Every command below is **safe to run** on the live system and has been verified against the current deployment.

---

## 0. The 10-Second Health Check

Run this first when something feels off. All four should be green.

```bash
# 1. Service running
systemctl status moa-gateway --no-pager | grep -E "Active|Description"
#  → expect: Active: active (running) since ...  Description: GateSwarm MoMA Router v0.5.6 ...

# 2. HTTP endpoint healthy
curl -sS http://localhost:8900/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'], '|', d['router'], '| llmJudge:', d['llmJudge'])"
#  → expect: healthy | GateSwarm MoMA Router v0.5.6 (Routing Transparency) | llmJudge: zai/glm-4.7

# 3. All critical providers healthy
curl -sS http://localhost:8900/v05/intel/quota | python3 -c "
import sys,json
for p in json.load(sys.stdin)['quotas']:
    if p['provider'] in ('zai','opencodego','ollama','ollama-cloud','codex-cli','claude-cli','bailian'):
        flag = 'OK' if p['health'] >= 80 and not p['throttled'] else 'DEGRADED'
        print(f'  [{flag}] {p[\"provider\"]:13s} health={p[\"health\"]:3} throttled={p[\"throttled\"]}')"

# 4. Last request routed correctly
curl -sS http://localhost:8900/v05/intel/last-decision | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'  last: {d[\"tier\"]} -> {d[\"provider\"]}/{d[\"model\"]} (conf={d[\"confidence\"]:.2f}, reason={d[\"reason\"]})')"
```

If any check fails, jump to **§2 Debugging**.

---

## 1. Architecture in 60 seconds

```
Pi TUI (display only)
  └─ → defaultProvider = "moma" (was "moa"; renamed 2026-06-20)
        └─ → baseUrl http://localhost:8900/v1
              └─ → moa-gateway.service (systemd, port 8900)
                    ├─ intent-engine-v04.ts    (ensemble voter: heuristic 0.55 + RAG 0.25 + history 0.20)
                    ├─ consumption-intelligence (token/load balancer + cheapest_available scoring)
                    ├─ provider-quota.ts        (health scoring; rateLimitHits penalty)
                    ├─ rag-index.ts            (context compression summaries, Q0/Q1/Q2 tiers)
                    ├─ turboquant-compressor   (auto-compact messages per model context)
                    ├─ feedback-store          (gold labels, retraining every 500)
                    ├─ cli-health-probe.sh     (auth-aware health for codex-cli / claude-cli)
                    └─ v04_config.json         (single source of truth for tier → provider/model)
                          └─ → providers: zai, ollama-cloud, ollama, codex-cli, claude-cli
                              (bailian removed 2026-06-20; opencodego quota exhausted 14d reset)
```

**Three namespaces, three files:**
- `package.json` (root): `gateswarm-router` v0.5.6
- `cli/package.json`: `gateswarm-bar` v0.5.6 (the TUI)
- `~/.pi/agent/settings.json` + `models.json`: Pi's view of "moma" provider

---

## 2. Debugging

### 2.1 Triage flowchart

```
symptom: "model output is wrong" or "routing looks off"
  │
  ├─ check health (4 commands above)
  │    └─ if degraded → §2.3 (provider health)
  │
  ├─ read recent routing decisions
  │    journalctl -u moa-gateway --since "10 min ago" --no-pager | grep "Score:"
  │    └─ look for: static provider X unhealthy → dynamic fallback picked Y
  │                → static config is wrong, fix v04_config.json (§3.2)
  │
  ├─ compare last decision vs TUI display
  │    curl -sS http://localhost:8900/v05/intel/last-decision
  │    └─ if TUI shows different → §2.5 (TUI version skew)
  │
  └─ check ensemble breakdown
       curl -sS -X POST http://localhost:8900/v1/chat/completions \
         -H "Content-Type: application/json" \
         -d '{"model":"gateswarm","messages":[{"role":"user","content":"<your prompt>"}],"stream":false,"max_tokens":10}' \
         -i 2>&1 | grep -i "x-routing"
       └─ headers X-Routing-Method, X-Routing-Reason show decision path
```

### 2.2 Common failure modes (known, fixed, won't recur unless reverted)

| Symptom | Root cause | Was caused by |
|---|---|---|
| Moderate prompt → `minimax-m2.7` | bailian primary failed, dynamic picked cheapest | `BAILIAN_KEY=*** expired` (2026-06-20, key now removed) |
| Heavy prompt → `minimax-m2.7` | opencodego primary failed, dynamic picked cheapest | `GoUsageLimitError`, 14d reset (2026-06-20) |
| All ZAI requests fall back to dynamic | ZAI healthScore stuck at 0 | `rateLimitHits=20` from quota-sync probe (2026-06-20, now decays) |
| Always 0.288 score | RAG tier pollution | Compressor `Q0/Q1/Q2` entries feeding into effort score map (2026-06-20, filtered) |
| TUI shows `INTENSIVE` row but actual = moderate | TUI rendered only static config | `TiersMatrix.tsx` didn't show last request (2026-06-20, added ★ LAST REQUEST header) |
| Status bar shows `(moa)` instead of `(moma)` | Pi TUI uses `defaultProvider` literally | `settings.json` had `"moa"` (2026-06-20, renamed to `"moma"`) |
| Codex CLI always "healthy" but errors at runtime | `healthCheck: codex --version` doesn't verify auth | (2026-06-20, replaced with `cli-health-probe.sh`) |

### 2.3 Provider health debugging

**Read the source of health score:**

```bash
# Live health for all providers
curl -sS http://localhost:8900/v05/intel/quota | python3 -c "
import sys, json
for p in json.load(sys.stdin)['quotas']:
    print(f'{p[\"provider\"]:13s} health={p[\"health\"]:3} rateLimitHits={p.get(\"rateLimitHits\",0)} throttled={p[\"throttled\"]}')"
```

**Decay rules** (in `src/provider-quota.ts:updateHealthScore`):
- `-15` per `rateLimitHits` (now decays -1 per `recordSuccess` call as of 2026-06-20)
- `-25` per consecutive 429 (resets on success)
- `-30` if RPM > 80% used
- `-25` if RPD > 80% used
- `-50` if `throttled && throttledUntil > now`
- Floor: 0

**If a provider is stuck at health=0 even though it works**, reset it:

```bash
# Stop service FIRST so the in-memory state doesn't overwrite the disk fix
systemctl stop moa-gateway
python3 -c "
import json
p='/root/.openclaw/workspace/gateswarm-moma-router/data/provider-quota.json'
d=json.load(open(p))
for pid in ('zai','opencodego','ollama-cloud','ollama','bailian'):
    q=d['quotas'].get(pid,{})
    if q.get('rateLimitHits',0) > 0 or q.get('healthScore',100) < 50:
        q['rateLimitHits']=0; q['healthScore']=100; q['throttled']=False; q['consecutive429s']=0
        print(f'  reset {pid}')
json.dump(d, open(p,'w'), indent=2)"
systemctl start moa-gateway
```

### 2.4 RAG signal pollution

RAG entries have **two types of `tier`**:
- Effort tier (`trivial`/`light`/`moderate`/`heavy`/`intensive`/`extreme`) — from real chat decisions
- Compressor quality (`Q0`/`Q1`/`Q2`) — from `turboquant-compressor` summaries

The intent engine filters `Q*` entries (since 2026-06-20). If you see a constant score around `0.288` for every prompt, the filter is broken or you have stale `Q*` entries. Check:

```bash
python3 -c "
import json, re
d=json.load(open('/root/.openclaw/workspace/gateswarm-moma-router/data/rag/index.json'))
bad=[e for e in d if re.match(r'^Q[0-9]+\$', str(e.get('tier','')))]
print(f'  total: {len(d)}, Q* compressor: {len(bad)}')
if bad:
    print('  → run cleanup:')
    print('  python3 -c \"import json,re; d=json.load(open(\\\"/root/.openclaw/workspace/gateswarm-moma-router/data/rag/index.json\\\")); json.dump([e for e in d if not re.match(r\\\"^Q[0-9]+\\\$\\\", str(e.get(\\\"tier\\\",\\\"\\\")))], open(\\\"/root/.openclaw/workspace/gateswarm-moma-router/data/rag/index.json\\\",\\\"w\\\"), indent=2)\"')"
```

### 2.5 TUI version skew

If the TUI shows an old version or wrong info but the gateway is correct:

```bash
# 1. Check the TUI source vs dist (source of truth)
head -2 /root/.openclaw/workspace/gateswarm-moma-router/cli/src/components/TiersMatrix.tsx
# Should say: * GateSwarm v0.5.6 — Tiers matrix panel

# 2. Rebuild the TUI dist if source is newer
cd /root/.openclaw/workspace/gateswarm-moma-router/cli && npx tsc

# 3. Check /usr/local/bin/gateswarm wrapper
head -2 /usr/local/bin/gateswarm
# Should say: # GateSwarm MoMA Router v0.5.6 — CLI wrapper

# 4. Restart Pi (the CLI TUI) to pick up new provider name
#    Pi caches defaultProvider from settings.json at startup
```

### 2.6 Reading the routing log

Every request produces one line like:
```
🧠 [default] Score: 0.346 → heavy (plan) → zai/glm-5.1 [provider_preferred, conf=0.90]
```

Fields:
- `[<agentId>]` — which agent the request was for (`default`, `quality`, `bmad-dev`, `bmad-architect`)
- `Score: 0.346` — ensemble score from intent engine (0.0–1.0)
- `→ heavy` — tier after `scoreToEffort()` mapping
- `(plan)` or `(act)` — detected intent mode (auto/plan/act)
- `→ zai/glm-5.1` — chosen provider/model
- `[provider_preferred, conf=0.90]` — reason: `provider_preferred` (static primary worked) | `cheapest_available` (dynamic fallback) | `static_fallback` (used a configured fallback) | `plan_mode_override`
- `conf=0.90` — confidence in the decision (0.0–1.0)

**Score bands** (from `intent-engine-v04.ts:scoreToEffort`):
- `0.00–0.10` → trivial
- `0.10–0.20` → light
- `0.20–0.32` → moderate
- `0.32–0.40` → heavy
- `0.40–0.46` → intensive
- `0.46+`    → extreme

If a request you think is "complex" lands in moderate, the heuristic + RAG signal together put it below 0.32. Check the RAG index (§2.4) and the heuristic classifier (`src/classifiers/heuristic-linear.ts`).

---

## 3. Updates

### 3.1 Safe update procedure

```bash
# 1. Snapshot the current state
cp /root/.openclaw/workspace/gateswarm-moma-router/v04_config.json /tmp/v04_config.json.bak
cp /root/.openclaw/workspace/gateswarm-moma-router/data/agent-registry.json /tmp/agent-registry.json.bak
cp /root/.openclaw/workspace/gateswarm-moma-router/data/provider-quota.json /tmp/provider-quota.json.bak

# 2. Make your source changes (edit v04_config.json, src/*.ts, etc.)

# 3. Type-check the gateway
cd /root/.openclaw/workspace/gateswarm-moma-router && npx tsc --noEmit
#  → must exit 0

# 4. Type-check the CLI TUI
cd cli && npx tsc --noEmit && npx tsc
#  → must exit 0; rebuilds cli/dist/*

# 5. Update version stamps IN THIS ORDER:
#    - v04_config.json  → "version": "v0.5.6-<your-tag>"
#    - package.json     → "version": "0.5.6"  (root)
#    - cli/package.json → "version": "0.5.6"
#    - src/gateswarm-cli.ts → "v0.5.6" in any "GateSwarm v..." string
#    - /usr/local/bin/gateswarm wrapper → "v0.5.6" in header comment
#    - systemd Description → "v0.5.6 - ..."
#    - ~/.pi/agent/models.json → "gateswarm" model name and llmJudge
#    - MEMORY.md and memory/2026-06-20.md → log the change

# 6. Restart and verify
systemctl restart moa-gateway
sleep 5
curl -sS http://localhost:8900/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='healthy', d; print('OK', d['router'])"

# 7. Smoke-test 4 tiers
for prompt in "hi" "Explain async" "Design a billing system" "Architect a global CRDT system"; do
  echo "  prompt: $prompt"
  timeout 240 curl -sS -X POST http://localhost:8900/v1/chat/completions \
    -H "Content-Type: application/json" -H "Authorization: Bearer $(grep BAILIAN_KEY /root/.openclaw/workspace/gateswarm-moma-router/.env 2>/dev/null | cut -d= -f2 || echo ***…d34b)" \
    -d "{\"model\":\"gateswarm\",\"messages\":[{\"role\":\"user\",\"content\":\"$prompt\"}],\"stream\":false,\"max_tokens\":15}" 2>&1 | python3 -c "
import sys,json
try: print('   ->', json.load(sys.stdin).get('model'))
except: print('   -> error / timeout')"
  sleep 1
done
```

### 3.2 Updating `v04_config.json` (most common edit)

The file has 4 sections:
1. **`tier_models[<tier>]`** — `{model, provider, max_tokens, enable_thinking, fallback_models[]}` for each of 6 tiers
2. **`feedback_loop.llmJudgeModel`** — `provider/model` for the LLM judge (sampled at 10%)
3. **`ensemble.weights`** — `{heuristic, cascade, ragSignal, historyBias}` summing to 1.0
4. **`thresholds.confidence.{high, low}`** — escalation rules

**Rules for `tier_models`:**
- Primary `model` must exist in the provider's `modelMatrix.getAvailableModels()` — verify with `curl http://localhost:8900/v1/models` for OpenAI-compatible, or check `data/agent-registry.json` for CLI providers
- Each `fallback_model` must also be valid
- Set `enable_thinking: true` only for tiers where reasoning matters (heavy+)
- `max_tokens` is the model's response budget; 256/512/2048/4096/8192 are sane defaults

**To swap a primary** (e.g. bailian expired → use zai):
```json
"moderate": {
  "model": "glm-5",           // was: "MiniMax-M2.5"
  "provider": "zai",          // was: "bailian"
  ...
}
```

**To add a fallback**: just append to `fallback_models[]`. Order matters: first viable one wins.

**Always purge the unhealthy provider** (or its `apiKey` from `data/agent-registry.json`) so the deep-probe doesn't waste a timeout on every request.

### 3.3 Adding a new provider

1. Add credentials to `.env`:
   ```bash
   NEWPROV_BASE=https://api.example.com/v1
   NEWPROV_KEY=***
   ```

2. Add the provider to `src/agent-registry.ts:HTTP_PROVIDER_MODELS` (typed catalog) and `registerProvider()` calls in `initialize()`.

3. Add its model IDs to `data/model-matrix.json` if not auto-discovered (CLI providers need manual entries).

4. For CLI providers: add to `DEFAULT_CLI_PROVIDERS` with a `healthCheck` pointing at `scripts/cli-health-probe.sh <agent-id>`.

5. Restart and verify `/health` includes it; `/v05/intel/quota` shows `health=100`.

### 3.4 Rolling back

```bash
# Restore last good config
cp /tmp/v04_config.json.bak /root/.openclaw/workspace/gateswarm-moma-router/v04_config.json
cp /tmp/agent-registry.json.bak /root/.openclaw/workspace/gateswarm-moma-router/data/agent-registry.json
cp /tmp/provider-quota.json.bak /root/.openclaw/workspace/gateswarm-moma-router/data/provider-quota.json
systemctl restart moa-gateway
```

For source-code rollbacks: `git log --oneline -10 && git checkout <hash> -- <files> && npm run build && systemctl restart moa-gateway`.

---

## 4. Analysis

### 4.1 Reading the ensemble breakdown

The intent engine combines 3 signals:
- **heuristic (0.55)** — keyword/regex classifier (`src/classifiers/heuristic-linear.ts`)
- **ragSignal (0.25)** — context similarity (`src/intent-engine-v04.ts:60`)
- **historyBias (0.20)** — recent decisions in the session

The `cascade` weight is `0` by default (self-eval LLM judge is the alternative path; 10% sampling).

To see what the heuristic thinks of a prompt, run the classifier directly:
```bash
# (Requires running the TS source — easiest via the gateway's /v05 endpoint)
curl -sS http://localhost:8900/v05/intel/quota | python3 -m json.tool | head -30
```

### 4.2 Token economy

```bash
# Last 24h of token usage + cost
journalctl -u moa-gateway --since "24 hours ago" --no-pager | grep -oE "in=[0-9]+ out=[0-9]+|tok=[0-9]+" | sort | uniq -c | sort -rn | head
```

Or via the API:
```bash
curl -sS http://localhost:8900/v05/intel/consumption | python3 -m json.tool | head -50
```

### 4.3 Provider reputation

The router scores each provider by:
- success rate (`recordSuccess` / total)
- avg latency (`avgLatencyMs`)
- health score (see §2.3)
- PROVIDER_REPUTATION constant in `src/consumption-intelligence.ts:600`

To see live scores, check `/v05/intel/quota` and `/v05/intel/balance`:
```bash
curl -sS http://localhost:8900/v05/intel/balance | python3 -m json.tool
```

### 4.4 Retraining & feedback

Every 500 interactions (configurable via `v04_config.json:feedback_loop.retrainFrequency`), the router runs a self-retraining pass using the feedback store. You can trigger it manually:

```bash
gateswarm retrain
# or via the HTTP API:
curl -sS -X POST http://localhost:8900/v04/training/retrain
```

To inspect what gold labels have been collected:
```bash
gateswarm training labels default
```

### 4.5 When to look at what

| You want to know... | Look at |
|---|---|
| Is the service up? | `systemctl status moa-gateway` |
| What tier was my last prompt? | `curl /v05/intel/last-decision` |
| What tier is configured for X? | `gateswarm models` (CLI) or read `v04_config.json:tier_models` |
| Why did I get a wrong-tier answer? | `journalctl -u moa-gateway \| grep "Score.*→"` for that timestamp |
| Is a provider failing? | `curl /v05/intel/quota` — health < 80 or throttled=true |
| How much did I spend? | `curl /v05/intel/consumption` |
| What's the RAG index look like? | `cat /root/.openclaw/workspace/gateswarm-moma-router/data/rag/index.json \| python3 -m json.tool \| less` |
| How is the model matrix indexed? | `curl /v05/intel/models?limit=20` or read `data/model-matrix.json` |
| What's the CLI TUI version? | `head -2 /root/.openclaw/workspace/gateswarm-moma-router/cli/src/components/TiersMatrix.tsx` |

---

## 5. Versioning

### 5.1 Version semantics

We use **`<major>.<minor>.<patch>-<tag>`** semver:

- **major** — Breaking changes to `v04_config.json` schema, API endpoints, or CLI commands. Requires migration script.
- **minor** — New features: new tier, new provider, new endpoint. Backward-compatible.
- **patch** — Bug fixes, performance, RAG/health scoring tweaks. Always safe to upgrade.
- **tag** — Free-form. Examples we've used: `routing-fix`, `cli-providers`, `health-aware`.

The canonical version is in `package.json` (root). The `v04_config.json:version` field mirrors it with the `v` prefix and optional tag.

### 5.2 Files that must stay in sync

When you bump the version, update **all of these** in one commit:

```
1. /root/.openclaw/workspace/gateswarm-moma-router/package.json          "version": "0.5.x"
2. /root/.openclaw/workspace/gateswarm-moma-router/cli/package.json       "version": "0.5.x"
3. /root/.openclaw/workspace/gateswarm-moma-router/v04_config.json       "version": "v0.5.x-..."
4. /root/.openclaw/workspace/gateswarm-moma-router/src/moma-gateway.ts   `router: 'GateSwarm MoMA Router v0.5.x ...'`
5. /root/.openclaw/workspace/gateswarm-moma-router/src/gateswarm-cli.ts  "GateSwarm MoMA Router v0.5.x — ..."
6. /root/.openclaw/workspace/gateswarm-moma-router/cli/src/**/*.tsx      "GateSwarm v0.5.x — ..." (any file header)
7. /usr/local/bin/gateswarm                                              "GateSwarm MoMA Router v0.5.x — CLI wrapper"
8. /etc/systemd/system/moa-gateway.service                               Description="... v0.5.x - ..."
9. /root/.pi/agent/models.json                                           gateswarm model name + llmJudge
10. /root/.openclaw/workspace/MEMORY.md                                  durable decision log
11. /root/.openclaw/workspace/memory/YYYY-MM-DD.md                       session log
```

**Helper:** use `grep -rln "v0\.5\." src/ cli/src/ cli/package.json package.json v04_config.json` to find every place that needs a bump.

### 5.3 When the CLI TUI and the gateway are out of sync

Symptoms: the TUI shows `v0.5.4` but `curl /health` shows `v0.5.6`. Cause: rebuilt the gateway but not the CLI, or vice versa.

```bash
# 1. Check both versions
grep '"version"' /root/.openclaw/workspace/gateswarm-moma-router/package.json
grep '"version"' /root/.openclaw/workspace/gateswarm-moma-router/cli/package.json
head -2 /root/.openclaw/workspace/gateswarm-moma-router/cli/src/components/TiersMatrix.tsx | head -1

# 2. If CLI dist is older than CLI src, rebuild
cd /root/.openclaw/workspace/gateswarm-moma-router/cli
npx tsc

# 3. If gateway is older than source, restart it
systemctl restart moa-gateway
```

### 5.4 The version-sync checklist (run before any release)

```bash
cd /root/.openclaw/workspace/gateswarm-moma-router

echo "=== Files claiming each version ==="
for f in package.json cli/package.json v04_config.json src/moma-gateway.ts src/gateswarm-cli.ts /usr/local/bin/gateswarm /etc/systemd/system/moa-gateway.service; do
  v=$(grep -hoE 'v?0\.5\.[0-9]+(-[a-z0-9-]+)?' "$f" 2>/dev/null | head -1)
  echo "  $v   $f"
done

echo ""
echo "=== Service reports ==="
curl -sS http://localhost:8900/health | python3 -c "import sys,json; print('  router:', json.load(sys.stdin)['router'])"

echo ""
echo "=== CLI wrapper reports ==="
head -2 /usr/local/bin/gateswarm

echo ""
echo "=== systemd Description ==="
grep Description /etc/systemd/system/moa-gateway.service
```

All five must show the same version. If they don't, the version bump is incomplete.

---

## 6. CLI ↔ Gateway sync

The CLI TUI (`gateswarm-bar`) and the gateway (`moma-gateway`) are **two separate processes** with **separate version strings**. They share the `v04_config.json` via the live `/v05/intel/*` HTTP endpoints.

- **Gateway** is the source of truth for routing decisions. Version is in `package.json` + `v04_config.json` + `/health` response.
- **CLI TUI** reads the gateway via HTTP and renders it. Version is in `cli/package.json` + file headers.
- **Pi** config (`~/.pi/agent/`) is a **third** layer that points at the gateway but has its own provider-name display.

**When you change `v04_config.json`:** the gateway picks it up on next request (no restart needed for tier_models). The CLI needs to refresh — it polls `/v05/intel` every few seconds when running.

**When you change the gateway's `package.json` version:** the CLI doesn't auto-detect this. You must rebuild CLI dist + bump `cli/package.json` to match, or the TUI's version banner will lie.

**When you change Pi's `defaultProvider`:** you must restart Pi entirely. The TUI caches this at startup.

**When you add a new endpoint to the gateway:** add it to `cli/src/types.ts` and the relevant `cli/src/api.ts` fetch helper, otherwise the TUI can't display it.

---

## 7. Emergency procedures

### Service is dead

```bash
systemctl status moa-gateway --no-pager  # check why
journalctl -u moa-gateway --since "5 min ago" --no-pager | tail -30  # read crash
# Most common: unhandled promise rejection in a new code path
# Recovery:
systemctl restart moa-gateway
sleep 5
curl -sS http://localhost:8900/health
```

### All providers failing simultaneously

1. `curl -sS https://coding-intl.dashscope.aliyuncs.com/v1/models` (bailian)
2. `curl -sS https://api.z.ai/api/coding/paas/v4/models` (zai)
3. `curl -sS https://ollama.com/v1/models` (ollama-cloud)

If all return errors → upstream outage, no router-side fix possible.

If only the router can't reach them → check `iptables -L -n | grep 8900` and `curl -v http://localhost:8900/health` for binding issues.

### Codex CLI auth expired

```bash
# 1. Check the auth state
cat ~/.codex/auth.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('  mode:', d.get('auth_mode')); print('  has access_token:', bool(d.get('access_token'))); print('  has refresh_token:', bool(d.get('refresh_token'))); print('  expires_at:', d.get('expires_at', 'unknown'))"

# 2. If expired, re-authenticate interactively
codex login  # or: codex login --device-code

# 3. Verify
echo "Reply with just the word pong" | codex exec - --model gpt-5.4

# 4. Re-probe via the router
curl -sS http://localhost:8900/v05/intel/rediscover -X POST
```

### User-facing: "I changed a key, now requests fail with 401"

Most likely cause: a provider's health hasn't been re-probed. Force a rediscover:

```bash
systemctl restart moa-gateway  # re-probes all providers on startup
# OR
curl -sS -X POST http://localhost:8900/v05/intel/rediscover
```

---

## 8. Reference: all live endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `/health` | GET | Service status, router version, llmJudge, providers list |
| `/v1/chat/completions` | POST | OpenAI-compatible chat completions (the main API) |
| `/v1/agents` | GET | List configured agents |
| `/metrics` | GET | Prometheus-format metrics |
| `/v04/training` | GET | Training mode status |
| `/v05/intel` | GET | Full intel report: stats, recommendations, recentDecisions |
| `/v05/intel/last-decision` | GET | The most recent request decision (filtered, no health-checks) |
| `/v05/intel/quota` | GET | Per-provider health, RPM/RPD, throttling state |
| `/v05/intel/consumption` | GET | Token usage, costs, tier distribution |
| `/v05/intel/balance` | GET | Load-balancer state and provider reputation scores |
| `/v05/intel/models` | GET | All indexed models (408 currently) |
| `/v05/intel/rediscover` | POST | Force re-probe of all providers |
| `/v05/cli` | GET | CLI provider status (codex-cli, claude-cli, etc.) |

---

## 9. Open items / follow-ups

These are the known next actions. Update this list as items close.

- [ ] **Rotate Bailian API key** (user blocker) — once rotated, restore `bailian/qwen3.5-plus` as moderate primary in `v04_config.json` and clear the empty `BAILIAN_KEY=*** in `.env`
- [ ] **Wait for OpenCodeGo quota reset** (14 days from 2026-06-20) — restore `opencodego/qwen3.7-plus` and `opencodego/qwen3.7-max` as heavy/intensive fallbacks
- [ ] **Wire `v05/intel/balance` into CLI TUI** — add a "Load Balancer" panel
- [ ] **Add an `agent-registry.json` schema validator** — currently we trust the JSON shape
- [ ] **Periodic self-test cron** — every 6h, send a test prompt to each tier and alert if any fails
- [ ] **Migrate the `v0.5.1-cli-providers` old version string** still in the v04-config source (default 0.5.1) — harmless but stale

---

*This document is regenerated whenever the routing topology, version scheme, or ops procedure changes. Last full update: 2026-06-20 by Jack (gateswarm-routing-fix).*
