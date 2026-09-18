/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { WorkflowCard } from '../WorkflowCard';

const mockState: any = { currentSessionPath: '/s/a.jsonl', agentActivitiesBySession: {}, agents: [] };
vi.mock('../../../stores', () => ({
  useStore: Object.assign(
    (selector: (s: any) => any) => selector(mockState),
    { getState: () => ({ setSubagentPreviewSessionPath: vi.fn() }) },
  ),
}));
vi.mock('../../chat/SubagentSessionPreview', () => ({
  SubagentSessionPreview: () => React.createElement('div', { 'data-testid': 'preview' }),
}));

const wf = (over: any) => ({
  id: 'w1', kind: 'workflow', status: 'running', sessionPath: '/s/a.jsonl',
  agentId: null, agentName: null, summary: '三行晨诗', childSessionPath: null,
  startedAt: 1, finishedAt: null, parentTaskId: null, label: null, phaseLabel: null, tokens: null, ...over,
});
const node = (over: any) => ({
  id: 'w1::node-1', kind: 'workflow_agent', status: 'running', sessionPath: '/s/a.jsonl',
  agentId: 'butter', agentName: null, summary: null, childSessionPath: '/s/child.jsonl',
  startedAt: 2, finishedAt: null, parentTaskId: 'w1', label: '探索', phaseLabel: null, tokens: null, ...over,
});

describe('WorkflowCard', () => {
  it('无 workflow 返回 null（subagent 不算）', () => {
    mockState.agentActivitiesBySession = { '/s/a.jsonl': [wf({ id: 's1', kind: 'subagent' })] };
    const { container } = render(<WorkflowCard />);
    expect(container.querySelector('.universal-card')).toBeNull();
  });

  it('workflow 行显示 agent 数（= 子节点数），未展开不列节点', () => {
    (window as any).t = (k: string, vars?: any) =>
      k === 'rightWorkspace.workflow.agents' ? `${vars?.n} 个 agent` : k;
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [wf({ id: 'w1' }), node({ id: 'w1::node-1', label: '探索' }), node({ id: 'w1::node-2', label: '下笔' })],
    };
    const { container } = render(<WorkflowCard />);
    expect(container.textContent).toContain('2 个 agent'); // 计数 = 子节点数
    expect(container.textContent).not.toContain('探索'); // 未展开不列节点
    delete (window as any).t;
  });

  it('点开 workflow 行后列出节点（label）', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [wf({ id: 'w1' }), node({ id: 'w1::node-1', label: '探索' })],
    };
    const { container } = render(<WorkflowCard />);
    const wfRow = container.querySelector('[data-status]') as HTMLElement; // 第一个 = workflow 行
    fireEvent.click(wfRow);
    expect(container.textContent).toContain('探索'); // 节点 label 显示
  });

  it('done workflow 显示耗时', () => {
    (window as any).t = (k: string, vars?: any) => (k === 'activity.duration' ? `耗时 ${vars?.text}` : k);
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [wf({ id: 'w1', status: 'done', startedAt: 1000, finishedAt: 6000 })],
    };
    const { container } = render(<WorkflowCard />);
    expect(container.textContent).toContain('5s');
    delete (window as any).t;
  });

  it('按 phaseLabel 分组显示 Phase 名称', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [
        wf({ id: 'w1' }),
        node({ id: 'w1::node-1', label: '探索', phaseLabel: 'Research' }),
        node({ id: 'w1::node-2', label: '验证', phaseLabel: 'Verify' }),
      ],
    };
    const { container } = render(<WorkflowCard />);
    const wfRow = container.querySelector('[data-status]') as HTMLElement;
    fireEvent.click(wfRow);
    expect(container.textContent).toContain('Research');
    expect(container.textContent).toContain('Verify');
  });

  it('workflow_step 节点显示 stepKind 标签', () => {
    mockState.agentActivitiesBySession = {
      '/s/a.jsonl': [
        wf({ id: 'w1' }),
        { ...node({ id: 'w1::step-1' }), kind: 'workflow_step' as const, stepKind: 'parallel' as const, label: null, agentId: null },
      ],
    };
    const { container } = render(<WorkflowCard />);
    const wfRow = container.querySelector('[data-status]') as HTMLElement;
    fireEvent.click(wfRow);
    expect(container.textContent).toContain('parallel');
  });
});
