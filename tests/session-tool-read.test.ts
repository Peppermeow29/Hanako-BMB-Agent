import { describe, it, expect, vi } from "vitest";
import { createSessionTool } from "../lib/tools/session-tool.ts";
import { SessionCollabDraftStore } from "../lib/session-collab/draft-store.ts";

// 实测字段名，容易想当然写错的两处（core/session-manifest/store.ts toRowManifest,
// core/engine.ts getSessionManifest）：
// - manifest 上没有 title 字段（title 只存在于 engine.listSessions() 的条目里）
// - manifest 的归属字段是 ownerAgentId，不是 agentId
function makeEngine(overrides: any = {}) {
  return {
    listSessions: vi.fn().mockResolvedValue([
      { path: "/tmp/a.jsonl", sessionId: "sid-a", title: "会话A", agentId: "hana",
        agentName: "Hana", modelId: "m1", modified: new Date("2026-07-01"), messageCount: 3 },
    ]),
    getSessionManifest: vi.fn().mockReturnValue({ currentLocator: { path: "/tmp/a.jsonl" }, ownerAgentId: "hana" }),
    resolveSessionOwnership: vi.fn().mockReturnValue({ agentId: "hana" }),
    getSessionIdForPath: vi.fn().mockReturnValue("sid-src"),
    isSessionStreaming: vi.fn().mockReturnValue(false),
    getAgent: vi.fn().mockReturnValue({
      agentName: "Hana",
      summaryManager: { getSummary: vi.fn().mockReturnValue({ summary: "这是摘要", updated_at: "2026-07-01" }) },
    }),
    ...overrides,
  };
}

function makeTool(engine = makeEngine()) {
  return createSessionTool({
    getEngine: () => engine,
    getDraftStore: () => null,
    listAgents: () => [{ id: "hana", name: "Hana" }],
    agentId: "hana",
    getAgentName: () => "Hana",
  });
}

const CTX = { sessionManager: { getSessionFile: () => "/tmp/src.jsonl" } };

async function run(tool: any, params: any) {
  const result = await tool.execute("t1", params, undefined, undefined, CTX);
  return result.content?.[0]?.text || "";
}

describe("session tool read side", () => {
  it('action:"?" 返回手册全文', async () => {
    const text = await run(makeTool(), { action: "?" });
    expect(text).toContain("# session tool");
    expect(text).toContain('action:"send"');
  });

  it("缺参报错内嵌该 action 用法段（报错即文档）", async () => {
    const text = await run(makeTool(), { action: "read" });
    expect(text).toContain("sessionId");
    expect(text).toContain('mode:"transcript"');
  });

  it("list 输出含 sessionId 且不含文件 path", async () => {
    const text = await run(makeTool(), { action: "list" });
    expect(text).toContain("sid-a");
    expect(text).toContain("Hana");
    expect(text).not.toContain("/tmp/a.jsonl");
  });

  it("list 带 query 走 searchSessions 且结果映射回 sessionId", async () => {
    const text = await run(makeTool(), { action: "list", query: "会话A" });
    expect(text).toContain("sid-a");
    expect(text).not.toContain("/tmp/a.jsonl");
  });

  it("read summary 档：有摘要直接给，零 LLM 动作", async () => {
    const text = await run(makeTool(), { action: "read", sessionId: "sid-a" });
    expect(text).toContain("这是摘要");
  });

  it("read summary 档：无摘要明确报无并提示 transcript，不附正文", async () => {
    const engine = makeEngine();
    engine.getAgent.mockReturnValue({ agentName: "Hana", summaryManager: { getSummary: () => null } });
    const text = await run(makeTool(engine), { action: "read", sessionId: "sid-a" });
    expect(text).toMatch(/no summary/i);
    expect(text).toContain('mode:"transcript"');
  });

  it("read 未知 sessionId 显式报错", async () => {
    const engine = makeEngine({ getSessionManifest: vi.fn().mockReturnValue(null) });
    const text = await run(makeTool(engine), { action: "read", sessionId: "nope" });
    expect(text).toMatch(/not found/i);
  });

  it("send 现在产草稿卡，不再是 Task 5 前的未实现占位", async () => {
    // 本文件其余用例复用 makeTool() 的 getDraftStore: () => null（读侧测试无需草稿存储），
    // 这条用例单独接一个真实 store 来验证 send 分支已落地为草稿创建路径。
    const engine = makeEngine();
    const tool = createSessionTool({
      getEngine: () => engine,
      getDraftStore: () => new SessionCollabDraftStore(),
      listAgents: () => [{ id: "hana", name: "Hana" }],
      agentId: "hana",
      getAgentName: () => "Hana",
    });
    const text = await run(tool, { action: "send", sessionId: "sid-a", message: "hi" });
    expect(text).toContain("Draft created");
  });
});
