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

const sessionPath = '/session/agent-avatar.jsonl';

describe('ChatTranscript agent avatar identity', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      agents: [{ id: 'kiku', name: 'Kiku', yuan: 'kiku', hasAvatar: true, homeFolder: '/home/kiku' }],
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

  it('renders the custom agent avatar url for agents with an uploaded avatar', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'a1',
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [{ type: 'text', html: '<p>你好</p>' }],
      },
    }];

    render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
        agentId="kiku"
      />,
    );

    const avatar = screen.getByAltText('Kiku');
    expect(avatar.tagName).toBe('IMG');
    expect(avatar.getAttribute('src')).toContain('/api/agents/kiku/avatar');
  });
});
