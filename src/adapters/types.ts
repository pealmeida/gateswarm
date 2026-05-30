/**
 * Model Adapter Types — Unified interface for local, cloud API, and CLI models
 */

// ─── Execution Backend ─────────────────────────────────

export type ExecutionBackend = 'webgpu' | 'webnn' | 'wasm' | 'cloud-api' | 'cloud-cli';

export interface AdapterConfig {
  id: string;
  backend: ExecutionBackend;
  modelId: string;
  displayName: string;
  maxTokens: number;
  supportsStreaming: boolean;
  costPer1kTokens: number; // in cents
}

// ─── Unified Generate Request/Response ─────────────────

export interface GenerateRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface GenerateChunk {
  token: string;
  done: boolean;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
  backend: ExecutionBackend;
  modelId: string;
  fromCache: boolean;
}

// ─── Model Adapter Interface ───────────────────────────

export interface ModelAdapter {
  readonly id: string;
  readonly backend: ExecutionBackend;
  readonly modelId: string;
  readonly isAvailable: boolean;

  initialize(): Promise<void>;
  generate(request: GenerateRequest): AsyncGenerator<GenerateChunk>;
  dispose(): Promise<void>;
}

// ─── Adapter Registry ──────────────────────────────────

export interface AdapterEntry {
  adapter: ModelAdapter;
  config: AdapterConfig;
  loaded: boolean;
  lastUsed: number;
  totalRequests: number;
  totalTokens: number;
  totalErrors: number;
  avgLatencyMs: number;
}
