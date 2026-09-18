// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { initQuotedSelectionLifecycle } from '../../stores/selection-actions';
import type { ChatListItem } from '../../stores/chat-types';

vi.mock('../../components/chat/ChatTranscript', () => ({
  ChatTranscript: ({ items }: { items: ChatListItem[] }) => (
    <div data-testid="transcript">
      {items.map((item) => {
        if (item.type !== 'message') return <span key={item.id}>c</span>;
        const text = item.data.role === 'user'
          ? item.data.text
          : item.data.blocks?.map((block) => block.type === 'text' ? (block.source || block.html) : '').join('');
        return (
          <article key={item.data.id} data-message-id={item.data.id}>
            <span id={`message-${item.data.id}`}>{text}</span>
          </article>
        );
      })}
    </div>
  ),
}));

vi.mock('../../components/chat/ChatTimelineNavigator', () => ({
  ChatTimelineNavigator: () => null,
}));

import { ChatArea } from '../../components/chat/ChatArea';

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

// A ResizeObserver whose callback can be fired on demand, to exercise the post-activation
// content-resize path (point #4: the first resize after a panel becomes active must snap, not animate).
class TriggerableResizeObserver {
  static instances: TriggerableResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TriggerableResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value) => { metrics.scrollTop = value; },
  });
}

function message(id: string, role: 'user' | 'assistant'): ChatListItem {
  return {
    type: 'message',
    data: role === 'user'
      ? { id, role, text: id, textHtml: `<p>${id}</p>` }
      : { id, role, blocks: [{ type: 'text', html: `<p>${id}</p>` }] },
  };
}

describe('ChatArea continuous bottom scroll', () => {
  beforeEach(() => {
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(16);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
    useStore.setState({
      currentSessionPath: '/chat/scroll.jsonl',
      welcomeVisible: false,
      quoteCandidate: null,
      quotedSelections: [],
      quotedSelection: null,
      chatSessions: {
        '/chat/scroll.jsonl': {
          items: [message('u-1', 'user')],
          hasMore: false,
          loadingMore: false,
        },
      },
      sessions: [{ path: '/chat/scroll.jsonl', agentId: 'hana', title: null, firstMessage: '', modified: '', messageCount: 1 }],
      streamingSessions: ['/chat/scroll.jsonl'],
      agents: [{ id: 'hana', name: 'Hana', yuan: 'hanako' }],
    } as never);
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it('does not force sticky when an assistant/tool message is appended after the user scrolled up', async () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 500 };
    const { container } = render(<ChatArea />);

    await waitFor(() => {
      expect(container.querySelector('[class*="sessionPanel"]')).toBeTruthy();
    });

    const panel = container.querySelector('[class*="sessionPanel"]') as HTMLElement;
    setScrollMetrics(panel, metrics);

    act(() => {
      metrics.scrollTop = 500;
      fireEvent.scroll(panel);
    });

    act(() => {
      useStore.setState((state) => ({
        chatSessions: {
          ...state.chatSessions,
          '/chat/scroll.jsonl': {
            ...state.chatSessions['/chat/scroll.jsonl'],
            items: [
              ...state.chatSessions['/chat/scroll.jsonl'].items,
              {
                type: 'message',
                data: {
                  id: 'a-tool',
                  role: 'assistant',
                  blocks: [{ type: 'tool_group', tools: [{ name: 'test.tool', done: false, success: false }], collapsed: false }],
                },
              },
            ],
          },
        },
      } as never));
    });

    expect(metrics.scrollTop).toBe(500);
  });

  it('mounts a current empty session panel instead of leaving the chat area blank', async () => {
    useStore.setState({
      currentSessionPath: '/chat/empty.jsonl',
      welcomeVisible: false,
      chatSessions: {
        '/chat/empty.jsonl': {
          items: [],
          hasMore: false,
          loadingMore: false,
        },
      },
      sessions: [{ path: '/chat/empty.jsonl', agentId: 'hana', title: null, firstMessage: '', modified: '', messageCount: 0 }],
      streamingSessions: [],
    } as never);

    const { container } = render(<ChatArea />);

    await waitFor(() => {
      expect(container.querySelector('[class*="sessionPanel"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });

  it('marks the active session shell for a lightweight reveal animation', async () => {
    const { container } = render(<ChatArea />);

    await waitFor(() => {
      expect(container.querySelector('[class*="sessionShell"]')).toBeTruthy();
    });

    const shell = container.querySelector('[class*="sessionShell"]') as HTMLElement;
    expect(shell).toHaveAttribute('data-active', 'true');
    expect(shell.className).toContain('sessionShellActive');
  });

  it('captures chat text selection on mouseup via the document selection lifecycle', async () => {
    // 选区提交由 document 级 initQuotedSelectionLifecycle 统一处理（生产中由 app-init
    // 注册）。ChatArea 只负责输出 data-chat-selection-root / data-session-path 标记，
    // 这里把两者放在一起做集成验证：标记正确 + lifecycle 能据此捕获。
    useStore.setState({
      currentSessionPath: '/chat/scroll.jsonl',
      chatSessions: {
        '/chat/scroll.jsonl': {
          items: [{
            type: 'message',
            data: {
              id: 'a-quote',
              role: 'assistant',
              blocks: [{ type: 'text', html: '<p>可以引用的话</p>', source: '可以引用的话' }],
            },
          }],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    const { container } = render(<ChatArea />);

    await waitFor(() => {
      expect(container.querySelector('[class*="sessionPanel"]')).toBeTruthy();
    });

    const dispose = initQuotedSelectionLifecycle(document);
    try {
      selectElementText(document.getElementById('message-a-quote')!);
      fireEvent.mouseUp(container.querySelector('[class*="sessionPanel"]') as HTMLElement);

      expect(useStore.getState().quoteCandidate).toMatchObject({
        text: '可以引用的话',
        sourceKind: 'chat',
        sourceMessageId: 'a-quote',
        sourceSessionPath: '/chat/scroll.jsonl',
      });
    } finally {
      dispose();
    }
  });

  it('does not capture chat selection on a right-click mouseup (button 2)', async () => {
    useStore.setState({
      currentSessionPath: '/chat/scroll.jsonl',
      chatSessions: {
        '/chat/scroll.jsonl': {
          items: [{
            type: 'message',
            data: {
              id: 'a-quote',
              role: 'assistant',
              blocks: [{ type: 'text', html: '<p>可以引用的话</p>', source: '可以引用的话' }],
            },
          }],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    const { container } = render(<ChatArea />);

    await waitFor(() => {
      expect(container.querySelector('[class*="sessionPanel"]')).toBeTruthy();
    });

    const dispose = initQuotedSelectionLifecycle(document);
    try {
      selectElementText(document.getElementById('message-a-quote')!);
      fireEvent.mouseUp(container.querySelector('[class*="sessionPanel"]') as HTMLElement, { button: 2 });

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('snaps instantly on the first content resize after a panel becomes active (no animated follow)', async () => {
    TriggerableResizeObserver.instances = [];
    window.ResizeObserver = TriggerableResizeObserver as unknown as typeof ResizeObserver;
    const rafCallbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => { rafCallbacks[id - 1] = () => {}; }) as typeof window.cancelAnimationFrame;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

    useStore.setState({
      currentSessionPath: '/chat/scroll.jsonl',
      streamingSessions: [],
      chatSessions: {
        '/chat/scroll.jsonl': {
          items: [message('u-1', 'user'), message('a-1', 'assistant')],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);

    const { container } = render(<ChatArea />);
    await waitFor(() => {
      expect(container.querySelector('[class*="sessionPanel"]')).toBeTruthy();
    });

    const panel = container.querySelector('[class*="sessionPanel"]') as HTMLElement;
    // Parked at the bottom after the first-content instant landing.
    const metrics = { scrollHeight: 600, clientHeight: 300, scrollTop: 300 };
    setScrollMetrics(panel, metrics);

    // First post-activation content reflow (e.g. media finishes loading) grows content under the
    // largeJump threshold. With the arm it must snap straight to the new bottom — no rAF animation.
    act(() => {
      metrics.scrollHeight = 950;
      TriggerableResizeObserver.instances[0]?.trigger();
    });
    expect(metrics.scrollTop).toBe(650);

    act(() => {
      const pending = rafCallbacks.splice(0);
      pending.forEach((cb) => cb(16));
    });
    expect(metrics.scrollTop).toBe(650);
  });
});

function selectElementText(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
