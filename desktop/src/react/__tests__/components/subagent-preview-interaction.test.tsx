/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '../../stores/index';
import { SubagentCard } from '../../components/chat/SubagentCard';
import { createSubagentPreviewSlice, type SubagentPreviewSlice } from '../../stores/subagent-preview-slice';
import { dispatchStreamKey } from '../../services/stream-key-dispatcher';

function makeSlice(): SubagentPreviewSlice {
  let state: SubagentPreviewSlice;
  const set = (partial: Partial<SubagentPreviewSlice> | ((s: SubagentPreviewSlice) => Partial<SubagentPreviewSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createSubagentPreviewSlice(set);
  return new Proxy({} as SubagentPreviewSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

beforeEach(() => {
  window.t = ((key: string) => key) as typeof window.t;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('subagent preview state ownership', () => {
  let slice: SubagentPreviewSlice;

  beforeEach(() => {
    useStore.setState({
      currentSessionPath: null,
      subagentPreviewByTaskId: {},
    } as never);
    slice = makeSlice();
  });

  it('按 taskId 独立保存 preview 状态，且可同时展开多个 card', () => {
    slice.openSubagentPreview('task-a', '/session/a');
    slice.openSubagentPreview('task-b', '/session/b');

    expect(slice.subagentPreviewByTaskId['task-a']).toEqual({
      open: true,
      sessionPath: '/session/a',
      loading: false,
      loadedOnce: false,
    });
    expect(slice.subagentPreviewByTaskId['task-b']).toEqual({
      open: true,
      sessionPath: '/session/b',
      loading: false,
      loadedOnce: false,
    });
  });

  it('切换 currentSessionPath 不会影响 taskId-owned preview 状态', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().setSubagentPreviewLoading('task-a', true);
    useStore.getState().markSubagentPreviewLoaded('task-a');
    useStore.getState().setSubagentPreviewSessionPath('task-a', '/session/a-2');

    useStore.setState({ currentSessionPath: '/session/other' } as never);

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: true,
      sessionPath: '/session/a-2',
      loading: false,
      loadedOnce: true,
    });
  });

  it('重复 open 不会误关 preview，close 只影响对应 taskId', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().openSubagentPreview('task-b', '/session/b');
    useStore.getState().openSubagentPreview('task-a', '/session/a-2');
    useStore.getState().closeSubagentPreview('task-a');

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: false,
      sessionPath: '/session/a-2',
      loading: false,
      loadedOnce: false,
    });
    expect(useStore.getState().subagentPreviewByTaskId['task-b']).toEqual({
      open: true,
      sessionPath: '/session/b',
      loading: false,
      loadedOnce: false,
    });
  });

  it('关闭后的 preview 仍可显式更新 sessionPath，供异步回填使用', () => {
    useStore.getState().openSubagentPreview('task-a', '/session/a');
    useStore.getState().closeSubagentPreview('task-a');
    useStore.getState().setSubagentPreviewSessionPath('task-a', null);

    expect(useStore.getState().subagentPreviewByTaskId['task-a']).toEqual({
      open: false,
      sessionPath: null,
      loading: false,
      loadedOnce: false,
    });
  });
});

describe('SubagentCard static resource card', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    useStore.setState({
      activeServerConnection: {
        kind: 'local',
        label: 'Local',
        baseUrl: 'http://127.0.0.1:3210',
        wsUrl: 'ws://127.0.0.1:3210',
        token: null,
      },
      currentAgentId: null,
      agents: [],
      chatSessions: {
        '/session/subagent-a': {
          items: [{ type: 'message', data: { id: 'a-1', role: 'assistant', blocks: [{ type: 'text', html: '<p>Preview A</p>' }] } }],
          hasMore: false,
          loadingMore: false,
        },
        '/session/subagent-b': {
          items: [{ type: 'message', data: { id: 'b-1', role: 'assistant', blocks: [{ type: 'text', html: '<p>Preview B</p>' }] } }],
          hasMore: false,
          loadingMore: false,
        },
      },
      subagentPreviewByTaskId: {},
    } as never);
  });

  it('只渲染静态卡面预览，不在聊天流内展开 child session', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: 'done',
        }}
      />,
    );

    expect(screen.getByText('SORA')).toBeTruthy();
    expect(screen.getByText('任务：do work')).toBeTruthy();
    expect(screen.getByText('subagent.status.done')).toBeTruthy();
    expect(screen.queryByText('Preview A')).toBeNull();
    expect(screen.queryByRole('button', { name: /SORA/i })).toBeNull();
    expect(useStore.getState().subagentPreviewByTaskId).toEqual({});
    expect(document.querySelector('[data-chat-resource-card]')?.getAttribute('data-variant')).toBe('task');
  });

  it('收起态显式信任 taskTitle，而不是再从 task 猜摘要', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: '任务：这是一段不该显示的旧字段内容\n\n你是一个生活整理顾问。请为用户制定一份一周生活整理清单。',
          taskTitle: '任务：制定一份一周生活整理清单',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: '这里是运行时输出，不该出现在收起态',
        }}
      />,
    );

    expect(screen.getByText('任务：制定一份一周生活整理清单')).toBeTruthy();
    expect(screen.queryByText('任务：这是一段不该显示的旧字段内容')).toBeNull();
    expect(screen.queryByText('这里是运行时输出，不该出现在收起态')).toBeNull();
  });

  it('运行时输出不会抢占静态卡面的 taskTitle', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: '任务：这是一段旧正文\n\n详细要求',
          taskTitle: '任务：制定一份一周生活整理清单',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'done',
          summary: '这里是运行时输出，不该抢占 header',
        }}
      />,
    );

    expect(screen.getByText('任务：制定一份一周生活整理清单')).toBeTruthy();
    expect(screen.queryByText('这里是运行时输出，不该抢占 header')).toBeNull();
    expect(screen.queryByText('Preview A')).toBeNull();
  });

  it('子 session 的 turn_end 不会把 subagent 卡片标记为完成', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'running',
        }}
      />,
    );

    expect(screen.getByText('subagent.status.dispatched')).toBeTruthy();

    act(() => {
      dispatchStreamKey('/session/subagent-a', { type: 'turn_end', sessionPath: '/session/subagent-a' });
    });

    expect(screen.getByText('subagent.status.dispatched')).toBeTruthy();
    expect(screen.queryByText('subagent.status.done')).toBeNull();
  });

  it('运行中概览卡不订阅 child session 的高频 text_delta', () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'running',
        }}
      />,
    );

    act(() => {
      dispatchStreamKey('/session/subagent-a', { type: 'text_delta', sessionPath: '/session/subagent-a', delta: '实时正文不该进概览' });
    });

    expect(screen.getByText('任务：do work')).toBeTruthy();
    expect(screen.queryByText('实时正文不该进概览')).toBeNull();
  });

  it('运行中卡片只保留终止按钮，不提供展开入口', async () => {
    render(
      <SubagentCard
        block={{
          taskId: 'task-a',
          task: 'do work',
          taskTitle: '任务：do work',
          agentName: 'SORA',
          streamKey: '/session/subagent-a',
          streamStatus: 'running',
        }}
      />,
    );

    const abort = screen.getByTitle('subagentAbort');
    fireEvent.click(abort);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3210/api/task/task-a/abort', { method: 'POST' });
    });
    expect(screen.queryByText('Preview A')).toBeNull();
    expect(useStore.getState().subagentPreviewByTaskId).toEqual({});
  });
});
