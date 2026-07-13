import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];

function temporaryDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  delete process.env.MOMA_TRAINING_DATA_DIR;
  delete process.env.MOMA_FEEDBACK_DATA_DIR;
  delete process.env.MOMA_RAG_DATA_DIR;
  vi.resetModules();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('durable JSON persistence', () => {
  it('preserves corrupt vote snapshots, replays journals, and compacts atomically', async () => {
    const directory = temporaryDir('gateswarm-votes-');
    writeFileSync(join(directory, 'votes.json'), '{not json', 'utf-8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.MOMA_TRAINING_DATA_DIR = directory;

    const votes = await import('../src/vote-persistence.js');
    expect(votes.getVotes()).toEqual([]);
    expect(readdirSync(directory)).toContainEqual(expect.stringMatching(/^votes\.json\.corrupt-\d+$/));
    expect(error).toHaveBeenCalled();

    votes.saveVote({
      id: 'journaled', agentId: 'durable', promptHash: 'hash', prompt: 'prompt', promptSnippet: 'prompt',
      predictedTier: 'light', actualTier: null, source: 'gold', weight: 1, timestamp: 1,
      expiresAt: Date.now() + 10_000, voted: false, userAgreed: null, userCorrectTier: null,
    });
    expect(readFileSync(join(directory, 'votes.journal.jsonl'), 'utf-8')).toContain('journaled');
    votes.compactVotes();

    expect(JSON.parse(readFileSync(join(directory, 'votes.json'), 'utf-8'))).toHaveLength(1);
    expect(readdirSync(directory).some(name => name.includes('.tmp-'))).toBe(false);
    error.mockRestore();
  });

  it('replays a feedback mutation journal before serving data', async () => {
    const directory = temporaryDir('gateswarm-feedback-');
    process.env.MOMA_FEEDBACK_DATA_DIR = directory;
    writeFileSync(join(directory, 'entries.json'), '[]', 'utf-8');
    writeFileSync(join(directory, 'entries.journal.jsonl'), `${JSON.stringify({
      type: 'upsert', entry: {
        id: 'feedback-journaled', timestamp: 1, promptHash: 'hash', predictedTier: 'light', actualTier: null,
        modelUsed: 'test', responseTokens: 0, adequacyScore: null, escalated: false, userSatisfaction: null,
      },
    })}\n`, 'utf-8');

    const feedback = await import('../src/feedback-store.js');
    feedback.initFeedbackStore();
    expect(feedback.getFeedbackEntries().map(entry => entry.id)).toContain('feedback-journaled');

    feedback.recordFeedback({
      prompt: 'durable feedback mutation', predictedTier: 'light', actualTier: null, modelUsed: 'test',
      responseTokens: 0, adequacyScore: null, escalated: false, userSatisfaction: null,
    });
    expect(readFileSync(join(directory, 'entries.journal.jsonl'), 'utf-8')).toContain('durable feedback mutation');
  });

  it('preserves a corrupt RAG index rather than overwriting it', async () => {
    const directory = temporaryDir('gateswarm-rag-');
    process.env.MOMA_RAG_DATA_DIR = directory;
    writeFileSync(join(directory, 'index.json'), '{not json', 'utf-8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const rag = await import('../src/rag-index.js');
    expect(rag.initRagIndex()).toEqual([]);
    expect(readdirSync(directory)).toContainEqual(expect.stringMatching(/^index\.json\.corrupt-\d+$/));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('restores per-agent fatigue counts from persisted votes on boot', async () => {
    const directory = temporaryDir('gateswarm-fatigue-');
    process.env.MOMA_TRAINING_DATA_DIR = directory;
    const vote = (id: string) => ({
      id, agentId: 'fatigue-agent', promptHash: id, prompt: 'prompt', promptSnippet: 'prompt', predictedTier: 'light',
      actualTier: null, source: 'gold', weight: 1, timestamp: 1, expiresAt: Date.now() + 10_000,
      voted: false, userAgreed: null, userCorrectTier: null,
    });
    writeFileSync(join(directory, 'votes.json'), JSON.stringify([vote('one'), vote('two')]), 'utf-8');

    const training = await import('../src/training-mode.js');
    expect(training.getTrainingStats('fatigue-agent').fatigueDecay).toBeCloseTo(Math.exp(-2 / 50));
  });
});
