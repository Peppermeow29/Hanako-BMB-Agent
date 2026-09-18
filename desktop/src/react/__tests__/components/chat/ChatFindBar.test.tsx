// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';

vi.mock('../../../stores/chat-find-actions', () => ({
  runChatFind: vi.fn(),
  stepChatFind: vi.fn(),
}));

import { runChatFind, stepChatFind } from '../../../stores/chat-find-actions';
import { ChatFindBar } from '../../../components/chat/ChatFindBar';

const runChatFindMock = vi.mocked(runChatFind);
const stepChatFindMock = vi.mocked(stepChatFind);

const SESSION = '/chat/find-bar.jsonl';

describe('ChatFindBar', () => {
  beforeEach(() => {
    (window as unknown as { t: (path: string) => string }).t = (path: string) => path;
    runChatFindMock.mockClear();
    stepChatFindMock.mockClear();
    useStore.setState({
      currentSessionPath: SESSION,
      welcomeVisible: false,
      chatFindBySession: {},
      sessions: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as unknown as { t?: unknown }).t;
  });

  it('findState.open=false 时不渲染；openChatFind 后渲染 ClassicFindBox', () => {
    render(<ChatFindBar />);
    expect(screen.queryByRole('search')).not.toBeInTheDocument();

    act(() => {
      useStore.getState().openChatFind(SESSION);
    });

    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('Cmd+F 在 currentSessionPath 存在且 welcomeVisible=false 时 preventDefault 并 openChatFind', () => {
    render(<ChatFindBar />);
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(useStore.getState().chatFindBySession[SESSION]?.open).toBe(true);
  });

  it('Cmd+F 在 welcomeVisible=true 时不响应', () => {
    useStore.setState({ welcomeVisible: true } as never);
    render(<ChatFindBar />);
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();
  });

  it('Cmd+F 在无 currentSessionPath 时不响应', () => {
    useStore.setState({ currentSessionPath: null } as never);
    render(<ChatFindBar />);
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  it('Cmd+F 在 event.defaultPrevented=true 时不响应（preview 已消费）', () => {
    // 模拟 PreviewPanel 的 capture 拦截先于本组件跑到：注册顺序早于渲染即可
    // 复现"事件到达本组件监听器时 defaultPrevented 已为 true"的效果。
    const preConsume = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', preConsume);
    render(<ChatFindBar />);
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();
    window.removeEventListener('keydown', preConsume);
  });

  it('输入变化：立即 setChatFindQuery（UI 响应）；debounce 300ms 内多次输入只触发一次 runChatFind', () => {
    vi.useFakeTimers();
    act(() => {
      useStore.getState().openChatFind(SESSION);
    });
    render(<ChatFindBar />);
    const input = document.querySelector('[data-classic-find-input]') as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: 'a' } });
    expect(useStore.getState().chatFindBySession[SESSION].query).toBe('a');
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(useStore.getState().chatFindBySession[SESSION].query).toBe('abc');

    // debounce 窗口内未到期，尚未触发查询
    expect(runChatFindMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(runChatFindMock).toHaveBeenCalledTimes(1);
    expect(runChatFindMock).toHaveBeenCalledWith(SESSION, 'abc');
  });

  it('点击下一条/上一条按钮调用 stepChatFind(path, ±1)', () => {
    act(() => {
      useStore.getState().openChatFind(SESSION, 'hi');
    });
    render(<ChatFindBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(stepChatFindMock).toHaveBeenCalledWith(SESSION, 1);

    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(stepChatFindMock).toHaveBeenCalledWith(SESSION, -1);
  });

  it('Esc/关闭按钮调用 closeChatFind（store 里状态被清）', () => {
    act(() => {
      useStore.getState().openChatFind(SESSION, 'hi');
    });
    render(<ChatFindBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Close find' }));

    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();
  });

  it('Esc 键调用 closeChatFind', () => {
    act(() => {
      useStore.getState().openChatFind(SESSION, 'hi');
    });
    render(<ChatFindBar />);
    const input = document.querySelector('[data-classic-find-input]') as HTMLInputElement;

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();
  });

  it('查找条已打开时再按 Cmd+F → input 重聚焦并全选现有词', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    act(() => {
      useStore.getState().openChatFind(SESSION, 'hello');
    });
    render(<ChatFindBar />);
    const input = document.querySelector('[data-classic-find-input]') as HTMLInputElement;
    input.blur();
    expect(document.activeElement).not.toBe(input);

    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('hello'.length);
    rafSpy.mockRestore();
  });

  it('输入后 debounce 窗口内 close → 推进 timer 后不复活幽灵状态、不触发查询', () => {
    vi.useFakeTimers();
    act(() => {
      useStore.getState().openChatFind(SESSION);
    });
    render(<ChatFindBar />);
    const input = document.querySelector('[data-classic-find-input]') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'ghost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }));
    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(runChatFindMock).not.toHaveBeenCalled();
    expect(useStore.getState().chatFindBySession[SESSION]).toBeUndefined();
  });

  it('debounce 在途时按下一条：flush 为立即 runChatFind 且本次不步进', () => {
    vi.useFakeTimers();
    act(() => {
      useStore.getState().openChatFind(SESSION);
    });
    render(<ChatFindBar />);
    const input = document.querySelector('[data-classic-find-input]') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));

    expect(runChatFindMock).toHaveBeenCalledTimes(1);
    expect(runChatFindMock).toHaveBeenCalledWith(SESSION, 'hi');
    expect(stepChatFindMock).not.toHaveBeenCalled();

    // flush 已清 timer：到期不重复触发
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(runChatFindMock).toHaveBeenCalledTimes(1);

    // timer 已不在途：再按下一条恢复正常步进
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(stepChatFindMock).toHaveBeenCalledWith(SESSION, 1);
  });

  it('计数展示：设置 results 后显示 activePos+1/total', () => {
    act(() => {
      useStore.getState().openChatFind(SESSION, 'hi');
      useStore.getState().setChatFindResults(SESSION, {
        matches: [
          { index: 1, exact: true, snippet: 'hi 1' },
          { index: 2, exact: true, snippet: 'hi 2' },
          { index: 3, exact: true, snippet: 'hi 3' },
        ],
        total: 3,
        tokens: ['hi'],
        truncated: false,
        bestIndex: null,
        revision: null,
      });
      useStore.getState().setChatFindActivePos(SESSION, 1);
    });
    render(<ChatFindBar />);

    expect(screen.getByText('2/3')).toBeInTheDocument();
  });
});
