// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolGroupBlock } from '../../components/chat/ToolGroupBlock';

describe('ToolGroupBlock', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders failed and unknown outcomes without presenting either as success', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { id: 'failed', name: 'read', done: true, success: false, status: 'failed', error: 'file not found' },
          { id: 'unknown', name: 'read', done: true, success: false, status: 'unknown' },
        ]}
      />,
    );

    expect(screen.getByText('file not found')).toBeInTheDocument();
    expect(screen.getByText('✗')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('shows the full bash command in the hover title when the visible detail is truncated', () => {
    const command = 'rm -rf /Users/jason/.claude/plugins/marketplaces/temp_*';

    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[{
          name: 'bash',
          args: { command },
          done: true,
          success: true,
        }]}
      />,
    );

    const detail = screen.getByTitle(command);

    expect(detail.textContent).toBe('rm -rf /Users/jason/.claude/plugins/mar…');
  });

  it('renders exec_command with the legacy bash user-facing copy', () => {
    window.t = ((key: string, vars?: Record<string, unknown>) => {
      if (key === 'tool.bash.done') return `💻 ${vars?.name} 用完电脑了`;
      return key;
    }) as typeof window.t;

    render(
      <ToolGroupBlock
        collapsed={false}
        agentName="Hanako"
        tools={[{
          name: 'exec_command',
          args: { cmd: 'npm test' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.getByText('💻 Hanako 用完电脑了')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('renders write_stdin with the legacy terminal user-facing copy', () => {
    window.t = ((key: string, vars?: Record<string, unknown>) => {
      if (key === 'tool.terminal.done') return `💻 ${vars?.name} 敲完了`;
      return key;
    }) as typeof window.t;

    render(
      <ToolGroupBlock
        collapsed={false}
        agentName="Hanako"
        tools={[{
          name: 'write_stdin',
          args: { process_id: 'term_1', chars: 'q\n' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.getByText('💻 Hanako 敲完了')).toBeInTheDocument();
    expect(document.querySelector('[data-tool="write_stdin"] [title]')).toHaveAttribute('title', 'q\n');
  });

  it('syncs a multi-tool group to collapsed when the completed block updates', async () => {
    const { rerender } = render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { name: 'bash', args: { command: 'npm test' }, done: true, success: true },
          { name: 'read', args: { file_path: '/tmp/report.md' }, done: false, success: false },
        ]}
      />,
    );

    // 展开时工具内容可见
    expect(screen.getByText('npm test')).toBeInTheDocument();

    rerender(
      <ToolGroupBlock
        collapsed={true}
        tools={[
          { name: 'bash', args: { command: 'npm test' }, done: true, success: true },
          { name: 'read', args: { file_path: '/tmp/report.md' }, done: true, success: true },
        ]}
      />,
    );

    // 折叠后，Collapse 组件通过 AnimatePresence 退场动画后移除内容。
    // jsdom 下 requestAnimationFrame 可能延迟执行退场，用 waitFor 等待。
    await waitFor(() => {
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });
  });

  it('keeps a single tool as a plain indicator without a fold summary', () => {
    render(
      <ToolGroupBlock
        collapsed={true}
        tools={[{
          name: 'bash',
          args: { command: 'npm test' },
          done: true,
          success: true,
        }]}
      />,
    );

    expect(screen.queryByText('toolGroup.count')).toBeNull();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('keeps every action in a multi-tool sequence with its canonical name', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { name: 'read', args: { file_path: 'a.txt' }, done: true, success: true },
          { name: 'read', args: { file_path: 'b.txt' }, done: true, success: true },
          { name: 'write', args: { file_path: 'target.md' }, done: true, success: true },
          { name: 'read', args: { file_path: 'target.md' }, done: true, success: true },
        ]}
      />,
    );

    const actionPreview = [...document.querySelectorAll('[data-tool-name-preview]')].at(-1);
    expect(actionPreview?.textContent).toBe('read → read → write → +1');
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('write').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.getAllByText('target.md')).toHaveLength(2);
  });

  it('keeps canonical names for card-backed, external, and retired tools', () => {
    render(
      <ToolGroupBlock
        collapsed={false}
        tools={[
          { name: 'automation', args: { action: 'create', label: 'Tea' }, done: true, success: true },
          { name: 'show_card', args: { title: 'dorm_comparison' }, done: true, success: true },
          { name: 'mcp_create_directory', args: { path: 'notes' }, done: true, success: true },
          { name: 'media_generate-image', args: { prompt: 'pelican' }, done: true, success: true },
        ]}
      />,
    );

    expect(screen.getByText('automation → show_card → mcp_create_directory → +1')).toBeInTheDocument();
    expect(screen.getAllByText('mcp_create_directory').length).toBeGreaterThan(0);
    expect(screen.getAllByText('media_generate-image').length).toBeGreaterThan(0);
    expect(screen.getByText('notes')).toBeInTheDocument();
  });

  it('keeps the tool layout box aligned to the task-block width', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const toolGroupRule = css.match(/\.toolGroup\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(toolGroupRule).toContain('width: var(--chat-task-block-width)');
    expect(toolGroupRule).toContain('max-width: 100%');
    expect(toolGroupRule).toContain('box-sizing: border-box');
  });

  it('fuses consecutive subagent cards into one rounded block', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const leading = css.match(/\.subagentResourceCard\[data-chat-resource-card\]:has\(\+ \.subagentResourceCard\[data-chat-resource-card\]\)\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const trailing = css.match(/\.subagentResourceCard\[data-chat-resource-card\]\s*\+\s*\.subagentResourceCard\[data-chat-resource-card\]\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(leading).toContain('margin-bottom: 0');
    expect(leading).toContain('border-bottom-left-radius: 0');
    expect(leading).toContain('border-bottom-right-radius: 0');
    expect(trailing).toContain('margin-top: 0');
    expect(trailing).toContain('border-top-left-radius: 0');
    expect(trailing).toContain('border-top-right-radius: 0');
    expect(trailing).toContain('border-top: 1px solid var(--overlay-light');
  });

  it('renders the task-family container: four-corner radius, no accent quote bar', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const toolGroupRule = css.match(/\.toolGroup\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    expect(toolGroupRule).toContain('border-radius: var(--radius-sm)');
    expect(toolGroupRule).not.toContain('padding-left');
    expect(css).not.toMatch(/\.toolGroup::before/);
    expect(css).not.toContain('hana-tool-bar-in');

    const toolDotsRule = css.match(/\.toolDots\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    expect(toolDotsRule).toContain('color: var(--tool-text)');
  });
});
