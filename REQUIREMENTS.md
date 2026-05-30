# REQUIREMENTS.md — Technical Requirements

## MoMA Gateway Router: Browser-Native Mixture of Agents

**Version:** 1.0.0-mvp  
**Date:** 2026-05-05

---

## 1. Functional Requirements

### FR-001: Prompt Complexity Scoring
- **FR-001.1:** The system SHALL evaluate prompt complexity on a continuous 0.0–1.0 scale.
- **FR-001.2:** Complexity scoring SHALL complete in < 50ms on cached models.
- **FR-001.3:** The system SHALL use a DeBERTa-v3-based regressor as the primary scoring model.
- **FR-001.4:** The system SHALL provide a heuristic fallback scorer when the ML model is unavailable.
- **FR-001.5:** The heuristic scorer SHALL consider: prompt length, code patterns, question structure, multi-sentence complexity, and keyword density.

### FR-002: Model Router
- **FR-002.1:** The router SHALL support three execution tiers: Local Direct, Gatekeeper, and Cloud Fallback.
- **FR-002.2:** Default complexity thresholds: Tier 1 (≤0.3), Tier 2 (0.3–0.6), Tier 3 (>0.6).
- **FR-002.3:** Thresholds SHALL be adjustable per device profile.
- **FR-002.4:** The router SHALL detect device capabilities and select an appropriate profile automatically.
- **FR-002.5:** The router SHALL expose the current routing decision for observability.

### FR-003: Local Model Execution
- **FR-003.1:** The system SHALL support on-device text generation via WebGPU, WebNN, and WASM backends.
- **FR-003.2:** Backend selection SHALL follow cascade: WebGPU → WebNN → WASM.
- **FR-003.3:** The system SHALL support streaming token-by-token output from local models.
- **FR-003.4:** Supported local models (MVP):
  - TinyLlama-1.1B-q4 (~600MB) — mobile worker
  - Llama-3.2-3B-q4 (~1.8GB) — desktop worker
- **FR-003.5:** Models SHALL be lazy-loaded on first use, not on page load.
- **FR-003.6:** Loaded models SHALL be cached in IndexedDB for subsequent sessions.

### FR-004: Gatekeeper
- **FR-004.1:** The gatekeeper SHALL use Qwen2.5-0.5B-q4 (~300MB) to evaluate moderate-complexity prompts.
- **FR-004.2:** The gatekeeper SHALL assess its own confidence level before generating a full response.
- **FR-004.3:** If confidence < 0.7 (configurable), the gatekeeper SHALL escalate to Cloud Fallback.
- **FR-004.4:** The gatekeeper SHALL be lazy-loaded on first moderate query.

### FR-005: Cloud Fallback
- **FR-005.1:** The system SHALL proxy complex queries through a Vercel Edge Function.
- **FR-005.2:** API keys SHALL be stored in server-side environment variables only, never exposed to the client.
- **FR-005.3:** Cloud responses SHALL be streamed via Server-Sent Events (SSE).
- **FR-005.4:** The proxy SHALL enforce rate limiting per IP address.
- **FR-005.5:** The system SHALL support OpenAI-compatible APIs as the primary cloud provider.

### FR-006: Platform Detection
- **FR-006.1:** The system SHALL detect available AI backends: WebGPU, WebNN, WASM.
- **FR-006.2:** The system SHALL estimate device memory via `navigator.deviceMemory` or `performance.memory`.
- **FR-006.3:** The system SHALL detect mobile vs desktop via user agent and screen size.
- **FR-006.4:** Detection results SHALL produce a `DeviceProfile` that informs all routing decisions.

### FR-007: Offline Support
- **FR-007.1:** The system SHALL function offline for all local-tier queries after initial model download.
- **FR-007.2:** A Service Worker SHALL cache the application shell and model files.
- **FR-007.3:** When offline, the system SHALL automatically disable cloud tier and adjust thresholds.
- **FR-007.4:** The system SHALL show a clear online/offline status indicator.

### FR-008: Model Caching
- **FR-008.1:** All downloaded models SHALL persist in IndexedDB across browser sessions.
- **FR-008.2:** The system SHALL implement LRU eviction when storage exceeds configured limits.
- **FR-008.3:** Model downloads SHALL verify integrity via SHA-256 hash.
- **FR-008.4:** The system SHALL show download progress for model loading.

### FR-009: Response Caching
- **FR-009.1:** The system SHALL cache responses for identical prompts (LRU, max 100 entries).
- **FR-009.2:** Cached responses SHALL be used for offline fallback when cloud tier is unavailable.
- **FR-009.3:** Response cache SHALL be invalidated after 24 hours.

### FR-010: Memory Management
- **FR-010.1:** The system SHALL monitor memory usage and unload models when pressure is detected.
- **FR-010.2:** Priority for unloading: Worker > Gatekeeper > Intent Engine (never unload).
- **FR-010.3:** Mobile memory limit: 2GB for all loaded models.
- **FR-010.4:** Desktop memory limit: 4GB for all loaded models.

---

## 2. Non-Functional Requirements

### NFR-001: Performance
| Metric | Target | Critical |
|--------|--------|----------|
| Intent Engine inference | < 50ms | Yes |
| Model load (cached) | < 2s | Yes |
| Model load (cold download) | < 30s (depends on network) | No |
| First token (local) | < 500ms | Yes |
| First token (cloud) | < 1.5s | Yes |
| Tokens per second (local) | > 10 tps | No |
| JS bundle size (gzipped) | < 500KB | Yes |

### NFR-002: Compatibility
| Browser | Minimum Version | Backend |
|---------|----------------|---------|
| Chrome | 113+ | WebGPU |
| Edge | 113+ | WebGPU |
| Safari | 17+ | WebNN |
| Firefox | 120+ | WASM |
| Chrome Android | 113+ | WebGPU |
| Safari iOS | 17+ | WebNN |

### NFR-003: Security
- **NFR-003.1:** API keys SHALL NOT be embedded in client-side code or bundled assets.
- **NFR-003.2:** All cloud API calls SHALL go through the Vercel Edge proxy.
- **NFR-003.3:** Model files SHALL be integrity-verified after download.
- **NFR-003.4:** User prompts SHALL NOT be logged or stored server-side.
- **NFR-003.5:** The Edge proxy SHALL enforce rate limiting (max 60 requests/minute per IP).

### NFR-004: Reliability
- **NFR-004.1:** The system SHALL degrade gracefully through the backend cascade (WebGPU → WebNN → WASM → Cloud).
- **NFR-004.2:** If all backends fail, the system SHALL display a user-friendly error with retry option.
- **NFR-004.3:** Network failures during cloud calls SHALL trigger automatic retry (max 2 retries, exponential backoff).
- **NFR-004.4:** Model loading failures SHALL fall back to the next available model or tier.

### NFR-005: Privacy
- **NFR-005.1:** User prompts SHALL NOT be transmitted to any server for local-tier queries.
- **NFR-005.2:** Cloud-tier prompts SHALL be sent only to the configured API endpoint.
- **NFR-005.3:** No analytics or telemetry SHALL include prompt content.
- **NFR-005.4:** All model inference runs entirely on-device for local tiers.

### NFR-006: Accessibility
- **NFR-006.1:** Status indicators (backend type, online/offline, loading) SHALL be accessible via ARIA.
- **NFR-006.2:** Error messages SHALL be clear and actionable.
- **NFR-006.3:** Model download progress SHALL be communicated to assistive technology.

---

## 3. Technical Constraints

### TC-001: Runtime Environment
- Must run in standard browser environment (no Node.js runtime in browser)
- No native modules; WebAssembly only
- No file system access (use IndexedDB/OPFS for storage)
- Must comply with Content Security Policy (CSP) headers

### TC-002: Model Format
- All models must be in ONNX format (for Transformers.js) or WebLLM format
- Models must be quantized to q4 (4-bit) for reasonable browser memory usage
- Model files must be served with correct MIME types and CORS headers

### TC-003: Network
- Cloud fallback requires internet connectivity
- Model downloads require internet on first use
- Subsequent uses can be fully offline (local tiers)
- Vercel Edge Functions have 30s timeout limit

### TC-004: Build & Deploy
- Vite-based build pipeline
- Static site deployment (Vercel, Netlify, Cloudflare Pages)
- Edge Functions deployed alongside static assets
- TypeScript strict mode enabled

---

## 4. API Specification

### 4.1 Public API (CrossPlatformMoMA)

```typescript
// Initialization
await moma.initialize(): Promise<InitResult>

// Process a prompt (streaming)
for await (const token of moma.process("Hello!")) {
  console.log(token);
}

// Get current status
moma.getStatus(): MoMAStatus

// Dispose (cleanup)
await moma.dispose(): Promise<void>
```

### 4.2 Configuration API

```typescript
interface MoMAConfig {
  complexityThresholds?: {
    tier1: number;  // default: 0.3
    tier2: number;  // default: 0.6
  };
  cloudEndpoint?: string;  // default: '/api/inference'
  cloudProvider?: 'openai' | 'anthropic';
  maxCacheSize?: number;   // default: 100 entries
  enableStreaming?: boolean; // default: true
  onStatusChange?: (status: MoMAStatus) => void;
  onError?: (error: MoMAError) => void;
}
```

### 4.3 Edge Proxy API

```
POST /api/inference
Content-Type: application/json

Request:
{
  "prompt": string,
  "model": string,       // e.g., "gpt-4.1-mini"
  "stream": boolean,
  "max_tokens": number   // optional
}

Response (streaming):
Content-Type: text/event-stream

data: {"token": "Hello"}
data: {"token": " world"}
data: {"done": true}
```

---

## 5. Data Models

```typescript
// Complexity scoring result
interface ComplexityScore {
  value: number;           // 0.0 – 1.0
  method: 'ml' | 'heuristic';
  latencyMs: number;
}

// Routing decision
interface RoutingDecision {
  tier: 'local' | 'gatekeeper' | 'cloud';
  model: string;
  confidence: number;
  reason: string;
}

// Device profile
interface DeviceProfile {
  backend: 'webgpu' | 'webnn' | 'wasm';
  memoryGB: number;
  isMobile: boolean;
  cores: number;
  tier1Limit: number;
  tier2Limit: number;
  recommendedModels: {
    worker: string;
    gatekeeper: string;
  };
}

// Gatekeeper result
interface GatekeeperResult {
  canHandle: boolean;
  confidence: number;
  response?: string;
  escalatedToCloud: boolean;
}

// System status
interface MoMAStatus {
  initialized: boolean;
  backend: string;
  online: boolean;
  loadedModels: string[];
  cacheSize: number;
  memoryUsage: number;
}
```

---

## 6. Testing Requirements

| Category | Coverage Target | Priority |
|----------|----------------|----------|
| Unit tests (router, scorer, cache) | > 80% | P0 |
| Integration tests (end-to-end flow) | Happy path + 3 degradation paths | P0 |
| Browser compatibility | Chrome, Safari, Firefox, Chrome Android | P1 |
| Performance benchmarks | Intent Engine < 50ms, first token < 500ms | P1 |
| Offline functionality | Full local tier operation | P1 |
| Memory profiling | No leaks, within budget | P2 |
