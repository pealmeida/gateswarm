import type { ModelSpec } from './types.js';

/**
 * Default routing matrix — a reviewed starting point, NOT a source of truth.
 * Prices are USD per 1M tokens, estimated 2026-08. Review periodically or
 * pass your own matrix via RouteOptions.matrix in production.
 */
export const DEFAULT_MATRIX: ModelSpec[] = [
  { id: 'gemini-flash-lite', provider: 'google',    maxEffort: 'light',     costPer1MInput: 0.10,  costPer1MOutput: 0.40,  quality: 0.55, avgLatencyMs: 400 },
  { id: 'gpt-5-mini',        provider: 'openai',    maxEffort: 'moderate',  costPer1MInput: 0.25,  costPer1MOutput: 2.00,  quality: 0.70, avgLatencyMs: 700 },
  { id: 'gemini-flash',      provider: 'google',    maxEffort: 'moderate',  costPer1MInput: 0.30,  costPer1MOutput: 2.50,  quality: 0.72, avgLatencyMs: 600 },
  { id: 'deepseek-chat',     provider: 'deepseek',  maxEffort: 'heavy',     costPer1MInput: 0.27,  costPer1MOutput: 1.10,  quality: 0.74, avgLatencyMs: 1200 },
  { id: 'gemini-pro',        provider: 'google',    maxEffort: 'intensive', costPer1MInput: 1.25,  costPer1MOutput: 10.00, quality: 0.87, avgLatencyMs: 1400 },
  { id: 'gpt-5.2',           provider: 'openai',    maxEffort: 'intensive', costPer1MInput: 1.75,  costPer1MOutput: 14.00, quality: 0.88, avgLatencyMs: 1500 },
  { id: 'claude-sonnet',     provider: 'anthropic', maxEffort: 'extreme',   costPer1MInput: 3.00,  costPer1MOutput: 15.00, quality: 0.92, avgLatencyMs: 1600 },
  { id: 'claude-opus',       provider: 'anthropic', maxEffort: 'extreme',   costPer1MInput: 15.00, costPer1MOutput: 75.00, quality: 0.97, avgLatencyMs: 2500 },
];
