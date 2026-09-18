// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../../components/chat/ChatTranscript';
import { useStore } from '../../stores';
import type { ChatListItem, ContentBlock, ToolCall } from '../../stores/chat-types';

const sessionPath = '/session/process-fold.jsonl';
const retryMock = vi.fn(async (..._args: unknown[]) => true);

vi.mock('../../stores/message-turn-actions', () => ({
  retrySessionTurn: (...args: unknown[]) => retryMock(...args),
  forkSessionTurn: vi.fn(async () => null),
  activateForkedSession: vi.fn(async () => undefined),
}));

function t(key: string, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = {
    'thinking.done': '思考完成',
    'thinking.active': '思考中',
    'toolGroup.count': '{n} 个工具',
    'toolGroup.countWithFail': '{total} 个工具（{fail} 个失败）',
    'toolGroup.running': '{n} 个工具运行中',
    'tool._fallback.done': '小花 忙完了',
    'tool._fallback.running': '小花 忙着',
    'processFold.summary': '✨ {name}忙活了一阵子',
    'processFold.tools': '{n} 个工具',
    'processFold.thinking': '{n} 次思考',
    'processFold.unsuccessful': '{n} 次尝试未成功',
    'common.regenerate': '重新生成',
    'common.forkSession': '分支为新会话',
  };
  return (table[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
}

function user(id: string): ChatListItem {
  return { type: 'message', data: { id, sourceEntryId: `entry-${id}`, role: 'user', text: '做一下' } };
}

function assistant(id: string, blocks: ContentBlock[]): ChatListItem {
  return { type: 'message', data: { id, sourceEntryId: `entry-${id}`, role: 'assistant', blocks } };
}

function thinking(content = '过程思考'): ContentBlock {
  return { type: 'thinking', content, sealed: true };
}

function tool(name: string, success = true): ToolCall {
  return { name, args: { command: name }, done: true, success };
}

function toolGroup(tools: ToolCall[]): ContentBlock {
  return { type: 'tool_group', tools, collapsed: false };
}

function textBlock(html: string, source: string): ContentBlock {
  return { type: 'text', html, source };
}

describe('ProcessFoldBlock', () => {
  beforeEach(() => {
    window.t = t as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: '小花',
      agentYuan: 'hanako',
      streamingSessions: [],
      selectedIdsBySession: {},
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [],
        },
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('exposes retry and fork on a collapsed process-only turn completion', () => {
    render(
      <ChatTranscript
        items={[
          user('u1'),
          assistant('a1', [thinking('第一步'), toolGroup([tool('read')])]),
          assistant('a2', [thinking('第二步'), toolGroup([tool('write')])]),
          assistant('a3', [thinking('第三步'), toolGroup([tool('verify')])]),
        ]}
        sessionPath={sessionPath}
        enableProcessFold
      />,
    );

    const footer = screen.getByTestId('process-fold-completion-actions');
    expect(within(footer).getByTitle('重新生成')).toBeInTheDocument();
    expect(within(footer).getByTitle('分支为新会话')).toBeInTheDocument();
    fireEvent.click(within(footer).getByTitle('重新生成'));

    expect(retryMock).toHaveBeenCalledWith(
      sessionPath,
      { role: 'assistant', entryId: 'entry-a3' },
      { message: expect.objectContaining({ id: 'u1', sourceEntryId: 'entry-u1', text: '做一下' }) },
    );
  });

  it('collapses process-only assistant runs and expands original blocks in place', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [
        thinking('第一段思考'),
        textBlock('<p>现在开始执行。</p>', '现在开始执行。'),
        toolGroup([tool('npm test')]),
      ]),
      assistant('a2', [
        thinking('第二段思考'),
        textBlock('<p>第二步：继续读文件。</p>', '第二步：继续读文件。'),
        toolGroup([tool('read'), tool('write', false)]),
      ]),
      assistant('a3', [
        thinking('第三段思考'),
        textBlock('<p>第三步：核对结果。</p>', '第三步：核对结果。'),
        toolGroup([tool('verify')]),
      ]),
      assistant('a4', [
        thinking('正文前思考'),
        { type: 'mood', yuan: 'butter', text: 'PULSE' },
        { type: 'text', html: '<p>正文来了</p>' },
      ]),
    ];

    render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
        enableProcessFold
      />,
    );

    const summary = screen.getByRole('button', {
      name: '✨ 小花忙活了一阵子 · 4 个工具 · 3 次思考 · 1 次尝试未成功',
    });
    expect(summary).toBeInTheDocument();
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('第一段思考')).not.toBeInTheDocument();
    expect(screen.queryByText('现在开始执行。')).not.toBeInTheDocument();
    expect(screen.queryByTitle('npm test')).not.toBeInTheDocument();
    expect(screen.getByText('正文来了')).toBeInTheDocument();
    expect(screen.getAllByText('思考完成')).toHaveLength(1);
    expect(screen.getByText(/PULSE/)).toBeInTheDocument();

    fireEvent.click(summary);

    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('npm test').length).toBeGreaterThan(0);
    expect(screen.getByText('现在开始执行。')).toBeInTheDocument();
    expect(screen.getAllByText('思考完成')).toHaveLength(4);
  });

  it('keeps the process-fold Collapse shell full width inside the assistant flex column', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/ProcessFoldBlock.tsx'),
      'utf8',
    );
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const processFoldCollapseRule = css.match(/\.processFoldCollapse\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(source).toContain('className={styles.processFoldCollapse}');
    expect(processFoldCollapseRule).toContain('width: 100%');
    expect(processFoldCollapseRule).toContain('box-sizing: border-box');
  });
});
