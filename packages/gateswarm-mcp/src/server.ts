/**
 * GateSwarm MCP server core: JSON-RPC 2.0 message handling and the three
 * agent-facing tools (route_prompt, submit_feedback, telemetry_summary).
 * Transport-independent — tests drive handleMessage() directly.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTierBoundaries } from 'gateswarm-lite';
import type { EffortLevel } from 'gateswarm-lite';
import {
  DEFAULT_MATRIX, blendedCost, formatRecalibration, recalibrateMatrix, route, routeSession, selectModel,
} from 'gateswarm-router';
import type { ModelSpec, OutcomeRecord as RouterOutcome, RouteOptions, RoutingStrategy } from 'gateswarm-router';
import {
  appendRecord,
  findDecision,
  promptHash,
  readRecords,
  snippet,
  type DecisionRecord,
  type OutcomeRecord,
} from './store.js';

export const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TIERS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;

export interface ServerState {
  decisions: Map<string, DecisionRecord>;
}

export function createState(): ServerState {
  return { decisions: new Map() };
}

interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function wire(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id as number, result });
}

function wireError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id as number, error: { code, message } });
}

function textResult(id: unknown, text: string, isError = false): string {
  return wire(id, { content: [{ type: 'text', text }], isError });
}

/** Human-readable summary first, machine-parseable payload second. */
function decisionResult(id: unknown, readable: string, payload: unknown): string {
  return wire(id, {
    content: [
      { type: 'text', text: readable },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
  });
}

function loadMatrix(path: string): ModelSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`could not read matrix file "${path}": ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`matrix file "${path}" must be a non-empty array of ModelSpec rows`);
  }
  for (const m of parsed as ModelSpec[]) {
    if (!m.id || !m.provider || !m.maxEffort || !(m.costPer1MInput >= 0) || !(m.costPer1MOutput >= 0) || !(m.quality > 0)) {
      throw new Error(`matrix file "${path}" has an invalid ModelSpec row`);
    }
  }
  return parsed as ModelSpec[];
}

function toolSchemas() {
  const tierEnum = [...TIERS];
  return [
    {
      name: 'route_prompt',
      description:
        'Score a prompt complexity with gateswarm-lite and get the advisory routing decision: which model/provider should handle it, why, and at what blended cost. The caller executes the actual request (directly or through the GateSwarm gateway).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The user prompt to score and route.' },
          project: { type: 'string', description: 'Project/use-case slug for telemetry grouping (letters, digits, ".", "_" or "-").', default: 'default' },
          strategy: { type: 'string', enum: ['cheapest-capable', 'best-value'], default: 'cheapest-capable' },
          matrixPath: { type: 'string', description: 'Optional path to a custom ModelSpec[] JSON matrix.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'route_session',
      description:
        'Sequence-aware routing for multi-turn conversations: pass the accumulated turns (oldest first); the newest context is windowed to a bounded budget (recency-biased) and routed. Use this instead of route_prompt when prior conversation context should influence model selection.',
      inputSchema: {
        type: 'object',
        properties: {
          turns: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Conversation turns, oldest first. The last entry is the newest user message.' },
          project: { type: 'string', default: 'default' },
          strategy: { type: 'string', enum: ['cheapest-capable', 'best-value'], default: 'cheapest-capable' },
          matrixPath: { type: 'string' },
          maxChars: { type: 'number', description: 'Window budget in characters. Default 65536.' },
          keep: { type: 'string', enum: ['head', 'tail'], default: 'tail' },
        },
        required: ['turns'],
      },
    },
    {
      name: 'submit_feedback',
      description:
        'Judge a previous routing decision: was the complexity tier right for this prompt? If wrong, provide the correct tier and get the model that SHOULD have been used. Verdicts feed the golden dataset used to recalibrate the scorer.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'eventId returned by route_prompt.' },
          verdict: { type: 'string', enum: ['correct', 'wrong'] },
          correctTier: { type: 'string', enum: tierEnum, description: 'Required when verdict is "wrong".' },
          notes: { type: 'string' },
          project: { type: 'string', default: 'default' },
        },
        required: ['eventId', 'verdict'],
      },
    },
    {
      name: 'submit_outcome',
      description:
        'Vote on the QUALITY of a delivered result: did the model that handled this actually produce an accurate, usable answer? Distinct from submit_feedback, which judges whether the complexity TIER was right. These votes accumulate per model and drive recalibrate_matrix, so the next routing decision reflects what each model actually delivered.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'eventId from route_prompt/route_session. Supplies model, provider and tier automatically.' },
          modelId: { type: 'string', description: 'Required only when no eventId is given.' },
          provider: { type: 'string' },
          tier: { type: 'string', enum: tierEnum, description: 'Required only when no eventId is given.' },
          verdict: { type: 'string', enum: ['accurate', 'partial', 'inaccurate', 'failed'], description: 'accurate=1.0, partial=0.5, inaccurate=0.0; failed=transport/provider error, excluded from quality.' },
          quality: { type: 'number', minimum: 0, maximum: 1, description: 'Optional explicit score, overrides the verdict mapping.' },
          judge: { type: 'string', enum: ['human', 'model'], default: 'model', description: 'Who judged. Human verdicts are weighted higher during recalibration.' },
          notes: { type: 'string' },
          project: { type: 'string', default: 'default' },
        },
        required: ['verdict'],
      },
    },
    {
      name: 'recalibrate_matrix',
      description:
        'Rebuild the routing matrix from recorded quality votes: each model\'s quality becomes what it actually delivered on this project, and a model that repeatedly underperforms at its ceiling tier is demoted. Returns the recalibrated matrix to pass back as matrixPath/matrix on later routing calls. Advisory — nothing is executed or persisted.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', default: 'default' },
          matrixPath: { type: 'string', description: 'Optional base matrix; defaults to the built-in DEFAULT_MATRIX.' },
          pseudoCounts: { type: 'number', description: 'Observations needed before a model outweighs its prior. Default 8.' },
          minSamplesForDemotion: { type: 'number', description: 'Graded outcomes at a ceiling tier before demotion is allowed. Default 5.' },
        },
      },
    },
    {
      name: 'telemetry_summary',
      description: 'Counts of stored routing decisions and human verdicts per tier for a project.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string', default: 'default' } },
      },
    },
  ];
}

function formatDecision(d: DecisionRecord, cost: number): string {
  return [
    `Routing decision (${d.eventId})`,
    `  tier:        ${d.tier}  (score ${d.score.toFixed(4)})`,
    `  model:       ${d.modelId}  [provider: ${d.provider}]`,
    `  strategy:    ${d.strategy}`,
    `  blended cost: $${cost.toFixed(2)} /1M tokens`,
    `  alternatives: ${d.alternatives.join(', ') || 'none'}`,
    `  reason:      ${d.reason}`,
    ...(d.reason.includes('falling back') ? ['⚠ no matrix model is rated for this tier — decision fell back.'] : []),
  ].join('\n');
}

function handleRoutePrompt(id: unknown, args: Record<string, unknown>, state: ServerState): string {
  const prompt = String(args.prompt ?? '');
  if (!prompt.trim()) {
    return textResult(id, JSON.stringify({ error: 'prompt is empty' }), true);
  }
  const project = String(args.project ?? 'default');
  const strategy = (args.strategy ?? 'cheapest-capable') as RoutingStrategy;
  if (strategy !== 'cheapest-capable' && strategy !== 'best-value') {
    return textResult(id, JSON.stringify({ error: `invalid strategy "${strategy}"` }), true);
  }
  let matrix = DEFAULT_MATRIX;
  if (typeof args.matrixPath === 'string') {
    try {
      matrix = loadMatrix(args.matrixPath);
    } catch (err) {
      return textResult(id, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), true);
    }
  }

  const opts: RouteOptions = { strategy, matrix };
  const decision = route(prompt, opts);
  const eventId = randomUUID();
  const record: DecisionRecord = {
    type: 'decision',
    eventId,
    ts: Date.now(),
    project,
    promptHash: promptHash(prompt),
    promptSnippet: snippet(prompt),
    score: decision.complexity.score,
    tier: decision.complexity.tier,
    boundariesHash: Buffer.from(getTierBoundaries().join(',')).toString('base64url').slice(0, 12),
    strategy: decision.strategy,
    modelId: decision.model.id,
    provider: decision.model.provider,
    alternatives: decision.alternatives.map((a) => a.id),
    reason: decision.reason,
    matrix,
  };
  state.decisions.set(eventId, record);
  appendRecord(project, record);

  return decisionResult(
    id,
    `${formatDecision(record, blendedCost(decision.model))}\n\nIf this tier looks wrong for the prompt, call submit_feedback with eventId "${eventId}".`,
    { eventId, ...decision },
  );
}

function handleRouteSession(id: unknown, args: Record<string, unknown>, state: ServerState): string {
  const rawTurns = args.turns;
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
    return textResult(id, JSON.stringify({ error: 'turns must be a non-empty array of strings' }), true);
  }
  const turns = rawTurns.map((t) => String(t ?? ''));
  if (turns.every((t) => !t.trim())) {
    return textResult(id, JSON.stringify({ error: 'all turns are empty' }), true);
  }
  const project = String(args.project ?? 'default');
  const strategy = (args.strategy ?? 'cheapest-capable') as RoutingStrategy;
  if (strategy !== 'cheapest-capable' && strategy !== 'best-value') {
    return textResult(id, JSON.stringify({ error: `invalid strategy "${strategy}"` }), true);
  }
  let matrix = DEFAULT_MATRIX;
  if (typeof args.matrixPath === 'string') {
    try {
      matrix = loadMatrix(args.matrixPath);
    } catch (err) {
      return textResult(id, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), true);
    }
  }
  const maxChars = typeof args.maxChars === 'number' ? args.maxChars : undefined;
  const keep = args.keep === 'head' ? ('head' as const) : ('tail' as const);

  const decision = routeSession(turns, { strategy, matrix, maxChars, keep });
  const eventId = randomUUID();
  const newest = turns[turns.length - 1];
  const record: DecisionRecord = {
    type: 'decision',
    eventId,
    ts: Date.now(),
    project,
    promptHash: promptHash(turns.join('\n\n')),
    promptSnippet: snippet(`${turns.length} turns; newest: ${newest}`),
    score: decision.complexity.score,
    tier: decision.complexity.tier,
    boundariesHash: Buffer.from(getTierBoundaries().join(',')).toString('base64url').slice(0, 12),
    strategy: decision.strategy,
    modelId: decision.model.id,
    provider: decision.model.provider,
    alternatives: decision.alternatives.map((a) => a.id),
    reason: decision.reason,
    matrix,
    turnsCount: decision.complexity.turnsCount,
    windowChars: decision.complexity.windowChars,
  };
  state.decisions.set(eventId, record);
  appendRecord(project, record);

  const readable = [
    `Routing decision - SESSION (${record.turnsCount} turns, window ${record.windowChars} chars${decision.complexity.truncated ? ', truncated' : ''})`,
    ...formatDecision(record, blendedCost(decision.model)).split('\n').slice(1),
  ].join('\n');

  return decisionResult(
    id,
    `${readable}

If this tier looks wrong for the conversation, call submit_feedback with eventId "${eventId}".`,
    { eventId, ...decision },
  );
}

function handleFeedback(id: unknown, args: Record<string, unknown>, state: ServerState): string {
  const eventId = String(args.eventId ?? '');
  const verdict = args.verdict === 'correct' || args.verdict === 'wrong' ? args.verdict : null;
  if (!verdict) {
    return textResult(id, JSON.stringify({ error: 'verdict must be "correct" or "wrong"' }), true);
  }
  const project = String(args.project ?? 'default');
  const original = state.decisions.get(eventId) ?? findDecision(project, eventId);
  if (!original) {
    return textResult(id, JSON.stringify({ error: `unknown eventId "${eventId}" for project "${project}"` }), true);
  }

  let correctTier: EffortLevel | undefined;
  let reroutedModelId: string | undefined;
  let reroutedProvider: string | undefined;
  if (verdict === 'wrong') {
    correctTier = (TIERS as readonly string[]).includes(args.correctTier as string)
      ? (args.correctTier as EffortLevel)
      : undefined;
    if (!correctTier) {
      return textResult(
        id,
        JSON.stringify({ error: `verdict "wrong" requires a valid correctTier (${TIERS.join('|')})` }),
        true,
      );
    }
    const rerouted = selectReroute(correctTier, original.matrix);
    reroutedModelId = rerouted.id;
    reroutedProvider = rerouted.provider;
  }

  appendRecord(project, {
    type: 'feedback',
    ts: Date.now(),
    project,
    decisionEventId: eventId,
    promptHash: original.promptHash,
    verdict,
    correctTier,
    reroutedModelId,
    reroutedProvider,
    notes: typeof args.notes === 'string' ? args.notes : undefined,
  });

  const lines = [`Verdict recorded: ${verdict} for ${original.modelId} @ tier ${original.tier}.`];
  if (reroutedModelId) {
    lines.push(`With tier "${correctTier}" the router would choose: ${reroutedModelId} [${reroutedProvider}].`);
  }
  lines.push('Thank you — this label feeds the golden dataset that recalibrates scoreComplexity.');
  return textResult(id, lines.join('\n'));
}

function selectReroute(tier: EffortLevel, matrix: ModelSpec[]): ModelSpec {
  return selectModel(tier, matrix).model;
}

const VERDICT_QUALITY: Record<string, number> = { accurate: 1, partial: 0.5, inaccurate: 0, failed: 0 };

function handleSubmitOutcome(id: unknown, args: Record<string, unknown>, state: ServerState): string {
  const verdict = String(args.verdict ?? '');
  if (!(verdict in VERDICT_QUALITY)) {
    return textResult(id, JSON.stringify({ error: 'verdict must be accurate|partial|inaccurate|failed' }), true);
  }
  const project = String(args.project ?? 'default');

  let modelId = typeof args.modelId === 'string' ? args.modelId : '';
  let provider = typeof args.provider === 'string' ? args.provider : '';
  let tier = args.tier as EffortLevel | undefined;
  let decisionEventId: string | undefined;
  let promptHash: string | undefined;

  const eventId = typeof args.eventId === 'string' ? args.eventId : '';
  if (eventId) {
    const original = state.decisions.get(eventId) ?? findDecision(project, eventId);
    if (!original) {
      return textResult(id, JSON.stringify({ error: `unknown eventId "${eventId}" for project "${project}"` }), true);
    }
    modelId = modelId || original.modelId;
    provider = provider || original.provider;
    tier = tier ?? original.tier;
    decisionEventId = eventId;
    promptHash = original.promptHash;
  }
  if (!modelId || !tier || !(TIERS as readonly string[]).includes(tier)) {
    return textResult(id, JSON.stringify({ error: 'provide an eventId, or modelId plus a valid tier' }), true);
  }

  const quality = typeof args.quality === 'number' && args.quality >= 0 && args.quality <= 1
    ? args.quality
    : VERDICT_QUALITY[verdict];
  const record: OutcomeRecord = {
    type: 'outcome',
    ts: Date.now(),
    project,
    decisionEventId,
    promptHash,
    modelId,
    provider: provider || 'unknown',
    tier,
    quality,
    ok: verdict !== 'failed',
    judge: args.judge === 'human' ? 'human' : 'model',
    notes: typeof args.notes === 'string' ? args.notes : undefined,
  };
  appendRecord(project, record);

  return textResult(id, [
    `Quality vote recorded: ${verdict} (${quality.toFixed(2)}) for ${modelId} @ tier ${tier}.`,
    'Run recalibrate_matrix once votes accumulate to fold this into the next routing decision.',
  ].join('\n'));
}

function handleRecalibrate(id: unknown, args: Record<string, unknown>): string {
  const project = String(args.project ?? 'default');
  let matrix = DEFAULT_MATRIX;
  if (typeof args.matrixPath === 'string') {
    try {
      matrix = loadMatrix(args.matrixPath);
    } catch (err) {
      return textResult(id, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), true);
    }
  }
  const outcomes = readRecords(project).filter((r): r is OutcomeRecord => r.type === 'outcome');
  if (!outcomes.length) {
    return textResult(id, JSON.stringify({
      error: `no quality votes recorded for project "${project}" — call submit_outcome after delivering results`,
    }), true);
  }
  // Human verdicts count double; they are the scarcer and more reliable signal.
  const graded: RouterOutcome[] = outcomes.map((o) => ({
    modelId: o.modelId,
    tier: o.tier,
    quality: o.quality,
    ok: o.ok,
    weight: o.judge === 'human' ? 2 : 1,
  }));
  const result = recalibrateMatrix(matrix, graded, {
    pseudoCounts: typeof args.pseudoCounts === 'number' ? args.pseudoCounts : undefined,
    minSamplesForDemotion: typeof args.minSamplesForDemotion === 'number' ? args.minSamplesForDemotion : undefined,
  });
  return decisionResult(
    id,
    `${formatRecalibration(result)}\n\nBased on ${outcomes.length} quality vote(s) across ${new Set(outcomes.map((o) => o.modelId)).size} model(s).`,
    { matrix: result.matrix, calibrations: result.calibrations, unknownModelIds: result.unknownModelIds },
  );
}

function handleSummary(id: unknown, args: Record<string, unknown>): string {
  const project = String(args.project ?? 'default');
  const records = readRecords(project);
  const decisions = records.filter((r) => r.type === 'decision') as DecisionRecord[];
  const feedback = records.filter((r) => r.type === 'feedback');
  const byTier: Record<string, number> = {};
  for (const d of decisions) byTier[d.tier] = (byTier[d.tier] ?? 0) + 1;
  const verdicts = { correct: 0, wrong: 0 };
  for (const f of feedback) {
    if (f.type === 'feedback' && f.verdict in verdicts) verdicts[f.verdict as keyof typeof verdicts]++;
  }
  const outcomes = records.filter((r): r is OutcomeRecord => r.type === 'outcome');
  const quality: Record<string, { n: number; mean: number; failures: number }> = {};
  for (const o of outcomes) {
    const q = (quality[o.modelId] ??= { n: 0, mean: 0, failures: 0 });
    if (o.ok) { q.mean = (q.mean * q.n + o.quality) / (q.n + 1); q.n++; } else { q.failures++; }
  }
  for (const q of Object.values(quality)) q.mean = Number(q.mean.toFixed(3));
  return textResult(
    id,
    JSON.stringify(
      { project, decisions: decisions.length, byTier, feedback: feedback.length, verdicts,
        outcomes: outcomes.length, qualityByModel: quality },
      null, 2,
    ),
  );
}

/** Handle one JSON-RPC message. Returns a response line, or null for notifications. */
export function handleMessage(state: ServerState, line: string): string | null {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(line) as IncomingMessage;
  } catch {
    return wireError(null, -32700, 'parse error');
  }
  const id = msg.id;

  switch (msg.method) {
    case 'initialize': {
      const requested = String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? PROTOCOL_VERSION);
      const version = SUPPORTED.includes(requested) ? requested : PROTOCOL_VERSION;
      return wire(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'gateswarm-mcp', version: '0.1.0' },
      });
    }
    case 'notifications/initialized':
      return null;
    case 'ping':
      return wire(id, {});
    case 'tools/list':
      return wire(id, { tools: toolSchemas() });
    case 'tools/call': {
      const name = String((msg.params as { name?: string })?.name ?? '');
      const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
          case 'route_prompt':
            return handleRoutePrompt(id, args, state);
          case 'route_session':
            return handleRouteSession(id, args, state);
          case 'submit_feedback':
            return handleFeedback(id, args, state);
          case 'submit_outcome':
            return handleSubmitOutcome(id, args, state);
          case 'recalibrate_matrix':
            return handleRecalibrate(id, args);
          case 'telemetry_summary':
            return handleSummary(id, args);
          default:
            return textResult(id, JSON.stringify({ error: `unknown tool "${name}"` }), true);
        }
      } catch (err) {
        return textResult(id, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), true);
      }
    }
    default:
      return id === undefined || id === null ? null : wireError(id, -32601, `method not found: ${String(msg.method)}`);
  }
}
