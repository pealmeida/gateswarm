/**
 * Adapters — Unified exports for all execution backends.
 *
 * v0.5.0: Added CLI Provider Adapter for subprocess-dispatched CLI agents
 * (Claude Code, Codex, Pi, Hermes, OpenClaw).
 *
 * Usage:
 *   import { OllamaAdapter, LocalAdapter, CloudApiAdapter, CliProviderAdapter } from 'moma-gateway-router/adapters';
 */
export { LocalAdapter } from './local-adapter.js';
export { CloudApiAdapter } from './cloud-api-adapter.js';
export { OllamaAdapter } from './ollama-adapter.js';
export { CliAdapter } from './cli-adapter.js';
export { CliProviderAdapter } from './cli-provider.js';
export { AdapterRegistry } from './registry.js';
export type {
  ModelAdapter, AdapterConfig, GenerateRequest, GenerateChunk,
  GenerateResult, TokenUsage, ExecutionBackend, AdapterEntry,
} from './types.js';
export type {
  CliProviderConfig, CliProviderResult, SubscriptionWindow,
  CliInputFormat, CliOutputFormat, CliQuotaType,
} from './cli-provider.js';
