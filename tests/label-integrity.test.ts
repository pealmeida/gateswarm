import { describe, expect, it } from 'vitest';
import {
  createVoteRequest,
  getTrainingStats,
  isVoteClarification,
  recordDetectedVoteReply,
} from '../src/training-mode.js';
import {
  getFeedbackEntries,
  getUnjudgedEntries,
  recordGoldVoteFeedback,
  updateAdequacy,
} from '../src/feedback-store.js';
import { getVotes, updateAgentConfig } from '../src/vote-persistence.js';
import { redactSensitive } from '../src/redact.js';

describe('label integrity', () => {
  it('rejects an unbound bare reply when multiple votes are pending', () => {
    const agentId = `multi-pending-${Date.now()}`;
    updateAgentConfig(agentId, { enabled: true, neverAskTiers: [], alwaysAskBelowConfidence: 1 });
    const first = createVoteRequest(agentId, 'first prompt', 'light', 0.1);
    const second = createVoteRequest(agentId, 'second prompt', 'heavy', 0.1);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(recordDetectedVoteReply(agentId, 'yes')).toBeNull();
    expect(getTrainingStats(agentId).pendingVotes).toBe(2);
  });

  it('keeps a negative vote pending and asks for its corrected tier', () => {
    const agentId = `clarification-${Date.now()}`;
    updateAgentConfig(agentId, { enabled: true, neverAskTiers: [], alwaysAskBelowConfidence: 1 });
    const vote = createVoteRequest(agentId, 'clarify prompt', 'heavy', 0.1);

    const result = recordDetectedVoteReply(agentId, `❌ [vote:${vote!.id}]`);
    expect(result).not.toBeNull();
    expect(isVoteClarification(result!)).toBe(true);
    expect(isVoteClarification(result!) && result.clarification).toContain('corrected tier');
    expect(getVotes({ agentId }).find(entry => entry.id === vote!.id)?.voted).toBe(false);
  });

  it('never sends gold entries to judging or lets adequacy overwrite their tier', () => {
    const voteId = `gold-${Date.now()}`;
    const entry = recordGoldVoteFeedback({
      voteId,
      agentId: 'gold-agent',
      promptHash: `hash-${voteId}`,
      promptSnippet: 'gold prompt',
      predictedTier: 'light',
      actualTier: 'heavy',
    });

    expect(getUnjudgedEntries(1).some(candidate => candidate.id === entry.id)).toBe(false);
    updateAdequacy(entry.id, 0.25, 'trivial');
    const updated = getFeedbackEntries().find(candidate => candidate.id === entry.id);
    expect(updated).toMatchObject({ adequacyScore: 0.25, actualTier: 'heavy', source: 'gold_vote' });
  });

  it('redacts API keys, token-shaped values, emails, and long digit runs', () => {
    const text = 'sk-proj_abcdefghijklmnopqrstuvwxyz123456 user@example.com abcdef0123456789abcdef0123456789 call 123456789';
    const redacted = redactSensitive(text);

    expect(redacted).not.toContain('sk-proj_');
    expect(redacted).not.toContain('user@example.com');
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
    expect(redacted).not.toContain('123456789');
    expect(redacted).toContain('[REDACTED_API_KEY]');
    expect(redacted).toContain('[REDACTED_EMAIL]');
  });
});
