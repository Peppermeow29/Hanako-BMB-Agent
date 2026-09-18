/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowInlineCard } from '../WorkflowInlineCard';
import { installWindowTestT } from '../../../__tests__/helpers/i18n-test-strings';

const mk = (over: any) => ({
  taskId: 'w1', taskTitle: '三行晨诗', streamStatus: 'running',
  startedAt: 1000, finishedAt: null, ...over,
});

describe('WorkflowInlineCard', () => {
  beforeEach(() => {
    installWindowTestT();
  });

  afterEach(() => {
    delete (window as { t?: unknown }).t;
  });

  it('显示 workflow 名 + 静态运行状态', () => {
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'running' })} />);
    expect(container.textContent).toContain('三行晨诗');
    expect(container.textContent).toContain('◐ 运行中');
    expect(container.querySelector('[data-chat-resource-card]')).toBeTruthy();
  });

  it('done 显示完成图标 + 耗时', () => {
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'done', startedAt: 1000, finishedAt: 6000 })} />);
    expect(container.textContent).toContain('✓ 已完成');
    expect(container.textContent).toContain('5s');
  });

  it('failed 显示失败图标', () => {
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'failed', finishedAt: 2000 })} />);
    expect(container.textContent).toContain('✗ 失败');
  });

  it('走任务族容器 variant', () => {
    const { container } = render(<WorkflowInlineCard block={mk({})} />);
    expect(container.querySelector('[data-chat-resource-card]')?.getAttribute('data-variant')).toBe('task');
  });
});
