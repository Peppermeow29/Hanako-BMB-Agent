/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  fetchHistoryFiles: vi.fn(async () => [
    { relPath: 'notes/a.md', deletedAt: null, lastCapturedAt: 1000, snapshotCount: 2 },
    { relPath: 'gone.md', deletedAt: 2000, lastCapturedAt: 900, snapshotCount: 1 },
  ]),
  fetchHistoryVersions: vi.fn(async () => [
    { id: 7, capturedAt: 1000, origin: 'event', opContext: 'agent_tool', rawSize: 5 },
  ]),
  fetchHistorySnapshot: vi.fn(async () => ({
    relPath: 'notes/a.md', capturedAt: 1000, origin: 'event', content: 'old',
  })),
  restoreHistorySnapshot: vi.fn(async () => ({ ok: true, relPath: 'notes/a.md' })),
}));
vi.mock('../../utils/file-history-api', () => mocks);

import { FileHistoryModal } from '../../components/file-history/FileHistoryModal';
import { useStore } from '../../stores';

beforeEach(() => {
  vi.clearAllMocks();
  window.t = ((key: string) => key) as typeof window.t;
  useStore.setState({
    fileHistoryModal: { open: true, preselectRelPath: null },
    currentAgentId: 'hana',
  } as never);
});

afterEach(() => {
  cleanup();
  useStore.setState({ fileHistoryModal: { open: false, preselectRelPath: null } } as never);
});

describe('FileHistoryModal', () => {
  it('loads and renders the tracked file list with a deleted group', async () => {
    render(<FileHistoryModal />);
    await waitFor(() => expect(screen.getByText('notes/a.md')).toBeTruthy());
    expect(screen.getByText('gone.md')).toBeTruthy();
  });

  it('loads versions when a file is selected and restores on confirm', async () => {
    render(<FileHistoryModal />);
    await waitFor(() => expect(screen.getByText('notes/a.md')).toBeTruthy());
    fireEvent.click(screen.getByText('notes/a.md'));
    await waitFor(() => expect(mocks.fetchHistoryVersions).toHaveBeenCalled());
    const versionRow = await screen.findByTestId('fh-version-7');
    fireEvent.click(versionRow);
    await waitFor(() => expect(mocks.fetchHistorySnapshot).toHaveBeenCalledWith('hana', 7));
    fireEvent.click(screen.getByTestId('fh-restore'));
    await waitFor(() => expect(mocks.restoreHistorySnapshot).toHaveBeenCalledWith('hana', 7));
  });
});
