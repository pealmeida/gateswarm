# PRD — Product Requirements Document

## MoMA Gateway Router: Browser-Native Mixture of Agents

**Version:** 1.0.0-mvp  
**Date:** 2026-05-05  
**Status:** Planning

---

## 1. Product Vision

Enable any web application to leverage multi-model AI inference directly in the browser — zero backend compute cost, full privacy, offline-capable — with an intelligent routing layer that automatically matches prompt complexity to the optimal model tier.

## 2. Problem Statement

| Pain Point | Impact |
|------------|--------|
| Cloud AI APIs are expensive at scale | Per-token costs compound; trivial queries waste budget |
| Server-side inference adds latency | Round-trip + queue time degrades UX |
| Privacy-sensitive queries can't leave device | Healthcare, finance, personal data require on-device processing |
| Mobile devices are underutilized | Modern phones have capable GPUs but can't run large models |
| No unified routing layer | Developers manually pick models; no adaptive complexity matching |

## 3. Target Users

### Primary: Web App Developers
- Building AI-powered features (chat, search, summarization, code assist)
- Want to reduce cloud API costs
- Need offline/privacy-first capabilities

### Secondary: End Users
- Use AI features within web apps
- Expect fast, responsive experiences
- May have limited or no connectivity

## 4. User Stories

### Intent Engine
- **US-001:** As a developer, I want the system to automatically classify my prompt's complexity so I don't have to manually route queries.
- **US-002:** As a developer, I want complexity scoring to complete in <50ms so it doesn't add perceptible latency.

### Model Router
- **US-003:** As a developer, I want simple prompts (greetings, factual lookups) handled entirely on-device with zero API calls.
- **US-004:** As a developer, I want complex prompts (reasoning, code generation) to fall back to cloud APIs when the device can't handle them.
- **US-005:** As a developer, I want to configure my own complexity thresholds and model tiers.

### Local Workers
- **US-006:** As a user, I want AI responses even when offline, so I can continue working without connectivity.
- **US-007:** As a user on mobile, I want the system to use my device's GPU for faster inference.

### Cloud Fallback
- **US-008:** As a developer, I want cloud API calls to go through a thin proxy (Vercel Edge) so I don't expose API keys client-side.

### Progressive Enhancement
- **US-009:** As a user on a low-end device, I want the system to gracefully fall back to lighter models instead of crashing.
- **US-010:** As a developer, I want to know what backend is active (WebGPU/WebNN/WASM/Cloud) at runtime.

## 5. Success Metrics (MVP)

| Metric | Target |
|--------|--------|
| Intent Engine inference time | < 50ms |
| Local model load time (cached) | < 2s |
| Simple prompt local response | < 500ms |
| Cloud fallback cold start | < 3s |
| Offline functionality | ✅ Full (for local tiers) |
| Browser support | Chrome 113+, Safari 17+, Firefox 120+ |
| Mobile device support | iOS Safari 17+, Chrome Android 113+ |
| Total bundle size (core) | < 500KB gzipped (excludes models) |

## 6. Scope

### In Scope (MVP)
- Intent Engine with DeBERTa-v3-q4 complexity scoring
- 3-tier model router (local → gatekeeper → cloud)
- WebGPU backend (desktop), WebNN backend (mobile), WASM fallback
- Qwen 0.5B gatekeeper, TinyLlama 1.1B mobile worker, Llama 3.2 3B desktop worker
- Cloud API proxy via Vercel Edge Functions
- IndexedDB model caching + Service Worker offline support
- Device capability detection & adaptive tier selection

### Out of Scope (Post-MVP)
- Fine-tuning models on-device
- Multi-turn conversation memory
- Custom model training pipeline
- Server-side MoMA aggregation (Together-style)
- RAG / document indexing
- Voice/audio input

## 7. Milestones

| Phase | Deliverable | Timeline |
|-------|-------------|----------|
| P0 | Intent Engine + Router + Basic Local Worker | Day 1-6h |
| P1 | Multi-backend support (WebGPU/WebNN/WASM) | Day 1-12h |
| P2 | Cloud fallback + Vercel Edge proxy | Day 1-18h |
| P3 | Offline caching + Service Worker | Day 1-22h |
| P4 | Polish, tests, documentation | Day 1-24h |

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WebGPU not available on target browsers | Medium | High | Fallback chain: WebGPU → WebNN → WASM → Cloud |
| Model download size too large for mobile | High | Medium | Progressive loading; lazy-load tiers on demand |
| DeBERTa accuracy insufficient for routing | Low | High | Add heuristics fallback (prompt length, keyword matching) |
| Cloud API latency spikes | Medium | Medium | Retry with exponential backoff; cache common patterns |
| Memory pressure on mobile | High | High | Aggressive model unloading; LRU cache; memory monitoring |

## 9. Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| @huggingface/transformers | ^3.x | ONNX model inference |
| @anthropic-ai/sdk or openai | latest | Cloud API fallback |
| onnxruntime-web | ^1.18+ | WASM/WebGPU ONNX backend |
| @webllm/browser | latest | WebGPU LLM inference |
| idb-keyval | latest | IndexedDB wrapper |
| vite | ^6.x | Build tool |

## 10. Open Questions

1. **WebNN maturity:** Is WebNN stable enough for production use in Safari 17+? (Research suggests yes for inference-only)
2. **Gatekeeper ROI:** Does adding Qwen 0.5B as a gatekeeper actually save enough cloud calls to justify the ~300MB download?
3. **Streaming:** Should local models stream tokens or batch responses? (Streaming preferred for UX, but adds complexity)
4. **Model licensing:** Confirm ONNX-converted models comply with original licenses (Llama, Qwen, TinyLlama)
