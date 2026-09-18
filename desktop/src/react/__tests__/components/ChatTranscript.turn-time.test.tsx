// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../../components/chat/ChatTranscript';
import { useStore } from '../../stores';
import type { ChatListItem, ContentBlock } from '../../stores/chat-types';

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

const retryMock = vi.fn(async (..._args: unknown[]) => true);

vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: (...args: unknown[]) => retryMock(...args),
  forkSessionTurn: vi.fn(async () => null),
  activateForkedSession: vi.fn(async () => undefined),
}));

const sessionPath = '/session/turn-time.jsonl';

function user(id: string, timestamp: number, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      sourceEntryId: `entry-${id}`,
      role: 'user',
      timestamp,
      text,
      textHtml: `<p>${text}</p>`,
    },
  };
}

function assistant(
  id: string,
  timestamp: number,
  blocks: ContentBlock[],
  turnInputEntryId?: string,
): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      sourceEntryId: `entry-${id}`,
      role: 'assistant',
      timestamp,
      blocks,
      ...(turnInputEntryId ? { turnInputEntryId } : {}),
    },
  };
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', html: `<p>${text}</p>`, source: text };
}

function thinking(content: string): ContentBlock {
  return { type: 'thinking', content, sealed: true };
}

function interlude(id: string, text: string): ChatListItem {
  return {
    type: 'interlude',
    id,
    data: {
      type: 'interlude',
      id,
      variant: 'deferred_result',
      status: 'success',
      text,
    },
  };
}

describe('ChatTranscript turn timestamps', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'thinking.done': '思考完成',
      'common.regenerate': '重新生成',
      'common.forkSession': '分支为新会话',
      'common.copyText': '复制文本',
      'common.screenshot': '截图',
      'common.selectAllMessages': '全选消息',
      'common.selectMessage': '选择消息',
    }[key] || key)) as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      streamingSessions: [],
      selectedIdsBySession: {},
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [],
        },
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows assistant footer only on the final assistant message of each completed turn', () => {
    const items: ChatListItem[] = [
      user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
      assistant('a1-tool', new Date(2026, 4, 7, 8, 1).getTime(), [thinking('读文件')]),
      assistant('a1-final', new Date(2026, 4, 7, 8, 2).getTime(), [textBlock('第一轮完成')]),
      user('u2', new Date(2026, 4, 7, 9, 0).getTime(), '第二轮'),
      assistant('a2-tool', new Date(2026, 4, 7, 9, 1).getTime(), [thinking('跑命令')]),
      assistant('a2-final', new Date(2026, 4, 7, 9, 2).getTime(), [textBlock('第二轮完成')]),
    ];

    render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
      />,
    );

    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.queryByText('08:01')).not.toBeInTheDocument();
    expect(screen.getByText('08:02')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.queryByText('09:01')).not.toBeInTheDocument();
    expect(screen.getByText('09:02')).toBeInTheDocument();
    expect(screen.getAllByTestId('assistant-completion-actions')).toHaveLength(2);
  });

  it('does not render the current assistant footer while the session is still streaming', () => {
    useStore.setState({ streamingSessions: [sessionPath] } as never);

    render(
      <ChatTranscript
        items={[
          user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
          assistant('a1-tool', new Date(2026, 4, 7, 8, 1).getTime(), [thinking('读文件')]),
          assistant('a1-latest', new Date(2026, 4, 7, 8, 2).getTime(), [thinking('继续处理')]),
        ]}
        sessionPath={sessionPath}
      />,
    );

    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.queryByText('08:01')).not.toBeInTheDocument();
    expect(screen.queryByText('08:02')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-completion-actions')).not.toBeInTheDocument();
  });

  it('selects the whole assistant turn from the final assistant footer checkbox', () => {
    const items: ChatListItem[] = [
      user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
      assistant('a1-tool', new Date(2026, 4, 7, 8, 1).getTime(), [thinking('读文件')]),
      assistant('a1-final', new Date(2026, 4, 7, 8, 2).getTime(), [textBlock('第一轮完成')]),
    ];

    render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
      />,
    );

    const footer = screen.getByTestId('assistant-completion-actions');
    fireEvent.click(within(footer).getByTitle('选择消息'));

    expect(useStore.getState().selectedIdsBySession[sessionPath]).toEqual(['a1-tool', 'a1-final']);
  });

  it('targets each historical assistant completion by its own persisted entry id', () => {
    const items: ChatListItem[] = [
      user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
      assistant('a1-final', new Date(2026, 4, 7, 8, 2).getTime(), [textBlock('第一轮完成')]),
      user('u2', new Date(2026, 4, 7, 9, 0).getTime(), '第二轮'),
      assistant('a2-final', new Date(2026, 4, 7, 9, 2).getTime(), [textBlock('第二轮完成')]),
    ];

    render(<ChatTranscript items={items} sessionPath={sessionPath} />);

    const footers = screen.getAllByTestId('assistant-completion-actions');
    fireEvent.click(within(footers[0]).getByTitle('重新生成'));

    expect(retryMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a1-final' },
      { message: expect.objectContaining({ id: 'u1', sourceEntryId: 'entry-u1', text: '第一轮' }) },
    );
  });

  it('keeps hidden-input Agent turns separate and never reuses the preceding visible user envelope', () => {
    const items: ChatListItem[] = [
      user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
      assistant(
        'a1-final',
        new Date(2026, 4, 7, 8, 2).getTime(),
        [textBlock('第一轮完成')],
        'entry-u1',
      ),
      assistant(
        'a2-background',
        new Date(2026, 4, 7, 8, 3).getTime(),
        [textBlock('处理后台结果一')],
        'entry-hidden-input-1',
      ),
      assistant(
        'a3-background',
        new Date(2026, 4, 7, 8, 4).getTime(),
        [textBlock('处理后台结果二')],
        'entry-hidden-input-2',
      ),
    ];

    render(<ChatTranscript items={items} sessionPath={sessionPath} />);

    const footers = screen.getAllByTestId('assistant-completion-actions');
    expect(footers).toHaveLength(3);
    fireEvent.click(within(footers[1]).getByTitle('重新生成'));

    expect(retryMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a2-background' },
    );
  });

  it('falls back to the preceding user entry for a just-finished assistant without a persisted id', () => {
    const freshAssistant: ChatListItem = {
      type: 'message',
      data: {
        id: 'stream-a1',
        role: 'assistant',
        timestamp: new Date(2026, 4, 7, 8, 2).getTime(),
        blocks: [textBlock('刚刚完成')],
      },
    };

    render(
      <ChatTranscript
        items={[
          user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
          freshAssistant,
        ]}
        sessionPath={sessionPath}
      />,
    );

    const assistantFooter = screen.getByTestId('assistant-completion-actions');
    fireEvent.click(within(assistantFooter).getByTitle('重新生成'));

    expect(retryMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant_turn', turnInputEntryId: 'entry-u1' },
      { message: expect.objectContaining({ id: 'u1', sourceEntryId: 'entry-u1', text: '第一轮' }) },
    );
  });

  it('renders interlude timeline items without an assistant message wrapper', () => {
    const { container } = render(
      <ChatTranscript
        items={[
          interlude('deferred:subagent-1:success', 'Hana 收到了后台回复'),
        ]}
        sessionPath={sessionPath}
      />,
    );

    expect(screen.getByText('Hana 收到了后台回复')).toBeInTheDocument();
    expect(container.querySelector('[data-interlude-status="success"]')).toBeInTheDocument();
    expect(container.querySelector('[data-message-id]')).toBeNull();
  });

  it('does not show a new assistant avatar only because an interlude sits between assistant messages', () => {
    render(
      <ChatTranscript
        items={[
          assistant('a1', new Date(2026, 4, 7, 8, 0).getTime(), [textBlock('前一段回复')]),
          interlude('deferred:subagent-2:success', '后台回复已抵达'),
          assistant('a2', new Date(2026, 4, 7, 8, 1).getTime(), [textBlock('继续接话')]),
        ]}
        sessionPath={sessionPath}
      />,
    );

    expect(screen.getByText('前一段回复')).toBeInTheDocument();
    expect(screen.getByText('后台回复已抵达')).toBeInTheDocument();
    expect(screen.getByText('继续接话')).toBeInTheDocument();
    expect(screen.getAllByText('Hana')).toHaveLength(1);
  });
});
