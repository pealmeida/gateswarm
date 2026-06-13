/**
 * MoMA Cross-Platform — Type Definitions
 * MoMA = Mixture of Multimodal Agents
 *
 * v0.5.1: Clean — no IntentMode, no DataSource, no mode/effortOverride
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
  tier?: EffortLevel;
  confidence?: number;
  lowConfidence?: boolean;
  classifierAccuracy?: number;
}

// ─── Router ─────────────────────────────────────────────

export type Tier = 'local' | 'gatekeeper' | 'cloud';

export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export type IntentMode = 'plan' | 'act' | 'auto';

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
  mode?: IntentMode;
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

export interface MoMAConfig {
  complexityThresholds?: {
    tier1: number;
    tier2: number;
  };
  cloudEndpoint?: string;
  cloudProvider?: 'openai' | 'anthropic';
  maxCacheSize?: number;
  enableStreaming?: boolean;
  onStatusChange?: (status: MoMAStatus) => void;
  onError?: (error: MoMAError) => void;
}

export const DEFAULT_CONFIG: Required<MoMAConfig> = {
  complexityThresholds: { tier1: 0.3, tier2: 0.6 },
  cloudEndpoint: '/api/inference',
  cloudProvider: 'openai',
  maxCacheSize: 100,
  enableStreaming: true,
  onStatusChange: () => {},
  onError: () => {},
};

// ─── Status ─────────────────────────────────────────────

export interface MoMAStatus {
  initialized: boolean;
  backend: BackendType;
  online: boolean;
  loadedModels: string[];
  cacheSizeBytes: number;
  memoryUsageBytes: number;
}

// ─── Errors ─────────────────────────────────────────────

export type MoMAErrorCode =
  | 'INIT_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'INFERENCE_FAILED'
  | 'CLOUD_UNAVAILABLE'
  | 'OFFLINE_NO_CACHE'
  | 'MEMORY_PRESSURE'
  | 'BACKEND_UNAVAILABLE';

export interface MoMAError extends Error {
  code: MoMAErrorCode;
  tier?: Tier;
  recoverable: boolean;
}
