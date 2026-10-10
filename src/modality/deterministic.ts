/**
 * Pluggable deterministic handlers: no LLM, no network, no eval. A handler is pure (input string -> result).
 * Register custom ones with registerDeterministicHandler (e.g. schema validation, lookup tables, regex parsers).
 */
export interface DeterministicHandler { id: string; description: string; run(input: string): { ok: true; output: string } | { ok: false; error: string } }
const handlers = new Map<string, DeterministicHandler>();
export function registerDeterministicHandler(h: DeterministicHandler): void { handlers.set(h.id, h); }
export function getDeterministicHandler(id: string): DeterministicHandler | undefined { return handlers.get(id); }
export function listDeterministicHandlers(): Array<{ id: string; description: string }> { return [...handlers.values()].map((h) => ({ id: h.id, description: h.description })); }

/** Recursive-descent arithmetic: + - * / % ^ and parentheses, decimal numbers. No identifiers, no eval. */
export function evalArithmetic(src: string): number {
  const s = src.replace(/\s+/g, '').replace(/,/g, '.');
  let i = 0;
  const peek = () => s[i];
  function num(): number {
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error('expected number');
    i += m[0].length; return parseFloat(m[0]);
  }
  function atom(): number {
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw new Error('missing )'); i++; return v; }
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '+') { i++; return atom(); }
    return num();
  }
  function pow(): number { const b = atom(); if (peek() === '^') { i++; return Math.pow(b, pow()); } return b; }
  function term(): number {
    let v = pow();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[i++]; const r = pow();
      if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  if (!s) throw new Error('empty');
  const v = expr();
  if (i !== s.length) throw new Error('unexpected input');
  if (!Number.isFinite(v)) throw new Error('not finite');
  return v;
}

registerDeterministicHandler({
  id: 'math', description: 'arithmetic expression evaluator (+ - * / % ^ parentheses)',
  run: (input) => { try { const v = evalArithmetic(input); return { ok: true, output: String(Math.round(v * 1e12) / 1e12) }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
});
registerDeterministicHandler({
  id: 'json-format', description: 'validate + pretty-print JSON',
  run: (input) => { try { return { ok: true, output: JSON.stringify(JSON.parse(input), null, 2) }; } catch (e) { return { ok: false, error: `invalid JSON: ${(e as Error).message.slice(0, 80)}` }; } },
});
