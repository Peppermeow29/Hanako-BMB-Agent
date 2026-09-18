// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import type { ChatListItem } from '../../../stores/chat-types';

vi.mock('../../../components/chat/ChatTranscript', () => ({
  ChatTranscript: ({ items, registerMessageElement }: {
    items: ChatListItem[];
    registerMessageElement?: (id: string, el: HTMLDivElement | null) => void;
  }) => (
    <div data-testid="transcript">
      {items.map((item) => item.type === 'message' ? (
        <div
          key={item.data.id}
          data-message-id={item.data.id}
          ref={(el) => {
            // [no-register] 模拟"在 items 中但 DOM 元素永远不注册"的消息（折叠块内 / 渲染为 null）
            if (item.data.role === 'user' && item.data.text?.includes('[no-register]')) return;
            registerMessageElement?.(item.data.id, el as HTMLDivElement | null);
          }}
        >
          {item.data.id}
        </div>
      ) : null)}
    </div>
  ),
}));

vi.mock('../../../components/chat/ChatTimelineNavigator', () => ({
  ChatTimelineNavigator: () => null,
}));

vi.mock('../../../stores/session-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/session-actions')>();
  return { ...actual, loadMoreMessages: vi.fn(), reconcileCurrentSessionMessages: vi.fn() };
});

import { loadMoreMessages, reconcileCurrentSessionMessages } from '../../../stores/session-actions';
import { ChatMessageSurface } from '../../../components/chat/ChatMessageSurface';

const loadMoreMessagesMock = vi.mocked(loadMoreMessages);
const reconcileMock = vi.mocked(reconcileCurrentSessionMessages);

const SESSION = '/chat/find-locate.jsonl';

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

// 可控 rAF 队列：回调不自动执行，flushRaf() 手动放行一帧
let rafSeq = 0;
let rafCallbacks = new Map<number, FrameRequestCallback>();
function flushRaf() {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of pending) cb(16);
}

function message(id: string, text = `msg-${id}`): ChatListItem {
  return {
    type: 'message',
    data: { id, role: 'user', text, textHtml: `<p>${text}</p>` },
  };
}

function setSession(partial: { items: ChatListItem[]; hasMore: boolean; loadingMore: boolean; oldestId: string | undefined; revision?: string | null }) {
  useStore.setState((state) => ({
    chatSessions: {
      ...state.chatSessions,
      [SESSION]: { ...state.chatSessions[SESSION], ...partial },
    },
  }) as never);
}

describe('ChatMessageSurface locate intent consumption', () => {
  beforeEach(() => {
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    rafSeq = 0;
    rafCallbacks = new Map();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.set(++rafSeq, cb);
      return rafSeq;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      rafCallbacks.delete(id);
    }) as typeof window.cancelAnimationFrame;
    // 生产环境 window.t 恒存在且引用稳定；jsdom 缺省时 useI18n 的 fallback 每次渲染
    // 都是新函数，会让依赖了 t 的 effect 每渲染必重跑，掩盖依赖数组问题
    (window as unknown as { t: (path: string) => string }).t = (path: string) => path;
    loadMoreMessagesMock.mockClear();
    reconcileMock.mockClear();
    useStore.setState({
      chatSessions: {
        [SESSION]: {
          items: [message('10'), message('11')],
          hasMore: true,
          loadingMore: false,
          oldestId: '10',
        },
      },
      sessions: [{ path: SESSION, agentId: 'hana', title: null, firstMessage: '', modified: '', messageCount: 2 }],
      streamingSessions: [],
      pendingMessageLocate: null,
      chatFindBySession: {},
      toasts: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as { t?: unknown }).t;
  });

  it('load-more 失败（oldestId 不前进、items 引用不动）→ 意图被 clear 且弹错误 toast，不留僵尸意图', async () => {
    render(<ChatMessageSurface sessionPath={SESSION} />);

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 1, term: 'x' });
    });
    // 第一轮：目标早于窗口且可翻页 → 发起 load-more
    expect(loadMoreMessagesMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();

    // 模拟 load-more 失败：loadingMore true→false，items 引用与 oldestId 都原地不动
    // （生产前提：失败的翻页不会产出新 items 数组，重触发只能靠 loadingMore 依赖。
    //  直接复用 store 中现存的数组引用，全程零 items 变化）
    const frozenItems = useStore.getState().chatSessions[SESSION].items;
    act(() => { setSession({ items: frozenItems, hasMore: true, loadingMore: true, oldestId: '10' }); });
    act(() => { setSession({ items: frozenItems, hasMore: true, loadingMore: false, oldestId: '10' }); });

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    // 进度守卫：oldestId 未前进 → 不再重试
    expect(loadMoreMessagesMock).toHaveBeenCalledTimes(1);
    const toasts = useStore.getState().toasts;
    expect(toasts.some((toast) => toast.type === 'error')).toBe(true);
  });

  it('load-more 有进展（oldestId 前进）→ 继续翻页而不放弃；随后停滞才 give-up', async () => {
    render(<ChatMessageSurface sessionPath={SESSION} />);

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 1, term: 'x' });
    });
    expect(loadMoreMessagesMock).toHaveBeenCalledTimes(1);

    // 第一页成功：oldestId 10 → 5
    act(() => { setSession({ items: [message('10'), message('11')], hasMore: true, loadingMore: true, oldestId: '10' }); });
    act(() => { setSession({ items: [message('5'), message('10'), message('11')], hasMore: true, loadingMore: false, oldestId: '5' }); });

    // 有进展 → 第二次 load-more，意图仍在、无 toast
    expect(loadMoreMessagesMock).toHaveBeenCalledTimes(2);
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();
    expect(useStore.getState().toasts.length).toBe(0);

    // 第二页失败：oldestId 停在 5、items 引用不动（复用 store 现存引用）→ give-up
    const frozenItems = useStore.getState().chatSessions[SESSION].items;
    act(() => { setSession({ items: frozenItems, hasMore: true, loadingMore: true, oldestId: '5' }); });
    act(() => { setSession({ items: frozenItems, hasMore: true, loadingMore: false, oldestId: '5' }); });

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    expect(loadMoreMessagesMock).toHaveBeenCalledTimes(2);
    expect(useStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true);
  });

  it('意图存在期间用户滚轮干预 → 意图取消且不弹 toast', async () => {
    const { container } = render(<ChatMessageSurface sessionPath={SESSION} />);

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 1, term: 'x' });
    });
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();

    const panel = container.querySelector('[data-chat-selection-root]') as HTMLElement;
    act(() => {
      fireEvent.wheel(panel, { deltaY: -40 });
    });

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    expect(useStore.getState().toasts.length).toBe(0);
  });

  it('live id 消息：目标序号超出 canonical 空间 → reconcile 重载 → items 重建后滚动到目标并 clear 意图', async () => {
    setSession({
      items: [message('10'), message('11'), message('stream-live-1')],
      hasMore: false,
      loadingMore: false,
      oldestId: '10',
      revision: 'r1',
    });
    const { container } = render(<ChatMessageSurface sessionPath={SESSION} />);
    const panel = container.querySelector('[data-chat-selection-root]') as HTMLElement & { scrollTo?: unknown };
    const scrollToSpy = vi.fn();
    panel.scrollTo = scrollToSpy as never;

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 12, term: 'x' });
    });
    // 目标 12 > newestNumeric 11 → refresh：调 reconcile 而不是误 give-up
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();
    expect(useStore.getState().toasts.length).toBe(0);

    // 模拟 reconcile 成功：items 重建为 canonical id、revision 前进
    act(() => {
      setSession({
        items: [message('10'), message('11'), message('12')],
        hasMore: false,
        loadingMore: false,
        oldestId: '10',
        revision: 'r2',
      });
    });

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts.length).toBe(0);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it('refresh 后 revision 未前进（流式中 reconcile no-op）→ give-up toast，僵尸意图不残留', async () => {
    setSession({
      items: [message('10'), message('11'), message('stream-live-1')],
      hasMore: false,
      loadingMore: false,
      oldestId: '10',
      revision: 'r1',
    });
    render(<ChatMessageSurface sessionPath={SESSION} />);

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 12, term: 'x' });
    });
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    // 模拟 reconcile no-op 后的下一次 items 变化（如流式追加）：revision 原地不动
    act(() => {
      setSession({
        items: [message('10'), message('11'), message('stream-live-1'), message('stream-live-2')],
        hasMore: false,
        loadingMore: false,
        oldestId: '10',
        revision: 'r1',
      });
    });

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    expect(useStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it('目标在 items 中但 DOM 永不注册（折叠块）→ 双帧有界等待后 give-up', async () => {
    setSession({
      items: [message('5'), message('7', 'msg-7 [no-register]'), message('10')],
      hasMore: true,
      loadingMore: false,
      oldestId: '5',
    });
    render(<ChatMessageSurface sessionPath={SESSION} />);

    act(() => {
      useStore.getState().requestMessageLocate({ sessionPath: SESSION, messageIndex: 7, term: 'x' });
    });
    // wait-element：双帧等待中，意图仍在、不翻页、无 toast
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();
    expect(loadMoreMessagesMock).not.toHaveBeenCalled();

    act(() => { flushRaf(); }); // 第一帧
    expect(useStore.getState().pendingMessageLocate).not.toBeNull();
    act(() => { flushRaf(); }); // 第二帧 → 元素仍未注册 → give-up

    await waitFor(() => {
      expect(useStore.getState().pendingMessageLocate).toBeNull();
    });
    expect(useStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true);
    expect(loadMoreMessagesMock).not.toHaveBeenCalled();
  });
});
