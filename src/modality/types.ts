export type Modality = 'text' | 'image' | 'audio' | 'video' | '3d';
export type RouteMode = 'off' | 'shadow' | 'on';
export function parseMode(v: unknown): RouteMode {
  const s = String(v ?? 'off').trim().toLowerCase();
  return s === 'shadow' || s === 'on' ? s : 'off';
}
/** How the model is invoked. Only 'chat', 'images' and 'speech' have executors; the others are registry-only. */
export type Endpoint = 'chat' | 'images' | 'speech' | 'transcriptions' | 'realtime' | 'video' | '3d';
export interface Capability {
  provider: string; model: string; input: Modality[]; output: Modality[]; endpoint: Endpoint;
  /** provider id the quota manager measures (credits/quota) */
  quotaProvider?: string;
  /** where the entry comes from; 'reported' = named by the operator, not probed by GateSwarm */
  source: 'builtin-reported' | 'file';
  notes?: string;
}
export interface Intent {
  /** modality asked for as OUTPUT; 'text' = ordinary chat */
  output: Modality; inputs: Modality[]; endpoint: Endpoint | null;
  /** how the intent was found */
  via: 'explicit' | 'heuristic' | 'media-parts' | 'none';
  /** non-null when a deterministic handler was requested/matched */
  deterministic: { handler: string; via: 'explicit' | 'heuristic'; input: string } | null;
  /** text to send to the generator (prompt/input), never logged */
  prompt: string;
  reasons: string[];
}
export type Plan =
  | { kind: 'llm'; reasons: string[] }
  | { kind: 'deterministic'; handler: string; reasons: string[] }
  | { kind: 'multimodal'; target: Capability; alternatives: Capability[]; reasons: string[] }
  | { kind: 'error'; code: 'no_provider' | 'no_executor' | 'no_deterministic_handler' | 'quota_exhausted'; message: string; status: number; reasons: string[] };
