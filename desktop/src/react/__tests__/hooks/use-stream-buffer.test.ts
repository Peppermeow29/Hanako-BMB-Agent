/**
 * streamBufferManager 行为测试
 *
 * 聚焦 "MOOD 后中断" bug 的三条防线：
 *   1) snapshot 能反映 in-flight 内容（供 loadMessages 合并）
 *   2) invalidate 桥接能清掉 buf（数据归属方主动清）
 *   3) ensureMessage 自愈：session 被 initSession 覆盖后，后续 live 事件仍能
 *      绑定回同一条 assistant message，而不是靠"最后一条消息"猜目标
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamBufferManager } from '../../hooks/use-stream-buffer';
import {
  snapshotStreamBuffer,
  invalidateStreamBuffer,
} from '../../stores/stream-invalidator';
import { useStore } from '../../stores';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';

const PATH = '/test/session.jsonl';
const MOVED_PATH = '/test/moved-session.jsonl';
const SESSION_ID = 'sess_stream_buffer';

function userItem(id: string, text: string): ChatListItem {
  return { type: 'message', data: { id, role: 'user', text } };
}

function getItems(): ChatListItem[] {
  return useStore.getState().chatSessions[PATH]?.items ?? [];
}

function sessionScopedItems(sessionPath: string): ChatListItem[] {
  const state: any = useStore.getState();
  return state.chatSessions[SESSION_ID]?.items ?? state.chatSessions[sessionPath]?.items ?? [];
}

function lastRole(): string | undefined {
  const items = getItems();
  const last = items[items.length - 1];
  return last?.type === 'message' ? last.data.role : undefined;
}

function getAssistantMessage(): ChatMessage | null {
  const item = getItems().find((entry) => entry.type === 'message' && entry.data.role === 'assistant');
  return item?.type === 'message' ? item.data : null;
}

function getThinkingBlock() {
  return getAssistantMessage()?.blocks?.find((block) => block.type === 'thinking') ?? null;
}

describe('streamBufferManager.snapshot', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.setState({
      currentSessionId: null,
      currentSessionPath: null,
      sessions: [],
      sessionLocatorsById: {},
    } as never);
    useStore.getState().clearSession(PATH);
    useStore.getState().clearSession(MOVED_PATH);
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
  });

  it('空 buffer 返回 null', () => {
    expect(snapshotStreamBuffer(PATH)).toBeNull();
  });

  it('累积 mood + text 后，snapshot 反映当前内容', () => {
    useStore.setState({
      sessions: [{
        path: PATH,
        agentId: 'owner',
        title: null,
        firstMessage: '',
        modified: '',
        messageCount: 0,
      }],
      agents: [{ id: 'owner', yuan: 'butter' }],
      currentAgentId: 'focus',
      agentYuan: 'hanako',
    } as never);

    streamBufferManager.handle({ type: 'mood_start', sessionPath: PATH });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Vibe: 好\n' });
    streamBufferManager.handle({ type: 'mood_text', sessionPath: PATH, delta: 'Will: 继续' });
    streamBufferManager.handle({ type: 'mood_end', sessionPath: PATH });
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '正文开始' });

    const snap = snapshotStreamBuffer(PATH);
    const streamed = getItems()[1];
    expect(streamed?.type).toBe('message');
    expect(snap).not.toBeNull();
    expect(snap!.hasContent).toBe(true);
    expect(snap!.messageId).toBe(streamed && streamed.type === 'message' ? streamed.data.id : null);
    expect(snap!.mood).toBe('Vibe: 好\nWill: 继续');
    expect(snap!.moodYuan).toBe('butter');
    expect(snap!.text).toBe('正文开始');
    expect(snap!.inMood).toBe(false);
  });

  it('invalidate 之后 snapshot 变 null（归属方清干净）', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'abc' });
    expect(snapshotStreamBuffer(PATH)?.hasContent).toBe(true);

    invalidateStreamBuffer(PATH);
    expect(snapshotStreamBuffer(PATH)).toBeNull();
  });

  it('turn_end binds persisted Pi entry ids to the live user and assistant messages', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'reply' });
    const assistantBefore = getAssistantMessage();
    expect(assistantBefore?.sourceEntryId).toBeUndefined();

    streamBufferManager.handle({
      type: 'turn_end',
      sessionPath: PATH,
      turnInputEntryId: 'entry-user-1',
      userEntryId: 'entry-user-1',
      assistantEntryId: 'entry-assistant-1',
    });

    const items = getItems().filter((item) => item.type === 'message');
    expect(items[0]?.type === 'message' ? items[0].data.sourceEntryId : null).toBe('entry-user-1');
    expect(getAssistantMessage()?.sourceEntryId).toBe('entry-assistant-1');
    expect(getAssistantMessage()?.turnInputEntryId).toBe('entry-user-1');
  });

  it('turn_end never overwrites a visible user with a hidden background input id', () => {
    useStore.getState().initSession(PATH, [{
      type: 'message',
      data: { id: 'u1', role: 'user', text: 'hi', sourceEntryId: 'entry-visible-user' },
    }], false);
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'background reply' });

    streamBufferManager.handle({
      type: 'turn_end',
      sessionPath: PATH,
      turnInputEntryId: 'entry-hidden-background-input',
      userEntryId: null,
      assistantEntryId: 'entry-background-assistant',
    });

    const visibleUser = getItems().find((item) => item.type === 'message' && item.data.role === 'user');
    expect(visibleUser?.type === 'message' ? visibleUser.data.sourceEntryId : null).toBe('entry-visible-user');
    expect(getAssistantMessage()).toMatchObject({
      sourceEntryId: 'entry-background-assistant',
      turnInputEntryId: 'entry-hidden-background-input',
    });
  });
});

describe('streamBufferManager.thinking 流式刷新', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.setState({
      currentSessionId: null,
      currentSessionPath: null,
      sessions: [],
      sessionLocatorsById: {},
    } as never);
    useStore.getState().clearSession(PATH);
    useStore.getState().clearSession(MOVED_PATH);
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
  });

  it('thinking_delta 按 30Hz 节奏刷新，未 thinking_end 也能显示内容', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-28T00:00:00.000Z'));

      streamBufferManager.handle({ type: 'thinking_start', sessionPath: PATH });
      streamBufferManager.handle({ type: 'thinking_delta', sessionPath: PATH, delta: '第一段思考' });

      const beforeFlush = getThinkingBlock();
      expect(beforeFlush).toEqual({ type: 'thinking', content: '', sealed: false });

      vi.advanceTimersByTime(32);
      expect(getThinkingBlock()).toEqual({ type: 'thinking', content: '', sealed: false });

      vi.advanceTimersByTime(1);
      expect(getThinkingBlock()).toEqual({ type: 'thinking', content: '第一段思考', sealed: false });
    } finally {
      streamBufferManager.clearAll();
      vi.useRealTimers();
    }
  });

  it('空 thinking 结束后保留 sealed 完成态，而不是消失或停在活跃态', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath: PATH });
    expect(getThinkingBlock()).toEqual({ type: 'thinking', content: '', sealed: false });

    streamBufferManager.handle({ type: 'thinking_end', sessionPath: PATH });
    expect(getThinkingBlock()).toEqual({ type: 'thinking', content: '', sealed: true });
  });
});

describe('streamBufferManager.ensureMessage 自愈', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.setState({
      currentSessionId: null,
      currentSessionPath: null,
      sessions: [],
      sessionLocatorsById: {},
    } as never);
    useStore.getState().clearSession(PATH);
    useStore.getState().clearSession(MOVED_PATH);
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
  });

  it('首次 text_delta 会 append 一条新 assistant', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '你好' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
  });

  it('text block keeps source markdown for display-only streaming effects', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: '**你好**' });

    const textBlock = getAssistantMessage()?.blocks?.find((block) => block.type === 'text');
    expect(textBlock).toMatchObject({
      type: 'text',
      source: '**你好**',
    });
    expect(textBlock && 'html' in textBlock ? textBlock.html : '').toContain('<strong>');
  });

  it('initSession 覆盖同 path 后，后续 tool 事件仍绑定回原 assistant 消息', () => {
    streamBufferManager.handle({ type: 'text_delta', sessionPath: PATH, delta: 'first' });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
    const firstAssistant = getItems()[1];
    const assistantId = firstAssistant?.type === 'message' ? firstAssistant.data.id : null;
    expect(assistantId).toBeTruthy();

    // 模拟 loadMessages 覆盖同 path：store 里暂时只剩 user。
    useStore.getState().initSession(PATH, [userItem('u1', 'hi')], false);
    expect(getItems().length).toBe(1);
    expect(lastRole()).toBe('user');

    // 后续不一定还有 text_delta；tool_start 也必须能把同一条 assistant 重新接回来。
    streamBufferManager.handle({ type: 'tool_start', sessionPath: PATH, name: 'web.search', args: { q: 'mi mo' } });
    expect(getItems().length).toBe(2);
    expect(lastRole()).toBe('assistant');
    const last = getItems()[1];
    expect(last.type).toBe('message');
    if (last.type !== 'message') throw new Error('expected assistant message');
    expect(last.data.id).toBe(assistantId);
    expect(last.data.blocks?.some((block: { type: string }) => block.type === 'tool_group')).toBe(true);
  });

  it('keeps in-flight turn state attached to sessionId when the session path moves', () => {
    useStore.setState({
      sessions: [{
        path: PATH,
        sessionId: SESSION_ID,
        agentId: 'owner',
        title: null,
        firstMessage: '',
        modified: '',
        messageCount: 0,
      }],
      sessionLocatorsById: { [SESSION_ID]: { path: PATH } },
      currentSessionId: SESSION_ID,
      currentSessionPath: PATH,
    } as never);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionId: SESSION_ID,
      sessionPath: PATH,
      delta: 'first',
    });
    const firstAssistantItem = sessionScopedItems(PATH)
      .find((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(firstAssistantItem?.type).toBe('message');
    if (firstAssistantItem?.type !== 'message') throw new Error('expected first assistant message');
    const firstAssistant = firstAssistantItem.data;
    expect(firstAssistant?.blocks?.find((block) => block.type === 'text')).toMatchObject({
      type: 'text',
      source: 'first',
    });

    useStore.setState((state: any) => ({
      sessions: state.sessions.map((session: any) => (
        session.sessionId === SESSION_ID ? { ...session, path: MOVED_PATH } : session
      )),
      sessionLocatorsById: { [SESSION_ID]: { path: MOVED_PATH } },
      currentSessionId: SESSION_ID,
      currentSessionPath: MOVED_PATH,
    }) as never);
    useStore.getState().initSession(MOVED_PATH, [
      userItem('u1', 'hi'),
      { type: 'message', data: firstAssistant! },
    ], true);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionId: SESSION_ID,
      sessionPath: MOVED_PATH,
      delta: ' second',
    });

    expect(snapshotStreamBuffer(MOVED_PATH)?.text).toBe('first second');
    expect(snapshotStreamBuffer(PATH)?.text).toBe('first second');
    streamBufferManager.finishTurn(MOVED_PATH, SESSION_ID);

    const movedItems = sessionScopedItems(MOVED_PATH);
    const movedAssistant = movedItems.find((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(movedAssistant?.type).toBe('message');
    if (movedAssistant?.type !== 'message') throw new Error('expected moved assistant message');
    expect(movedAssistant.data.id).toBe(firstAssistant?.id);
    expect(movedAssistant.data.blocks?.find((block) => block.type === 'text')).toMatchObject({
      type: 'text',
      source: 'first second',
    });
    expect(snapshotStreamBuffer(MOVED_PATH)).toBeNull();
    expect(snapshotStreamBuffer(PATH)).toBeNull();
  });

  it('tool_end 有调用 ID 时只闭合对应的同名工具', () => {
    streamBufferManager.handle({ type: 'tool_start', sessionPath: PATH, id: 'call_a', name: 'echo', args: { value: 'first' } });
    streamBufferManager.handle({ type: 'tool_start', sessionPath: PATH, id: 'call_b', name: 'echo', args: { value: 'second' } });
    streamBufferManager.handle({ type: 'tool_end', sessionPath: PATH, id: 'call_b', name: 'echo', success: true });

    const group = getAssistantMessage()?.blocks?.find((block) => block.type === 'tool_group');
    expect(group).toBeTruthy();
    if (!group || group.type !== 'tool_group') throw new Error('expected tool group');
    expect(group.tools).toEqual([
      expect.objectContaining({ id: 'call_a', name: 'echo', done: false }),
      expect.objectContaining({ id: 'call_b', name: 'echo', done: true, success: true }),
    ]);
  });

  it('tool_end keeps the live failure outcome and short reason', () => {
    streamBufferManager.handle({ type: 'tool_start', sessionPath: PATH, id: 'call_failed', name: 'read' });
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath: PATH,
      id: 'call_failed',
      name: 'read',
      status: 'failed',
      success: false,
      error: 'permission denied',
    });

    const group = getAssistantMessage()?.blocks?.find((block) => block.type === 'tool_group');
    expect(group).toBeTruthy();
    if (!group || group.type !== 'tool_group') throw new Error('expected tool group');
    expect(group.tools[0]).toMatchObject({
      id: 'call_failed',
      done: true,
      success: false,
      status: 'failed',
      error: 'permission denied',
    });
  });

  it('renders a delayed result file as a normal attachment without a generation placeholder', () => {
    streamBufferManager.handle({ type: 'turn_end', sessionPath: PATH });
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'file',
        fileId: 'sf_result',
        filePath: '/tmp/result.png',
        label: 'result.png',
        ext: 'png',
        mime: 'image/png',
        kind: 'image',
      },
    });

    const assistantItems = getItems().filter((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    const assistant = assistantItems[0];
    expect(assistant?.type).toBe('message');
    if (assistant?.type !== 'message') throw new Error('expected assistant message');
    expect(assistant.data.blocks).toEqual([
      expect.objectContaining({ type: 'file', fileId: 'sf_result', filePath: '/tmp/result.png' }),
    ]);
  });

  it('workflow pre-reply 幕间成为独立时间线条目，不伪装成 assistant 消息', () => {
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'workflow',
        taskId: 'workflow-1',
        taskTitle: 'ten-writers',
        streamStatus: 'running',
        startedAt: 1000,
      },
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath: PATH });

    streamBufferManager.beginTurn(PATH);
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'interlude',
        id: 'deferred:workflow-1:success',
        variant: 'deferred_result',
        taskId: 'workflow-1',
        status: 'success',
        sourceKind: 'workflow',
        sourceLabel: 'ten-writers',
        text: 'Hanako 收到了来自 ten-writers workflow 的结果',
        detailMarkdown: 'workflow result',
      },
    });

    expect(getItems().map((item) => item.type)).toEqual(['message', 'message', 'interlude']);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: PATH,
      delta: '收到 workflow 结果。',
    });
    streamBufferManager.finishTurn(PATH);

    const items = getItems();
    expect(items.map((item) => item.type)).toEqual(['message', 'message', 'interlude', 'message']);
    const interludeItem = items[2];
    expect(interludeItem?.type).toBe('interlude');
    if (interludeItem?.type !== 'interlude') throw new Error('expected interlude item');
    expect(interludeItem.data).toMatchObject({
      type: 'interlude',
      taskId: 'workflow-1',
      sourceKind: 'workflow',
    });

    const assistantItems = getItems().filter((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(assistantItems).toHaveLength(2);
    const [workflowMessage] = assistantItems;
    expect(workflowMessage?.type).toBe('message');
    if (workflowMessage?.type !== 'message') throw new Error('expected assistant message');
    expect(workflowMessage.data.blocks?.map((block) => block.type)).toEqual(['workflow']);
    const replyMessage = assistantItems[1];
    expect(replyMessage?.type).toBe('message');
    if (replyMessage?.type !== 'message') throw new Error('expected reply message');
    expect(replyMessage.data.blocks?.find((block) => block.type === 'text')).toMatchObject({
      type: 'text',
      source: '收到 workflow 结果。',
    });
  });

  it('beginTurn 后收到的 workflow 幕间会插在新 assistant 回复前', () => {
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'workflow',
        taskId: 'workflow-late-text',
        taskTitle: '冒烟测试',
        streamStatus: 'running',
        startedAt: 1000,
      },
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath: PATH });

    const firstItems = getItems();
    const firstAssistant = firstItems.find((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(firstAssistant?.type).toBe('message');
    if (firstAssistant?.type !== 'message') throw new Error('expected first assistant message');
    const firstAssistantId = firstAssistant.data.id;

    streamBufferManager.beginTurn(PATH);
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'interlude',
        id: 'deferred:workflow-late-text:success',
        variant: 'deferred_result',
        taskId: 'workflow-late-text',
        status: 'success',
        sourceKind: 'workflow',
        sourceLabel: '冒烟测试',
        text: 'Hanako 收到了来自 冒烟测试 workflow 的结果',
      },
    });

    expect(getItems().map((item) => (item.type === 'message' ? item.data.id : item.id))).toEqual([
      'u1',
      firstAssistantId,
      'deferred:workflow-late-text:success',
    ]);

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: PATH,
      delta: '收到，workflow 已经完成。',
    });
    streamBufferManager.finishTurn(PATH);

    const items = getItems();
    expect(items.map((item) => (item.type === 'message' ? item.data.id : item.id))).toEqual([
      'u1',
      firstAssistantId,
      'deferred:workflow-late-text:success',
      expect.stringMatching(/^stream-/),
    ]);

    const assistantItems = items.filter((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(assistantItems).toHaveLength(2);
    const workflowMessage = assistantItems[0];
    expect(workflowMessage?.type).toBe('message');
    if (workflowMessage?.type !== 'message') throw new Error('expected assistant message');
    expect(workflowMessage.data.id).toBe(firstAssistantId);
    expect(workflowMessage.data.blocks?.map((block) => block.type)).toEqual(['workflow']);
    const replyMessage = assistantItems[1];
    expect(replyMessage?.type).toBe('message');
    if (replyMessage?.type !== 'message') throw new Error('expected reply message');
    const textBlock = replyMessage.data.blocks?.find((block) => block.type === 'text');
    expect(textBlock).toMatchObject({
      type: 'text',
      source: '收到，workflow 已经完成。',
    });
  });

  it('beginTurn 会清掉上一轮 assistant 绑定，让幕间后的正文创建新消息', () => {
    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'workflow',
        taskId: 'workflow-mid-turn',
        taskTitle: '中途结果',
        streamStatus: 'running',
        startedAt: 1000,
      },
    });
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: PATH,
      delta: 'Workflow 已经提交后台运行了。',
    });
    streamBufferManager.finishTurn(PATH);

    const firstItems = getItems();
    const firstAssistant = firstItems.find((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(firstAssistant?.type).toBe('message');
    if (firstAssistant?.type !== 'message') throw new Error('expected first assistant message');
    const firstAssistantId = firstAssistant.data.id;

    streamBufferManager.beginTurn(PATH);

    streamBufferManager.handle({
      type: 'content_block',
      sessionPath: PATH,
      block: {
        type: 'interlude',
        id: 'deferred:workflow-mid-turn:success',
        variant: 'deferred_result',
        taskId: 'workflow-mid-turn',
        status: 'success',
        sourceKind: 'workflow',
        sourceLabel: '中途结果',
        text: 'Hanako 收到了来自 中途结果 workflow 的结果',
      },
    });

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath: PATH,
      delta: '收到，workflow 已经完成。',
    });
    streamBufferManager.finishTurn(PATH);

    const items = getItems();
    expect(items.map((item) => (item.type === 'message' ? item.data.id : item.id))).toEqual([
      'u1',
      firstAssistantId,
      'deferred:workflow-mid-turn:success',
      expect.stringMatching(/^stream-/),
    ]);

    const assistantItems = items.filter((item) => item.type === 'message' && item.data.role === 'assistant');
    expect(assistantItems).toHaveLength(2);
    const workflowMessage = assistantItems[0];
    expect(workflowMessage?.type).toBe('message');
    if (workflowMessage?.type !== 'message') throw new Error('expected assistant message');
    expect(workflowMessage.data.id).toBe(firstAssistantId);
    expect(workflowMessage.data.blocks?.map((block) => block.type)).toEqual(['workflow', 'text']);
    expect(workflowMessage.data.blocks?.find((block) => block.type === 'text')).toMatchObject({
      type: 'text',
      source: 'Workflow 已经提交后台运行了。',
    });
    const replyMessage = assistantItems[1];
    expect(replyMessage?.type).toBe('message');
    if (replyMessage?.type !== 'message') throw new Error('expected reply message');
    expect(replyMessage.data.blocks?.find((block) => block.type === 'text')).toMatchObject({
      type: 'text',
      source: '收到，workflow 已经完成。',
    });
  });
});
