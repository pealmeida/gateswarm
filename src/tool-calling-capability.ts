/**
 * Tool-calling capability for direct HTTP routes.
 *
 * The model matrix is populated at runtime; a static provider allowlist plus
 * permissive unknown-model behavior keeps fresh deploys usable while explicit
 * matrix entries with supportsTools: false still block tool calls.
 */

import { modelMatrix } from './model-matrix.js';

/** HTTP providers known to expose OpenAI-compatible tool calling APIs. */
export const TOOL_CAPABLE_HTTP_PROVIDER_IDS = new Set([
  'zai',
  'bailian',
  'deepseek',
  'openrouter',
  'moonshot',
  'opencodego',
]);

/**
 * Upstream model id sent to providers. Strips only repeated `providerId/` prefixes;
 * does not drop interior path segments (e.g. openrouter → z-ai/glm-5.3).
 */
export function normalizeUpstreamModelId(providerId: string, model: string): string {
  let trimmed = model.trim();
  const prefix = `${providerId}/`;
  while (trimmed.startsWith(prefix)) {
    trimmed = trimmed.slice(prefix.length);
  }
  return trimmed;
}

export type ToolCallingCapability =
  | { allowed: true; source: 'matrix' | 'allowlist' | 'unknown' }
  | { allowed: false; source: 'matrix'; reason: string };

export function evaluateToolCallingCapability(providerId: string, modelId: string): ToolCallingCapability {
  const normalizedModel = normalizeUpstreamModelId(providerId, modelId);
  const entry = modelMatrix.getModel(providerId, normalizedModel);
  if (entry) {
    if (entry.supportsTools) {
      return { allowed: true, source: 'matrix' };
    }
    return {
      allowed: false,
      source: 'matrix',
      reason: `Model ${providerId}/${normalizedModel} is marked as not supporting tools in the model matrix`,
    };
  }
  if (TOOL_CAPABLE_HTTP_PROVIDER_IDS.has(providerId)) {
    return { allowed: true, source: 'allowlist' };
  }
  console.warn(
    `⚠️  [tools] ${providerId}/${normalizedModel} is not in the model matrix; allowing tool calling (add a matrix entry to enforce capability)`,
  );
  return { allowed: true, source: 'unknown' };
}
