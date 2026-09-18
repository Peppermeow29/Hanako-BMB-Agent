// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { executeCompact } from '../../components/input/slash-commands';

const { sendMock, getWebSocketMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getWebSocketMock: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: getWebSocketMock,
}));

const translate = (key: string) => key;

describe('executeCompact', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.OPEN, send: sendMock });
    useStore.setState({ currentSessionId: 'sess_a', currentSessionPath: '/session/a.jsonl', toasts: [] } as never);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('sends only sessionId and keeps the visual timer local to the command', async () => {
    const setBusy = vi.fn();
    const setInput = vi.fn();
    const setMenuOpen = vi.fn();

    await executeCompact(translate, setBusy, setInput, setMenuOpen)();

    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({ type: 'compact', sessionId: 'sess_a' }));
    expect(setBusy).toHaveBeenCalledWith('compact');
    expect(setInput).toHaveBeenCalledWith('');
    expect(setMenuOpen).toHaveBeenCalledWith(false);
  });

  it('shows an error and preserves input when sessionId is unavailable', async () => {
    useStore.setState({ currentSessionId: null } as never);
    const setBusy = vi.fn();
    const setInput = vi.fn();

    await executeCompact(translate, setBusy, setInput, vi.fn())();

    expect(sendMock).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ text: 'error.noActiveSession', type: 'error' });
  });

  it('shows an error and does not clear input when WebSocket is disconnected', async () => {
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.CLOSED, send: sendMock });
    const setInput = vi.fn();

    await executeCompact(translate, vi.fn(), setInput, vi.fn())();

    expect(sendMock).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ text: 'status.disconnected', type: 'error' });
  });
});
