import { describe, expect, it } from 'vitest';
import type { UsageLedgerEntry } from '../../settings/tabs/providers/usage-ledger-actions';
import { groupDateWindowEntries } from '../../settings/tabs/providers/usage-ledger-model';

function entry(requestId: string, endedAt: string, totalTokens: number): UsageLedgerEntry {
  return {
    requestId,
    startedAt: endedAt,
    endedAt,
    durationMs: 10,
    status: 'ok',
    source: { subsystem: 'session', operation: 'reply' },
    attribution: { kind: 'session', agentId: 'hana', sessionPath: '/s/a.jsonl' },
    model: { provider: 'openai', modelId: 'gpt-5', api: 'openai-responses' },
    usage: {
      input: { totalTokens },
      output: { totalTokens: 0 },
      cache: { readTokens: 0, hit: false },
      totalTokens,
      costTotal: 0,
    },
    error: null,
  };
}

describe('usage ledger date window model', () => {
  it('pads the weekly window to seven local days ending on the latest entry date', () => {
    const groups = groupDateWindowEntries([
      entry('req-1', '2026-05-25T12:00:00.000Z', 100),
      entry('req-2', '2026-05-28T12:00:00.000Z', 200),
    ], 'week');

    expect(groups).toHaveLength(7);
    expect(groups.map(group => group.key)).toEqual([
      '2026-05-22',
      '2026-05-23',
      '2026-05-24',
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
      '2026-05-28',
    ]);
    expect(groups.map(group => group.totalTokens)).toEqual([0, 0, 0, 100, 0, 0, 200]);
  });

  it('pads the monthly window to thirty local days ending on the latest entry date', () => {
    const groups = groupDateWindowEntries([
      entry('req-1', '2026-05-01T12:00:00.000Z', 100),
      entry('req-2', '2026-05-28T12:00:00.000Z', 200),
    ], 'month');

    expect(groups).toHaveLength(30);
    expect(groups[0].key).toBe('2026-04-29');
    expect(groups.at(-1)?.key).toBe('2026-05-28');
    expect(groups.find(group => group.key === '2026-05-01')?.totalTokens).toBe(100);
    expect(groups.find(group => group.key === '2026-05-28')?.totalTokens).toBe(200);
  });
});
