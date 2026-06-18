/**
 * MoA Cross-Platform — Type Definitions
 */

// ─── Backend & Device ───────────────────────────────────

export type BackendType = 'webgpu' | 'webnn' | 'wasm';

export interface BackendInfo {
  type: BackendType;
  webgpu: boolean;
  webnn: boolean;
  wasm: true; // always available
  deviceMemory: number | null;
  isMobile: boolean;
}

export interface DeviceProfile {
  backend: BackendType;
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

// ─── Intent Engine ──────────────────────────────────────

export interface ComplexityScore {
  value: number; // 0.0 – 1.0
  method: 'ml' | 'heuristic' | 'v3.3-heuristic' | 'heuristic-fallback' | 'ensemble-v0.4';
  latencyMs: number;
  /** Predicted tier (v3.3: from heuristic score boundaries) */
  tier?: EffortLevel;
  /** LLM validation confidence (v3.3: 0.99) */
  confidence?: number;
  /** Low confidence flag */
  lowConfidence?: boolean;
  /** Classifier accuracy (v3.3: 0.99 = LLM agreement rate) */
  classifierAccuracy?: number;
}

// ─── Router ─────────────────────────────────────────────

export type Tier = 'local' | 'gatekeeper' | 'cloud';

export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export type ModelTier = 'nano' | 'small' | 'medium' | 'large' | 'cloud-light' | 'cloud-heavy';

export type DeviceProfileName = 'desktop-high' | 'desktop-mid' | 'mobile-high' | 'mobile-low' | 'lowend';

export interface RoutingDecision {
  tier: Tier;
  model: string;
  score: number;
  effort: EffortLevel;
  deviceClass: DeviceProfileName;
  estimatedLatencyMs: number;
  estimatedCostCents: number;
  qualityScore: number;
  reason: string;
  profile: DeviceProfile;
}

// ─── Gatekeeper ─────────────────────────────────────────

export interface GatekeeperResult {
  canHandle: boolean;
  confidence: number;
  response?: string;
  escalatedToCloud: boolean;
}

// ─── Generation ─────────────────────────────────────────

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface GenerationChunk {
  token: string;
  done: boolean;
}

// ─── Cloud ──────────────────────────────────────────────

export interface CloudOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

// ─── Cache ──────────────────────────────────────────────

export interface CacheEntry<T> {
  key: string;
  value: T;
  timestamp: number;
  size: number;
}

// ─── Configuration ──────────────────────────────────────

export interface MoAConfig {
  complexityThresholds?: {
    tier1: number;
    tier2: number;
  };
  cloudEndpoint?: string;
  cloudProvider?: 'openai' | 'anthropic';
  maxCacheSize?: number;
  enableStreaming?: boolean;
  onStatusChange?: (status: MoAStatus) => void;
  onError?: (error: MoAError) => void;
}

export const DEFAULT_CONFIG: Required<MoAConfig> = {
  complexityThresholds: { tier1: 0.3, tier2: 0.6 },
  cloudEndpoint: '/api/inference',
  cloudProvider: 'openai',
  maxCacheSize: 100,
  enableStreaming: true,
  onStatusChange: () => {},
  onError: () => {},
};

// ─── Status ─────────────────────────────────────────────

export interface MoAStatus {
  initialized: boolean;
  backend: BackendType;
  online: boolean;
  loadedModels: string[];
  cacheSizeBytes: number;
  memoryUsageBytes: number;
}

// ─── Errors ─────────────────────────────────────────────

export type MoAErrorCode =
  | 'INIT_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'INFERENCE_FAILED'
  | 'CLOUD_UNAVAILABLE'
  | 'OFFLINE_NO_CACHE'
  | 'MEMORY_PRESSURE'
  | 'BACKEND_UNAVAILABLE';

export interface MoAError extends Error {
  code: MoAErrorCode;
  tier?: Tier;
  recoverable: boolean;
}
