import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hanaFetchMock, switchSessionMock } = vi.hoisted(() => ({
  hanaFetchMock: vi.fn(),
  switchSessionMock: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: hanaFetchMock }));
vi.mock('../../stores/session-actions', () => ({ switchSession: switchSessionMock }));

import { useStore } from '../../stores';
import { runChatFind, stepChatFind, locateSearchHit } from '../../stores/chat-find-actions';

const PATH = '/tmp/agents/hana/sessions/a.jsonl';

function findResponse(body: any, ok = true) {
  return { ok, json: async () => body } as Response;
}

const SAMPLE = {
  query: 'x', total: 2, bestIndex: 9, tokens: ['x'], truncated: false, revision: 'r1',
  matches: [{ index: 3, exact: false, snippet: 'a' }, { index: 9, exact: true, snippet: 'b' }],
};

describe('chat-find-actions', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    switchSessionMock.mockReset();
    useStore.setState({ chatFindBySession: {}, pendingMessageLocate: null, currentSessionPath: PATH });
  });

  it('runChatFind 写结果并把定位意图指向最新命中', async () => {
    useStore.getState().openChatFind(PATH, 'x');
    hanaFetchMock.mockResolvedValue(findResponse(SAMPLE));
    await runChatFind(PATH, 'x');
    const st = useStore.getState().chatFindBySession[PATH];
    expect(st.matches.length).toBe(2);
    expect(st.status).toBe('done');
    expect(useStore.getState().pendingMessageLocate).toEqual({ sessionPath: PATH, messageIndex: 9, term: 'x' });
  });

  it('runChatFind 不给已离开的会话种定位意图（切换窗口内 debounce 残留）', async () => {
    useStore.getState().openChatFind(PATH, 'x');
    hanaFetchMock.mockResolvedValue(findResponse(SAMPLE));
    useStore.setState({ currentSessionPath: '/elsewhere.jsonl' });
    await runChatFind(PATH, 'x');
    // 结果照常落地（查找条状态无损），但不种陈旧意图
    expect(useStore.getState().chatFindBySession[PATH].matches.length).toBe(2);
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('runChatFind 竞态护栏：返回时 query 已变化则丢弃结果', async () => {
    useStore.getState().openChatFind(PATH, 'x');
    let resolveFetch: (v: Response) => void;
    hanaFetchMock.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const p = runChatFind(PATH, 'x');
    useStore.getState().setChatFindQuery(PATH, 'changed');
    resolveFetch!(findResponse(SAMPLE));
    await p;
    expect(useStore.getState().chatFindBySession[PATH].matches).toEqual([]);
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('runChatFind 不写 query：查找条已关闭后到达的调用不重建幽灵条目', async () => {
    // 模拟 debounce 竞态漏网：close 之后 runChatFind 才被调用。
    // runChatFind 只负责查询与结果落地，query 状态由 UI 层（ChatFindBar）写；
    // 若它自己写 query，会经 EMPTY_FIND 兜底重建 open:false 的幽灵条目。
    hanaFetchMock.mockResolvedValue(findResponse(SAMPLE));
    await runChatFind(PATH, 'x');
    expect(useStore.getState().chatFindBySession[PATH]).toBeUndefined();
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('runChatFind 接口失败置 error 状态、不发定位', async () => {
    useStore.getState().openChatFind(PATH, 'x');
    hanaFetchMock.mockResolvedValue(findResponse({ error: 'boom' }, false));
    await runChatFind(PATH, 'x');
    expect(useStore.getState().chatFindBySession[PATH].status).toBe('error');
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('stepChatFind 环回并发定位意图', () => {
    useStore.getState().openChatFind(PATH, 'x');
    useStore.getState().setChatFindResults(PATH, SAMPLE);
    // activePos 默认 1（最后一条）
    stepChatFind(PATH, 1);
    expect(useStore.getState().chatFindBySession[PATH].activePos).toBe(0); // wrap
    expect(useStore.getState().pendingMessageLocate?.messageIndex).toBe(3);
    stepChatFind(PATH, -1);
    expect(useStore.getState().chatFindBySession[PATH].activePos).toBe(1);
    expect(useStore.getState().pendingMessageLocate?.messageIndex).toBe(9);
  });

  it('stepChatFind 无命中时是 no-op', () => {
    useStore.getState().openChatFind(PATH, 'x');
    stepChatFind(PATH, 1);
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('locateSearchHit：切 session、开查找条带词、定位 bestIndex 对应命中', async () => {
    switchSessionMock.mockImplementation(async (p: string) => {
      useStore.setState({ currentSessionPath: p });
    });
    hanaFetchMock.mockResolvedValue(findResponse(SAMPLE));
    await locateSearchHit(PATH, 'x');
    expect(switchSessionMock).toHaveBeenCalledWith(PATH);
    const st = useStore.getState().chatFindBySession[PATH];
    expect(st.open).toBe(true);
    expect(st.query).toBe('x');
    expect(st.activePos).toBe(1); // bestIndex 9 -> matches[1]
    expect(useStore.getState().pendingMessageLocate).toEqual({ sessionPath: PATH, messageIndex: 9, term: 'x' });
  });

  it('locateSearchHit：switch 后已被抢占（currentSessionPath 不是目标）则中止', async () => {
    switchSessionMock.mockImplementation(async () => {
      useStore.setState({ currentSessionPath: '/elsewhere.jsonl' });
    });
    hanaFetchMock.mockResolvedValue(findResponse(SAMPLE));
    await locateSearchHit(PATH, 'x');
    expect(useStore.getState().chatFindBySession[PATH]).toBeUndefined();
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });

  it('locateSearchHit：find 空命中时不开查找条不定位（console.warn 路径）', async () => {
    switchSessionMock.mockImplementation(async (p: string) => {
      useStore.setState({ currentSessionPath: p });
    });
    hanaFetchMock.mockResolvedValue(findResponse({ ...SAMPLE, total: 0, matches: [], bestIndex: null }));
    await locateSearchHit(PATH, 'x');
    expect(useStore.getState().chatFindBySession[PATH]).toBeUndefined();
    expect(useStore.getState().pendingMessageLocate).toBeNull();
  });
});
