import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  appendVotePromptToCompletion,
  createVoteRequest,
  formatVotePrompt,
  getTrainingStats,
  recordDetectedVoteReply,
  type VoteRequest,
} from '../src/training-mode.js';
import { getFeedbackEntries, recordFeedback } from '../src/feedback-store.js';
import { getAgentConfig, updateAgentConfig } from '../src/vote-persistence.js';

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

describe('training mode organic votes', () => {
  it('appends the formatted vote prompt to the assistant content and keeps structured metadata', () => {
    const vote: VoteRequest = {
      id: 'vtest123',
      agentId: 'agent-test',
      prompt: 'Build a router',
      predictedTier: 'heavy',
      confidence: 0.62,
      timestamp: Date.now(),
      voted: false,
      userAgreed: null,
      userCorrectTier: null,
    };

    const response = appendVotePromptToCompletion({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Done.' },
        finish_reason: 'stop',
      }],
    }, vote);

    expect(response.choices[0].message.content).toContain('Done.');
    expect(response.choices[0].message.content).toContain(formatVotePrompt(vote).trim());
    expect(response._voteRequest).toMatchObject({
      id: 'vtest123',
      predictedTier: 'heavy',
      confidence: 0.62,
    });
    expect(response._voteRequest.prompt).toContain('Router chose: heavy');
  });

  it('defaults vote expiry to 24 hours', () => {
    const agentId = `expiry-${Date.now()}`;
    expect(getAgentConfig(agentId).voteExpiryMs).toBe(24 * 60 * 60 * 1000);
  });

  it('intercepts a pending chat vote reply and records gold feedback', () => {
    const agentId = `organic-${Date.now()}`;
    const prompt = `Please refactor this subsystem ${Date.now()}`;
    const promptHash = hashPrompt(prompt);

    updateAgentConfig(agentId, {
      enabled: true,
      neverAskTiers: [],
      alwaysAskBelowConfidence: 0.95,
      voteExpiryMs: 24 * 60 * 60 * 1000,
    });

    recordFeedback({
      prompt,
      predictedTier: 'heavy',
      actualTier: null,
      modelUsed: 'test/model',
      responseTokens: 12,
      adequacyScore: null,
      escalated: false,
      userSatisfaction: null,
      score: 0.39,
    });

    const vote = createVoteRequest(agentId, prompt, 'heavy', 0.2, 0.39);
    expect(vote).not.toBeNull();

    const recorded = recordDetectedVoteReply(agentId, '❌ moderate');
    expect(recorded).toMatchObject({
      agentId,
      promptHash,
      predictedTier: 'heavy',
      actualTier: 'moderate',
      agreed: false,
    });

    const matchingFeedback = getFeedbackEntries().find(e => e.promptHash === promptHash);
    expect(matchingFeedback).toMatchObject({
      actualTier: 'moderate',
      source: 'gold_vote',
      score: 0.39,
    });

    const organicPath = new URL('../data/organic/labeled.jsonl', import.meta.url);
    expect(existsSync(organicPath)).toBe(true);
    const lines = readFileSync(organicPath, 'utf-8').trim().split('\n');
    const organic = lines.map(line => JSON.parse(line)).find(row => row.promptHash === promptHash);
    expect(organic).toMatchObject({ agentId, predictedTier: 'heavy', actualTier: 'moderate', agreed: false });
    expect(getTrainingStats(agentId).pendingVotes).toBe(0);
  });
});
