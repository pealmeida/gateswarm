/**
 * MoA Gateway — Agent Registry
 * 
 * Manages multi-agent configurations where each agent has:
 * - Unique API key for identification
 * - Custom tier→provider routing profile
 * - Benchmark tracking (on/off)
 * - Usage quotas and rate limits
 * 
 * Config: data/agent-registry.json (auto-created)
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = join(__dirname, '../data/agent-registry.json');

// ─── Types ─────────────────────────────────────────────

export interface AgentTierConfig {
  trivial: string;   // model name for trivial tier
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
  provider: string;        // primary provider: bailian, zai, openrouter, moa
  tierConfig: AgentTierConfig;
  benchmarkEnabled: boolean;
  maxTokensPerRequest: number;
  createdAt: string;
  lastUsed: string | null;
  requestCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
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
};

// ─── Registry ──────────────────────────────────────────

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
    // Set up providers from env
    this.registerProvider({
      id: 'bailian',
      name: 'Alibaba Bailian (Coding Plan)',
      baseUrl: process.env.BAILIAN_BASE || 'https://coding-intl.dashscope.aliyuncs.com/v1',
      apiKey: process.env.BAILIAN_KEY || process.env.OPENAI_API_KEY || '',
      models: ['qwen3.6-plus', 'qwen3.5-plus', 'qwen3-coder-plus', 'qwen3.6-max-preview', 'qwen4.6'],
    });

    this.registerProvider({
      id: 'zai',
      name: 'Z.AI (GLM Coding Lite)',
      baseUrl: process.env.ZAI_BASE || 'https://api.z.ai/api/coding/paas/v4',
      apiKey: process.env.ZAI_KEY || process.env.GLM_API_KEY || '',
      models: ['glm-4.7', 'glm-4.7-flash', 'glm-5', 'glm-5-turbo', 'glm-5.1'],
    });

    this.registerProvider({
      id: 'openrouter',
      name: 'OpenRouter (Benchmark)',
      baseUrl: process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: ['owl-alpha', 'glm-4.7-flash', 'qwen-plus', 'gemini-2.5-flash', 'claude-sonnet-4.6', 'claude-opus-4.6'],
    });

    // Load persisted agents
    try {
      const raw = await fs.readFile(REGISTRY_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      this.state = { ...this.state, ...saved };
      // Merge persisted provider creds into in-memory providers (env overrides if set)
      if (saved.providers) {
        for (const [id, persisted] of Object.entries(saved.providers as Record<string, ProviderConfig>)) {
          if (this.providers[id]) {
            // Fill in missing apiKey/baseUrl from persisted data
            if (!this.providers[id].apiKey && persisted.apiKey) {
              this.providers[id].apiKey = persisted.apiKey;
            }
            if (!this.providers[id].baseUrl && persisted.baseUrl) {
              this.providers[id].baseUrl = persisted.baseUrl;
            }
          } else {
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

  private async createDefaultAgents(): Promise<void> {
    // Default agent (cost-optimized profile)
    await this.registerAgent({
      name: 'default',
      provider: 'moa',
      tierProfile: 'cost-optimized',
      benchmarkEnabled: true,
    });

    // Quality-focused agent (for dev/architect tasks)
    await this.registerAgent({
      name: 'quality',
      provider: 'moa',
      tierProfile: 'quality',
      benchmarkEnabled: true,
    });

    // Additional agents
    await this.registerAgent({
      name: 'bmad-dev',
      provider: 'moa',
      tierProfile: 'quality',
      benchmarkEnabled: false,
    });

    await this.registerAgent({
      name: 'bmad-architect',
      provider: 'moa',
      tierProfile: 'quality',
      benchmarkEnabled: false,
    });

    // Generic agent (for any new agent)
    await this.registerAgent({
      name: 'default',
      provider: 'moa',
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
    const apiKey = `moa-${randomBytes(16).toString('hex')}`;
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

  getProviderBaseUrl(providerId: string): string {
    return this.providers[providerId]?.baseUrl || '';
  }

  getProviderApiKey(providerId: string): string {
    return this.providers[providerId]?.apiKey || '';
  }

  resolveModel(agent: AgentConfig, tier: string): { providerId: string; model: string } {
    const model = agent.tierConfig[tier as keyof AgentTierConfig] || agent.tierConfig.moderate;

    // Determine provider from model prefix
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
    // Z.AI models: glm-* (glm-4.5-air, glm-4.7-flash, glm-4.7, glm-5, glm-5-turbo, glm-5.1)
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
