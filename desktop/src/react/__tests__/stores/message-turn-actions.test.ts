// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import {
  forkSessionTurn,
  retrySessionTurn,
} from '../../stores/message-turn-actions';
import { installWindowTestT } from '../helpers/i18n-test-strings';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../utils/ui-context', () => ({
  collectUiContext: () => ({ surface: 'test' }),
}));

describe('message turn actions', () => {
  const sessionPath = '/sessions/source.jsonl';
  const sessionId = 'sess_source';
  const setInlineError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    installWindowTestT({
      'error.code.sessionForkActiveTask': '这条消息之后还有任务在跑，等它结束再从这里分支',
      'error.code.sessionBusy': '会话正忙，稍后再试',
      'error.code.unexpected': '出了点意外',
    });
    useStore.setState({
      currentSessionPath: sessionPath,
      currentSessionId: sessionId,
      sessionLocatorsById: { [sessionId]: { path: sessionPath } },
      sessions: [{ path: sessionPath, sessionId }],
      streamingSessions: [],
      setInlineError,
    } as never);
  });

  it('retries an arbitrary persisted user node with explicit session identity and display envelope', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const message = {
      id: 'client-u1',
      sourceEntryId: 'entry-u1',
      role: 'user' as const,
      text: '原消息',
      quotedText: '引用',
      attachments: [{ path: '/tmp/image.png', name: 'image.png', isDir: false }],
    };

    const ok = await retrySessionTurn(
      sessionPath,
      { role: 'user', entryId: 'entry-u1' },
      { message, replacementText: '修改后' },
    );

    expect(ok).toBe(true);
    expect(hanaFetch).toHaveBeenCalledWith('/api/sessions/turns/retry', expect.objectContaining({
      method: 'POST',
      timeout: 30 * 60 * 1000,
      throwOnHttpError: false,
    }));
    const init = vi.mocked(hanaFetch).mock.calls[0][1];
    expect(init).toEqual(expect.objectContaining({
      timeout: 30 * 60 * 1000,
      throwOnHttpError: false,
    }));
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      sessionId,
      sessionPath,
      target: { role: 'user', entryId: 'entry-u1' },
      clientMessageId: 'client-u1',
      text: '修改后',
      uiContext: { surface: 'test' },
      displayMessage: expect.objectContaining({
        text: '修改后',
        quotedText: '引用',
      }),
    }));
  });

  it('forks an assistant node and normalizes the returned child locator', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      sessionId: 'sess_child',
      path: '/sessions/child.jsonl',
      agentId: 'hana',
    }), { status: 200 }));

    const child = await forkSessionTurn(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
    );

    expect(child).toEqual({
      sessionId: 'sess_child',
      sessionPath: '/sessions/child.jsonl',
      agentId: 'hana',
    });
    const init = vi.mocked(hanaFetch).mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId,
      sessionPath,
      target: { role: 'assistant', entryId: 'entry-a1' },
    });
  });

  it('fails visibly instead of guessing when a session id cannot be resolved', async () => {
    useStore.setState({
      currentSessionPath: null,
      currentSessionId: null,
      sessionLocatorsById: {},
      sessions: [],
      streamingSessions: [],
      setInlineError,
    } as never);

    const ok = await retrySessionTurn(
      sessionPath,
      { role: 'assistant_turn', turnInputEntryId: 'entry-u1' },
    );

    expect(ok).toBe(false);
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(setInlineError).toHaveBeenCalledWith(
      sessionPath,
      expect.objectContaining({ detail: expect.stringContaining('sessionId') }),
      6000,
    );
  });

  it('speaks the localized sentence and keeps the backend English as detail when an active task blocks Fork', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'active workflow must finish before Fork',
      code: 'session_fork_active_task',
    }), { status: 409, statusText: 'Conflict' }));

    const child = await forkSessionTurn(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
    );

    expect(child).toBeNull();
    expect(setInlineError).toHaveBeenCalledWith(
      sessionPath,
      {
        text: '这条消息之后还有任务在跑，等它结束再从这里分支',
        detail: 'active workflow must finish before Fork',
        code: 'session_fork_active_task',
      },
      6000,
    );
  });

  it('recognises routes whose error field is the code itself', async () => {
    // POST /sessions/fork answers a streaming session with { error: "session_busy" }, no code field.
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'session_busy',
    }), { status: 409, statusText: 'Conflict' }));

    const child = await forkSessionTurn(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
    );

    expect(child).toBeNull();
    expect(setInlineError).toHaveBeenCalledWith(
      sessionPath,
      { text: '会话正忙，稍后再试', detail: null, code: 'session_busy' },
      6000,
    );
  });

  it('falls back to a readable sentence when the backend sends an unmapped failure', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'session pin order is empty',
      code: 'session_pin_order_empty',
    }), { status: 409, statusText: 'Conflict' }));

    const child = await forkSessionTurn(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
    );

    expect(child).toBeNull();
    expect(setInlineError).toHaveBeenCalledWith(
      sessionPath,
      {
        text: '出了点意外',
        detail: 'session pin order is empty',
        code: 'session_pin_order_empty',
      },
      6000,
    );
  });
});
