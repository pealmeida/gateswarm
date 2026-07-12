import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  appendVotePromptToCompletion,
  appendVotePromptToStream,
  createVoteRequest,
  formatVotePrompt,
  getTrainingStats,
  recordDetectedVoteReply,
  persistOrganicGoldLabel,
  type VoteRequest,
} from '../src/training-mode.js';
import { getFeedbackEntries, recordFeedback } from '../src/feedback-store.js';
import { getAgentConfig, getVotes, updateAgentConfig } from '../src/vote-persistence.js';
import { decodeOrganicLabel } from '../src/organic-labels.js';

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

  it('provides the same vote prompt as a stream-safe final content delta', () => {
    const vote: VoteRequest = {
      id: 'vstream123', agentId: 'agent-test', prompt: 'Stream this', predictedTier: 'moderate',
      confidence: 0.55, timestamp: Date.now(), voted: false, userAgreed: null, userCorrectTier: null,
    };

    expect(appendVotePromptToStream(vote).content).toBe(formatVotePrompt(vote));
  });

  it('defaults vote expiry to 24 hours', () => {
    const agentId = `expiry-${Date.now()}`;
    expect(getAgentConfig(agentId).voteExpiryMs).toBe(24 * 60 * 60 * 1000);
  });

  it('uses the v0.6 organic collection defaults', () => {
    const config = getAgentConfig(`defaults-${Date.now()}`);
    expect(config.aleatoryRate).toBe(0.25);
    expect(config.neverAskTiers).toEqual(['trivial']);
  });

  it('round-trips a full prompt through organic gold-label persistence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateswarm-organic-'));
    const path = join(dir, 'labeled.jsonl');
    const prompt = `Design a durable label pipeline ${'with detail '.repeat(40)}`;
    try {
      persistOrganicGoldLabel({
        id: 'vroundtrip',
        agentId: 'organic-roundtrip',
        promptHash: hashPrompt(prompt),
        prompt,
        promptSnippet: prompt.slice(0, 100),
        predictedTier: 'heavy',
        actualTier: null,
        source: 'gold',
        weight: 1,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        voted: false,
        userAgreed: null,
        userCorrectTier: null,
      }, 'moderate', false, path);

      const decoded = decodeOrganicLabel(JSON.parse(readFileSync(path, 'utf-8')));
      expect(decoded).toMatchObject({
        ok: true,
        row: { prompt, predictedTier: 'heavy', actualTier: 'moderate', agreed: false },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      agentId,
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
    const persistedPrompt = getVotes({ agentId }).find((entry) => entry.id === vote?.id)?.prompt;
    expect(persistedPrompt).not.toBe(prompt);
    expect(persistedPrompt).toContain('[REDACTED_NUMBER]');

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

    expect(getTrainingStats(agentId).pendingVotes).toBe(0);
  });
});
