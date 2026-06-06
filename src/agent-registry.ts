/**
 * MoMA Gateway — Agent Registry
 * 
 * Manages multi-agent configurations where each agent has:
 * - Unique API key for identification
 * - Custom tier→provider routing profile
 * - Benchmark tracking (on/off)
 * - Usage quotas and rate limits
 * 
 * v0.5.1: Agent Registry
 * v0.5.0: Added CLI provider support (Claude Code, Codex, Pi, Hermes, OpenClaw)
 * CLI providers are subprocess-dispatched, respecting official CLI OAuth/policies.
 *
 * Config: data/agent-registry.json (auto-created)
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import { CliProviderAdapter } from './adapters/cli-provider.js';
import type { CliProviderConfig } from './adapters/cli-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = join(__dirname, '../data/agent-registry.json');

// ─── Types ─────────────────────────────────────────────

export type ProviderType = 'http-api' | 'cli-agent';



export interface HttpProviderConfig {
  id: string;
  name: string;
  type: 'http-api';
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface CliProviderEntry {
  id: string;
  name: string;
  type: 'cli-agent';
  models: string[];
  cliConfig: CliProviderConfig;
}

export type ProviderConfig = HttpProviderConfig | CliProviderEntry;

export interface AgentTierConfig {
  trivial: string;
  light: string;
  moderate: string;
  heavy: string;
  intensive: string;
  extreme: string;
}



export interface AgentConfig {
  id: string;
  name: string;
  apiKey: string;
  provider: string;
  tierConfig: AgentTierConfig;
  benchmarkEnabled: boolean;
  maxTokensPerRequest: number;
  createdAt: string;
  lastUsed: string | null;
  requestCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface RegistryState {
  providers: Record<string, ProviderConfig>;
  agents: Record<string, AgentConfig>;
  defaultAgentId: string;
}

// ─── Default Tier Mappings ─────────────────────────────

export const DEFAULT_TIER_CONFIGS: Record<string, AgentTierConfig> = {
  // Cost-optimized (Coding Plan) — smallest models for low tiers
  'cost-optimized': {
    trivial: 'qwen3.5-plus',        // Bailian — greetings, simple math, facts
    light: 'glm-4.7-flash',        // ZAI — summaries, short Q&A, formatting
    moderate: 'qwen3-coder-plus',  // Bailian — code-capable for code/analysis
    heavy: 'qwen3.6-plus',         // Bailian — Deep reasoning (ZAI glm-5.1 quota exhausted)
    intensive: 'qwen3.5-plus',     // Bailian — complex systems, multi-constraint
    extreme: 'qwen3.6-plus',       // Bailian — elite reasoning, planning
  },
  // Quality-focused — higher baseline for dev/architect agents
  'quality': {
    trivial: 'qwen3.5-plus',        // Bailian
    light: 'glm-4.7-flash',        // ZAI Flash for speed
    moderate: 'qwen3-coder-plus',  // Bailian — code-optimized
    heavy: 'qwen3.6-plus',         // Bailian Deep reasoning
    intensive: 'qwen3.5-plus',     // Bailian — strong reasoning
    extreme: 'qwen3.6-plus',       // Bailian Flagship
  },
  // Balanced — cost/quality tradeoff (Bailian-first)
  'balanced': {
    trivial: 'qwen3.5-plus',        // Bailian
    light: 'qwen3.5-plus',         // Fast + reliable
    moderate: 'qwen3-coder-plus',  // Bailian — code-capable
    heavy: 'qwen3.6-plus',         // Deep reasoning
    intensive: 'qwen3.5-plus',     // Bailian — strong reasoning
    extreme: 'qwen3.6-plus',       // Flagship
  },
  // OpenRouter benchmark
  'benchmark': {
    trivial: 'openrouter/owl-alpha',
    light: 'openrouter/z-ai/glm-4.7-flash',
    moderate: 'openrouter/qwen/qwen-plus',
    heavy: 'openrouter/google/gemini-2.5-flash',
    intensive: 'openrouter/anthropic/claude-sonnet-4.6',
    extreme: 'openrouter/anthropic/claude-opus-4.6',
  },
  // CLI-first (Claude Code for heavy tiers)
  'claude-quality': {
    trivial: 'qwen3.5-plus',
    light: 'glm-4.7-flash',
    moderate: 'cc/claude-sonnet-4-6',
    heavy: 'cc/claude-sonnet-4-6',
    intensive: 'cc/claude-sonnet-4-6',
    extreme: 'cc/claude-opus-4-7',
  },
  // CLI-first (Codex for heavy tiers)
  'codex-heavy': {
    trivial: 'qwen3.5-plus',
    light: 'glm-4.7-flash',
    moderate: 'qwen3-coder-plus',
    heavy: 'cx/gpt-5.3-codex',
    intensive: 'cx/gpt-5.3-codex',
    extreme: 'cc/claude-opus-4-7',
  },
};

// ─── CLI Provider Defaults ─────────────────────────────

export const DEFAULT_CLI_PROVIDERS: Record<string, CliProviderEntry> = {
  'claude-cli': {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    type: 'cli-agent',
    models: ['cc/claude-sonnet-4-6', 'cc/claude-opus-4-7', 'cc/claude-opus-4-8', 'cc/claude-haiku-4-5'],
    cliConfig: {
      command: 'claude',
      argsTemplate: ['--print', '--model', '{model}', '-p', '{prompt}'],
      modelFlag: '--model',
      inputFormat: 'arg',
      outputFormat: 'stdout-text',
      timeoutMs: 300_000,
      maxTokens: 64_000,
      maxConcurrent: 1,
      modelAlias: {
        'cc/claude-sonnet-4-6': 'claude-sonnet-4-6',
        'cc/claude-opus-4-7': 'claude-opus-4-7',
        'cc/claude-opus-4-8': 'claude-opus-4-8',
        'cc/claude-haiku-4-5': 'claude-haiku-4-5',
      },
      healthCheck: { command: 'claude --version', expectedExitCode: 0 },
      quota: {
        type: 'subscription',
        windows: [
          { name: '5-hour', durationMs: 18_000_000, limit: 0, lastReset: 0, used: 0 },
          { name: 'weekly', durationMs: 604_800_000, limit: 0, lastReset: 0, used: 0 },
        ],
      },
    },
  },
  'codex-cli': {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    type: 'cli-agent',
    models: ['cx/gpt-5.5-codex', 'cx/gpt-5.4-codex', 'cx/gpt-5.3-codex', 'cx/gpt-4.1'],
    cliConfig: {
      command: 'codex',
      argsTemplate: ['exec', '-'],
      modelFlag: '--config',
      inputFormat: 'stdin',
      outputFormat: 'stdout-text',
      timeoutMs: 300_000,
      maxTokens: 64_000,
      maxConcurrent: 1,
      modelAlias: {
        'cx/gpt-5.5-codex': 'gpt-5.5',
        'cx/gpt-5.4-codex': 'gpt-5.4',
        'cx/gpt-5.3-codex': 'gpt-5.5',
        'cx/gpt-4.1': 'gpt-4.1',
      },
      healthCheck: { command: 'codex --version', expectedExitCode: 0 },
      quota: {
        type: 'subscription',
        windows: [
          { name: '5-hour', durationMs: 18_000_000, limit: 0, lastReset: 0, used: 0 },
          { name: 'weekly', durationMs: 604_800_000, limit: 0, lastReset: 0, used: 0 },
        ],
      },
    },
  },
  'pi-agent': {
    id: 'pi-agent',
    name: 'Pi Agent (local)',
    type: 'cli-agent',
    models: ['pi/qwen3.5-plus', 'pi/glm-4.7-flash'],
    cliConfig: {
      command: 'node',
      argsTemplate: [process.env.HOME + '/.pi/agent/src/index.js', '-p', '{prompt}', '--model', '{model}', '--json'],
      modelFlag: '--model',
      inputFormat: 'arg',
      outputFormat: 'stdout-json',
      timeoutMs: 180_000,
      maxTokens: 32_000,
      maxConcurrent: 2,
      modelAlias: {
        'pi/qwen3.5-plus': 'qwen3.5-plus',
        'pi/glm-4.7-flash': 'glm-4.7-flash',
      },
      healthCheck: { command: 'ls ' + process.env.HOME + '/.pi/agent/src/index.js', expectedExitCode: 0 },
    },
  },
  'hermes-agent': {
    id: 'hermes-agent',
    name: 'Hermes Agent (self-improving)',
    type: 'cli-agent',
    models: ['hm/glm-4.7', 'hm/glm-4.7-flash'],
    cliConfig: {
      command: 'node',
      argsTemplate: ['/usr/local/lib/hermes-agent/src/agent.js', '-p', '{prompt}', '--model', '{model}', '--json'],
      modelFlag: '--model',
      inputFormat: 'arg',
      outputFormat: 'stdout-json',
      timeoutMs: 180_000,
      maxTokens: 32_000,
      maxConcurrent: 2,
      modelAlias: {
        'hm/glm-4.7': 'glm-4.7',
        'hm/glm-4.7-flash': 'glm-4.7-flash',
      },
      healthCheck: { command: 'ls /usr/local/lib/hermes-agent/src/agent.js', expectedExitCode: 0 },
    },
  },
  'openclaw-agent': {
    id: 'openclaw-agent',
    name: 'OpenClaw Agent (sessions_spawn)',
    type: 'cli-agent',
    models: ['oc/bailian/qwen3.5-plus', 'oc/zai/glm-4.7-flash'],
    cliConfig: {
      command: 'openclaw',
      argsTemplate: ['agent', '--agent', 'main', '--model', '{model}', '--message', '{prompt}', '--timeout', '120', '--json'],
      modelFlag: '--model',
      inputFormat: 'arg',
      outputFormat: 'stdout-json',
      timeoutMs: 180_000,
      maxTokens: 32_000,
      maxConcurrent: 3,
      modelAlias: {
        'oc/bailian/qwen3.5-plus': 'bailian/qwen3.5-plus',
        'oc/zai/glm-4.7-flash': 'zai/glm-4.7-flash',
      },
    },
  },
};

// ─── Registry ──────────────────────────────────────────

const cliAdapters = new Map<string, CliProviderAdapter>();

export class AgentRegistry {
  private state: RegistryState;
  private providers: Record<string, ProviderConfig> = {};

  constructor() {
    this.state = {
      providers: {},
      agents: {},
      defaultAgentId: 'default',
    };
  }

  async initialize(): Promise<void> {
    // Set up HTTP providers from env
    this.registerProvider({
      id: 'bailian',
      name: 'Alibaba Bailian (Coding Plan)',
      type: 'http-api',
      baseUrl: process.env.BAILIAN_BASE || 'https://coding-intl.dashscope.aliyuncs.com/v1',
      apiKey: process.env.BAILIAN_KEY || process.env.OPENAI_API_KEY || '',
      models: ['qwen3.6-plus', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3.6-max-preview', 'qwen4.6'],
    });

    this.registerProvider({
      id: 'zai',
      name: 'Z.AI (GLM Coding Lite)',
      type: 'http-api',
      baseUrl: process.env.ZAI_BASE || 'https://api.z.ai/api/coding/paas/v4',
      apiKey: process.env.ZAI_KEY || process.env.GLM_API_KEY || '',
      models: ['glm-4.7', 'glm-4.7-flash', 'glm-5', 'glm-5-turbo', 'glm-5.1'],
    });

    this.registerProvider({
      id: 'openrouter',
      name: 'OpenRouter (Benchmark)',
      type: 'http-api',
      baseUrl: process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: ['owl-alpha', 'glm-4.7-flash', 'qwen-plus', 'gemini-2.5-flash', 'claude-sonnet-4.6', 'claude-opus-4.6'],
    });

    this.registerProvider({
      id: 'opencodego',
      name: 'OpenCode Go (Multi-model)',
      type: 'http-api',
      baseUrl: process.env.OPENCODEGO_BASE || 'https://opencode.ai/zen/go/v1',
      apiKey: process.env.OPENCODEGO_KEY || '',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.7-plus', 'qwen3.7-max',
               'qwen3.6-plus', 'kimi-k2.5', 'kimi-k2.6', 'glm-5', 'glm-5.1',
               'minimax-m3', 'minimax-m2.7', 'mimo-v2.5', 'mimo-v2.5-pro'],
    });

    // Load persisted state (providers + agents)
    try {
      const raw = await fs.readFile(REGISTRY_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      this.state = { ...this.state, ...saved };
      // Merge persisted provider creds into in-memory providers
      if (saved.providers) {
        for (const [id, persisted] of Object.entries(saved.providers as Record<string, ProviderConfig>)) {
          if (this.providers[id] && persisted.type === 'http-api') {
            // Fill in missing apiKey/baseUrl from persisted data
            const p = this.providers[id] as HttpProviderConfig;
            if (!p.apiKey && (persisted as HttpProviderConfig).apiKey) {
              p.apiKey = (persisted as HttpProviderConfig).apiKey;
            }
            if (!p.baseUrl && (persisted as HttpProviderConfig).baseUrl) {
              p.baseUrl = (persisted as HttpProviderConfig).baseUrl;
            }
          } else if (persisted.type === 'cli-agent') {
            // CLI providers from persisted config
            this.providers[id] = persisted;
          }
        }
      }
    } catch {
      // First run — create defaults
      await this.createDefaultAgents();
    }
  }

  private registerProvider(config: ProviderConfig): void {
    this.providers[config.id] = config;
    this.state.providers[config.id] = config;
  }

  /** Register a CLI provider from default config or custom config. */
  registerCliProvider(config: CliProviderEntry): void {
    this.providers[config.id] = config;
    this.state.providers[config.id] = config;
    // Initialize the adapter
    cliAdapters.set(config.id, new CliProviderAdapter(config.cliConfig));
  }

  /** Register all default CLI providers. */
  registerDefaultCliProviders(): void {
    for (const [, config] of Object.entries(DEFAULT_CLI_PROVIDERS)) {
      this.registerCliProvider(config);
    }
  }

  private async createDefaultAgents(): Promise<void> {
    // Default agent (cost-optimized profile)
    await this.registerAgent({
      name: 'default',
      provider: 'moma',
      tierProfile: 'cost-optimized',
      benchmarkEnabled: true,
    });

    // Quality-focused agent (for dev/architect tasks)
    await this.registerAgent({
      name: 'quality',
      provider: 'moma',
      tierProfile: 'quality',
      benchmarkEnabled: true,
    });

    // Additional agents
    await this.registerAgent({
      name: 'bmad-dev',
      provider: 'moma',
      tierProfile: 'quality',
      benchmarkEnabled: false,
    });

    await this.registerAgent({
      name: 'bmad-architect',
      provider: 'moma',
      tierProfile: 'quality',
      benchmarkEnabled: false,
    });

    // Generic agent (for any new agent)
    await this.registerAgent({
      name: 'default',
      provider: 'moma',
      tierProfile: 'balanced',
      benchmarkEnabled: true,
    });

    await this.save();
  }

  async registerAgent(options: {
    name: string;
    provider: string;
    tierProfile: string;
    benchmarkEnabled?: boolean;
    maxTokensPerRequest?: number;
  }): Promise<AgentConfig> {
    const apiKey = `moma-${randomBytes(16).toString('hex')}`;
    const id = options.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const tierProfileKey = options.tierProfile in DEFAULT_TIER_CONFIGS
      ? options.tierProfile
      : 'balanced';
    const tierConfig = DEFAULT_TIER_CONFIGS[tierProfileKey];

    const agent: AgentConfig = {
      id,
      name: options.name,
      apiKey,
      provider: options.provider,
      tierConfig,
      benchmarkEnabled: options.benchmarkEnabled ?? true,
      maxTokensPerRequest: options.maxTokensPerRequest || 65536,
      createdAt: new Date().toISOString(),
      lastUsed: null,
      requestCount: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };

    this.state.agents[id] = agent;
    await this.save();
    return agent;
  }

  async authenticate(apiKey: string): Promise<AgentConfig | null> {
    // Check all agents
    for (const agent of Object.values(this.state.agents)) {
      if (agent.apiKey === apiKey) {
        agent.lastUsed = new Date().toISOString();
        agent.requestCount++;
        await this.save();
        return agent;
      }
    }
    return null;
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.state.agents[id];
  }

  getAgents(): AgentConfig[] {
    return Object.values(this.state.agents);
  }

  getProviders(): ProviderConfig[] {
    return Object.values(this.providers);
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.providers[id];
  }

  getProviderBaseUrl(providerId: string): string {
    const p = this.providers[providerId];
    if (!p) return '';
    if (p.type === 'cli-agent') return '';
    return (p as HttpProviderConfig).baseUrl || '';
  }

  getProviderApiKey(providerId: string): string {
    const p = this.providers[providerId];
    if (!p) return '';
    if (p.type === 'cli-agent') return '';
    return (p as HttpProviderConfig).apiKey || '';
  }

  // ─── CLI Provider Methods (v0.5) ─────────────────────

  isCliProvider(providerId: string): boolean {
    return this.providers[providerId]?.type === 'cli-agent';
  }

  isHttpProvider(providerId: string): boolean {
    return this.providers[providerId]?.type === 'http-api';
  }

  getCliProviderConfig(providerId: string): CliProviderConfig | null {
    const p = this.providers[providerId];
    if (!p || p.type !== 'cli-agent') return null;
    return (p as CliProviderEntry).cliConfig;
  }

  getCliAdapter(providerId: string): CliProviderAdapter | null {
    return cliAdapters.get(providerId) ?? null;
  }

  getCliProviderQuotaStatus(providerId: string): Record<string, any> {
    const adapter = cliAdapters.get(providerId);
    return adapter?.getQuotaStatus() ?? {};
  }

  /** Check CLI provider availability (health + quota). */
  async checkCliProviderAvailability(providerId: string): Promise<{ ok: boolean; reason?: string }> {
    const adapter = cliAdapters.get(providerId);
    if (!adapter) return { ok: false, reason: 'CLI provider not registered' };
    return adapter.isAvailable();
  }

  /** List all registered models across all provider types. */
  listAllModels(): Array<{ id: string; provider: string; type: ProviderType }> {
    const result: Array<{ id: string; provider: string; type: ProviderType }> = [];
    for (const [, p] of Object.entries(this.providers)) {
      for (const model of p.models) {
        result.push({ id: model, provider: p.id, type: p.type ?? 'http-api' });
      }
    }
    return result;
  }

  // ─── Model Resolution ────────────────────────────────

  resolveModel(agent: AgentConfig, tier: string): { providerId: string; model: string } {
    const model = agent.tierConfig[tier as keyof AgentTierConfig] || agent.tierConfig.moderate;

    // ─── CLI provider prefixes (9router notation) ──────
    if (model.startsWith('cc/')) {
      return { providerId: 'claude-cli', model };
    }
    if (model.startsWith('cx/')) {
      return { providerId: 'codex-cli', model };
    }
    if (model.startsWith('pi/')) {
      return { providerId: 'pi-agent', model };
    }
    if (model.startsWith('hm/')) {
      return { providerId: 'hermes-agent', model };
    }
    if (model.startsWith('oc/')) {
      return { providerId: 'openclaw-agent', model };
    }

    // ─── HTTP provider prefixes ────────────────────────
    if (model.startsWith('openrouter/')) {
      return { providerId: 'openrouter', model: model.replace('openrouter/', '') };
    }
    if (model.startsWith('bailian/')) {
      return { providerId: 'bailian', model: model.replace('bailian/', '') };
    }
    if (model.startsWith('zai/')) {
      return { providerId: 'zai', model: model.replace('zai/', '') };
    }

    // No prefix — detect provider by model name pattern
    // Z.AI models: glm-*
    if (model.startsWith('glm-')) {
      return { providerId: 'zai', model };
    }
    // Bailian models: qwen*, kimi*, MiniMax*
    if (model.startsWith('qwen') || model.startsWith('kimi') || model.startsWith('MiniMax')) {
      return { providerId: 'bailian', model };
    }

    // Fallback: infer from agent provider
    if (agent.provider === 'bailian') {
      return { providerId: 'bailian', model };
    }
    if (agent.provider === 'zai') {
      return { providerId: 'zai', model };
    }
    if (agent.provider === 'openrouter') {
      return { providerId: 'openrouter', model: `openrouter/${model}` };
    }

    // MOA provider — default to bailian for unknown models
    return { providerId: 'bailian', model };
  }

  async updateUsage(agentId: string, tokensIn: number, tokensOut: number): Promise<void> {
    const agent = this.state.agents[agentId];
    if (agent) {
      agent.totalTokensIn += tokensIn;
      agent.totalTokensOut += tokensOut;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(dirname(REGISTRY_FILE), { recursive: true });
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(this.state, null, 2));
  }
}

export const agentRegistry = new AgentRegistry();
