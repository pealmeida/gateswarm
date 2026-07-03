// Self-contained probe against a running GateSwarm gateway.
//   node scripts/demo-gateway-probe.mjs [baseUrl] [agentKey]
// Defaults: http://localhost:8900, key "moma-default" (override with a real
// agent key from `gateswarm agents` when GATESWARM_REQUIRE_AUTH is on).
const BASE = process.argv[2] || process.env.GATESWARM_BASE || 'http://localhost:8900';
const KEY = process.argv[3] || process.env.GATESWARM_KEY || 'moma-default';

async function chat(payload, label) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ max_tokens: 24, ...payload }),
  });
  const b = await r.json().catch(() => ({}));
  const h = (n) => r.headers.get(n) ?? '-';
  console.log(`\n[${label}] status=${r.status}`);
  console.log(`  tier=${h('x-tier')} score=${h('x-score')} modality=${h('x-modality')} routed=${h('x-routed-model')} reason=${h('x-routing-reason')}`);
  const text = b?.choices?.[0]?.message?.content;
  console.log(`  response: ${typeof text === 'string' ? JSON.stringify(text.slice(0, 120)) : JSON.stringify(b?.error || b).slice(0, 160)}`);
}

console.log(`=== GateSwarm probe -> ${BASE} ===`);
await chat({ model: 'auto', messages: [{ role: 'user', content: 'What is 2+2? Answer briefly.' }] }, 'trivial');
await chat({ model: 'auto', messages: [{ role: 'user', content: 'Explain TCP vs UDP: reliability, ordering, and one use case each.' }] }, 'moderate');
await chat({
  model: 'auto',
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'What color is this image? One word.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } },
  ]}],
}, 'vision');
console.log('\n=== probe complete ===');
