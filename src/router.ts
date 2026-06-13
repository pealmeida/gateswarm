/**
 * Model Router — Effort × Model matrix-based routing
 *
 * Uses the routing matrix to make device-aware, cost-optimized
 * decisions based on the effort level derived from intent scoring.
 */

import type { ComplexityScore, DeviceProfile, RoutingDecision, Tier, EffortLevel, DeviceProfileName } from './types.js';
import { classifyDevice, scoreToEffort, lookupMatrix, MODEL_INVENTORY } from './routing-matrix.js';

export class ModelRouter {
  private tier1Limit: number;
  private tier2Limit: number;
  private deviceClassName: DeviceProfileName;

  constructor(
    private profile: DeviceProfile,
    overrides?: { tier1?: number; tier2?: number }
  ) {
    this.tier1Limit = overrides?.tier1 ?? profile.tier1Limit;
    this.tier2Limit = overrides?.tier2 ?? profile.tier2Limit;
    this.deviceClassName = classifyDevice(
      profile.backend,
      profile.memoryGB,
      profile.isMobile
    );
  }

  route(score: number): RoutingDecision {
    // 1. Convert score to effort level
    const effort = scoreToEffort(score);

    // 2. Look up matrix cell
    const cell = lookupMatrix(effort, this.deviceClassName);

    // 3. Determine tier from model
    const model = MODEL_INVENTORY[cell.primaryModel];
    const tier = this.inferTier(model?.tier ?? 'cloud-light');

    // 4. Check if model is feasible on this device
    const feasibleModel = this.ensureFeasibility(cell.primaryModel, cell.fallbackModel);

    return {
      tier,
      model: feasibleModel,
      score,
      effort,
      deviceClass: this.deviceClassName,
      estimatedLatencyMs: cell.estimatedLatencyMs,
      estimatedCostCents: cell.estimatedCostCents,
      qualityScore: cell.qualityScore,
      reason: this.buildReason(effort, feasibleModel, score, cell),
      profile: this.profile,
    };
  }

  private inferTier(modelTier: string): Tier {
    if (modelTier.startsWith('cloud')) return 'cloud';
    if (modelTier === 'nano' || modelTier === 'small') return 'gatekeeper';
    return 'local';
  }

  /**
   * Ensure the selected model can actually run on this device.
   * Falls back to the fallback model or cloud if not.
   */
  private ensureFeasibility(primary: string, fallback: string): string {
    const model = MODEL_INVENTORY[primary];
    if (!model) return fallback;

    // Check memory
    if (model.minMemoryGB > this.profile.memoryGB) {
      console.warn(`[Router] ${primary} needs ${model.minMemoryGB}GB, device has ${this.profile.memoryGB}GB → fallback`);
      return fallback;
    }

    // Check backend compatibility
    if (model.backendReq.length > 0 && !model.backendReq.includes(this.profile.backend)) {
      console.warn(`[Router] ${primary} requires ${model.backendReq}, device has ${this.profile.backend} → fallback`);
      return fallback;
    }

    return primary;
  }

  private buildReason(
    effort: EffortLevel,
    model: string,
    score: number,
    cell: any
  ): string {
    const modelDef = MODEL_INVENTORY[model];
    const modelName = modelDef?.displayName ?? model;
    return `Effort=${effort} (score ${score.toFixed(2)}) × Device=${this.deviceClassName} → ${modelName} | est. ${cell.estimatedLatencyMs}ms, $${(cell.estimatedCostCents / 100).toFixed(3)}/1Ktok, quality ${(cell.qualityScore * 100).toFixed(0)}%`;
  }

  /** Adjust thresholds (e.g., when going offline) */
  adjustThresholds(tier1?: number, tier2?: number): void {
    if (tier1 !== undefined) this.tier1Limit = tier1;
    if (tier2 !== undefined) this.tier2Limit = tier2;
  }

  /** Force all routing to local (offline mode) */
  forceLocal(): void {
    this.tier1Limit = 1.0;
    this.tier2Limit = 1.0;
  }

  /** Disable all local tiers */
  disableLocal(): void {
    this.tier1Limit = 0;
    this.tier2Limit = 0;
  }

  get currentThresholds(): { tier1: number; tier2: number } {
    return { tier1: this.tier1Limit, tier2: this.tier2Limit };
  }

  get deviceClass(): DeviceProfileName {
    return this.deviceClassName;
  }
}
