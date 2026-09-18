import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatSlice, type ChatSlice } from '../../stores/chat-slice';
import type { ChatListItem, SessionModel } from '../../stores/chat-types';
import { registerStreamBufferInvalidator, registerStreamResumeMetaInvalidator } from '../../stores/stream-invalidator';

function makeSlice(initial: Record<string, unknown> = {}): ChatSlice {
  let state: ChatSlice & Record<string, unknown>;
  const set = (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = { ...createChatSlice(set as never, get), ...initial };
  return new Proxy({} as ChatSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

const MODEL: SessionModel = {
  id: 'claude-opus-4-6',
  name: 'Claude Opus 4.6',
  provider: 'anthropic',
  input: ['text', 'image'],
  reasoning: true,
  contextWindow: 1_000_000,
};

function interludeItem(id: string): ChatListItem {
  return {
    type: 'interlude',
    id,
    data: {
      type: 'interlude',
      id,
      variant: 'deferred_result',
      status: 'success',
      text: '后台回复已抵达',
    },
  };
}

describe('chat-slice', () => {
  let slice: ChatSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态：chatSessions / sessionModelsByPath / _loadMessagesVersion 均为空', () => {
    expect(slice.chatSessions).toEqual({});
    expect(slice.sessionModelsByPath).toEqual({});
    expect(slice._loadMessagesVersion).toEqual({});
  });

  it('有 sessionId locator 时，消息、模型、registry 和清理都使用 sessionId key', () => {
    slice = makeSlice({
      currentSessionId: 'sess_chat',
      currentSessionPath: '/sessions/moved.jsonl',
      sessions: [{ sessionId: 'sess_chat', path: '/sessions/moved.jsonl' }],
      sessionLocatorsById: { sess_chat: { path: '/sessions/moved.jsonl' } },
    });

    slice.initSession('/sessions/moved.jsonl', [], false);
    slice.updateSessionModel('/sessions/moved.jsonl', MODEL);
    slice.setSessionRegistryFiles('/sessions/moved.jsonl', [{
      fileId: 'sf_1',
      filePath: '/tmp/out.md',
      label: 'out.md',
      mime: 'text/markdown',
      status: 'available',
    }]);

    expect(slice.chatSessions.sess_chat).toBeDefined();
    expect(slice.chatSessions['/sessions/moved.jsonl']).toBeUndefined();
    expect(slice.sessionModelsByPath.sess_chat).toEqual(MODEL);
    expect(slice.sessionRegistryFilesByPath.sess_chat).toHaveLength(1);

    slice.clearSession('/sessions/moved.jsonl');
    expect(slice.chatSessions.sess_chat).toBeUndefined();
    expect(slice.sessionModelsByPath.sess_chat).toBeUndefined();
    expect(slice.sessionRegistryFilesByPath.sess_chat).toBeUndefined();
  });

  describe('updateSessionModel', () => {
    it('uncached session 不在 chatSessions 里创建 stub（#405 核心回归）', () => {
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions).toEqual({});
      expect(slice.sessionModelsByPath).toEqual({ '/a': MODEL });
    });

    it('顺序无关：先 updateSessionModel 再 initSession，最终状态 chatSessions 存在 且 model 保留', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.chatSessions['/a']?.items).toEqual([]);
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('顺序无关：先 initSession 再 updateSessionModel，二者各自独立', () => {
      slice.initSession('/a', [], false);
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('多次 updateSessionModel 覆盖之前的值', () => {
      slice.updateSessionModel('/a', MODEL);
      const newer: SessionModel = { ...MODEL, id: 'claude-sonnet-4-6' };
      slice.updateSessionModel('/a', newer);
      expect(slice.sessionModelsByPath['/a']).toEqual(newer);
    });
  });

  describe('initSession', () => {
    it('不复用 chatSessions 中已有的 model 字段（model 已独立）', () => {
      // 即使下面这行在旧代码里会从 chatSessions[path].model 复用，
      // 新代码根本不会去碰 sessionModelsByPath
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toEqual({
        items: [],
        hasMore: false,
        loadingMore: false,
        oldestId: undefined,
        revision: null,
      });
    });

    it('记录 hydrate 时的磁盘修订点，缺省为 null', () => {
      slice.initSession('/a', [], false, '4096:1765500000000');
      expect(slice.chatSessions['/a']?.revision).toBe('4096:1765500000000');

      slice.initSession('/b', [], false);
      expect(slice.chatSessions['/b']?.revision).toBeNull();
    });

    it('oldestId 取第一条 message，不被前置幕间条目占位', () => {
      slice.initSession('/a', [
        interludeItem('deferred:task-1:success'),
        { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
      ], true);

      expect(slice.chatSessions['/a']?.oldestId).toBe('a1');
    });

    it('LRU 淘汰只影响 chatSessions，不动 sessionModelsByPath', () => {
      // 填满 8 个，且每个都写一份模型
      for (let i = 0; i < 9; i++) {
        const p = `/s${i}`;
        slice.updateSessionModel(p, MODEL);
        slice.initSession(p, [], false);
      }
      // chatSessions 最多 8 条
      expect(Object.keys(slice.chatSessions).length).toBeLessThanOrEqual(8);
      // 模型快照全量保留
      expect(Object.keys(slice.sessionModelsByPath).length).toBe(9);
    });
  });

  describe('bumpLoadMessagesVersion', () => {
    it('第一次返回 1，后续递增', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(3);
    });

    it('不同 path 的版本独立', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/b')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice._loadMessagesVersion).toEqual({ '/a': 2, '/b': 1 });
    });
  });

  describe('clearSession', () => {
    it('同时清掉 chatSessions / sessionModelsByPath / _loadMessagesVersion', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      slice.bumpLoadMessagesVersion('/a');
      slice.saveScrollPosition('/a', 128);
      slice.clearSession('/a');
      expect(slice.chatSessions['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice._loadMessagesVersion['/a']).toBeUndefined();
      expect(slice.scrollPositions['/a']).toBeUndefined();
    });

    it('只清目标 path，别的不动', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.updateSessionModel('/b', MODEL);
      slice.clearSession('/a');
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/b']).toEqual(MODEL);
    });

    it('通知 streamBufferManager invalidate 对应 session（归属方主动清）', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      slice.initSession('/a', [], false);
      slice.clearSession('/a');
      expect(invalidator).toHaveBeenCalledWith('/a');
    });

    it('通知 stream resume meta invalidate 对应 session（避免丢渲染缓存后从旧 seq 续传）', () => {
      const invalidator = vi.fn();
      registerStreamResumeMetaInvalidator(invalidator);
      slice.initSession('/a', [], false);
      slice.clearSession('/a');
      expect(invalidator).toHaveBeenCalledWith('/a');
    });

    it('LRU eviction 时也 invalidate 被淘汰 session 的 streamBuffer', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      for (let i = 0; i < 8; i++) {
        slice.saveScrollPosition(`/s${i}`, i);
      }
      for (let i = 0; i < 9; i++) {
        slice.initSession(`/s${i}`, [], false);
      }
      // 第 9 次 initSession 会淘汰最老的 /s0（keys.find(k => k !== path)）
      expect(invalidator).toHaveBeenCalledWith('/s0');
      expect(slice.scrollPositions['/s0']).toBeUndefined();
    });

    it('LRU eviction 时也 invalidate 被淘汰 session 的 stream resume meta', () => {
      const invalidator = vi.fn();
      registerStreamResumeMetaInvalidator(invalidator);
      for (let i = 0; i < 9; i++) {
        slice.initSession(`/s${i}`, [], false);
      }
      expect(invalidator).toHaveBeenCalledWith('/s0');
    });
  });

  describe('appendInterludeItem', () => {
    it('appendInterludeItem 把幕间作为下一轮回复前置项追加到时间线尾部并去重', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'run workflow' } },
        {
          type: 'message',
          data: {
            id: 'a-card',
            role: 'assistant',
            blocks: [{
              type: 'workflow',
              taskId: 'workflow-1',
              taskTitle: '冒烟测试',
              streamStatus: 'running',
            }],
          },
        },
      ], false);

      const interlude = {
        type: 'interlude' as const,
        id: 'deferred:workflow-1:success',
        variant: 'deferred_result',
        taskId: 'workflow-1',
        status: 'success',
        sourceKind: 'workflow',
        text: 'Hanako 收到了来自 冒烟测试 workflow 的结果',
      };

      expect(slice.appendInterludeItem('/a', interlude)).toBe(true);
      expect(slice.appendInterludeItem('/a', interlude)).toBe(true);
      expect(slice.chatSessions['/a']?.items.map((item) => (
        item.type === 'message' ? item.data.id : item.id
      ))).toEqual(['u1', 'a-card', 'deferred:workflow-1:success']);
    });

    it('同一 task 的不同 delivery 幕间作为不同输入事件保留', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'a-card', role: 'assistant', text: 'card from checked results' } },
      ], false);

      const first = {
        type: 'interlude' as const,
        id: 'deferred:task-a:success:delivery-1',
        deliveryId: 'delivery-1',
        variant: 'deferred_result',
        taskId: 'task-a',
        status: 'success',
        sourceKind: 'subagent',
        text: 'Hanako 收到了来自 A 的回复',
      };
      const second = {
        ...first,
        id: 'deferred:task-a:success:delivery-2',
        deliveryId: 'delivery-2',
      };

      expect(slice.appendInterludeItem('/a', first)).toBe(true);
      expect(slice.appendInterludeItem('/a', second)).toBe(true);
      expect(slice.chatSessions['/a']?.items.map((item) => (
        item.type === 'message' ? item.data.id : item.id
      ))).toEqual([
        'a-card',
        'deferred:task-a:success:delivery-1',
        'deferred:task-a:success:delivery-2',
      ]);
    });

  });

  describe('truncateSessionFromMessage', () => {
    it('只截断目标 session 从指定消息开始的尾部，其它 session 不动', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
        { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
        { type: 'message', data: { id: 'u2', role: 'user', text: 'retry' } },
        { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [] } },
      ], false);
      slice.initSession('/b', [
        { type: 'message', data: { id: 'b1', role: 'user', text: 'keep' } },
      ], false);

      expect(slice.truncateSessionFromMessage('/a', 'u2')).toBe(true);

      expect(slice.chatSessions['/a']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
      expect(slice.chatSessions['/b']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['b1']);
    });

    it('找不到消息时保持原状态并返回 false', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
      ], false);

      expect(slice.truncateSessionFromMessage('/a', 'missing')).toBe(false);
      expect(slice.chatSessions['/a']?.items).toHaveLength(1);
    });
  });

  describe('SessionFile flight barrier（#2188）', () => {
    it('beginSessionFilesFlight 之后用相同 version consume：返回记录并删除', () => {
      slice.beginSessionFilesFlight('/a', 1);
      const result = slice.consumeSessionFilesFlight('/a', 1);
      expect(result).toEqual({ resetSeen: false, upserts: [] });
      // 删除后再次 consume 应返回 null
      expect(slice.consumeSessionFilesFlight('/a', 1)).toBeNull();
    });

    it('version 不匹配：返回 null 且不删除记录', () => {
      slice.beginSessionFilesFlight('/a', 1);
      expect(slice.consumeSessionFilesFlight('/a', 2)).toBeNull();
      // 记录未被删除：用正确 version 仍能 consume 到
      expect(slice.consumeSessionFilesFlight('/a', 1)).toEqual({ resetSeen: false, upserts: [] });
    });

    it('upsertSessionRegistryFile 在 flight 活跃时把文件记进 upserts', () => {
      slice.beginSessionFilesFlight('/a', 1);
      slice.upsertSessionRegistryFile('/a', { fileId: 'sf_1', filePath: '/tmp/a.md' });
      slice.upsertSessionRegistryFile('/a', { fileId: 'sf_2', filePath: '/tmp/b.md' });
      const flight = slice.consumeSessionFilesFlight('/a', 1);
      expect(flight?.upserts.map((f) => f.fileId)).toEqual(['sf_1', 'sf_2']);
    });

    it('upsertSessionRegistryFile 在 flight 不活跃时不记录（registry 正常写入）', () => {
      slice.upsertSessionRegistryFile('/a', { fileId: 'sf_1', filePath: '/tmp/a.md' });
      expect(slice.sessionRegistryFilesByPath['/a']).toEqual([{ fileId: 'sf_1', filePath: '/tmp/a.md' }]);
      // 没有 flight 记录可 consume
      expect(slice.consumeSessionFilesFlight('/a', 1)).toBeNull();
    });

    it('applyBranchResetSessionFiles(path, null) 只标记 resetSeen，不动 registry', () => {
      slice.setSessionRegistryFiles('/a', [{ fileId: 'old', filePath: '/tmp/old.md' }]);
      slice.beginSessionFilesFlight('/a', 1);
      slice.applyBranchResetSessionFiles('/a', null);
      expect(slice.sessionRegistryFilesByPath['/a']).toEqual([{ fileId: 'old', filePath: '/tmp/old.md' }]);
      const flight = slice.consumeSessionFilesFlight('/a', 1);
      expect(flight?.resetSeen).toBe(true);
    });

    it('applyBranchResetSessionFiles(path, files) 整表替换并标记 resetSeen', () => {
      slice.setSessionRegistryFiles('/a', [{ fileId: 'old', filePath: '/tmp/old.md' }]);
      slice.beginSessionFilesFlight('/a', 1);
      slice.applyBranchResetSessionFiles('/a', [{ fileId: 'new', filePath: '/tmp/new.md' }]);
      expect(slice.sessionRegistryFilesByPath['/a']).toEqual([{ fileId: 'new', filePath: '/tmp/new.md' }]);
      const flight = slice.consumeSessionFilesFlight('/a', 1);
      expect(flight?.resetSeen).toBe(true);
    });

    it('clearSession 清掉该 path 的 flight 记录', () => {
      slice.beginSessionFilesFlight('/a', 1);
      slice.clearSession('/a');
      expect(slice.consumeSessionFilesFlight('/a', 1)).toBeNull();
    });
  });

});
