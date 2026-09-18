/**
 * @vitest-environment jsdom
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionTodoCard } from '../SessionTodoCard';

const actionMocks = vi.hoisted(() => ({
  completeSessionTodos: vi.fn(async () => true),
}));

const mockState: any = {
  currentSessionPath: '/s/a.jsonl',
  currentSessionId: null,
  sessions: [],
  sessionLocatorsById: {},
  todosBySession: {},
  streamingSessions: [],
};
vi.mock('../../../stores', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));
vi.mock('../../../stores/session-actions', () => ({
  completeSessionTodos: actionMocks.completeSessionTodos,
}));

describe('SessionTodoCard', () => {
  beforeEach(() => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.currentSessionId = null;
    mockState.sessions = [];
    mockState.sessionLocatorsById = {};
    mockState.todosBySession = {};
    mockState.streamingSessions = [];
    actionMocks.completeSessionTodos.mockClear();
    window.t = ((key: string) => {
      if (key === 'common.markAllComplete') return '全部标记为已完成';
      if (key === 'rightWorkspace.todo.title') return '待办';
      if (key === 'rightWorkspace.todo.waitForOutput') return '输出完成后再标记';
      return key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
  });

  it('无 todo 返回 null', () => {
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelector('.universal-card')).toBeNull();
  });

  it('渲染三态 + 完成计数，in_progress 用 activeForm', () => {
    mockState.todosBySession['/s/a.jsonl'] = [
      { content: '写代码', activeForm: '写代码中', status: 'in_progress' },
      { content: '测试', activeForm: '测试中', status: 'pending' },
      { content: '提交', activeForm: '提交中', status: 'completed' },
    ];
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelectorAll('[data-status]')).toHaveLength(3);
    expect(container.textContent).toContain('1/3'); // 完成 1/3
    expect(container.textContent).toContain('写代码中'); // in_progress → activeForm
  });

  it('用 sessionId-keyed todos 渲染当前 session', () => {
    mockState.currentSessionId = 'sess_a';
    mockState.sessionLocatorsById = { sess_a: { path: '/s/a.jsonl' } };
    mockState.todosBySession.sess_a = [
      { content: '迁移 renderer store', activeForm: '迁移中', status: 'in_progress' },
    ];

    const { container } = render(<SessionTodoCard />);

    expect(container.textContent).toContain('迁移中');
  });

  it('无对话返回 null', () => {
    mockState.currentSessionPath = null;
    mockState.todosBySession['/s/a.jsonl'] = [{ content: 'x', activeForm: 'x', status: 'pending' }];
    const { container } = render(<SessionTodoCard />);
    expect(container.querySelector('.universal-card')).toBeNull();
  });

  it('从右侧面板触发全部标记为已完成', async () => {
    mockState.todosBySession['/s/a.jsonl'] = [
      { content: '写代码', activeForm: '写代码中', status: 'in_progress' },
    ];

    render(<SessionTodoCard />);
    fireEvent.click(screen.getByRole('button', { name: '全部标记为已完成' }));

    await waitFor(() => {
      expect(actionMocks.completeSessionTodos).toHaveBeenCalledWith('/s/a.jsonl');
    });
  });

  it('输出中禁用全部标记为已完成', () => {
    mockState.todosBySession['/s/a.jsonl'] = [
      { content: '写代码', activeForm: '写代码中', status: 'in_progress' },
    ];
    mockState.streamingSessions = ['/s/a.jsonl'];

    render(<SessionTodoCard />);
    const button = screen.getByRole('button', { name: '全部标记为已完成' });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(actionMocks.completeSessionTodos).not.toHaveBeenCalled();
  });
});
