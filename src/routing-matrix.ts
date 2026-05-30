export type { EffortLevel, DeviceProfileName } from './types.js';
/**
 * Routing Matrix — Effort × Model selection grid
 *
 * Maps computational effort levels (derived from intent score)
 * against available models, producing optimal routing decisions
 * that account for device capability, cost, and latency.
 *
 * v3.6: TIER BOUNDARIES UNIFIED — now matches v04_config.json boundaries.
 * Previously had conflicting ranges vs v04-config.ts, causing same score
 * to route to different tiers depending on which file was read.
 * Canonical boundaries: v04_config.json → tier_boundaries.
 */

// ─── Effort Levels ──────────────────────────────────────

/**
 * Effort levels represent the computational complexity required.
 * Derived from the Intent Engine's complexity score (0–1).
 */
import type { EffortLevel, ModelTier, DeviceProfileName } from './types.js';

export const EFFORT_RANGES: Record<EffortLevel, [number, number]> = {
  // v3.6: UNIFIED — matches v04_config.json tier_boundaries
  trivial:   [0.00, 0.1557],
  light:     [0.1557, 0.1842],
  moderate:  [0.1842, 0.2788],
  heavy:     [0.2788, 0.3488],
  intensive: [0.3488, 0.4611],
  extreme:   [0.4611, 1.00],
};

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  trivial:   'Trivial',
  light:     'Light',
  moderate:  'Moderate',
  heavy:     'Heavy',
  intensive: 'Intensive',
  extreme:   'Extreme',
};

// ─── Model Definitions ──────────────────────────────────



export interface ModelDefinition {
  id: string;
  tier: ModelTier;
  displayName: string;
  sizeMB: number;
  backendReq: ('webgpu' | 'webnn' | 'wasm')[];
  minMemoryGB: number;
  tpsEstimate: { webgpu: number; webnn: number; wasm: number }; // tokens/sec
  maxContextTokens: number;
  strengths: string[];
  weaknesses: string[];
}

/**
 * Complete model inventory with capability profiles.
 */
export const MODEL_INVENTORY: Record<string, ModelDefinition> = {
  'deberta-v3-q4': {
    id: 'deberta-v3-q4',
    tier: 'nano',
    displayName: 'DeBERTa v3 (q4)',
    sizeMB: 80,
    backendReq: ['webgpu', 'wasm'],
    minMemoryGB: 0.5,
    tpsEstimate: { webgpu: 500, webnn: 400, wasm: 200 },
    maxContextTokens: 512,
    strengths: ['complexity scoring', 'intent classification', 'fast inference'],
    weaknesses: ['classification only', 'no generation'],
  },
  'qwen-0.5b-q4': {
    id: 'qwen-0.5b-q4',
    tier: 'small',
    displayName: 'Qwen 2.5 0.5B (q4)',
    sizeMB: 300,
    backendReq: ['webgpu', 'wasm'],
    minMemoryGB: 1,
    tpsEstimate: { webgpu: 45, webnn: 30, wasm: 12 },
    maxContextTokens: 2048,
    strengths: ['gatekeeper', 'short answers', 'fast response', 'low memory'],
    weaknesses: ['hallucination risk', 'limited reasoning', 'short context'],
  },
  'tinyllama-1.1b-q4': {
    id: 'tinyllama-1.1b-q4',
    tier: 'small',
    displayName: 'TinyLlama 1.1B (q4)',
    sizeMB: 600,
    backendReq: ['webgpu', 'webnn', 'wasm'],
    minMemoryGB: 1.5,
    tpsEstimate: { webgpu: 30, webnn: 20, wasm: 8 },
    maxContextTokens: 2048,
    strengths: ['general chat', 'mobile-friendly', 'broad knowledge'],
    weaknesses: ['reasoning depth', 'code quality', 'long context'],
  },
  'llama-3.2-3b-q4': {
    id: 'llama-3.2-3b-q4',
    tier: 'medium',
    displayName: 'Llama 3.2 3B (q4)',
    sizeMB: 1800,
    backendReq: ['webgpu'],
    minMemoryGB: 4,
    tpsEstimate: { webgpu: 18, webnn: 0, wasm: 0 },
    maxContextTokens: 4096,
    strengths: ['reasoning', 'code', 'instruction following', 'longer context'],
    weaknesses: ['desktop only', 'slow on weak GPU', 'large download'],
  },
  'cloud-gpt4o-mini': {
    id: 'cloud-gpt4o-mini',
    tier: 'cloud-light',
    displayName: 'GPT-4o Mini (Cloud)',
    sizeMB: 0,
    backendReq: [],
    minMemoryGB: 0,
    tpsEstimate: { webgpu: 0, webnn: 0, wasm: 0 },
    maxContextTokens: 128000,
    strengths: ['fast cloud', 'good quality', 'cheap', 'large context'],
    weaknesses: ['requires internet', 'API cost', 'latency'],
  },
  'cloud-gpt4o': {
    id: 'cloud-gpt4o',
    tier: 'cloud-heavy',
    displayName: 'GPT-4o (Cloud)',
    sizeMB: 0,
    backendReq: [],
    minMemoryGB: 0,
    tpsEstimate: { webgpu: 0, webnn: 0, wasm: 0 },
    maxContextTokens: 128000,
    strengths: ['best reasoning', 'code generation', 'nuanced output', 'massive context'],
    weaknesses: ['expensive', 'higher latency', 'requires internet'],
  },
  'cloud-claude-sonnet': {
    id: 'cloud-claude-sonnet',
    tier: 'cloud-heavy',
    displayName: 'Claude Sonnet (Cloud)',
    sizeMB: 0,
    backendReq: [],
    minMemoryGB: 0,
    tpsEstimate: { webgpu: 0, webnn: 0, wasm: 0 },
    maxContextTokens: 200000,
    strengths: ['best coding', 'analysis', 'long context', 'nuanced reasoning'],
    weaknesses: ['expensive', 'higher latency', 'requires internet'],
  },
};

// ─── Routing Matrix ─────────────────────────────────────

/**
 * The Effort × Model routing matrix.
 * 
 * For each (effort, device_profile) cell, defines:
 * - Primary model: best fit for the effort level on this device
 * - Fallback model: if primary can't load
 * - Cloud override: when to skip local and go cloud anyway
 */
export interface MatrixCell {
  effort: EffortLevel;
  deviceProfile: string;
  primaryModel: string;
  fallbackModel: string;
  cloudOverride: boolean;  // if true, skip local entirely
  estimatedLatencyMs: number;
  estimatedCostCents: number;  // per 1K tokens
  qualityScore: number;  // 0-1 estimate of response quality
}

/**
 * Full routing matrix: EFFORT_LEVEL × DEVICE_PROFILE
 * 
 * Device profiles:
 *   - desktop-high:  WebGPU, ≥8GB RAM
 *   - desktop-mid:   WebGPU, 4-8GB RAM  
 *   - mobile-high:   WebGPU/WebNN, ≥4GB RAM
 *   - mobile-low:    WASM only, <4GB RAM
 *   - lowend:        WASM, <2GB RAM
 */
export const ROUTING_MATRIX: MatrixCell[] = [
  // ─── TRIVIAL (greetings, simple facts) ───────────────
  { effort: 'trivial', deviceProfile: 'desktop-high',  primaryModel: 'qwen-0.5b-q4',      fallbackModel: 'tinyllama-1.1b-q4',  cloudOverride: false, estimatedLatencyMs: 200,  estimatedCostCents: 0,    qualityScore: 0.85 },
  { effort: 'trivial', deviceProfile: 'desktop-mid',   primaryModel: 'qwen-0.5b-q4',      fallbackModel: 'tinyllama-1.1b-q4',  cloudOverride: false, estimatedLatencyMs: 250,  estimatedCostCents: 0,    qualityScore: 0.85 },
  { effort: 'trivial', deviceProfile: 'mobile-high',   primaryModel: 'qwen-0.5b-q4',      fallbackModel: 'tinyllama-1.1b-q4',  cloudOverride: false, estimatedLatencyMs: 300,  estimatedCostCents: 0,    qualityScore: 0.80 },
  { effort: 'trivial', deviceProfile: 'mobile-low',    primaryModel: 'qwen-0.5b-q4',      fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: false, estimatedLatencyMs: 500,  estimatedCostCents: 0,    qualityScore: 0.75 },
  { effort: 'trivial', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 800,  estimatedCostCents: 0.15, qualityScore: 0.90 },

  // ─── LIGHT (short answers, rephrasing) ───────────────
  { effort: 'light', deviceProfile: 'desktop-high',  primaryModel: 'tinyllama-1.1b-q4',  fallbackModel: 'qwen-0.5b-q4',      cloudOverride: false, estimatedLatencyMs: 300,  estimatedCostCents: 0,    qualityScore: 0.85 },
  { effort: 'light', deviceProfile: 'desktop-mid',   primaryModel: 'tinyllama-1.1b-q4',  fallbackModel: 'qwen-0.5b-q4',      cloudOverride: false, estimatedLatencyMs: 400,  estimatedCostCents: 0,    qualityScore: 0.80 },
  { effort: 'light', deviceProfile: 'mobile-high',   primaryModel: 'tinyllama-1.1b-q4',  fallbackModel: 'qwen-0.5b-q4',      cloudOverride: false, estimatedLatencyMs: 500,  estimatedCostCents: 0,    qualityScore: 0.75 },
  { effort: 'light', deviceProfile: 'mobile-low',    primaryModel: 'qwen-0.5b-q4',       fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: false, estimatedLatencyMs: 800,  estimatedCostCents: 0.15, qualityScore: 0.70 },
  { effort: 'light', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 1000, estimatedCostCents: 0.15, qualityScore: 0.90 },

  // ─── MODERATE (summaries, translations, explanations) ─
  { effort: 'moderate', deviceProfile: 'desktop-high',  primaryModel: 'llama-3.2-3b-q4',    fallbackModel: 'tinyllama-1.1b-q4',  cloudOverride: false, estimatedLatencyMs: 600,  estimatedCostCents: 0,    qualityScore: 0.85 },
  { effort: 'moderate', deviceProfile: 'desktop-mid',   primaryModel: 'tinyllama-1.1b-q4',  fallbackModel: 'qwen-0.5b-q4',      cloudOverride: false, estimatedLatencyMs: 800,  estimatedCostCents: 0,    qualityScore: 0.70 },
  { effort: 'moderate', deviceProfile: 'mobile-high',   primaryModel: 'tinyllama-1.1b-q4',  fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: false, estimatedLatencyMs: 1000, estimatedCostCents: 0,    qualityScore: 0.65 },
  { effort: 'moderate', deviceProfile: 'mobile-low',    primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 1200, estimatedCostCents: 0.15, qualityScore: 0.90 },
  { effort: 'moderate', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 1500, estimatedCostCents: 0.15, qualityScore: 0.90 },

  // ─── HEAVY (code gen, analysis, comparison) ──────────
  { effort: 'heavy', deviceProfile: 'desktop-high',  primaryModel: 'llama-3.2-3b-q4',    fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: false, estimatedLatencyMs: 1200, estimatedCostCents: 0,    qualityScore: 0.75 },
  { effort: 'heavy', deviceProfile: 'desktop-mid',   primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 1500, estimatedCostCents: 0.15, qualityScore: 0.90 },
  { effort: 'heavy', deviceProfile: 'mobile-high',   primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 1800, estimatedCostCents: 0.15, qualityScore: 0.90 },
  { effort: 'heavy', deviceProfile: 'mobile-low',    primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 2000, estimatedCostCents: 0.15, qualityScore: 0.90 },
  { effort: 'heavy', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 2500, estimatedCostCents: 0.15, qualityScore: 0.90 },

  // ─── INTENSIVE (multi-step reasoning, complex code) ──
  { effort: 'intensive', deviceProfile: 'desktop-high',  primaryModel: 'cloud-gpt4o-mini',   fallbackModel: 'cloud-gpt4o',        cloudOverride: true,  estimatedLatencyMs: 2000, estimatedCostCents: 0.15, qualityScore: 0.90 },
  { effort: 'intensive', deviceProfile: 'desktop-mid',   primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-claude-sonnet', cloudOverride: true,  estimatedLatencyMs: 2500, estimatedCostCents: 0.50, qualityScore: 0.95 },
  { effort: 'intensive', deviceProfile: 'mobile-high',   primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 3000, estimatedCostCents: 0.50, qualityScore: 0.95 },
  { effort: 'intensive', deviceProfile: 'mobile-low',    primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 3500, estimatedCostCents: 0.50, qualityScore: 0.95 },
  { effort: 'intensive', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 4000, estimatedCostCents: 0.50, qualityScore: 0.95 },

  // ─── EXTREME (novel generation, deep research, architecture) ─
  { effort: 'extreme', deviceProfile: 'desktop-high',  primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-claude-sonnet', cloudOverride: true,  estimatedLatencyMs: 3000, estimatedCostCents: 0.50, qualityScore: 0.95 },
  { effort: 'extreme', deviceProfile: 'desktop-mid',   primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-claude-sonnet', cloudOverride: true,  estimatedLatencyMs: 3500, estimatedCostCents: 0.50, qualityScore: 0.95 },
  { effort: 'extreme', deviceProfile: 'mobile-high',   primaryModel: 'cloud-claude-sonnet', fallbackModel: 'cloud-gpt4o',        cloudOverride: true,  estimatedLatencyMs: 4000, estimatedCostCents: 0.75, qualityScore: 0.97 },
  { effort: 'extreme', deviceProfile: 'mobile-low',    primaryModel: 'cloud-claude-sonnet', fallbackModel: 'cloud-gpt4o',        cloudOverride: true,  estimatedLatencyMs: 4500, estimatedCostCents: 0.75, qualityScore: 0.97 },
  { effort: 'extreme', deviceProfile: 'lowend',        primaryModel: 'cloud-gpt4o',        fallbackModel: 'cloud-gpt4o-mini',   cloudOverride: true,  estimatedLatencyMs: 5000, estimatedCostCents: 0.50, qualityScore: 0.95 },
];

// ─── Matrix Lookup ──────────────────────────────────────



/**
 * Map runtime device profile to matrix profile name.
 */
export function classifyDevice(
  backend: string,
  memoryGB: number,
  isMobile: boolean
): DeviceProfileName {
  if (isMobile) {
    if (memoryGB >= 4) return 'mobile-high';
    if (memoryGB >= 2) return 'mobile-low';
    return 'lowend';
  }
  // Desktop
  if (backend === 'webgpu' && memoryGB >= 8) return 'desktop-high';
  if (backend === 'webgpu' && memoryGB >= 4) return 'desktop-mid';
  if (memoryGB >= 4) return 'desktop-mid';
  return 'lowend';
}

/**
 * Convert complexity score (0-1) to effort level.
 * v3.6: UNIFIED boundaries matching v04_config.json tier_boundaries.
 */
export function scoreToEffort(score: number): EffortLevel {
  if (score < 0.1557) return 'trivial';
  if (score < 0.1842) return 'light';
  if (score < 0.2788) return 'moderate';
  if (score < 0.3488) return 'heavy';
  if (score < 0.4611) return 'intensive';
  return 'extreme';
}

/**
 * Look up the matrix cell for a given effort × device combination.
 */
export function lookupMatrix(
  effort: EffortLevel,
  deviceProfile: DeviceProfileName
): MatrixCell {
  const cell = ROUTING_MATRIX.find(
    (c) => c.effort === effort && c.deviceProfile === deviceProfile
  );
  if (!cell) {
    // Safe default: cloud-light
    return {
      effort,
      deviceProfile,
      primaryModel: 'cloud-gpt4o-mini',
      fallbackModel: 'cloud-gpt4o-mini',
      cloudOverride: true,
      estimatedLatencyMs: 2000,
      estimatedCostCents: 0.15,
      qualityScore: 0.90,
    };
  }
  return cell;
}

/**
 * Get the full matrix as a 2D grid (for visualization/debugging).
 */
export function getMatrixGrid(): Record<EffortLevel, Record<DeviceProfileName, MatrixCell>> {
  const efforts: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  const devices: DeviceProfileName[] = ['desktop-high', 'desktop-mid', 'mobile-high', 'mobile-low', 'lowend'];

  const grid: any = {};
  for (const effort of efforts) {
    grid[effort] = {};
    for (const device of devices) {
      grid[effort][device] = lookupMatrix(effort, device);
    }
  }
  return grid as Record<EffortLevel, Record<DeviceProfileName, MatrixCell>>;
}

/**
 * Estimate total cost for a session based on routing distribution.
 */
export function estimateSessionCost(
  routingHistory: Array<{ effort: EffortLevel; deviceProfile: DeviceProfileName; tokens: number }>
): { totalCostCents: number; localPct: number; cloudPct: number } {
  let totalCost = 0;
  let localTokens = 0;
  let cloudTokens = 0;

  for (const entry of routingHistory) {
    const cell = lookupMatrix(entry.effort, entry.deviceProfile);
    totalCost += (entry.tokens / 1000) * cell.estimatedCostCents;
    const model = MODEL_INVENTORY[cell.primaryModel];
    if (model?.tier.startsWith('cloud')) {
      cloudTokens += entry.tokens;
    } else {
      localTokens += entry.tokens;
    }
  }

  const total = localTokens + cloudTokens;
  return {
    totalCostCents: totalCost,
    localPct: total > 0 ? Math.round((localTokens / total) * 100) : 0,
    cloudPct: total > 0 ? Math.round((cloudTokens / total) * 100) : 0,
  };
}
