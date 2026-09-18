/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  loadLlmUsageEntries: vi.fn(),
}));

vi.mock('../../settings/tabs/providers/usage-ledger-actions', () => ({
  loadLlmUsageEntries: () => mocks.loadLlmUsageEntries(),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    const labels: Record<string, string> = {
      'settings.usage.title': 'Usage',
      'settings.usage.note': 'Usage is for reference only.',
      'settings.usage.refresh': 'Refresh',
      'settings.usage.total': 'All',
      'settings.usage.requests': 'Requests',
      'settings.usage.totalTokens': 'Total tokens',
      'settings.usage.cacheRead': 'Cache read',
      'settings.usage.cacheHitRate': 'Hit rate',

      'settings.usage.uncached': 'Uncached',
      'settings.usage.modelMix': 'Model mix',
      'settings.usage.dailyUsage': 'Daily usage',
      'settings.usage.requestLedger': 'Request ledger',
      'settings.usage.window.week': 'Last 7 days',
      'settings.usage.window.month': 'Last 30 days',
      'settings.usage.view.overall': 'Overall',
      'settings.usage.view.daily': 'Date',
      'settings.usage.view.category': 'Category',
      'settings.usage.view.model': 'Model',
      'settings.usage.period.week': 'Week',
      'settings.usage.period.month': 'Month',
      'settings.usage.category.session': 'Session',
      'settings.usage.category.compaction': 'Compaction',
      'settings.usage.status.ok': 'Ok',
      'settings.usage.status.error': 'Error',
    };
    if (key === 'settings.usage.groupMeta') return `${params?.requests} requests / ${params?.errors} errors`;
    if (key === 'settings.usage.cacheShort') return `cache ${params?.tokens}`;
    if (key === 'settings.usage.tokensShort') return `${params?.tokens} tok`;
    if (key === 'settings.usage.cacheSummary') return `cache ${params?.cache} / uncached ${params?.uncached}`;
    return labels[key] || key;
  },
}));

import { UsageLedgerSection } from '../../settings/tabs/providers/UsageLedgerSection';

describe('UsageLedgerSection', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('groups usage by category and model', async () => {
    mocks.loadLlmUsageEntries.mockResolvedValue([
      {
        requestId: 'req-1',
        startedAt: '2026-05-25T00:00:00.000Z',
        endedAt: '2026-05-25T00:00:01.000Z',
        durationMs: 1000,
        status: 'ok',
        source: { subsystem: 'session', operation: 'reply' },
        attribution: { kind: 'session', agentId: 'hana', sessionPath: '/s/a.jsonl' },
        model: { provider: 'openai', modelId: 'gpt-5', api: 'openai-responses' },
        usage: {
          input: { totalTokens: 100, uncachedTokens: 40 },
          output: { totalTokens: 25 },
          cache: { readTokens: 60, hit: true },
          totalTokens: 1250,
          costTotal: 0.001,
        },
        error: null,
      },
      {
        requestId: 'req-2',
        startedAt: '2026-05-25T00:00:02.000Z',
        endedAt: '2026-05-25T00:00:03.000Z',
        durationMs: 1000,
        status: 'error',
        source: { subsystem: 'compaction', operation: 'compact' },
        attribution: { kind: 'session', agentId: 'hana', sessionPath: '/s/a.jsonl' },
        model: { provider: 'anthropic', modelId: 'claude', api: 'anthropic-messages' },
        usage: {
          input: { totalTokens: 50 },
          output: { totalTokens: 0 },
          cache: { readTokens: 0, hit: false },
          totalTokens: 1250000,
          costTotal: 0,
        },
        error: { message: 'empty', name: 'AppError' },
      },
    ]);

    render(<UsageLedgerSection />);

    expect(await screen.findByText('Usage is for reference only.')).toBeInTheDocument();
    expect((await screen.findAllByText('1.3M')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('1.3K')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Model mix')).length).toBeGreaterThan(0);
    expect(screen.getByText('Request ledger')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Model' }));

    expect(await screen.findByText('openai / gpt-5')).toBeInTheDocument();
    expect(screen.getByText('anthropic / claude')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Category' }));

    expect(await screen.findByText('Session')).toBeInTheDocument();
    expect(screen.getByText('Compaction')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Date' }));

    expect((await screen.findAllByText('Last 7 days')).length).toBeGreaterThan(0);
  });

  it('shows a weekly date window by default and switches to a monthly window', async () => {
    mocks.loadLlmUsageEntries.mockResolvedValue([
      {
        requestId: 'req-1',
        startedAt: '2026-05-28T00:00:00.000Z',
        endedAt: '2026-05-28T00:00:01.000Z',
        durationMs: 1000,
        status: 'ok',
        source: { subsystem: 'session', operation: 'reply' },
        attribution: { kind: 'session', agentId: 'hana', sessionPath: '/s/a.jsonl' },
        model: { provider: 'openai', modelId: 'gpt-5', api: 'openai-responses' },
        usage: {
          input: { totalTokens: 100 },
          output: { totalTokens: 0 },
          cache: { readTokens: 0, hit: false },
          totalTokens: 100,
          costTotal: 0,
        },
        error: null,
      },
    ]);

    render(<UsageLedgerSection />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Date' }));

    expect(await screen.findByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTitle(/·/)).toHaveLength(7);
    expect(screen.getAllByText('Last 7 days').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTitle(/·/)).toHaveLength(30);
    expect(screen.getAllByText('Last 30 days').length).toBeGreaterThan(0);
  });
});
