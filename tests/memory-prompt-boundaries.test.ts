import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("[]"),
}));

import { callText } from "../core/llm-client.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { compileToday, compileDaily, compileLongterm } from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

const RESOLVED_MODEL = {
  model: "m",
  api: "openai-completions",
  api_key: "k",
  base_url: "http://x",
  headers: { "x-provider-contract": "memory" },
};

function makeFakeSummaryManager(summaries) {
  return {
    getSummariesInRange: vi.fn().mockReturnValue(summaries),
  };
}

describe("memory prompt boundaries", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    (callText as any).mockResolvedValue("[]");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-prompts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("session summary uses the agent reflection frame and keeps work only at theme level", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries"));

    await manager._callRollingLLM("【用户】我最近在关注记忆系统。", "", RESOLVED_MODEL, 2, {
      memoryReflectionSnapshot: {
        agentName: "Hana",
        userName: "测试用户",
        identityAndPersonality: "Hana 的人格设定。",
        userProfile: "测试用户的主人设定。",
        existingMemory: "已有长期记忆。",
        roster: "同处于这个系统里的别的 Agent：Butter。",
      },
    });

    const request = (callText as any).mock.calls[0][0];
    const prompt = request.systemPrompt;
    expect(request.headers).toEqual(RESOLVED_MODEL.headers);
    expect(prompt).toContain("你是 Hana");
    expect(prompt).toContain("从自己的视角审视本次对话");
    expect(prompt).toContain("这是你在本次对话开始前已经拥有的记忆");
    expect(prompt).toContain("工作相关内容只允许保留到大主题层级");
    expect(prompt).toContain("如果这条信息回答的是“和用户工作时该怎么做”");
    expect(prompt).toContain("如果这条信息回答的是“用户最近在关注哪个领域/项目/主题”");
  });

  it("adds a reasoning buffer to rolling summary maxTokens without changing visible budget text", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries"));
    const reasoningModel = {
      ...RESOLVED_MODEL,
      model: { id: "reasoning-model", provider: "deepseek", reasoning: true, maxTokens: 8192 },
    };

    await manager._callRollingLLM("【用户】我最近在关注记忆系统。", "", reasoningModel, 2);

    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("重要事实最多24字。事情经过最多56字。");
    expect(request.maxTokens).toBeGreaterThan(150);
  });

  it("today and daily prompts keep broad work themes but reject work details", async () => {
    const summaries = [
      {
        session_id: "s1",
        updated_at: new Date().toISOString(),
        summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
      },
    ];
    const manager = makeFakeSummaryManager(summaries);
    const todayDraftPath = path.join(tmpDir, "today-draft.md");
    fs.writeFileSync(todayDraftPath, "用户在讨论记忆系统。", "utf-8");

    await compileToday(manager, path.join(tmpDir, "today.md"), RESOLVED_MODEL);
    await compileDaily(manager, path.join(tmpDir, "daily"), "2026-07-03", RESOLVED_MODEL, { todayDraftPath });

    const todayPrompt = (callText as any).mock.calls[0][0].systemPrompt;
    const dailyPrompt = (callText as any).mock.calls[1][0].systemPrompt;
    expect((callText as any).mock.calls[0][0].headers).toEqual(RESOLVED_MODEL.headers);
    expect((callText as any).mock.calls[1][0].headers).toEqual(RESOLVED_MODEL.headers);
    for (const prompt of [todayPrompt, dailyPrompt]) {
      expect(prompt).toContain("工作相关内容只允许保留到大主题层级");
      expect(prompt).toContain("领域/项目/主题");
      expect(prompt).toContain("不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节");
      expect(prompt).toContain("不要输出 Markdown 标题");
    }
  });

  it("adds a reasoning buffer to compile maxTokens while keeping compile prompt body budget", async () => {
    const summaries = [
      {
        session_id: "s1",
        updated_at: new Date().toISOString(),
        summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
      },
    ];
    const manager = makeFakeSummaryManager(summaries);
    const reasoningModel = {
      ...RESOLVED_MODEL,
      model: { id: "reasoning-model", provider: "deepseek", reasoning: true, maxTokens: 8192 },
    };

    await compileToday(manager, path.join(tmpDir, "today.md"), reasoningModel);

    const request = (callText as any).mock.calls[0][0];
    expect(request.systemPrompt).toContain("最多 300 字");
    expect(request.maxTokens).toBeGreaterThan(450);
  });

  it("longterm prompt keeps durable user profile instead of work patterns", async () => {
    const longtermPath = path.join(tmpDir, "longterm.md");

    await compileLongterm("用户最近在关注记忆系统。", longtermPath, RESOLVED_MODEL);

    const request = (callText as any).mock.calls[0][0];
    const prompt = request.systemPrompt;
    expect(request.headers).toEqual(RESOLVED_MODEL.headers);
    expect(prompt).toContain("记忆不是工作日志");
    expect(prompt).toContain("用户画像");
    expect(prompt).toContain("长期关注方向");
    expect(prompt).toContain("不要输出 Markdown 标题");
    expect(prompt).not.toContain("工作模式");
  });

  it("deep memory only extracts profile and coarse current-interest facts", async () => {
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "s1",
          summary: "## 重要事实\n无\n\n## 事情经过\n用户在讨论记忆系统。",
          snapshot: "",
          updated_at: new Date().toISOString(),
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    const request = (callText as any).mock.calls[0][0];
    const prompt = request.systemPrompt;
    expect(request.headers).toEqual(RESOLVED_MODEL.headers);
    expect(prompt).toContain("只提取用户画像和粗颗粒近况");
    expect(prompt).toContain("禁止提取工作方式偏好");
    expect(prompt).toContain("如果一条事实描述的是“以后遇到类似任务应该怎么做”");
    expect(prompt).not.toContain("3月15日");
  });

  it("extracts deep memory facts from JSON wrapped by a thought block (#1642)", async () => {
    (callText as any).mockResolvedValue([
      "<thought>先判断这是不是长期画像。</thought>",
      JSON.stringify([
        {
          fact: "用户最近在关注记忆系统",
          tags: ["记忆系统", "近况"],
          time: null,
        },
      ]),
    ].join("\n"));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "thought-wrapped-json-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "thought-wrapped-json-session",
      },
    ]);
    expect(summaryManager.markProcessed).toHaveBeenCalledWith("thought-wrapped-json-session");
  });

  it("keeps dirty sessions retryable when deep memory JSON parsing fails (#1642)", async () => {
    (callText as any).mockResolvedValue("<thought>无法形成 JSON。</thought>\nno json here");
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "malformed-json-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    expect(factStore.addBatch).not.toHaveBeenCalled();
    expect(summaryManager.markProcessed).not.toHaveBeenCalled();
  });

  it("atomically replaces facts for a rebuilt sibling summary", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      { fact: "用户当前关注新的记忆分支", tags: ["记忆", "近况"], time: null },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "branch-replacement",
          summary: "### 重要事实\n- 用户当前关注新的记忆分支\n\n### 事情经过\n- 用户重新生成了回复。",
          snapshot: "discarded sibling summary",
          factReplacementRequired: true,
          updated_at: "2026-07-16T08:00:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn(), replaceBySession: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    expect(factStore.addBatch).not.toHaveBeenCalled();
    expect(factStore.replaceBySession).toHaveBeenCalledWith("branch-replacement", [
      {
        fact: "用户当前关注新的记忆分支",
        tags: ["记忆", "近况"],
        time: null,
        session_id: "branch-replacement",
      },
    ]);
    expect(summaryManager.markProcessed).toHaveBeenCalledWith("branch-replacement");
    const requestText = (callText as any).mock.calls[0][0].messages[0].content;
    expect(requestText).not.toContain("discarded sibling summary");
  });

  it("clears old facts for an empty replacement without calling the LLM", async () => {
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "empty-replacement",
          summary: "",
          snapshot: "old summary",
          factReplacementRequired: true,
          updated_at: "2026-07-16T08:00:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn(), replaceBySession: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    expect(callText).not.toHaveBeenCalled();
    expect(factStore.replaceBySession).toHaveBeenCalledWith("empty-replacement", []);
    expect(summaryManager.markProcessed).toHaveBeenCalledWith("empty-replacement");
  });

  it("never marks a replacement processed after repeated extraction failures", async () => {
    (callText as any).mockResolvedValue("not-json");
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "replacement-retry-unique",
          summary: "### 重要事实\n- 新分支事实",
          snapshot: "old sibling",
          factReplacementRequired: true,
          updated_at: "2026-07-16T08:00:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn(), replaceBySession: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);
    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);
    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL);

    expect(factStore.replaceBySession).not.toHaveBeenCalled();
    expect(summaryManager.markProcessed).not.toHaveBeenCalled();
  });

  it("drops extracted facts when a newer summary revision lands during the LLM call", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries-race"));
    const oldSummary = {
      session_id: "replacement-race",
      summary: "### 重要事实\n- 旧分支事实\n\n### 事情经过\n- 旧分支事件。",
      snapshot: "discarded sibling",
      cursor: { coveredLeafId: "a-old", lineageHash: "hash-old" },
      factReplacementRequired: true,
      created_at: "2026-07-16T08:00:00.000Z",
      updated_at: "2026-07-16T08:00:00.000Z",
    };
    manager.saveSummary(oldSummary.session_id, oldSummary);
    let resolveFacts: (value: string) => void = () => {};
    (callText as any).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFacts = resolve;
    }));
    const factStore = { addBatch: vi.fn(), replaceBySession: vi.fn() };

    const processing = processDirtySessions(manager, factStore, RESOLVED_MODEL, {
      getCurrentBranchProjection: () => ({
        rootLineageHash: "root",
        prefixHashes: { "a-old": "hash-old" },
      }),
    });
    await vi.waitFor(() => expect(callText).toHaveBeenCalledOnce());
    manager.saveSummary(oldSummary.session_id, {
      ...oldSummary,
      summary: "### 重要事实\n- 新分支事实\n\n### 事情经过\n- 新分支事件。",
      cursor: { coveredLeafId: "a-new", lineageHash: "hash-new" },
      updated_at: "2026-07-16T08:01:00.000Z",
    });
    resolveFacts(JSON.stringify([{ fact: "不应写入的旧事实", tags: [], time: null }]));
    await processing;

    expect(factStore.replaceBySession).not.toHaveBeenCalled();
    expect(manager.getSummary(oldSummary.session_id)).toMatchObject({
      cursor: { coveredLeafId: "a-new", lineageHash: "hash-new" },
      factReplacementRequired: true,
      snapshot: "discarded sibling",
    });
  });

  it("drops extracted facts when the current branch leaves the captured summary lineage", async () => {
    const manager = new SessionSummaryManager(path.join(tmpDir, "summaries-branch-race"));
    manager.saveSummary("branch-race", {
      session_id: "branch-race",
      summary: "### 重要事实\n- 分支事实\n\n### 事情经过\n- 分支事件。",
      snapshot: "discarded sibling",
      cursor: { coveredLeafId: "a-old", lineageHash: "hash-old" },
      factReplacementRequired: true,
      created_at: "2026-07-16T08:00:00.000Z",
      updated_at: "2026-07-16T08:00:00.000Z",
    });
    const factStore = { addBatch: vi.fn(), replaceBySession: vi.fn() };
    (callText as any).mockResolvedValueOnce(JSON.stringify([
      { fact: "不应写入的兄弟分支事实", tags: [], time: null },
    ]));

    await processDirtySessions(manager, factStore, RESOLVED_MODEL, {
      getCurrentBranchProjection: () => ({
        rootLineageHash: "root",
        prefixHashes: { "a-new": "hash-new" },
      }),
    });

    expect(factStore.replaceBySession).not.toHaveBeenCalled();
    expect(manager.getSummary("branch-race")).toMatchObject({
      factReplacementRequired: true,
      snapshot: "discarded sibling",
    });
  });

  it("corrects example-anchored fact dates when a legacy summary has a single source day", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T14:30",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "single-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [14:30] 用户讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
          source_time_range: {
            start: "2026-05-16T06:30:00.000Z",
            end: "2026-05-16T07:00:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-05-16T14:30",
        session_id: "single-day-session",
      },
    ]);
  });

  it("nulls legacy HH:mm fact dates for cross-day summaries instead of guessing one date", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T23:50",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "cross-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [23:50] 用户开始讨论记忆系统。\n- [00:10] 用户继续讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
          source_time_range: {
            start: "2026-05-16T15:50:00.000Z",
            end: "2026-05-16T16:20:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16", "2026-05-17"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "cross-day-session",
      },
    ]);
  });

  it("rejects fact times that do not appear in the summary timeline", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-05-16T14:30",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "no-time-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- 用户讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T07:00:00.000Z",
          source_time_range: {
            start: "2026-05-16T06:30:00.000Z",
            end: "2026-05-16T07:00:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "no-time-session",
      },
    ]);
  });

  it("does not trust full summary dates outside the source session range", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T23:50",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "cross-day-hallucinated-date",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [2026-03-15 23:50] 用户开始讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
          source_time_range: {
            start: "2026-05-16T15:50:00.000Z",
            end: "2026-05-16T16:20:00.000Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-05-16", "2026-05-17"],
          },
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "cross-day-hallucinated-date",
      },
    ]);
  });

  it("uses caller-provided source time ranges for old summaries without persisted time metadata", async () => {
    (callText as any).mockResolvedValue(JSON.stringify([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: "2026-03-15T00:10",
      },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([
        {
          session_id: "old-cross-day-session",
          summary: "### 重要事实\n- 用户最近在关注记忆系统\n\n### 事情经过\n- [23:50] 用户开始讨论记忆系统。\n- [00:10] 用户继续讨论记忆系统。",
          snapshot: "",
          updated_at: "2026-05-16T16:20:00.000Z",
        },
      ]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };
    const getSourceTimeRange = vi.fn(() => ({
      start: "2026-05-16T15:50:00.000Z",
      end: "2026-05-16T16:20:00.000Z",
      timezone: "Asia/Shanghai",
      localDates: ["2026-05-16", "2026-05-17"],
    }));

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, {
      timeZone: "Asia/Shanghai",
      getSourceTimeRange,
    });

    expect(getSourceTimeRange).toHaveBeenCalledWith("old-cross-day-session");
    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "用户最近在关注记忆系统",
        tags: ["记忆系统", "近况"],
        time: null,
        session_id: "old-cross-day-session",
      },
    ]);
  });
});
