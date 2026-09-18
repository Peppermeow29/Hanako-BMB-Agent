// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { useStore } from '../../stores';
import type { ChatMessage } from '../../stores/chat-types';

const retryMock = vi.fn(async (_sessionPath: string, _target: unknown, _options?: unknown) => true);
const forkMock = vi.fn(async (_sessionPath: string, _target: unknown) => ({
  sessionId: 'sess_fork',
  sessionPath: '/session/fork.jsonl',
  agentId: 'hana',
}));
const activateForkMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.copyText': '复制文本',
      'common.screenshot': '截图',
      'common.selectMessage': '选择消息',
      'common.selectAllMessages': '全选消息',
    }[key] || key),
  }),
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: (sessionPath: string, target: unknown, options?: unknown) => retryMock(sessionPath, target, options),
  forkSessionTurn: (sessionPath: string, target: unknown) => forkMock(sessionPath, target),
  activateForkedSession: (forked: unknown) => activateForkMock(forked),
}));

describe('AssistantMessage completion actions', () => {
  const sessionPath = '/session/a.jsonl';
  const userMessage: ChatMessage = {
    id: 'u1',
    sourceEntryId: 'entry-u1',
    role: 'user',
    text: '讲讲月亮',
    textHtml: '<p>讲讲月亮</p>',
    quotedText: '先前的上下文',
    attachments: [{ path: '/tmp/moon.png', name: 'moon.png', isDir: false }],
  };
  const assistantMessage: ChatMessage = {
    id: 'a1',
    sourceEntryId: 'entry-a1',
    role: 'assistant',
    timestamp: new Date(2026, 4, 7, 5, 43).getTime(),
    blocks: [{ type: 'text', html: '<p>月亮很好。</p>' }],
  };

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      t: (key: string) => ({
        'common.regenerate': '重新生成',
        'common.forkSession': '分支为新会话',
      }[key] || key),
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      selectedIdsBySession: {},
      streamingSessions: [],
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: userMessage },
            { type: 'message', data: assistantMessage },
          ],
        },
      },
    } as never);
  });

  it('shows completed time and retry for the latest finished assistant reply', async () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage
        showTurnCompletionTime
        turnTarget={{ role: 'assistant', entryId: 'entry-a1' }}
        retrySourceMessage={userMessage}
      />,
    );

    expect(screen.getByText('05:43')).toBeInTheDocument();
    const footer = screen.getByTestId('assistant-completion-actions');
    expect(footer.className).not.toContain('messageFooterActionsVisible');
    expect(footer.className).toContain('messageFooterActionsTimePersistent');
    expect(within(footer).getByTitle('复制文本')).toBeInTheDocument();
    expect(within(footer).getByTitle('截图')).toBeInTheDocument();
    expect(within(footer).getByTitle('全选消息')).toBeInTheDocument();
    expect(within(footer).getByTitle('选择消息')).toBeInTheDocument();

    const ordered = Array.from(footer.children).map(child => (
      child.textContent?.trim() || child.getAttribute('title') || ''
    ));

    expect(ordered).toEqual([
      '05:43',
      '重新生成',
      '分支为新会话',
      '复制文本',
      '截图',
      '全选消息',
      '选择消息',
    ]);

    fireEvent.click(screen.getByTitle('重新生成'));

    expect(retryMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
      { message: userMessage },
    );
  });

  it('does not render a footer unless the caller marks the assistant message as turn completion', () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage={false}
        turnTarget={{ role: 'assistant', entryId: 'entry-a1' }}
      />,
    );

    expect(screen.queryByText('05:43')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-completion-actions')).not.toBeInTheDocument();
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
  });

  it('keeps retry and fork available for older turn-ending assistant replies', async () => {
    const onForkCreated = vi.fn(async () => undefined);
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage={false}
        showTurnCompletionTime
        turnTarget={{ role: 'assistant', entryId: 'entry-a1' }}
        onForkCreated={onForkCreated}
      />,
    );

    expect(screen.getByText('05:43')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-completion-actions').className).not.toContain('messageFooterActionsTimePersistent');
    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('分支为新会话'));
    await waitFor(() => expect(forkMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1' },
    ));
    expect(onForkCreated).toHaveBeenCalledWith({
      sessionId: 'sess_fork',
      sessionPath: '/session/fork.jsonl',
      agentId: 'hana',
    });
    expect(screen.getByTitle('复制文本')).toBeInTheDocument();
    expect(screen.getByTitle('截图')).toBeInTheDocument();
    expect(screen.getByTitle('全选消息')).toBeInTheDocument();
    expect(screen.getByTitle('选择消息')).toBeInTheDocument();
  });

  it('hides the assistant footer while the assistant reply is still streaming', () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming
        isSelected={false}
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage
        showTurnCompletionTime
        turnTarget={{ role: 'assistant', entryId: 'entry-a1' }}
      />,
    );

    expect(screen.queryByText('05:43')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-completion-actions')).not.toBeInTheDocument();
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
  });
});
