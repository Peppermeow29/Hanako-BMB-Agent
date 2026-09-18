// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputStatusBars } from '../../components/input/InputStatusBars';
import { installWindowTestT } from '../helpers/i18n-test-strings';

describe('InputStatusBars', () => {
  it('shows an indeterminate screenshot progress bar above the chat input', () => {
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel="执行中..."
        compacting={false}
        compactingLabel="上下文压缩中"
        screenshotBusy
        screenshotLabel="正在截图"
        screenshotPageLabel="正在截图，第 2/4 页"
        screenshotProgress={{
          completedBlocks: 12,
          totalBlocks: 37,
          currentPage: 2,
          totalPages: 4,
        }}
        inlineError={null}
        slashResult={null}
        onResultClick={undefined}
      />,
    );

    expect(screen.getByText('正在截图，第 2/4 页')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: '正在截图，第 2/4 页' });
    expect(progress).toHaveAttribute('aria-valuenow', '12');
    expect(progress).toHaveAttribute('aria-valuemax', '37');
  });

  it('makes clickable results keyboard-accessible with Enter and Space', () => {
    const onResultClick = vi.fn();
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel=""
        compacting={false}
        compactingLabel=""
        screenshotBusy={false}
        screenshotLabel=""
        inlineError={null}
        slashResult={{ text: '截图已保存', type: 'success', filePath: '/tmp/card.png' }}
        onResultClick={onResultClick}
      />,
    );

    const result = screen.getByRole('button', { name: '截图已保存' });
    expect(result).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(result, { key: 'Enter' });
    fireEvent.keyDown(result, { key: ' ' });

    expect(onResultClick).toHaveBeenCalledTimes(2);
  });

  it('keeps non-clickable results outside the keyboard button contract', () => {
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel=""
        compacting={false}
        compactingLabel=""
        screenshotBusy={false}
        screenshotLabel=""
        inlineError={null}
        slashResult={{ text: '操作失败', type: 'error' }}
        onResultClick={undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: '操作失败' })).not.toBeInTheDocument();
    expect(screen.getByText('操作失败')).not.toHaveAttribute('tabindex');
  });

  it('keeps clickable result hover and focus feedback on the solid panel background', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );

    expect(css).toMatch(
      /\.slash-busy-bar-clickable:hover,\s*\.slash-busy-bar-clickable:focus-visible\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--panel-card-bg\) 96%, var\(--text\) 4%\);/s,
    );
  });
});

const QUIET_PROPS = {
  slashBusy: null,
  slashBusyLabel: '',
  compacting: false,
  compactingLabel: '',
  screenshotBusy: false,
  screenshotLabel: '',
  slashResult: null,
  onResultClick: undefined,
};

describe('InputStatusBars · inline error', () => {
  beforeEach(() => {
    installWindowTestT({
      'error.detailShow': '详情',
      'error.detailHide': '收起',
    });
  });

  afterEach(cleanup);

  it('shows the human sentence and hides the technical detail until asked', () => {
    render(<InputStatusBars
      {...QUIET_PROPS}
      inlineError={{
        text: '这条消息之后还有任务在跑，等它结束再从这里分支',
        detail: 'active task cannot be shared by a session fork: subagent-1785635522479-v82otz',
        code: 'session_fork_active_task',
      }}
    />);

    expect(screen.getByText('这条消息之后还有任务在跑，等它结束再从这里分支')).toBeInTheDocument();
    expect(screen.queryByText(/subagent-1785635522479/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '详情' }));

    expect(screen.getByText(/subagent-1785635522479/)).toBeInTheDocument();
    expect(screen.getByText('session_fork_active_task')).toBeInTheDocument();
  });

  it('collapses again on a second click', () => {
    render(<InputStatusBars
      {...QUIET_PROPS}
      inlineError={{ text: '出了点意外', detail: "version `GLIBC_2.29' not found", code: null }}
    />);

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText(/GLIBC_2.29/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText(/GLIBC_2.29/)).not.toBeInTheDocument();
  });

  it('offers no toggle when the error carries nothing extra to show', () => {
    render(<InputStatusBars
      {...QUIET_PROPS}
      inlineError={{ text: '会话正忙，稍后再试', detail: null, code: null }}
    />);

    expect(screen.getByText('会话正忙，稍后再试')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '详情' })).not.toBeInTheDocument();
  });

  it('re-collapses when a different error replaces the current one', () => {
    const { rerender } = render(<InputStatusBars
      {...QUIET_PROPS}
      inlineError={{ text: '第一个错误', detail: 'first detail', code: null }}
    />);

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('first detail')).toBeInTheDocument();

    rerender(<InputStatusBars
      {...QUIET_PROPS}
      inlineError={{ text: '第二个错误', detail: 'second detail', code: null }}
    />);

    expect(screen.queryByText('second detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument();
  });
});
