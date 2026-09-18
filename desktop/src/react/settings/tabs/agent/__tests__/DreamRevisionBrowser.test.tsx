// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreamRevisionBrowser } from '../DreamRevisionBrowser';
import {
  loadDreamRevision,
  loadDreamRevisions,
  restoreDream,
} from '../agent-memory-dream-actions';

vi.mock('../agent-memory-dream-actions', () => ({
  loadDreamRevision: vi.fn(),
  loadDreamRevisions: vi.fn(),
  restoreDream: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => ({
    'error.code.dreamRevisionNotFound': '找不到这个 Dream 版本，它可能已经被清理',
    'settings.memory.dream.errors.restoreFailed': '恢复 Dream 版本失败，当前记忆没有改动',
  } as Record<string, string>)[key] ?? key,
}));

const summaries = [
  {
    schemaVersion: 1 as const,
    revisionId: 'rev-2',
    runId: 'run-2',
    trigger: 'manual' as const,
    createdAt: '2026-08-08T02:00:00.000Z',
    kind: 'pre_restore' as const,
    restoresRevisionId: 'rev-1',
    bodyChars: 40,
    sectionChars: { facts: 10, today: 0, week: 10, longterm: 20 },
  },
  {
    schemaVersion: 1 as const,
    revisionId: 'rev-1',
    runId: 'run-1',
    trigger: 'automatic' as const,
    createdAt: '2026-08-08T01:00:00.000Z',
    kind: 'dream' as const,
    restoresRevisionId: null,
    bodyChars: 30,
    sectionChars: { facts: 10, today: 0, week: 10, longterm: 10 },
  },
];

describe('DreamRevisionBrowser', () => {
  beforeEach(() => {
    vi.mocked(loadDreamRevisions).mockResolvedValue(summaries);
    vi.mocked(loadDreamRevision).mockImplementation(async (_agentId, revisionId) => ({
      ...summaries.find((item) => item.revisionId === revisionId)!,
      before: {
        facts: `- facts ${revisionId}`,
        today: 'today stays intact',
        weekDays: [{ date: '2026-08-07', body: 'week stays intact' }],
        longterm: `- longterm ${revisionId}`,
      },
    }));
    vi.mocked(restoreDream).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens a revision list, previews the selected version, and requires explicit confirmation', async () => {
    render(<DreamRevisionBrowser agentId="hana" open onClose={vi.fn()} />);

    expect(await screen.findByText('- facts rev-2')).toBeInTheDocument();
    expect(screen.getByText('week stays intact')).toBeInTheDocument();
    const revisionButtons = screen.getAllByRole('button').filter((button) =>
      button.textContent?.includes('settings.memory.dream.revisions.characters'));
    expect(revisionButtons[0]).toHaveTextContent('settings.memory.dream.revisions.preRestore');
    expect(revisionButtons[1]).toHaveTextContent('settings.memory.dream.revisions.automatic');

    fireEvent.click(revisionButtons[1]);
    expect(await screen.findByText('- facts rev-1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.memory.dream.revisions.restoreThis'));
    expect(restoreDream).not.toHaveBeenCalled();
    expect(screen.getByText('settings.memory.dream.revisions.confirmHint')).toBeInTheDocument();

    fireEvent.click(screen.getByText('settings.memory.dream.revisions.confirmRestore'));
    await waitFor(() => expect(restoreDream).toHaveBeenCalledWith('hana', 'rev-1'));
    expect(await screen.findByText('settings.memory.dream.revisions.restored')).toBeInTheDocument();
    expect(loadDreamRevisions).toHaveBeenCalledTimes(2);
  });

  it('shows a localized restore error instead of the backend English detail', async () => {
    const codedError = Object.assign(new Error('Dream revision was not found'), {
      code: 'dream_revision_not_found',
    });
    vi.mocked(restoreDream).mockRejectedValueOnce(codedError);
    render(<DreamRevisionBrowser agentId="hana" open onClose={vi.fn()} />);

    expect(await screen.findByText('- facts rev-2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('settings.memory.dream.revisions.restoreThis'));
    fireEvent.click(screen.getByText('settings.memory.dream.revisions.confirmRestore'));

    expect(await screen.findByText('找不到这个 Dream 版本，它可能已经被清理')).toBeInTheDocument();
    expect(screen.queryByText('Dream revision was not found')).not.toBeInTheDocument();
  });
});
