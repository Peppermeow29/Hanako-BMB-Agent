// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityPanel } from '../../components/ActivityPanel';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../hooks/use-panel', () => ({
  usePanel: () => ({ visible: true, close: vi.fn() }),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(() => Promise.resolve({ desk: { heartbeat_master: true } })),
  invalidateConfigCache: vi.fn(),
}));

describe('ActivityPanel', () => {
  beforeEach(() => {
    window.t = ((key: string, vars?: Record<string, string>) => {
      if (key === 'activity.duration') return `耗时 ${vars?.text || ''}`;
      return key;
    }) as typeof window.t;
    vi.mocked(hanaFetch).mockImplementation((path: string) => {
      if (path === '/api/desk/activities/act_cover/session') {
        return Promise.resolve({
          json: () => Promise.resolve({
            messages: [{ role: 'assistant', content: 'cover 已经生成' }],
          }),
        } as Response);
      }
      return Promise.resolve({
        json: () => Promise.resolve({}),
      } as Response);
    });
    useStore.setState({
      activities: [{
        id: 'act_cover',
        type: 'beautify',
        label: 'Markdown cover',
        status: 'running',
        agentId: 'agent-hana',
        agentName: 'Hanako',
        summary: '正在为 傍晚.md 生成 cover',
        sessionFile: 'act_cover.jsonl',
        startedAt: Date.now(),
      }],
      agents: [{ id: 'agent-hana', name: 'Hanako', yuan: '', isPrimary: true }],
      currentAgentId: 'agent-hana',
      agentName: 'Hanako',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('leaves loading state and renders the background session transcript after expansion', async () => {
    render(<ActivityPanel />);

    await screen.findByText('正在为 傍晚.md 生成 cover');
    fireEvent.click(screen.getByRole('button', { name: 'activity.expand' }));

    expect(screen.getByText('activity.loadingSession')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('cover 已经生成')).toBeInTheDocument();
    });
    expect(screen.queryByText('activity.loadingSession')).not.toBeInTheDocument();
  });
});
