import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInputSlice, type InputSlice } from '../../stores/input-slice';
import { registerDraftSyncListener } from '../../stores/input-draft-sync';

type SliceState = InputSlice & {
  currentSessionId?: string | null;
  currentSessionPath?: string | null;
  sessions?: Array<{ sessionId?: string | null; path?: string | null }>;
  sessionLocatorsById?: Record<string, { path: string | null }>;
};

function makeSlice(initial?: Partial<SliceState>): SliceState {
  let state: SliceState;
  const set = (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = { ...createInputSlice(set), ...initial };
  return new Proxy({} as SliceState, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('input-slice quoted selections', () => {
  let slice: SliceState;
  beforeEach(() => { slice = makeSlice(); });

  it('初始状态没有候选选区和已加入引用', () => {
    expect(slice.quoteCandidate).toBeNull();
    expect(slice.quotedSelections).toEqual([]);
  });
  it('setQuoteCandidate 设置悬浮引用候选，不加入引用列表', () => {
    const sel = {
      text: '玻色子',
      sourceTitle: '百科全书',
      sourceKind: 'preview',
      sourceFilePath: '/path/to/file.md',
      lineStart: 12,
      lineEnd: 15,
      charCount: 128,
    } as const;
    slice.setQuoteCandidate(sel);
    expect(slice.quoteCandidate).toEqual(sel);
    expect(slice.quotedSelections).toEqual([]);
  });
  it('addQuotedSelection 追加多个独立引用', () => {
    slice.addQuotedSelection({ text: 'old', sourceTitle: 'A', sourceKind: 'preview', charCount: 3 });
    slice.addQuotedSelection({ text: 'new', sourceTitle: 'B', sourceKind: 'chat', charCount: 3 });
    expect(slice.quotedSelections.map(sel => sel.text)).toEqual(['old', 'new']);
  });
  it('removeQuotedSelection 只移除指定 chip', () => {
    slice.addQuotedSelection({ text: 'old', sourceTitle: 'A', sourceKind: 'preview', charCount: 3 });
    slice.addQuotedSelection({ text: 'new', sourceTitle: 'B', sourceKind: 'chat', charCount: 3 });
    slice.removeQuotedSelection(0);
    expect(slice.quotedSelections.map(sel => sel.text)).toEqual(['new']);
  });
  it('clearQuotedSelections 清除所有已加入引用', () => {
    slice.addQuotedSelection({ text: 'test', sourceTitle: 'title', sourceKind: 'preview', charCount: 4 });
    slice.clearQuotedSelections();
    expect(slice.quotedSelections).toEqual([]);
  });
});

describe('input-slice attachedFiles session ownership', () => {
  it('当前会话存在时，add/remove/clear 会同步更新 attachedFilesBySession', () => {
    const slice = makeSlice({ currentSessionPath: '/session/a' });

    slice.addAttachedFile({ path: '/tmp/a.txt', name: 'a.txt' });
    slice.addAttachedFile({ path: '/tmp/b.txt', name: 'b.txt' });
    expect(slice.attachedFilesBySession['/session/a']).toEqual([
      { path: '/tmp/a.txt', name: 'a.txt' },
      { path: '/tmp/b.txt', name: 'b.txt' },
    ]);

    slice.removeAttachedFile(0);
    expect(slice.attachedFilesBySession['/session/a']).toEqual([
      { path: '/tmp/b.txt', name: 'b.txt' },
    ]);

    slice.clearAttachedFiles();
    expect(slice.attachedFilesBySession['/session/a']).toEqual([]);
    expect(slice.attachedFiles).toEqual([]);
  });

  it('当前会话有 sessionId 时，附件和草稿写入 sessionId-keyed 状态', () => {
    const slice = makeSlice({
      currentSessionId: 'sess_input',
      currentSessionPath: '/session/moved',
      sessions: [{ sessionId: 'sess_input', path: '/session/moved' }],
      sessionLocatorsById: { sess_input: { path: '/session/moved' } },
    });

    slice.addAttachedFile({ path: '/tmp/a.txt', name: 'a.txt' });
    slice.setDraft('/session/moved', 'hello', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(slice.attachedFilesBySession.sess_input).toEqual([
      { path: '/tmp/a.txt', name: 'a.txt' },
    ]);
    expect(slice.attachedFilesBySession['/session/moved']).toBeUndefined();
    expect(slice.drafts.sess_input).toBe('hello');
    expect(slice.draftDocs.sess_input).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });

    slice.clearDraft('/session/moved');
    expect(slice.drafts.sess_input).toBeUndefined();
    expect(slice.draftDocs.sess_input).toBeUndefined();
  });

  it('没有 currentSessionPath 时只更新当前输入区，不写 keyed 附件状态', () => {
    const slice = makeSlice();

    slice.addAttachedFile({ path: '/tmp/a.txt', name: 'a.txt' });
    expect(slice.attachedFiles).toEqual([{ path: '/tmp/a.txt', name: 'a.txt' }]);
    expect(slice.attachedFilesBySession).toEqual({});
  });

  it('迟到清理指定后台 session 时不清空当前 session 的附件 (#2078)', () => {
    const slice = makeSlice({
      currentSessionId: 'sess_b',
      currentSessionPath: '/session/b',
      sessions: [
        { sessionId: 'sess_a', path: '/session/a' },
        { sessionId: 'sess_b', path: '/session/b' },
      ],
      sessionLocatorsById: {
        sess_a: { path: '/session/a' },
        sess_b: { path: '/session/b' },
      },
      attachedFiles: [{ path: '/tmp/b.txt', name: 'b.txt' }],
      attachedFilesBySession: {
        sess_a: [{ path: '/tmp/a.txt', name: 'a.txt' }],
        sess_b: [{ path: '/tmp/b.txt', name: 'b.txt' }],
      },
    });

    slice.clearAttachedFilesForSession('/session/a');

    expect(slice.attachedFilesBySession.sess_a).toBeUndefined();
    expect(slice.attachedFilesBySession.sess_b).toEqual([{ path: '/tmp/b.txt', name: 'b.txt' }]);
    expect(slice.attachedFiles).toEqual([{ path: '/tmp/b.txt', name: 'b.txt' }]);
  });
});

describe('draft sync notifications', () => {
  afterEach(() => registerDraftSyncListener(null));

  it('notifies listener with resolved key on setDraft and clearDraft', () => {
    const onSet = vi.fn();
    const onClear = vi.fn();
    registerDraftSyncListener({ onSet, onClear });

    const slice = makeSlice({
      currentSessionId: 'sess-1',
      currentSessionPath: '/agents/a/sessions/s1.jsonl',
      sessions: [{ sessionId: 'sess-1', path: '/agents/a/sessions/s1.jsonl' }],
      sessionLocatorsById: { 'sess-1': { path: '/agents/a/sessions/s1.jsonl' } },
    });

    slice.setDraft('/agents/a/sessions/s1.jsonl', 'hello', { type: 'doc' } as any);
    expect(onSet).toHaveBeenCalledWith('sess-1', 'hello', { type: 'doc' });

    slice.clearDraft('/agents/a/sessions/s1.jsonl');
    expect(onClear).toHaveBeenCalledWith('sess-1');
  });

  it('passes through the home draft key untouched', () => {
    const onSet = vi.fn();
    registerDraftSyncListener({ onSet, onClear: vi.fn() });
    const slice = makeSlice();
    slice.setDraft('__home__', 'home text');
    expect(onSet).toHaveBeenCalledWith('__home__', 'home text', null);
    expect(slice.drafts['__home__']).toBe('home text');
  });

  it('is a no-op when text and doc are unchanged (keeps referential identity)', () => {
    const onSet = vi.fn();
    registerDraftSyncListener({ onSet, onClear: vi.fn() });
    const slice = makeSlice();
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };

    slice.setDraft('__home__', 'hello', doc);
    const draftsAfterFirst = slice.drafts;
    const draftDocsAfterFirst = slice.draftDocs;
    expect(onSet).toHaveBeenCalledTimes(1);

    slice.setDraft('__home__', 'hello', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(onSet).toHaveBeenCalledTimes(1);
    expect(slice.drafts).toBe(draftsAfterFirst);
    expect(slice.draftDocs).toBe(draftDocsAfterFirst);
  });

  it('exposes draftsHydratedAt with initial 0', () => {
    const slice = makeSlice();
    expect(slice.draftsHydratedAt).toBe(0);
  });
});
