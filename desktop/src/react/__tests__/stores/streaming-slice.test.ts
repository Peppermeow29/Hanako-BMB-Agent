import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createStreamingSlice, type StreamingSlice } from '../../stores/streaming-slice';

function makeSlice(locatorState: Record<string, unknown> = {}): StreamingSlice {
  let state: StreamingSlice & Record<string, unknown>;
  const set = (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = { ...createStreamingSlice(set, get), ...locatorState };
  return new Proxy({} as StreamingSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('streaming-slice', () => {
  let slice: StreamingSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态', () => {
    expect(slice.streamingSessions).toEqual([]);
    expect(slice.activeSessionStreams).toEqual({});
    expect(slice.unreadOutputSessionPaths).toEqual([]);
    expect(slice.inlineErrors).toEqual({});
  });

  it('addStreamingSession 添加 path', () => {
    slice.addStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });

  it('addStreamingSession 去重', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });

  it('addStreamingSession 多个不同 path', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s2');
    expect(slice.streamingSessions).toEqual(['/s1', '/s2']);
  });

  it('removeStreamingSession 移除指定 path', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s2');
    slice.removeStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s2']);
  });

  it('removeStreamingSession 对不存在的 path 无影响', () => {
    slice.addStreamingSession('/s1');
    slice.removeStreamingSession('/x');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });

  it('removeStreamingSession 忽略不匹配的旧 streamId', () => {
    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    const applied = slice.removeStreamingSession('/s1', { streamId: 'stream-old' });
    expect(applied).toBe(false);
    expect(slice.streamingSessions).toEqual(['/s1']);
    expect(slice.activeSessionStreams['/s1']).toEqual({ streamId: 'stream-new', turnId: null });
  });

  it('addStreamingSession 不用空身份覆盖已有 streamId', () => {
    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    slice.addStreamingSession('/s1', { streamId: null });
    expect(slice.streamingSessions).toEqual(['/s1']);
    expect(slice.activeSessionStreams['/s1']).toEqual({ streamId: 'stream-new', turnId: null });
  });

  it('removeStreamingSession 不允许空身份结束已有 streamId 的运行态', () => {
    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    const applied = slice.removeStreamingSession('/s1', { streamId: null });
    expect(applied).toBe(false);
    expect(slice.streamingSessions).toEqual(['/s1']);
    expect(slice.activeSessionStreams['/s1']).toEqual({ streamId: 'stream-new', turnId: null });
  });

  it('forceRemoveStreamingSession 清理服务端权威恢复确认的运行态', () => {
    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    const applied = slice.forceRemoveStreamingSession('/s1');
    expect(applied).toBe(true);
    expect(slice.streamingSessions).toEqual([]);
    expect(slice.activeSessionStreams['/s1']).toBeUndefined();
  });

  it('removeStreamingSession 接受匹配的 streamId 并清理 active state', () => {
    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    const applied = slice.removeStreamingSession('/s1', { streamId: 'stream-new' });
    expect(applied).toBe(true);
    expect(slice.streamingSessions).toEqual([]);
    expect(slice.activeSessionStreams['/s1']).toBeUndefined();
  });

  it('markSessionOutputUnread 标记后台完成输出并去重', () => {
    slice.markSessionOutputUnread('/s1');
    slice.markSessionOutputUnread('/s1');
    slice.markSessionOutputUnread('/s2');
    expect(slice.unreadOutputSessionPaths).toEqual(['/s1', '/s2']);
  });

  it('clearSessionOutputUnread 清理指定 session 的未读输出标记', () => {
    slice.markSessionOutputUnread('/s1');
    slice.markSessionOutputUnread('/s2');
    slice.clearSessionOutputUnread('/s1');
    expect(slice.unreadOutputSessionPaths).toEqual(['/s2']);
  });

  it('已知 locator 的流式状态用 sessionId 做存储 key，并支持 legacy path 清理', () => {
    slice = makeSlice({
      currentSessionPath: '/s1',
      currentSessionId: 'sess_1',
      sessions: [{ path: '/s1', sessionId: 'sess_1' }],
      sessionLocatorsById: { sess_1: { path: '/s1' } },
    });

    slice.addStreamingSession('/s1', { streamId: 'stream-new' });
    slice.markSessionOutputUnread('/s1');
    slice.setInlineError('/s1', 'boom', 0);

    expect(slice.streamingSessions).toEqual(['sess_1']);
    expect(slice.activeSessionStreams).toEqual({ sess_1: { streamId: 'stream-new', turnId: null } });
    expect(slice.unreadOutputSessionPaths).toEqual(['sess_1']);
    expect(slice.inlineErrors).toEqual({ sess_1: { text: 'boom', detail: null, code: null } });

    expect(slice.removeStreamingSession('/s1', { streamId: 'stream-new' })).toBe(true);
    slice.clearSessionOutputUnread('/s1');
    slice.clearInlineError('/s1');

    expect(slice.streamingSessions).toEqual([]);
    expect(slice.activeSessionStreams).toEqual({});
    expect(slice.unreadOutputSessionPaths).toEqual([]);
    expect(slice.inlineErrors).toEqual({ sess_1: null });
  });
});

describe('streaming-slice · inlineError TTL', () => {
  let slice: StreamingSlice;

  beforeEach(() => {
    vi.useFakeTimers();
    slice = makeSlice();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setInlineError 写入文本', () => {
    slice.setInlineError('/s1', 'boom');
    expect(slice.inlineErrors['/s1']?.text).toBe('boom');
  });

  it('字符串入参归一化成结构化条目，不凭空造 detail/code', () => {
    slice.setInlineError('/s1', 'boom', 0);
    expect(slice.inlineErrors['/s1']).toEqual({ text: 'boom', detail: null, code: null });
  });

  it('结构化入参原样保留人话、详情与错误码', () => {
    slice.setInlineError('/s1', {
      text: '这条消息之后还有任务在跑',
      detail: 'active task cannot be shared by a session fork: subagent-1',
      code: 'session_fork_active_task',
    }, 0);

    expect(slice.inlineErrors['/s1']).toEqual({
      text: '这条消息之后还有任务在跑',
      detail: 'active task cannot be shared by a session fork: subagent-1',
      code: 'session_fork_active_task',
    });
  });

  it('默认 5s 后自动清除', () => {
    slice.setInlineError('/s1', 'boom');
    expect(slice.inlineErrors['/s1']?.text).toBe('boom');
    vi.advanceTimersByTime(4999);
    expect(slice.inlineErrors['/s1']?.text).toBe('boom');
    vi.advanceTimersByTime(1);
    expect(slice.inlineErrors['/s1']).toBeNull();
  });

  it('自定义 ttl 生效', () => {
    slice.setInlineError('/s1', 'boom', 1000);
    vi.advanceTimersByTime(999);
    expect(slice.inlineErrors['/s1']?.text).toBe('boom');
    vi.advanceTimersByTime(1);
    expect(slice.inlineErrors['/s1']).toBeNull();
  });

  it('ttl=0 时不自动清除（永久 error）', () => {
    slice.setInlineError('/s1', 'critical', 0);
    vi.advanceTimersByTime(60000);
    expect(slice.inlineErrors['/s1']?.text).toBe('critical');
  });

  it('新 error 覆盖旧 error 时取消旧定时器，不会误清新 error', () => {
    slice.setInlineError('/s1', 'old', 5000);
    vi.advanceTimersByTime(3000);
    slice.setInlineError('/s1', 'new', 5000);
    // 原旧定时器到期时间点到了，新 error 不应该被清
    vi.advanceTimersByTime(2000);
    expect(slice.inlineErrors['/s1']?.text).toBe('new');
    // 从新 error 写入算起 5s 后，才清除
    vi.advanceTimersByTime(3000);
    expect(slice.inlineErrors['/s1']).toBeNull();
  });

  it('连续两次同样的文案，旧定时器不会把新写入的那条清掉', () => {
    // 同一个错误重复发生时文案完全一样，靠文本相等判断归属会误清新条目。
    slice.setInlineError('/s1', 'boom', 5000);
    vi.advanceTimersByTime(3000);
    slice.setInlineError('/s1', 'boom', 5000);
    vi.advanceTimersByTime(2000);
    expect(slice.inlineErrors['/s1']?.text).toBe('boom');
    vi.advanceTimersByTime(3000);
    expect(slice.inlineErrors['/s1']).toBeNull();
  });

  it('clearInlineError 立刻清除并取消定时器', () => {
    slice.setInlineError('/s1', 'boom');
    slice.clearInlineError('/s1');
    expect(slice.inlineErrors['/s1']).toBeNull();
    // 确认定时器已取消，后续推进也不会误写
    slice.setInlineError('/s1', 'fresh', 0); // 防 timer 污染
    vi.advanceTimersByTime(10000);
    expect(slice.inlineErrors['/s1']?.text).toBe('fresh');
  });

  it('多 session 独立管理', () => {
    slice.setInlineError('/s1', 'e1', 3000);
    slice.setInlineError('/s2', 'e2', 5000);
    vi.advanceTimersByTime(3000);
    expect(slice.inlineErrors['/s1']).toBeNull();
    expect(slice.inlineErrors['/s2']?.text).toBe('e2');
    vi.advanceTimersByTime(2000);
    expect(slice.inlineErrors['/s2']).toBeNull();
  });
});
