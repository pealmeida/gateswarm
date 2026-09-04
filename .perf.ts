import { scoreComplexity, extractFeatures } from 'gateswarm-lite';
const huge = 'analyze this system '.repeat(5000);       // ~100 KB
const big  = 'analyze this system '.repeat(500);        // ~10 KB
const norm = 'Design a distributed cache with failover.';
for (const [label, p] of [['normal (41 B)', norm], ['big (10 KB)', big], ['huge (100 KB)', huge]] as [string,string][]) {
  const n = label.startsWith('normal') ? 200 : 5;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) scoreComplexity(p);
  const per = (performance.now() - t0) / n;
  console.log(`  ${label.padEnd(16)} ${per.toFixed(2)} ms/call`);
}
// isolate the two new regexes on the truncated input
const MAXED = huge.slice(0, 65536);
const B = /^[ \t]*[-*•][ \t]+\S/gm, L = /^([A-Z][A-Za-z0-9 ./-]{2,30}):[ \t]/gm;
for (const [n, re] of [['BULLET_LINE_RE', B], ['LABELLED_FIELD_RE', L]] as [string,RegExp][]) {
  const t = performance.now();
  for (let i = 0; i < 5; i++) [...MAXED.matchAll(re)];
  console.log(`  ${n.padEnd(20)} ${((performance.now()-t)/5).toFixed(2)} ms per pass over 64 KB`);
}
