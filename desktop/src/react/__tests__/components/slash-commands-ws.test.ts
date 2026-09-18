// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { executeSlashViaWs } from '../../components/input/slash-commands';

const { sendMock, getWebSocketMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getWebSocketMock: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: getWebSocketMock,
}));

describe('executeSlashViaWs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.OPEN, send: sendMock });
    useStore.setState({ currentSessionPath: '/session/a.jsonl' } as never);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('carries the agent that owns this input box so the server never has to guess', async () => {
    await executeSlashViaWs('stop', 'agent-a', vi.fn(), vi.fn(), vi.fn())();

    expect(JSON.parse(sendMock.mock.calls[0][0])).toEqual({
      type: 'slash',
      text: '/stop',
      sessionPath: '/session/a.jsonl',
      agentId: 'agent-a',
    });
  });

  it('keeps the typed command line intact and still carries the identity', async () => {
    await executeSlashViaWs('reset', 'agent-b', vi.fn(), vi.fn(), vi.fn())('  /reset hard  ');

    expect(JSON.parse(sendMock.mock.calls[0][0])).toMatchObject({
      text: '/reset hard',
      agentId: 'agent-b',
    });
  });

  it('states an unknown identity explicitly instead of dropping the field', async () => {
    // Silently omitting the field is what made the server fall back to its own
    // lookup and then fail with a raw assertion; an explicit null keeps the
    // contract visible on the wire.
    await executeSlashViaWs('stop', null, vi.fn(), vi.fn(), vi.fn())();

    expect(JSON.parse(sendMock.mock.calls[0][0])).toHaveProperty('agentId', null);
  });
});
