import { describe, it, expect } from 'vitest';
import { rubricHardFail } from '../eval/lib/hybrid-rubric.js';
import {
  markProviderUnhealthy,
  providerSkipReason,
  rowsForLiveScoring,
  summarizeSkippedRows,
} from '../eval/lib/hybrid-live.js';

describe('rubricHardFail', () => {
  it('fails on non-200', () => {
    expect(rubricHardFail({ status: 500, content: 'ok', reasoning: '' }).fail).toBe(true);
  });
  it('fails on empty content+reasoning', () => {
    expect(rubricHardFail({ status: 200, content: '', reasoning: '' }).fail).toBe(true);
  });
  it('fails on empty visible content even when reasoning is present', () => {
    const result = rubricHardFail({ status: 200, content: '   ', reasoning: 'answer is 4' });
    expect(result.fail).toBe(true);
    expect(result.reasons).toContain('empty_content');
  });
  it('passes on content present', () => {
    expect(rubricHardFail({ status: 200, content: '4', reasoning: '' }).fail).toBe(false);
  });
  it('fails on provider authentication error content', () => {
    const result = rubricHardFail({
      status: 200,
      content: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      reasoning: '',
    });
    expect(result.fail).toBe(true);
    expect(result.reasons).toContain('provider_error');
  });
  it('fails on short API auth error content without the failed-auth prefix', () => {
    const result = rubricHardFail({
      status: 200,
      content: 'API Error: 401 Invalid authentication credentials',
      reasoning: '',
    });
    expect(result.fail).toBe(true);
    expect(result.reasons).toContain('provider_error');
  });
  it('does not flag ordinary auth troubleshooting answers as provider errors', () => {
    const result = rubricHardFail({
      status: 200,
      content: 'Check whether the service account key is present, then retry the request.',
      reasoning: '',
    });
    expect(result.reasons).not.toContain('provider_error');
    expect(result.fail).toBe(false);
  });
});

describe('live skip helpers', () => {
  it('marks providers unhealthy by routed model and returns skip reasons', () => {
    const unhealthy = new Map<string, string>();
    markProviderUnhealthy(unhealthy, 'codex-cli/gpt-5', 'provider_error');

    expect(providerSkipReason(unhealthy, 'codex-cli/gpt-5-mini')).toBe('provider_error');
    expect(providerSkipReason(unhealthy, 'zai/glm-4.7-flash')).toBeUndefined();
  });
  it('excludes skipped rows from scoring and summarizes skipped infra rows', () => {
    const rows = [
      { routedModel: 'codex-cli/gpt-5', skipped: true, reason: 'provider_error' },
      { routedModel: 'codex-cli/gpt-5-mini', skipped: true, reason: 'provider_error' },
      { routedModel: 'zai/glm-4.7-flash', skipped: false },
      { routedModel: 'opencode-free/deepseek-v4-flash-free' },
    ];

    expect(rowsForLiveScoring(rows)).toHaveLength(2);
    expect(summarizeSkippedRows(rows)).toEqual([{ provider: 'codex-cli', reason: 'provider_error', count: 2 }]);
  });
});
