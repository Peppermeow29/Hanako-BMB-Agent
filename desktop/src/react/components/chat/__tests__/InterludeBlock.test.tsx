/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterludeBlock } from '../InterludeBlock';

const block = {
  type: 'interlude',
  id: 'deferred:subagent-1:success',
  variant: 'deferred_result',
  taskId: 'subagent-1',
  status: 'success',
  sourceKind: 'subagent',
  sourceLabel: '明 · 大纲评估',
  text: '小花 收到了来自 明 · 大纲评估 的回复',
  detailMarkdown: '**内部详情**\n\n- 第一条',
} as const;

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('InterludeBlock', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('桌面端点击幕间消息显示轻量 markdown 预览', () => {
    mockMatchMedia(false);
    render(<InterludeBlock block={block} />);

    fireEvent.click(screen.getByRole('button', { name: /小花 收到了/ }));

    expect(screen.getByRole('dialog')).toHaveTextContent('内部详情');
    expect(screen.getByRole('dialog')).toHaveTextContent('第一条');
  });

  it('桌面端预览按正常聊天协议渲染 mood 和 markdown', () => {
    mockMatchMedia(false);
    render(
      <InterludeBlock
        block={{
          ...block,
          detailMarkdown: '<mood>\nVibe: 清醒\nWill: 保持克制\n</mood>\n\n**正文**\n\n> 引用',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /小花 收到了/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('✿ MOOD');
    expect(dialog).toHaveTextContent('正文');
    expect(dialog).toHaveTextContent('引用');
    expect(dialog).not.toHaveTextContent('<mood>');
  });

  it('滚动预览浮层本身时保持打开', () => {
    mockMatchMedia(false);
    render(<InterludeBlock block={block} />);

    fireEvent.click(screen.getByRole('button', { name: /小花 收到了/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.scroll(dialog);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('移动端不启用点击预览', () => {
    mockMatchMedia(true);
    render(<InterludeBlock block={block} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
