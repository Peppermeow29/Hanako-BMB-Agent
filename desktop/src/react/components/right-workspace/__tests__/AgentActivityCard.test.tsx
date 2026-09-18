/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AgentActivityCard } from '../AgentActivityCard';

// mock store：组件用 useStore（currentSessionPath + selectAgentActivities + agents）
// 子组件展开时走 useStore.getState().setSubagentPreviewSessionPath
const mockState: any = {
  currentSessionPath: '/s/a.jsonl',
  agentActivitiesBySession: {},
  agents: [],
  setSubagentPreviewSessionPath: vi.fn(),
};
vi.mock('../../../stores', () => {
  const useStore: any = (selector: (s: any) => any) => selector(mockState);
  useStore.getState = () => mockState;
  return { useStore };
});

// 展开实时流是重组件（订阅 streamKey / loadMessages），单测只验证「展开后挂载 + 传对 props」
vi.mock('../../chat/SubagentSessionPreview', () => ({
  SubagentSessionPreview: (props: any) => (
    <div
      data-testid="preview"
      data-session={props.sessionPath ?? ''}
      data-task={props.taskId}
      data-stream={props.streamStatus}
    />
  ),
}));

const mk = (over: any) => ({
  id: 'x', kind: 'subagent', status: 'running', sessionPath: '/s/a.jsonl',
  agentId: null, agentName: null, summary: 's', childSessionPath: null, startedAt: 1, finishedAt: null, ...over,
});

describe('AgentActivityCard', () => {
  it('无活动时返回 null（desk 撑满）', () => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.agentActivitiesBySession = {};
    const { container } = render(<AgentActivityCard />);
    expect(container.querySelector('.universal-card')).toBeNull();
  });

  it('只渲染当前 session 的 subagent，running 优先排序', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [
        mk({ id: 'd2', status: 'done', agentName: '毛毛', summary: '调研完成', startedAt: 1000, finishedAt: 2000 }),
        mk({ id: 'd1', status: 'running', agentName: '小黎', summary: '点评咖啡', startedAt: 3000 }),
        mk({ id: 'wf', kind: 'workflow', status: 'running', summary: 'workflow-only', startedAt: 4000 }),
      ],
      '/s/b.jsonl': [mk({ id: 'other', agentName: '别的', summary: '别的对话', sessionPath: '/s/b.jsonl', startedAt: 9000 })],
    };
    const { container } = render(<AgentActivityCard />);
    const rows = container.querySelectorAll('[data-status]');
    expect(rows).toHaveLength(2); // 只当前 session 的 subagent，不含 /s/b 与 workflow
    expect(rows[0].getAttribute('data-status')).toBe('running'); // running 优先
    expect(container.textContent).toContain('小黎');
    expect(container.textContent).toContain('点评咖啡');
    expect(container.textContent).not.toContain('别的对话');
    expect(container.textContent).not.toContain('workflow-only');
  });

  it('reads current session activity from the session id bucket', () => {
    mockState.currentSessionPath = '/s/a.jsonl';
    mockState.currentSessionId = 'sess_a';
    mockState.sessionLocatorsById = { sess_a: { path: '/s/a.jsonl' } };
    mockState.agentActivitiesBySession = {
      sess_a: [
        mk({ id: 'd1', status: 'running', agentName: '小黎', summary: '点评咖啡', startedAt: 3000 }),
      ],
      '/s/a.jsonl': [
        mk({ id: 'legacy', status: 'running', agentName: '旧桶', summary: '旧 path bucket', startedAt: 1000 }),
      ],
    };

    const { container } = render(<AgentActivityCard />);

    expect(container.textContent).toContain('点评咖啡');
    expect(container.textContent).not.toContain('旧 path bucket');
    mockState.currentSessionId = null;
    mockState.sessionLocatorsById = {};
  });

  it('点击行展开实时流，sessionPath 传 childSessionPath 并对齐 preview entry', () => {
    const setSp = vi.fn();
    mockState.setSubagentPreviewSessionPath = setSp;
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [mk({ id: 't1', status: 'running', agentId: 'ag1', agentName: '小黎', summary: '点评咖啡', childSessionPath: '/s/child.jsonl' })],
    };
    const { container, getByTestId, queryByTestId } = render(<AgentActivityCard />);
    expect(queryByTestId('preview')).toBeNull(); // 默认折叠不挂载

    fireEvent.click(container.querySelector('[data-status]') as HTMLElement);

    const preview = getByTestId('preview');
    expect(preview.getAttribute('data-session')).toBe('/s/child.jsonl');
    expect(preview.getAttribute('data-task')).toBe('t1');
    expect(preview.getAttribute('data-stream')).toBe('running');
    expect(setSp).toHaveBeenCalledWith('t1', '/s/child.jsonl');
  });

  it('无当前 session 时返回 null', () => {
    mockState.currentSessionPath = null;
    mockState.agentActivitiesBySession = { '/s/a.jsonl': [mk({ id: 'x' })] };
    const { container } = render(<AgentActivityCard />);
    expect(container.querySelector('.universal-card')).toBeNull();
    mockState.currentSessionPath = '/s/a.jsonl'; // 复位
  });
});
