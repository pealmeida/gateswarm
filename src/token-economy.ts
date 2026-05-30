/**
 * Token Economy Tracker — GateSwarm v0.6
 *
 * Tracks raw vs filtered token consumption per agent, per tier,
 * with cumulative savings metrics. Persisted to disk for survival across restarts.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, '../data/token-economy.json');

interface AgentTokenRecord {
  requestCount: number;
  totalRawIn: number;
  totalRawOut: number;
  totalFiltered: number;
  totalSaved: number;
  filterHitCount: number;
  strategyBreakdown: Record<string, number>;
}

interface TokenEconomyState {
  agents: Record<string, AgentTokenRecord>;
  globalTotal: {
    requestCount: number;
    rawIn: number;
    rawOut: number;
    filtered: number;
    saved: number;
  };
  startedAt: string;
  lastReset: string;
}

let state: TokenEconomyState | null = null;

async function loadState(): Promise<TokenEconomyState> {
  if (state) return state;
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf-8');
    state = JSON.parse(raw);
  } catch {
    state = {
      agents: {},
      globalTotal: { requestCount: 0, rawIn: 0, rawOut: 0, filtered: 0, saved: 0 },
      startedAt: new Date().toISOString(),
      lastReset: new Date().toISOString(),
    };
  }
  return state;
}

async function saveState() {
  try {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {}
}

export async function initTokenEconomy() {
  await loadState();
}

export async function recordTokenEconomy(
  agentId: string,
  tier: string,
  rawIn: number,
  rawOut: number,
  filteredOut: number,
  strategy: string,
) {
  const s = await loadState();

  if (!s.agents[agentId]) {
    s.agents[agentId] = {
      requestCount: 0, totalRawIn: 0, totalRawOut: 0,
      totalFiltered: 0, totalSaved: 0, filterHitCount: 0, strategyBreakdown: {},
    };
  }

  const a = s.agents[agentId];
  const saved = Math.max(0, rawOut - filteredOut);

  a.requestCount++;
  a.totalRawIn += rawIn;
  a.totalRawOut += rawOut;
  a.totalFiltered += filteredOut;
  a.totalSaved += saved;
  if (strategy !== 'none') {
    a.filterHitCount++;
    a.strategyBreakdown[strategy] = (a.strategyBreakdown[strategy] || 0) + 1;
  }

  s.globalTotal.requestCount++;
  s.globalTotal.rawIn += rawIn;
  s.globalTotal.rawOut += rawOut;
  s.globalTotal.filtered += filteredOut;
  s.globalTotal.saved += saved;

  saveState().catch(() => {});
}

export function getTokenEconomyStats() {
  if (!state) {
    return {
      agents: {},
      globalTotal: { requestCount: 0, rawIn: 0, rawOut: 0, filtered: 0, saved: 0 },
      startedAt: new Date().toISOString(),
      lastReset: new Date().toISOString(),
    };
  }
  return state;
}

export function getAgentTokenStats(agentId: string): AgentTokenRecord | null {
  if (!state || !state.agents[agentId]) return null;
  return state.agents[agentId];
}

export async function resetTokenEconomy() {
  state = {
    agents: {},
    globalTotal: { requestCount: 0, rawIn: 0, rawOut: 0, filtered: 0, saved: 0 },
    startedAt: new Date().toISOString(),
    lastReset: new Date().toISOString(),
  };
  await saveState();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
