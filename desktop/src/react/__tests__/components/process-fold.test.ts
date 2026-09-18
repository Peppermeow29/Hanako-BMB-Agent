import { describe, expect, it } from 'vitest';
import type { ChatListItem, ChatMessage, ContentBlock, ToolCall } from '../../stores/chat-types';
import {
  buildProcessFoldSummary,
  buildTranscriptRenderItems,
  isProcessOnlyAssistantMessage,
} from '../../components/chat/process-fold';

function user(id: string, text = '请处理'): ChatListItem {
  return { type: 'message', data: { id, role: 'user', text } };
}

function assistant(id: string, blocks: ContentBlock[], turnInputEntryId?: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'assistant',
      blocks,
      ...(turnInputEntryId ? { turnInputEntryId } : {}),
    },
  };
}

function thinking(content = '想了一下'): ContentBlock {
  return { type: 'thinking', content, sealed: true };
}

function tool(name: string, success = true): ToolCall {
  return { name, args: { command: name }, done: true, success };
}

function toolGroup(tools: ToolCall[]): ContentBlock {
  return { type: 'tool_group', tools, collapsed: tools.length > 1 };
}

function textBlock(html = '<p>完成</p>', source?: string): ContentBlock {
  return { type: 'text', html, ...(source ? { source } : {}) };
}

describe('process fold grouping', () => {
  it('folds consecutive process-only assistant messages into one render item', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([tool('bash')])]),
      assistant('a2', [thinking(), toolGroup([tool('read'), tool('write')])]),
      assistant('a3', [thinking(), toolGroup([tool('grep')])]),
      assistant('a4', [textBlock('<p>正文</p>')]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toMatchObject({
      type: 'process_fold',
      id: 'process-fold-a1-a3',
      stats: {
        toolCount: 4,
        thinkingCount: 3,
        unsuccessfulCount: 0,
      },
    });
    expect(rendered[2]).toMatchObject({ type: 'source', item: items[4] });
  });

  it('does not treat assistant messages that contain mood, pulse, or reflect as foldable process', () => {
    const moodMessage: ChatMessage = {
      id: 'mood',
      role: 'assistant',
      blocks: [thinking(), { type: 'mood', yuan: 'butter', text: 'PULSE' }],
    };

    expect(isProcessOnlyAssistantMessage(moodMessage)).toBe(false);
  });

  it('does not throw or fold malformed tool_group blocks', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [{ type: 'tool_group', collapsed: false } as unknown as ContentBlock]),
      assistant('a2', [{ type: 'tool_group', tools: null, collapsed: false } as unknown as ContentBlock]),
      assistant('a3', [toolGroup([tool('read')])]),
    ];

    expect(() => buildTranscriptRenderItems(items, { isStreaming: false })).not.toThrow();
    expect(buildTranscriptRenderItems(items, { isStreaming: false }).map((item) => item.type)).toEqual([
      'source',
      'source',
      'source',
      'source',
    ]);
  });

  it('does not throw on malformed text blocks without html/source', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [
        thinking(),
        { type: 'text' } as unknown as ContentBlock,
        toolGroup([tool('read')]),
      ]),
    ];

    expect(() => buildTranscriptRenderItems(items, { isStreaming: false })).not.toThrow();
    expect(buildTranscriptRenderItems(items, { isStreaming: false })[1]).toMatchObject({
      type: 'source',
      item: items[1],
    });
  });

  it('folds short process narration before the final answer', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [
        thinking(),
        textBlock('<p>现在开始执行。</p>', '现在开始执行。'),
        toolGroup([tool('missing-file', false)]),
      ]),
      assistant('a2', [
        thinking(),
        textBlock('<p>第二步：读取真实文件。</p>', '第二步：读取真实文件。'),
        toolGroup([tool('read')]),
      ]),
      assistant('a3', [
        thinking(),
        textBlock('<p>第三步：核对结果。</p>', '第三步：核对结果。'),
        toolGroup([tool('verify')]),
      ]),
      assistant('a4', [
        thinking(),
        textBlock('<p>全部检查完成。以下是总结。</p>', '全部检查完成。以下是总结。'),
      ]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toMatchObject({
      type: 'process_fold',
      id: 'process-fold-a1-a3',
      stats: {
        toolCount: 3,
        thinkingCount: 3,
        unsuccessfulCount: 1,
      },
    });
    expect(rendered[2]).toMatchObject({ type: 'source', item: items[4] });
  });

  it('counts all tool calls in process fold stats', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([
        tool('media_generate-image', false),
        tool('browser'),
      ])]),
      assistant('a2', [thinking(), toolGroup([
        tool('workflow'),
        tool('install_skill'),
      ])]),
      assistant('a3', [thinking(), toolGroup([
        tool('update_settings'),
        { ...tool('automation'), args: { action: 'pending_update' } },
        tool('hana_card_guide'),
        tool('show_card'),
      ])]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered[1]).toMatchObject({
      type: 'process_fold',
      stats: {
        toolCount: 8,
        thinkingCount: 3,
        unsuccessfulCount: 1,
      },
    });
  });

  it('keeps user steer messages as hard fold boundaries', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([tool('read')])]),
      assistant('a2', [thinking(), toolGroup([tool('write')])]),
      assistant('a3', [thinking(), toolGroup([tool('stat')])]),
      user('u2', '先暂停一下，换个文件看'),
      assistant('a4', [thinking(), toolGroup([tool('grep')])]),
      assistant('a5', [textBlock('<p>第二轮总结。</p>', '第二轮总结。')]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered.map((item) => item.type)).toEqual([
      'source',
      'process_fold',
      'source',
      'source',
      'source',
    ]);
    expect(rendered[1]).toMatchObject({ id: 'process-fold-a1-a3' });
    expect(rendered[2]).toMatchObject({ type: 'source', item: items[4] });
  });

  it('never folds process-only messages across hidden custom turn inputs', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([tool('read')])], 'hidden-input-1'),
      assistant('a2', [thinking(), toolGroup([tool('write')])], 'hidden-input-2'),
      assistant('a3', [thinking(), toolGroup([tool('verify')])], 'hidden-input-3'),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered).toHaveLength(4);
    expect(rendered.every((item) => item.type === 'source')).toBe(true);
  });

  it('protects the final short narration of every hidden custom turn', () => {
    const shortFinal = (label: string) => [
      thinking(),
      textBlock(`<p>${label}</p>`, label),
      toolGroup([tool('verify')]),
    ];
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([tool('read')])], 'hidden-input-1'),
      assistant('a2', shortFinal('第一轮完成'), 'hidden-input-1'),
      assistant('a3', [thinking(), toolGroup([tool('write')])], 'hidden-input-2'),
      assistant('a4', shortFinal('第二轮完成'), 'hidden-input-2'),
      assistant('a5', [thinking(), toolGroup([tool('grep')])], 'hidden-input-3'),
      assistant('a6', shortFinal('第三轮完成'), 'hidden-input-3'),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered).toHaveLength(7);
    expect(rendered.every((item) => item.type === 'source')).toBe(true);
  });

  it('keeps long middle text visible instead of treating it as process narration', () => {
    const longText = '这段内容已经接近真正的阶段性说明，包含足够多的细节和判断，读者刷新页面以后也应该直接看见它。'.repeat(5);
    const items: ChatListItem[] = [
      user('u1'),
      assistant('a1', [thinking(), toolGroup([tool('read')])]),
      assistant('a2', [
        thinking(),
        textBlock(`<p>${longText}</p>`, longText),
        toolGroup([tool('write')]),
      ]),
      assistant('a3', [thinking(), toolGroup([tool('grep')])]),
      assistant('a4', [thinking(), toolGroup([tool('ls')])]),
      assistant('a5', [thinking(), toolGroup([tool('pwd')])]),
      assistant('a6', [textBlock('<p>最后总结。</p>', '最后总结。')]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: false });

    expect(rendered.map((item) => item.type)).toEqual([
      'source',
      'source',
      'source',
      'process_fold',
      'source',
    ]);
    expect(rendered[1]).toMatchObject({ type: 'source', item: items[1] });
    expect(rendered[2]).toMatchObject({ type: 'source', item: items[2] });
    expect(rendered[3]).toMatchObject({ id: 'process-fold-a3-a5' });
  });

  it('leaves the current trailing process segment expanded while the session is streaming', () => {
    const items: ChatListItem[] = [
      user('u1'),
      assistant('old-a1', [thinking(), toolGroup([tool('bash')])]),
      assistant('old-a2', [thinking(), toolGroup([tool('read')])]),
      assistant('old-a3', [thinking(), toolGroup([tool('stat')])]),
      assistant('old-a4', [textBlock('<p>旧正文</p>')]),
      user('u2'),
      assistant('live-a1', [thinking(), toolGroup([tool('grep')])]),
      assistant('live-a2', [thinking(), toolGroup([tool('ls')])]),
    ];

    const rendered = buildTranscriptRenderItems(items, { isStreaming: true });

    expect(rendered.map((item) => item.type)).toEqual([
      'source',
      'process_fold',
      'source',
      'source',
      'source',
      'source',
    ]);
    expect(rendered[1]).toMatchObject({ id: 'process-fold-old-a1-old-a3' });
    expect(rendered[4]).toMatchObject({ type: 'source', item: items[6] });
    expect(rendered[5]).toMatchObject({ type: 'source', item: items[7] });
  });

  it('formats unsuccessful attempts as light process copy', () => {
    const text = buildProcessFoldSummary(
      { toolCount: 13, thinkingCount: 5, unsuccessfulCount: 1 },
      '小花',
      (key, vars) => {
        const table: Record<string, string> = {
          'processFold.summary': '✨ {name}忙活了一阵子',
          'processFold.tools': '{n} 个工具',
          'processFold.thinking': '{n} 次思考',
          'processFold.unsuccessful': '{n} 次尝试未成功',
        };
        return (table[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
      },
    );

    expect(text).toBe('✨ 小花忙活了一阵子 · 13 个工具 · 5 次思考 · 1 次尝试未成功');
  });
});
