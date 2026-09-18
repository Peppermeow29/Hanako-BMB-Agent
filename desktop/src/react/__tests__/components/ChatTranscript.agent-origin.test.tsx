// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../../components/chat/ChatTranscript';
import { useStore } from '../../stores';
import type { ChatListItem } from '../../stores/chat-types';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

const sessionPath = '/session/agent-origin.jsonl';

describe('ChatTranscript agent origin routing', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      if (key === 'sessionCollab.fromAgent') return `来自 ${params?.name ?? 'Agent'} 的消息`;
      if (key === 'common.regenerate') return '重新生成';
      if (key === 'common.forkSession') return '分支为新会话';
      return key;
    }) as typeof window.t;
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
  });

  it('renders AgentOriginMessage for messages carrying an agent origin', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'u1',
        sourceEntryId: 'entry-u1',
        role: 'user',
        timestamp: Date.now(),
        text: '跨 session 投递的消息',
        origin: { kind: 'agent', agentId: 'hanako', agentName: 'Hanako' },
      },
    }];

    render(<ChatTranscript items={items} sessionPath={sessionPath} agentId="hana" />);

    expect(screen.getByText('来自 Hanako 的消息')).toBeInTheDocument();
    expect(screen.getByText('跨 session 投递的消息')).toBeInTheDocument();
    expect(screen.getByTestId('agent-origin-node-actions')).toBeInTheDocument();
    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    expect(screen.getByTitle('分支为新会话')).toBeInTheDocument();
  });

  it('renders a normal UserMessage for messages without an agent origin', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'u2',
        role: 'user',
        timestamp: Date.now(),
        text: '普通用户消息',
        textHtml: '<p>普通用户消息</p>',
      },
    }];

    render(<ChatTranscript items={items} sessionPath={sessionPath} agentId="hana" />);

    expect(screen.getByText('普通用户消息')).toBeInTheDocument();
    expect(screen.queryByText(/来自 .* 的消息/)).not.toBeInTheDocument();
  });
});
