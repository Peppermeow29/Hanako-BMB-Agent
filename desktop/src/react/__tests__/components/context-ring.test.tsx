// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextRing } from '../../components/input/ContextRing';
import { useStore } from '../../stores';
import { refreshSessionCapabilities } from '../../stores/session-actions';

const { sendMock, getWebSocketMock, hanaFetchMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getWebSocketMock: vi.fn(),
  hanaFetchMock: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: getWebSocketMock,
}));

vi.mock('../../stores/session-actions', () => ({
  refreshSessionCapabilities: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: hanaFetchMock,
}));

describe('ContextRing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hanaFetchMock.mockResolvedValue(new Response(JSON.stringify({
      experiments: [{ id: 'session.instant_simple_compaction', value: false }],
    })));
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.OPEN, send: sendMock });
    useStore.setState({
      agentYuan: 'hanako',
      currentSessionId: 'sess_a',
      currentSessionPath: '/session/a.jsonl',
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      contextBySession: {},
      compactingSessions: ['/session/a.jsonl'],
      compactionModeBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      currentSessionPath: null,
      currentSessionId: null,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      contextBySession: {},
      compactingSessions: [],
      compactionModeBySession: {},
    } as never);
  });

  it('stays visible while the current session is compacting before usage arrives', async () => {
    const { container } = render(<ContextRing />);

    await waitFor(() => {
      const button = container.querySelector('button');
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('identifies instant simple compaction in the ring tooltip', async () => {
    useStore.setState({
      compactionModeBySession: { sess_a: 'lossy_local' },
    } as never);
    const { container } = render(<ContextRing />);

    fireEvent.mouseEnter(container.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByText('chat.instantSimpleCompaction')).toBeInTheDocument();
    });
  });

  it('is visible for an active session but never shows the token label', async () => {
    useStore.setState({
      contextBySession: {
        '/session/a.jsonl': { tokens: 12_345, window: 200_000, percent: 6 },
      },
      compactingSessions: [],
    } as never);

    const { container, queryByText } = render(<ContextRing />);

    await waitFor(() => {
      expect(container.querySelector('button')).toBeTruthy();
    });
    expect(queryByText('12k')).toBeNull();
  });

  it('keeps the token label hidden at high usage', async () => {
    useStore.setState({
      contextBySession: {
        '/session/a.jsonl': { tokens: 100_000, window: 200_000, percent: 50 },
      },
      compactingSessions: [],
    } as never);

    const { container, queryByText } = render(<ContextRing />);

    await waitFor(() => {
      expect(container.querySelector('button')).toBeTruthy();
    });
    expect(queryByText('100k')).toBeNull();
  });

  it('opens a two-action menu instead of compacting immediately', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    const button = container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'input.compact',
      'input.refreshAndCompact',
    ]);
    expect(screen.queryByText('chat.instantSimpleCompaction')).not.toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('shows and runs instant simple compaction only when its experiment is enabled', async () => {
    hanaFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      experiments: [{ id: 'session.instant_simple_compaction', value: true }],
    })));
    useStore.setState({ compactingSessions: [] } as never);

    const { container } = render(<ContextRing />);
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/experiments'));
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const actions = await screen.findAllByRole('menuitem');
    expect(actions.map(item => item.textContent)).toEqual([
      'input.compact',
      'input.refreshAndCompact',
      'chat.instantSimpleCompaction',
    ]);
    fireEvent.click(actions[2]);

    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: 'compact',
      sessionId: 'sess_a',
      method: 'instant_simple',
    }));
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
  });

  it('updates the one-shot menu entry when the settings window broadcasts the toggle', async () => {
    useStore.setState({ compactingSessions: [] } as never);
    const { container } = render(<ContextRing />);
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/experiments'));

    window.dispatchEvent(new CustomEvent('hana-settings', {
      detail: {
        type: 'experiment-changed',
        id: 'session.instant_simple_compaction',
        value: true,
      },
    }));
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(await screen.findByText('chat.instantSimpleCompaction')).toBeInTheDocument();
  });

  it('runs fresh compact from the update action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.refreshAndCompact'));

    expect(refreshSessionCapabilities).toHaveBeenCalledWith('/session/a.jsonl');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('shows a tooltip for the update action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.mouseEnter(screen.getByText('input.refreshAndCompact'));

    await waitFor(() => {
      expect(screen.getByText('input.refreshAndCompactTooltip')).toBeInTheDocument();
    });
  });

  it('runs ordinary compact from the compact action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.compact'));

    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({ type: 'compact', sessionId: 'sess_a' }));
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
  });

  it('shows an error instead of sending when session identity is unavailable', () => {
    useStore.setState({ currentSessionId: null, compactingSessions: [] } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.compact'));

    expect(sendMock).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ type: 'error' });
  });

  it('shows an error instead of silently dropping while WebSocket is disconnected', () => {
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.CLOSED, send: sendMock });
    useStore.setState({ compactingSessions: [] } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.compact'));

    expect(sendMock).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ type: 'error' });
  });
});
