# ARCHITECTURE.md — System Architecture & Design

## MoMA Gateway Router: Browser-Native Mixture of Agents

**Version:** 1.0.0-mvp  
**Date:** 2026-05-05

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser Client                       │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌────────────────────┐  │
│  │  Intent   │──▶│  Model   │──▶│   Execution Layer  │  │
│  │  Engine   │   │  Router  │   │                    │  │
│  │ (DeBERTa) │   │          │   │  ┌──────────────┐  │  │
│  └──────────┘   └──────────┘   │  │ Local Worker  │  │  │
│       │              │         │  │ (WebGPU/WNN)  │  │  │
│       │              │         │  └──────────────┘  │  │
│       │              │         │  ┌──────────────┐  │  │
│       │              │         │  │  Gatekeeper   │  │  │
│       │              │         │  │  (Qwen 0.5B)  │  │  │
│       │              │         │  └──────────────┘  │  │
│       │              │         └────────────────────┘  │
│       │              │                                   │
│       │              │         ┌────────────────────┐   │
│       │              └────────▶│  Cloud Fallback    │   │
│       │                        │  (Vercel Edge)     │   │
│       │                        └────────────────────┘   │
│       │                                                  │
│  ┌────┴─────────────────────────────────────────────┐   │
│  │              Platform Abstraction Layer            │   │
│  │  WebGPU │ WebNN │ WASM │ Device Detection │ Cache │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 2. Core Components

### 2.1 Intent Engine

**Purpose:** Evaluate prompt complexity on a 0–1 scale using a trained regressor.

**Model:** `DeBERTa-v3-base-PromptComplexityEstimator` (q4 quantized, ~80MB)

```
Input:  user prompt (string)
Output: complexity score (float 0.0 – 1.0)
Latency target: < 50ms
```

**How it works:**
1. Tokenize input via DeBERTa tokenizer (cached in IndexedDB)
2. Forward pass through ONNX Runtime (WebGPU > WASM)
3. Sigmoid output → complexity score

**Fallback:** If DeBERTa fails to load or times out:
- Use heuristic scoring: `f(length, special_tokens, question_words, code_patterns)`
- Log degradation event for analytics

### 2.2 Model Router

**Purpose:** Map complexity scores to execution tiers with device-aware adjustments.

```
Complexity Score    →    Tier Selection
─────────────────────────────────────────
  0.0 ─ 0.3        →    Tier 1: Local Direct
  0.3 ─ 0.6        →    Tier 2: Gatekeeper (Qwen 0.5B)
  0.6 ─ 1.0        →    Tier 3: Cloud Fallback
```

**Device-aware adjustments:**
| Device Profile | Tier 1 Limit | Tier 2 Limit | Notes |
|---------------|-------------|-------------|-------|
| Desktop (WebGPU, ≥8GB) | 0.3 | 0.6 | Full pipeline |
| Mobile (WebGPU, ≥4GB) | 0.25 | 0.5 | Tighter thresholds |
| Mobile (WASM only) | 0.15 | 0.35 | Conservative; prefer cloud |
| Low-end (no WebGPU) | 0.1 | 0.2 | Almost everything to cloud |

**Router decision flow:**
```
route(score, deviceProfile):
  if score <= deviceProfile.tier1Limit:
    return LOCAL_DIRECT
  elif score <= deviceProfile.tier2Limit:
    return GATEKEEPER
  else:
    return CLOUD_FALLBACK
```

### 2.3 Execution Layer

#### Tier 1: Local Direct
- **Model:** TinyLlama-1.1B-q4 (~600MB mobile) or Llama-3.2-3B-q4 (~1.8GB desktop)
- **Backend:** WebGPU (preferred) → WebNN → WASM
- **Use cases:** Simple Q&A, greetings, factual lookups, rephrasing
- **Streaming:** Token-by-token via generator pattern

#### Tier 2: Gatekeeper
- **Model:** Qwen2.5-0.5B-q4 (~300MB)
- **Purpose:** Handle moderate prompts that don't need full cloud reasoning
- **Decision:** Gatekeeper evaluates if it can confidently answer; if not, escalates to cloud
- **Confidence threshold:** 0.7 (configurable)

#### Tier 3: Cloud Fallback
- **Endpoint:** Vercel Edge Function (thin proxy)
- **Providers:** OpenAI, Anthropic, or any OpenAI-compatible API
- **Purpose:** Complex reasoning, code generation, long-form writing
- **Streaming:** SSE (Server-Sent Events) for real-time token delivery

### 2.4 Platform Abstraction Layer (PAL)

**Backend detection cascade:**
```
1. Check navigator.gpu (WebGPU)
2. Check navigator.ml (WebNN / Neural Network API)
3. Fallback to WASM (always available)
4. Memory check: performance.memory or deviceMemory estimate
5. Select optimal models based on detected capabilities
```

**Device profiles:**
```typescript
interface DeviceProfile {
  backend: 'webgpu' | 'webnn' | 'wasm';
  memoryGB: number;
  isMobile: boolean;
  cores: number;
  tier1Limit: number;
  tier2Limit: number;
  recommendedModels: {
    worker: string;     // model ID for local worker
    gatekeeper: string; // model ID for gatekeeper
  };
}
```

## 3. Data Flow

### 3.1 Happy Path (Simple Query)

```
User types: "What is 2+2?"
    │
    ▼
Intent Engine: score = 0.12 (simple)
    │
    ▼
Router: Tier 1 → Local Direct
    │
    ▼
Local Worker (TinyLlama): "2 + 2 = 4"
    │
    ▼
Response to user (total: ~300ms)
```

### 3.2 Moderate Query (Gatekeeper)

```
User types: "Summarize this 500-word article about climate change"
    │
    ▼
Intent Engine: score = 0.45 (moderate)
    │
    ▼
Router: Tier 2 → Gatekeeper
    │
    ▼
Qwen 0.5B evaluates:
  - Can answer confidently? → YES → Generate summary locally
  - Not confident? → ESCALATE → Cloud Fallback
    │
    ▼
Response to user
```

### 3.3 Complex Query (Cloud)

```
User types: "Write a Python microservice with FastAPI, auth, and tests"
    │
    ▼
Intent Engine: score = 0.82 (complex)
    │
    ▼
Router: Tier 3 → Cloud Fallback
    │
    ▼
Vercel Edge Function → OpenAI/Anthropic API
    │
    ▼
Stream response back to user
```

## 4. Model Inventory

| Model | Size (q4) | Role | Backend | Download Trigger |
|-------|-----------|------|---------|-----------------|
| DeBERTa-v3-q4 | ~80MB | Intent scoring | WebGPU/WASM | First page load |
| Qwen2.5-0.5B-q4 | ~300MB | Gatekeeper | WebGPU/WASM | First moderate query |
| TinyLlama-1.1B-q4 | ~600MB | Mobile worker | WebGPU/WebNN | First local query (mobile) |
| Llama-3.2-3B-q4 | ~1.8GB | Desktop worker | WebGPU | First local query (desktop) |

**Progressive loading strategy:**
1. DeBERTa loads immediately (small, always needed)
2. Worker model loads lazily on first local query
3. Gatekeeper loads lazily on first moderate query
4. All models cached in IndexedDB after first download

## 5. Offline Strategy

```
┌─────────────────────────────────┐
│       Service Worker             │
│                                  │
│  Cache Strategy:                 │
│  ├── App shell → Cache First    │
│  ├── Model files → Cache Only   │
│  └── API calls → Network First  │
│       └── Fallback: cached      │
│           responses             │
├─────────────────────────────────┤
│       IndexedDB                  │
│                                  │
│  ├── models/                     │
│  │   ├── deberta-v3-q4.onnx     │
│  │   ├── qwen-0.5b-q4/          │
│  │   ├── tinyllama-1.1b-q4/     │
│  │   └── llama-3.2-3b-q4/       │
│  ├── responses/ (LRU cache)     │
│  └── config/ (thresholds, etc.) │
└─────────────────────────────────┘
```

## 6. Vercel Edge Proxy Architecture

```
Client Browser
    │
    │  POST /api/inference
    │  { prompt, model, stream: true }
    │
    ▼
Vercel Edge Function
    ├── Validate request (rate limiting, CORS)
    ├── Inject API key from env (never exposed to client)
    ├── Forward to provider API (OpenAI / Anthropic)
    └── Stream response back (SSE)
    
Edge Function is STATELESS — no session, no DB, no inference.
```

## 7. Error Handling & Degradation

```
Error Cascade:
1. WebGPU fails → Try WebNN
2. WebNN fails → Try WASM
3. WASM model OOM → Unload larger models, keep intent engine
4. All local fails → Cloud fallback
5. Cloud fails → Return cached response if available
6. Nothing works → Show user-friendly error with retry option
```

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| DeBERTa over prompted SLM for intent | Trained regressor is more reliable than few-shot prompting a 0.5B model |
| ONNX + WebGPU over raw WebGPU | Ecosystem maturity, model compatibility, Transformers.js integration |
| Progressive loading over preload | Don't block UX for models user may never need |
| Cloud as fallback, not default | Cost optimization; privacy; latency |
| Edge proxy over direct API calls | API key security; CORS; rate limiting |
| IndexedDB over OPFS for models | Broader browser support; simpler API |

## 9. Security Model

- **API keys:** Never stored client-side; only in Vercel environment variables
- **Model integrity:** SHA-256 hash verification on download
- **Prompt sanitization:** Basic input validation before routing
- **Rate limiting:** Edge proxy enforces per-IP rate limits
- **No persistent logging:** Responses not stored server-side

## 10. Performance Budget

| Component | Target | Measurement |
|-----------|--------|-------------|
| Intent Engine inference | < 50ms | DeBERTa forward pass |
| Model load (cached) | < 2s | IndexedDB → GPU upload |
| Model load (cold) | < 30s | Network download + cache |
| First token (local) | < 500ms | Including routing overhead |
| First token (cloud) | < 1.5s | Including proxy hop |
| Total JS bundle | < 500KB | Gzipped, excluding models |
| Memory usage (mobile) | < 2GB | All loaded models |
| Memory usage (desktop) | < 4GB | All loaded models |
