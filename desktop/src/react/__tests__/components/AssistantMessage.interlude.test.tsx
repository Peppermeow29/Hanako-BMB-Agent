// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { useStore } from '../../stores';

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('AssistantMessage interlude-only rendering', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    useStore.setState({
      agents: [],
      agentName: 'Hanako',
      agentYuan: 'hanako',
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('纯幕间消息不显示 Agent 身份、消息操作或完成时间', () => {
    const { container } = render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar
        sessionPath="/sessions/main.jsonl"
        isLatestAssistantMessage
        message={{
          id: 'interlude-1',
          role: 'assistant',
          timestamp: Date.now(),
          blocks: [{
            type: 'interlude',
            id: 'deferred:subagent-1:success',
            variant: 'deferred_result',
            taskId: 'subagent-1',
            status: 'success',
            sourceKind: 'subagent',
            sourceLabel: '明 · 大纲评估',
            text: '小花 收到了来自 明 · 大纲评估 的回复',
            detailMarkdown: '内部详情',
          }],
        }}
      />,
    );

    expect(screen.getByText('小花 收到了来自 明 · 大纲评估 的回复')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Hanako');
    expect(container.querySelector('[data-message-actions]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-completion-actions"]')).toBeNull();
  });
});
