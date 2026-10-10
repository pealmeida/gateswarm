/**
 * Deterministic intent detection (regex/tables, no LLM, no network).
 * Explicit fields win: body.modality | body.output_type | body.output_modality | body.modalities (OpenAI style),
 * header x-output-type, body.deterministic ({handler,input}) / header x-deterministic.
 * Heuristics are deliberately conservative: only a LEADING imperative ("generate an image of ...") or a prompt that is
 * entirely an arithmetic expression. Anything ambiguous stays plain text -> normal LLM routing.
 */
import type { Endpoint, Intent, Modality } from './types.js';

const OUT_ALIASES: Record<string, Modality> = {
  text: 'text', chat: 'text', image: 'image', images: 'image', 'image-generation': 'image', img: 'image',
  audio: 'audio', tts: 'audio', speech: 'audio', voice: 'audio', video: 'video', '3d': '3d', '3d-model': '3d', mesh: '3d',
};
const ENDPOINT_OF: Record<Modality, Endpoint | null> = { text: 'chat', image: 'images', audio: 'speech', video: 'video', '3d': '3d' };
const MEDIA_IN: Record<string, Modality> = { image_url: 'image', image: 'image', input_image: 'image', input_audio: 'audio', audio: 'audio', video_url: 'video', video: 'video' };

const LEADING: Array<[RegExp, Modality]> = [
  [/^\s*(?:please\s+)?(?:generate|create|draw|make|render)\s+(?:an?\s+)?(?:image|picture|illustration|photo)\s+(?:of|showing|with|:)\s+/i, 'image'],
  [/^\s*(?:gere|crie|desenhe|fa[cç]a)\s+(?:uma?\s+)?(?:imagem|ilustra[cç][aã]o|foto)\s+(?:de|do|da|com|:)\s+/i, 'image'],
  [/^\s*(?:text[- ]to[- ]speech|tts|read aloud|narrate)\s*[:\-]\s+/i, 'audio'],
  [/^\s*(?:converta em [aá]udio|narre|fale)\s*[:\-]\s+/i, 'audio'],
  [/^\s*(?:generate|create|make|render)\s+(?:an?\s+)?(?:video|clip)\s+(?:of|showing|with|:)\s+/i, 'video'],
  [/^\s*(?:generate|create|make|render)\s+(?:an?\s+)?(?:3d model|3d mesh|3d asset)\s+(?:of|showing|with|:)\s+/i, '3d'],
];

const MATH_RE = /^\s*(?:(?:calculate|compute|calcule|quanto [eé])\s*:?\s*)?([-+*/%^().,\d\s]+?)\s*[=?]?\s*$/i;

export function detectIntent(body: any, headers: Record<string, unknown> = {}, promptText = ''): Intent {
  const reasons: string[] = [];
  const h = (k: string): string | undefined => { const v = headers[k]; return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v); };
  const inputs = new Set<Modality>(['text']);
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) { const t = p && typeof p === 'object' ? MEDIA_IN[String(p.type)] : undefined; if (t) inputs.add(t); }
  }
  if (inputs.size > 1) reasons.push(`input parts: ${[...inputs].filter((x) => x !== 'text').join('+')}`);
  const prompt = String(body?.prompt ?? body?.input ?? promptText ?? '');

  // deterministic: explicit
  let deterministic: Intent['deterministic'] = null;
  const dExplicit = body?.deterministic ?? h('x-deterministic');
  if (dExplicit) {
    const handler = typeof dExplicit === 'string' ? dExplicit : String(dExplicit.handler ?? '');
    const input = typeof dExplicit === 'object' && dExplicit.input != null ? String(dExplicit.input) : promptText;
    if (handler) { deterministic = { handler: handler.toLowerCase(), via: 'explicit', input }; reasons.push(`explicit deterministic handler=${handler}`); }
  }

  // modality: explicit
  let output: Modality = 'text'; let via: Intent['via'] = 'none'; let text = prompt;
  const raw = body?.modality ?? body?.output_type ?? body?.output_modality ?? h('x-output-type')
    ?? (Array.isArray(body?.modalities) ? body.modalities.map(String).filter((x: string) => x !== 'text')[0] : undefined);
  if (raw != null) {
    const m = OUT_ALIASES[String(raw).toLowerCase()];
    if (m) { output = m; via = 'explicit'; reasons.push(`explicit output=${m}`); }
    else reasons.push(`unknown explicit modality "${String(raw).slice(0, 20)}" ignored`);
  }
  if (via === 'none') {
    for (const [re, m] of LEADING) { if (re.test(promptText)) { output = m; via = 'heuristic'; text = promptText.replace(re, ''); reasons.push(`leading imperative -> ${m}`); break; } }
  }
  if (via === 'none' && inputs.has('audio') && !deterministic) { via = 'media-parts'; }
  if (!deterministic && output === 'text' && via !== 'explicit') {
    const mm = MATH_RE.exec(promptText);
    if (mm && !/^\s*\d+(?:\s*-\s*\d+){2,}\s*$/.test(mm[1]) && /\d/.test(mm[1]) && /[-+*/%^]/.test(mm[1].replace(/^\s*-/, '')) && mm[1].length <= 200) { deterministic = { handler: 'math', via: 'heuristic', input: mm[1] }; reasons.push('prompt is a pure arithmetic expression'); }
    else if (/^\s*format json\s*:/i.test(promptText)) { deterministic = { handler: 'json-format', via: 'heuristic', input: promptText.replace(/^\s*format json\s*:/i, '') }; reasons.push('format json: prefix'); }
  }
  return { output, inputs: [...inputs], endpoint: ENDPOINT_OF[output], via, deterministic, prompt: text, reasons };
}
