import http from 'node:http';

export interface ScoreResp {
  score: number;
  tier: string;
  confidence: number;
  selected?: { model: string; provider: string };
  latencyMs?: number;
}

export interface ChatResult {
  status: number;
  headers: Record<string, string>;
  content: string;
  reasoning: string;
  raw: unknown;
  timedOut?: boolean;
}

function requestJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer moma-default',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer | string) => (data += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(Object.assign(new Error('timeout'), { timedOut: true }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function postScore(port: number, prompt: string): Promise<ScoreResp> {
  const t0 = Date.now();
  const { status, json } = await requestJson(port, '/v1/score', { prompt }, {}, 30_000);
  if (status !== 200) throw new Error(`/v1/score HTTP ${status}: ${JSON.stringify(json)}`);
  return { ...(json as ScoreResp), latencyMs: Date.now() - t0 };
}

export async function postChatAuto(
  port: number,
  prompt: string,
  maxTokens: number,
  timeoutMs = 120_000,
): Promise<ChatResult> {
  try {
    const { status, headers, json } = await requestJson(
      port,
      '/v1/chat/completions',
      {
        model: 'auto',
        stream: false,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
      {},
      timeoutMs,
    );
    const raw = json as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
    };
    const msg = raw?.choices?.[0]?.message || {};
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') flat[k.toLowerCase()] = v;
      else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(',');
    }
    return {
      status,
      headers: flat,
      content: msg.content || '',
      reasoning: msg.reasoning_content || msg.reasoning || '',
      raw: json,
    };
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'timedOut' in e && (e as { timedOut?: boolean }).timedOut) {
      return {
        status: 0,
        headers: {},
        content: '',
        reasoning: '',
        raw: { error: 'timeout' },
        timedOut: true,
      };
    }
    throw e;
  }
}

export async function judgeAdequacy(
  port: number,
  prompt: string,
  answer: string,
): Promise<{ adequacy: number; minimumTier: string; reason: string; available: boolean }> {
  try {
    const judgePrompt =
      `You are a strict grading JSON API. Score the assistant answer for the user prompt.\n` +
      `Independently determine the minimum effort tier the user prompt needs.\n` +
      `Valid tiers: trivial, light, moderate, heavy, intensive, extreme.\n` +
      `Return ONLY JSON: {"adequacy":1-5,"minimum_tier":"one valid tier","reason":"<=200 chars"}\n\n` +
      `USER PROMPT:\n${prompt}\n\nASSISTANT ANSWER:\n${answer.slice(0, 4000)}`;
    const { status, json } = await requestJson(
      port,
      '/v1/chat/completions',
      {
        model: 'zai/glm-4.7-flash',
        stream: false,
        max_tokens: 200,
        messages: [{ role: 'user', content: judgePrompt }],
      },
      {},
      60_000,
    );
    if (status !== 200) return { adequacy: 0, minimumTier: '', reason: `judge_http_${status}`, available: false };
    const raw = json as { choices?: Array<{ message?: { content?: string } }> };
    const text = raw?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { adequacy: 0, minimumTier: '', reason: 'judge_parse_fail', available: false };
    try {
      const parsed = JSON.parse(m[0]) as { adequacy?: unknown; minimum_tier?: unknown; reason?: unknown };
      const adequacy = Number(parsed.adequacy);
      const minimumTier = typeof parsed.minimum_tier === 'string' ? parsed.minimum_tier.trim() : '';
      if (!Number.isInteger(adequacy) || adequacy < 1 || adequacy > 5 || !minimumTier) {
        return { adequacy: 0, minimumTier: '', reason: 'judge_invalid_response', available: false };
      }
      return {
        adequacy,
        minimumTier,
        reason: String(parsed.reason || '').slice(0, 200),
        available: true,
      };
    } catch {
      return { adequacy: 0, minimumTier: '', reason: 'judge_json_fail', available: false };
    }
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'timedOut' in e && (e as { timedOut?: boolean }).timedOut) {
      return { adequacy: 0, minimumTier: '', reason: 'judge_timeout', available: false };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { adequacy: 0, minimumTier: '', reason: message.slice(0, 200), available: false };
  }
}

export async function healthOrThrow(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
      (res) => {
        res.resume();
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) resolve();
        else reject(new Error(`health HTTP ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('health timeout'));
    });
    req.end();
  });
}
