/**
 * Executors. Deterministic: local handlers. Multimodal: OpenAI-compatible endpoints only
 * (images -> /images/generations, speech -> /audio/speech). Other endpoints have no executor (planner reports it).
 * Secrets are passed in by the caller and never logged or echoed.
 */
import { getDeterministicHandler } from './deterministic.js';
import type { Capability, Intent } from './types.js';

export function runDeterministic(handler: string, input: string): { ok: boolean; output?: string; error?: string } {
  const h = getDeterministicHandler(handler);
  return h ? h.run(input) : { ok: false, error: 'handler not registered' };
}

export interface ExecResult { ok: boolean; status: number; kind: 'image' | 'audio'; data?: unknown; contentType?: string; error?: string; latencyMs: number }

export async function runMultimodal(target: Capability, i: Intent, conn: { baseUrl: string; apiKey: string }, body: any, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000): Promise<ExecResult> {
  const t0 = Date.now();
  const base = conn.baseUrl.replace(/\/+$/, '');
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (target.endpoint === 'images') {
      const payload: Record<string, unknown> = { model: target.model, prompt: i.prompt, n: Math.min(Number(body?.n) || 1, 4) };
      if (typeof body?.size === 'string') payload.size = body.size;
      const r = await fetchImpl(`${base}/images/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` }, body: JSON.stringify(payload), signal: ctl.signal });
      const txt = await r.text();
      if (!r.ok) return { ok: false, status: r.status, kind: 'image', error: `upstream ${r.status}`, latencyMs: Date.now() - t0 };
      let j: any; try { j = JSON.parse(txt); } catch { return { ok: false, status: 502, kind: 'image', error: 'upstream returned non-JSON', latencyMs: Date.now() - t0 }; }
      return { ok: true, status: 200, kind: 'image', data: j.data ?? j, latencyMs: Date.now() - t0 };
    }
    if (target.endpoint === 'speech') {
      const payload = { model: target.model, input: i.prompt, voice: typeof body?.voice === 'string' ? body.voice : undefined, response_format: typeof body?.response_format === 'string' ? body.response_format : undefined };
      const r = await fetchImpl(`${base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` }, body: JSON.stringify(payload), signal: ctl.signal });
      if (!r.ok) return { ok: false, status: r.status, kind: 'audio', error: `upstream ${r.status}`, latencyMs: Date.now() - t0 };
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: 200, kind: 'audio', data: { b64: buf.toString('base64'), bytes: buf.length }, contentType: r.headers.get('content-type') ?? 'audio/mpeg', latencyMs: Date.now() - t0 };
    }
    return { ok: false, status: 501, kind: 'image', error: `no executor for ${target.endpoint}`, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 502, kind: target.endpoint === 'speech' ? 'audio' : 'image', error: (e as Error).name === 'AbortError' ? 'timeout' : 'transport error', latencyMs: Date.now() - t0 };
  } finally { clearTimeout(to); }
}
