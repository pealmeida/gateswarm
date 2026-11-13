import { agentRegistry, DEFAULT_CLI_PROVIDERS } from '../../src/agent-registry.js';

const registeredByHelper = new Set<string>();

export function registerClaudeCliForTests(): void {
  if (agentRegistry.isCliProvider('claude-cli')) return;
  agentRegistry.registerCliProvider(DEFAULT_CLI_PROVIDERS['claude-cli']);
  registeredByHelper.add('claude-cli');
}

export function restoreCliProvidersRegisteredForTests(): void {
  for (const providerId of registeredByHelper) {
    agentRegistry.unregisterCliProvider(providerId);
  }
  registeredByHelper.clear();
}
