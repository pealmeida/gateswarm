# Integration Guide

How to integrate GateSwarm MoA Router with your LLM gateway, agent framework, or coding tool.

---

## Quick Integration Patterns

### Pattern 1: Sidecar API (Recommended)

Run the router as a standalone HTTP service alongside your gateway:

```bash
# Start the router API
python router.py --serve --port 8080

# Score any prompt via HTTP
curl -s -X POST http://localhost:8080/score \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a REST API in Python"}' | jq .
```

Use the `model` and `provider` fields from the response to route your actual LLM call.

### Pattern 2: Library Import

```python
import sys
sys.path.insert(0, "/path/to/gateswarm-moa-router")

from router import score_prompt, set_tier_models

result = score_prompt("Your prompt here")
print(result["model"], result["provider"], result["tier"])
```

### Pattern 3: CLI Pipe

```bash
MODEL=$(python /path/to/router.py "$PROMPT" --json | jq -r '.model')
your_llm_client --model "$MODEL" --prompt "$PROMPT"
```

---

## Platform-Specific Integrations

### Any LLM Agent

GateSwarm works as a scoring sidecar or embedded skill:

```bash
# Option A: Sidecar
python router.py --serve --port 8080
# Then call from a skill: curl http://localhost:8080/score
```

```python
# Option B: Embedded in a skill
import sys; sys.path.insert(0, "/path/to/gateswarm-moa-router")
from router import score_prompt, set_tier_models

# Override models for your providers
set_tier_models({
    "trivial":   {"model": "glm-4.5-air",   "provider": "zai",     "max_tokens": 256},
    "light":     {"model": "glm-4.7-flash",  "provider": "zai",     "max_tokens": 512},
    "moderate":  {"model": "glm-4.7",        "provider": "zai",     "max_tokens": 1024},
    "heavy":     {"model": "glm-5.1",        "provider": "zai",     "max_tokens": 2048},
    "intensive": {"model": "qwen3.6-plus",   "provider": "bailian", "max_tokens": 4096},
    "extreme":   {"model": "qwen3.6-plus",   "provider": "bailian", "max_tokens": 8192},
})
```

### Pi Agent

Use GateSwarm as a pre-routing layer before model selection:

```python
# ~/.pi/agent/skills/router_skill.py
from gateswarm.router import score_prompt

def before_model_call(prompt: str, default_model: str) -> str:
    """Select model based on prompt complexity."""
    result = score_prompt(prompt)
    if result["confidence"] > 0.7:
        return result["model"]
    return default_model  # Fall back to Pi's default
```

### Self-Improving Agent

Use for model selection in self-improvement and skill creation loops:

```python
feedback integration/feedback integration
import sys
sys.path.insert(0, "/path/to/gateswarm-moa-router")
from router import score_prompt

def select_model_for_task(task_description: str) -> str:
    result = score_prompt(task_description)
    return result["model"]
```

### OpenCode / Codex

Pre-route prompts before invoking your coding agent:

```bash
TIER=$(python /path/to/router.py "$PROMPT" --json | jq -r .tier)

case $TIER in
  trivial|light)   MODEL="opencode/minimax-m2.5-free" ;;
  moderate|heavy)  MODEL="opencode/kimi-k2.5-free" ;;
  intensive)       MODEL="zai/glm-5.1" ;;
  extreme)         MODEL="claude-opus-4-6" ;;
esac

opencode --model "$MODEL" --prompt "$PROMPT"
```

### LangChain

```python
from router import score_prompt
from langchain.chat_models import init_chat_model

result = score_prompt(user_input)
model = init_chat_model(result["model"], model_provider=result["provider"])
response = model.invoke([("user", user_input)])
```

### LiteLLM

```python
from router import score_prompt
import litellm

result = score_prompt(user_input)
response = litellm.completion(
    model=f"{result['provider']}/{result['model']}",
    messages=[{"role": "user", "content": user_input}],
    max_tokens=result["max_tokens"],
)
```

### Docker Compose

```yaml
version: "3.8"
services:
  router:
    build:
      context: .
      dockerfile: Dockerfile.inference
    ports:
      - "8080:8080"
    command: python router.py --serve --port 8080

  app:
    build: .
    environment:
      - ROUTER_URL=http://router:8080
    depends_on:
      - router
```

---

## Model Recommendations

### Cloud API Models (by tier)

| Tier | Cost-Optimized | Balanced | Premium |
|------|----------------|----------|---------|
| **trivial** | `glm-4.5-air` (ZAI, FREE) | `gpt-4o-mini` (OpenAI) | `gemini-3-flash` (Google) |
| **light** | `glm-4.7-flash` (ZAI, $0.02/M) | `gpt-4o-mini` (OpenAI) | `gemini-3-flash` (Google) |
| **moderate** | `glm-4.7` (ZAI, $0.10/M) | `qwen3.5-9b` (OpenRouter) | `gpt-4o` (OpenAI) |
| **heavy** | `glm-5.1` (ZAI, $0.13/M) | `qwen3.6-plus` (Bailian) | `claude-sonnet-4.6` (Anthropic) |
| **intensive** | `qwen3.6-plus` (Bailian) | `claude-sonnet-4.6` (Anthropic) | `gpt-5.5` (OpenAI) |
| **extreme** | `qwen3.6-plus` (Bailian) | `claude-opus-4.6` (Anthropic) | `gpt-5.5` (OpenAI) |

### Local Models (Ollama / vLLM / llama.cpp)

| Tier | Fast (4-bit quant) | Balanced (8-bit) | Best (FP16) |
|------|-------------------|-------------------|-------------|
| **trivial** | `qwen3-0.6b` | `phi-4-mini` | `qwen3-1.7b` |
| **light** | `qwen3-1.7b` | `gemma-3-4b` | `llama-4-scout-17b` |
| **moderate** | `qwen3-4b` | `llama-4-scout-17b` | `qwen3-8b` |
| **heavy** | `qwen3-8b` | `llama-4-maverick-17b` | `deepseek-r1-14b` |
| **intensive** | `deepseek-r1-14b` | `qwen3-14b` | `qwen3-32b` |
| **extreme** | `qwen3-32b` | `deepseek-r1-32b` | `qwen3-72b` |

### Choosing Your Stack

- **Budget-first:** Use the "Cost-Optimized" cloud column for trivial–heavy, local models for intensive–extreme
- **Quality-first:** Use the "Premium" cloud column with the router to avoid wasting Opus on trivial prompts
- **Air-gapped / privacy:** Use local models exclusively — the router itself requires no network calls
- **Hybrid (recommended):** Cloud for trivial–moderate (cheapest), local for heavy–extreme (most private)

Override defaults with `set_tier_models()` to match your setup.

---

## Advanced: Confidence-Based Routing

For smarter routing, use the confidence score to decide when to escalate:

```python
from router import score_prompt

def smart_route(prompt: str) -> str:
    result = score_prompt(prompt)

    # High confidence → trust the tier
    if result["confidence"] > 0.8:
        return result["model"]

    # Low confidence → escalate to next tier
    tier_order = ["trivial", "light", "moderate", "heavy", "intensive", "extreme"]
    idx = tier_order.index(result["tier"])
    safe_idx = min(idx + 1, len(tier_order) - 1)
    safe_tier = tier_order[safe_idx]

    # Return the model for the escalated tier
    from router import TIER_MODELS
    return TIER_MODELS[safe_tier]["model"]
```

---

## Advanced: Fallback Escalation

Start cheap, escalate only if the response is inadequate:

```python
from router import score_prompt

def escalate_route(prompt: str) -> str:
    result = score_prompt(prompt)
    model = result["model"]

    # Try the recommended model first
    response = call_your_llm(model, prompt)

    # If response quality is low, escalate to next tier
    if response_quality(response, prompt) < 0.7:
        next_model = get_model_for_next_tier(result["tier"])
        response = call_your_llm(next_model, prompt)

    return response
```
