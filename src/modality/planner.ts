/**
 * Plan: given an Intent, decide llm | deterministic | multimodal | clear error. Pure; the gateway executes.
 * Deterministic layers (all local, no LLM): intent detection (regex/tables), capability registry lookup,
 * quota gating (band/breaker from the quota manager), candidate ordering (band, then registry order).
 */
import type { MgrBand } from '../quota-manager/core.js';
import { getDeterministicHandler } from './deterministic.js';
import type { Capability, Intent, Plan, RouteMode } from './types.js';

export interface PlanCtx {
  modalityMode: RouteMode; deterministicMode: RouteMode;
  capabilities: Capability[];
  isConfigured: (provider: string) => boolean;
  bandOf: (provider: string) => MgrBand;
  breakerOpen: (provider: string) => boolean;
}
const EXECUTABLE = new Set(['chat', 'images', 'speech']);
const BAND_RANK: Record<MgrBand, number> = { green: 0, unknown: 1, yellow: 2, orange: 3, red: 4 };

export function planIntent(i: Intent, c: PlanCtx): Plan {
  const reasons = [...i.reasons];
  if (i.deterministic && c.deterministicMode !== 'off') {
    const h = getDeterministicHandler(i.deterministic.handler);
    if (h) return { kind: 'deterministic', handler: h.id, reasons };
    if (i.deterministic.via === 'explicit') return { kind: 'error', code: 'no_deterministic_handler', status: 422, message: `deterministic handler "${i.deterministic.handler.slice(0, 40)}" is not registered`, reasons };
  }
  if (i.output !== 'text' && c.modalityMode !== 'off') {
    const all = c.capabilities.filter((x) => x.output.includes(i.output));
    const active = all.filter((x) => c.isConfigured(x.provider));
    if (!active.length) {
      return { kind: 'error', code: 'no_provider', status: 422, message: `no active provider offers ${i.output} output (sem provedor ativo); not emulated`, reasons };
    }
    const exec = active.filter((x) => EXECUTABLE.has(x.endpoint));
    if (!exec.length) return { kind: 'error', code: 'no_executor', status: 501, message: `${i.output} output is registered (${active.map((a) => a.provider + '/' + a.model).join(', ')}) but this gateway has no executor for endpoint ${active[0].endpoint}`, reasons };
    const ok = exec.filter((x) => !c.breakerOpen(x.quotaProvider ?? x.provider) && (c.bandOf(x.quotaProvider ?? x.provider) !== 'red'));
    if (!ok.length) return { kind: 'error', code: 'quota_exhausted', status: 429, message: `all providers for ${i.output} are quota-limited (red band or breaker open)`, reasons };
    const sorted = [...ok].sort((a, b) => BAND_RANK[c.bandOf(a.quotaProvider ?? a.provider)] - BAND_RANK[c.bandOf(b.quotaProvider ?? b.provider)]);
    if (sorted.length < exec.length) reasons.push('skipped quota-limited candidates');
    return { kind: 'multimodal', target: sorted[0], alternatives: sorted.slice(1), reasons };
  }
  return { kind: 'llm', reasons };
}
