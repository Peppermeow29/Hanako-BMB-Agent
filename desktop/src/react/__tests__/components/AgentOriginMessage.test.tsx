// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOriginMessage } from '../../components/chat/AgentOriginMessage';
import { useStore } from '../../stores';
import type { ChatMessage } from '../../stores/chat-types';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    text: '你好，这是一条跨 session 消息',
    origin: { kind: 'agent', agentId: 'hana', agentName: 'Hana' },
    ...overrides,
  } as ChatMessage;
}

describe('AgentOriginMessage', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      if (key === 'sessionCollab.fromAgent') return `来自 ${params?.name ?? 'Agent'} 的消息`;
      if (key === 'sessionCollab.expand') return '展开';
      if (key === 'sessionCollab.collapse') return '收起';
      return key;
    }) as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: 'Hanako',
      agentYuan: 'hanako',
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the source agent badge and message text in a centered card', () => {
    const { container } = render(
      <AgentOriginMessage message={makeMessage()} sessionPath="/session/agent-origin.jsonl" isStreaming={false} />,
    );

    expect(screen.getByText('来自 Hana 的消息')).toBeInTheDocument();
    expect(screen.getByText('你好，这是一条跨 session 消息')).toBeInTheDocument();

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('agentOriginRow');
  });

  it('does not show an expand/collapse toggle for short text', () => {
    render(
      <AgentOriginMessage
        message={makeMessage({ text: '短消息，三行以内。' })}
        sessionPath="/session/agent-origin.jsonl"
        isStreaming={false}
      />,
    );

    expect(screen.queryByText('展开')).not.toBeInTheDocument();
    expect(screen.queryByText('收起')).not.toBeInTheDocument();
  });

  it('collapses long text behind an expand/collapse toggle', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n');
    render(
      <AgentOriginMessage
        message={makeMessage({ text: longText })}
        sessionPath="/session/agent-origin.jsonl"
        isStreaming={false}
      />,
    );

    const toggle = screen.getByText('展开');
    expect(toggle).toBeInTheDocument();

    const body = screen.getByText((_content, el) => el?.textContent === longText);
    expect(body.className).toContain('agentOriginBodyCollapsed');

    fireEvent.click(toggle);
    expect(screen.getByText('收起')).toBeInTheDocument();
    expect(body.className).not.toContain('agentOriginBodyCollapsed');

    fireEvent.click(screen.getByText('收起'));
    expect(screen.getByText('展开')).toBeInTheDocument();
    expect(body.className).toContain('agentOriginBodyCollapsed');
  });

  it('makes node actions interactive when the origin card is hovered', () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf-8',
    );
    expect(css).toMatch(/\.agentOriginCard:hover\s+\.messageFooterActions[\s\S]*?pointer-events:\s*auto/);
  });
});
