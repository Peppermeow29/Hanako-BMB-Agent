// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatResourceCard } from '../../components/chat/ChatResourceCard';

function Icon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 15 15H1Z" /></svg>;
}

describe('ChatResourceCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a static resource card without interactive expansion work', () => {
    render(<ChatResourceCard icon={<Icon />} title="静态卡片" subtitle="预览" />);

    expect(screen.getByText('静态卡片')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps a future expandable contract without rendering details while collapsed', () => {
    const onToggle = vi.fn();
    render(
      <ChatResourceCard
        icon={<Icon />}
        title="可展开卡片"
        expandable
        expanded={false}
        onToggle={onToggle}
      >
        <div>详情内容</div>
      </ChatResourceCard>,
    );

    const button = screen.getByRole('button', { name: '可展开卡片' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('详情内容')).toBeNull();

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders details only when the expandable card is opened', () => {
    render(
      <ChatResourceCard
        icon={<Icon />}
        title="已展开卡片"
        expandable
        expanded
        onToggle={() => {}}
      >
        <div>详情内容</div>
      </ChatResourceCard>,
    );

    expect(screen.getByRole('button', { name: '已展开卡片' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('详情内容')).toBeInTheDocument();
  });

  it('defaults to the panel variant contract', () => {
    const { container } = render(<ChatResourceCard icon={<Icon />} title="默认卡片" />);
    expect(container.querySelector('[data-chat-resource-card]')).toHaveAttribute('data-variant', 'panel');
  });

  it('marks the task variant for the task-block family', () => {
    const { container } = render(<ChatResourceCard icon={<Icon />} title="任务卡片" variant="task" />);
    expect(container.querySelector('[data-chat-resource-card]')).toHaveAttribute('data-variant', 'task');
  });
});
