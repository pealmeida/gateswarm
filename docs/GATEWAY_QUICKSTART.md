# GateSwarm MoA Router v0.4.4 — Quick Start

**Version:** 0.4.4-context-aware
**Date:** 2026-05-14

---

## 1. Prerequisites

- Node.js 18+
- Bailian Coding Plan API key (`sk-sp-xxxxx`)
- Z.AI GLM API key

---

## 2. Setup

### 2.1 Environment Variables

Create `.env` in the project root:

```bash
BAILIAN_KEY=sk-sp-xxxxx
GLM_API_KEY=xxxxx
BAILIAN_BASE=https://coding-intl.dashscope.aliyuncs.com/v1
ZAI_BASE=https://api.z.ai/api/coding/paas/v4
```

### 2.2 Install Dependencies

```bash
cd gateswarm-moa-router
npm install
```

### 2.3 Start the Gateway

```bash
# Direct start
npx tsx src/moa-gateway.ts --port 8900

# Or use the auto-restart script
./scripts/start-gateway.sh --port 8900
```

### 2.4 Verify

```bash
curl -s http://localhost:8900/health | python3 -m json.tool
```

Expected output:
```json
{
  "status": "healthy",
  "router": "GateSwarm MoA Router v0.4.4",
  "turboquant": "v3.6 (structure-aware + dynamic KV + RAG + CWM)",
  "ensemble": "enabled",
  "feedback": "enabled"
}
```

---

## 3. Connect an Agent

### 3.1 Pi Agent

Edit `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "moa": {
      "baseUrl": "http://localhost:8900/v1",
      "apiKey": "moa-<your-agent-key>",
      "authHeader": true,
      "api": "openai-completions",
      "models": [{
        "id": "gateswarm",
        "name": "GateSwarm MoA v0.4.4"
      }]
    }
  }
}
```

Edit `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "moa",
  "defaultModel": "gateswarm"
}
```

### 3.2 External Client

Add to `openclaw.json`:

```json
{
  "providers": {
    "moa": {
      "baseUrl": "http://localhost:8900/v1",
      "apiKey": "moa-<your-agent-key>",
      "auth": "api-key",
      "api": "openai-completions",
      "models": [...]
    }
  }
}
```

### 3.3 Test

```bash
pi -p --provider moa --model gateswarm --no-session "Say hello"
```

---

## 4. CLI Commands

```bash
# Show status
npx tsx src/gateswarm-cli.ts status

# List tier models
npx tsx src/gateswarm-cli.ts models

# Set model for tier
npx tsx src/gateswarm-cli.ts model intensive qwen3.6-plus bailian

# Toggle reasoning
npx tsx src/gateswarm-cli.ts reasoning extreme on

# Set retrain frequency
npx tsx src/gateswarm-cli.ts retrain-freq 200

# Set ensemble weights
npx tsx src/gateswarm-cli.ts weights heuristic 0.55

# View feedback stats
npx tsx src/gateswarm-cli.ts feedback

# View RAG stats
npx tsx src/gateswarm-cli.ts rag

# Trigger retraining
npx tsx src/gateswarm-cli.ts retrain
```

---

## 5. Management Endpoints

```bash
# System status
curl http://localhost:8900/v04/status

# Feedback buffer
curl http://localhost:8900/v04/feedback

# Training stats
curl "http://localhost:8900/v04/training?agentId=jack"

# Enable training mode
curl -X POST http://localhost:8900/v04/training/enable \
  -H "Content-Type: application/json" \
  -d '{"agentId":"jack","enabled":true}'

# Manual retraining
curl -X POST http://localhost:8900/v04/retrain

# List agents
curl http://localhost:8900/v1/agents

# Per-agent metrics
curl http://localhost:8900/metrics/jack
```

---

## 6. Monitor

```bash
# Live logs
tail -f logs/gateway.log

# Score and routing
grep "Score:" logs/gateway.log | tail -20

# Compression stats
grep "TurboQuant" logs/gateway.log | tail -10

# RAG retrieval
grep "RAG injected" logs/gateway.log | tail -10

# Model switches
grep "Model switch" logs/gateway.log | tail -10

# Errors
grep "Provider error\|Forward error\|timed out" logs/gateway.log | tail -10
```

---

## 7. Troubleshooting

### Gateway won't start

```bash
# Check if port is in use
lsof -i:8900

# Kill existing process
kill -9 $(lsof -t -i:8900)

# Clear tsx cache
rm -rf /tmp/tsx-0/

# Restart
npx tsx src/moa-gateway.ts --port 8900
```

### Provider errors

```bash
# Check API keys
cat .env | grep -v "sk-\|GLM"

# Verify endpoints
curl -s https://coding-intl.dashscope.aliyuncs.com/v1/models \
  -H "Authorization: Bearer $BAILIAN_KEY" | head -5

curl -s https://api.z.ai/api/coding/paas/v4/models \
  -H "Authorization: Bearer $GLM_API_KEY" | head -5
```

### TypeScript errors

```bash
npx tsc --noEmit
```

### Persistence not working

```bash
# Check directories exist
ls -la data/rag/ data/feedback/ data/training/

# Check files are being written
stat data/rag/index.json
stat data/feedback/entries.json
```
