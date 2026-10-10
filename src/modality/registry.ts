/**
 * Capability registry: which provider/model can take which input modalities and produce which output.
 * Nothing is invented: the built-ins are the models the operator reported for the Bailian Token Plan; they are
 * marked source=builtin-reported (not probed). Extra entries come from GATESWARM_MODALITY_REGISTRY_FILE (JSON array
 * of Capability). An entry only counts as ACTIVE when its provider is configured in this gateway.
 * video / 3d have NO built-in provider: they report "no active provider" until a configured entry offers them.
 */
import { readFileSync } from 'node:fs';
import type { Capability, Modality } from './types.js';

export const BUILTIN_CAPABILITIES: Capability[] = [
  { provider: 'bailian', model: 'wan2.7-image', input: ['text'], output: ['image'], endpoint: 'images', quotaProvider: 'bailian', source: 'builtin-reported', notes: 'image generation; request shape unverified (OpenAI-compatible /images/generations assumed)' },
  { provider: 'bailian', model: 'qwen-audio-3.0-tts', input: ['text'], output: ['audio'], endpoint: 'speech', quotaProvider: 'bailian', source: 'builtin-reported', notes: 'TTS; OpenAI-compatible /audio/speech assumed' },
  { provider: 'bailian', model: 'qwen-audio-3.0-realtime', input: ['audio', 'text'], output: ['audio', 'text'], endpoint: 'realtime', quotaProvider: 'bailian', source: 'builtin-reported', notes: 'realtime/STT: registered only, no executor (websocket)' },
];

export function loadCapabilities(env: NodeJS.ProcessEnv = process.env): Capability[] {
  const out = [...BUILTIN_CAPABILITIES];
  const f = env.GATESWARM_MODALITY_REGISTRY_FILE;
  if (f) {
    try {
      const arr = JSON.parse(readFileSync(f, 'utf8')) as Capability[];
      for (const c of arr) if (c && c.provider && c.model && Array.isArray(c.output) && c.endpoint) out.push({ ...c, input: c.input ?? ['text'], source: 'file' });
    } catch { /* ignore a bad file: built-ins only */ }
  }
  return out;
}

export interface ActiveInfo { modality: Modality; active: Capability[]; status: 'active' | 'no_active_provider'; note?: string }
/** Per output modality: which entries are usable now (provider configured). */
export function summarize(caps: Capability[], isConfigured: (provider: string) => boolean): ActiveInfo[] {
  const mods: Modality[] = ['image', 'audio', 'video', '3d'];
  return mods.map((m) => {
    const active = caps.filter((c) => c.output.includes(m) && isConfigured(c.provider));
    return { modality: m, active, status: active.length ? 'active' : 'no_active_provider', note: active.length ? undefined : 'no configured provider offers this output (not invented)' } as ActiveInfo;
  });
}
