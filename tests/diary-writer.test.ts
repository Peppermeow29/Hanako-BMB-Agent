import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
  t: (key) => key,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  generateSummary: vi.fn(async () => "临时摘要"),
}));

import { callText } from "../core/llm-client.ts";
import { generateSummary } from "../lib/pi-sdk/index.ts";
import { writeDiary } from "../lib/diary/diary-writer.ts";
import { readCurrentSessionBranch } from "../lib/session-jsonl.ts";

let tempRoot;

function makeSession(sessionDir, sessionId, messages) {
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  const lines = [
    { type: "session", id: sessionId, timestamp: "2026-05-07T03:59:00.000Z", cwd: tempRoot },
    ...messages.map((message, index) => ({
      type: "message",
      id: `${sessionId}-${index}`,
      parentId: index === 0 ? null : `${sessionId}-${index - 1}`,
      timestamp: message.timestamp,
      message: {
        role: message.role,
        content: message.content,
      },
    })),
  ];
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  return filePath;
}

function baseOpts( overrides: any = {}) {
  const sessionDir = path.join(tempRoot, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });

  const summaryManager = {
    getSummariesInRange: vi.fn().mockReturnValue([]),
    getSummary: vi.fn().mockReturnValue(null),
    rollingSummary: vi.fn(),
  };

  return {
    summaryManager,
    sessionDir,
    resolvedModel: {
      model: { id: "test-model", provider: "test-provider" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
      headers: { "x-provider-contract": "diary" },
    },
    agentPersonality: "你是 Hana。",
    memory: "",
    userName: "测试用户",
    agentName: "小花",
    cwd: tempRoot,
    isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(true),
    generateTemporarySummary: vi.fn(),
    ...overrides,
  };
}

function diaryPrompt() {
  return (callText as any).mock.calls[0][0].messages[0].content;
}

describe("writeDiary hybrid material collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00+08:00"));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-diary-test-"));
    (callText as any).mockResolvedValue("# 2026-05-07 测试日记\n\n今天把日记写好了。");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("uses the resolved execution headers for header-only temporary compaction", async () => {
    const opts = baseOpts({
      resolvedModel: {
        model: { id: "header-model", provider: "header-provider" },
        api: "openai-completions",
        api_key: "",
        base_url: "https://header-provider.test/v1",
        headers: { Authorization: "Bearer header-owned-token" },
      },
      isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(false),
      generateTemporarySummary: undefined,
    });
    makeSession(opts.sessionDir, "header-only-session", [{
      role: "user",
      content: "今天完成了统一模型配置。",
      timestamp: "2026-05-07T04:00:00.000Z",
    }]);

    await writeDiary(opts);

    expect(generateSummary).toHaveBeenCalledWith(
      expect.any(Array),
      opts.resolvedModel.model,
      expect.any(Number),
      "",
      opts.resolvedModel.headers,
      undefined,
      expect.any(String),
      undefined,
    );
  });

  it("persists a rolling summary for today's missing memory-enabled session before writing diary", async () => {
    const opts = baseOpts();
    makeSession(opts.sessionDir, "enabled-session", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我会补齐缺失摘要。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("## 事情经过\n[12:10] 用户讨论日记链路，助手补齐缺失摘要。");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).toHaveBeenCalledWith(
      "enabled-session",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "今天想把日记链路改成摘要优先。" }),
      ]),
      opts.resolvedModel,
      expect.objectContaining({
        projection: expect.objectContaining({ selectedLeafId: "enabled-session-1" }),
        revalidateProjection: expect.any(Function),
      }),
    );
    expect(opts.generateTemporarySummary).not.toHaveBeenCalled();
    expect(diaryPrompt()).toContain("## 事情经过");
    expect(diaryPrompt()).toContain("补齐缺失摘要");
    expect((callText as any).mock.calls[0][0].headers).toEqual(opts.resolvedModel.headers);
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });

  it("writes new diary files under OH-Works and ignores legacy diary folders", async () => {
    const opts = baseOpts();
    fs.mkdirSync(path.join(tempRoot, "日记"), { recursive: true });
    makeSession(opts.sessionDir, "workspace-output-session", [
      { role: "user", content: "今天要把工作区产物统一到一个目录。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我会把新日记写进 OH-Works。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockResolvedValue("## 事情经过\n[12:10] 工作区产物统一到 OH-Works。");

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(result.filePath).toContain(path.join("OH-Works", "日记"));
    expect(result.filePath).not.toContain(path.join(tempRoot, "日记"));
    expect(fs.readdirSync(path.join(tempRoot, "日记"))).toEqual([]);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("falls back to temporary compaction when persistent summary backfill fails", async () => {
    const opts = baseOpts({
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n持久摘要失败后，临时材料仍然能支撑今天的日记。"),
    });
    makeSession(opts.sessionDir, "backfill-fails-session", [
      { role: "user", content: "今天写日记时某个 session 摘要补写失败。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "那也不能让整篇日记失败。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockRejectedValue(new Error("simulated summary failure"));

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "backfill-fails-session",
      previousSummary: "",
      reason: "backfill-failed",
    }));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "backfill-fails-session",
        stage: "rolling-summary",
        message: "simulated summary failure",
      }),
    ]));
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("临时材料仍然能支撑今天的日记");
  });

  it("uses temporary compaction for a memory-disabled session without saving a rolling summary", async () => {
    const opts = baseOpts({
      isSessionMemoryEnabledForPath: vi.fn().mockReturnValue(false),
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n记忆关闭的 session 也参与这次日记，但不会落回摘要库。"),
    });
    makeSession(opts.sessionDir, "memory-off-session", [
      { role: "user", content: "这条 session 关闭了记忆。", timestamp: "2026-05-07T05:10:00.000Z" },
      { role: "assistant", content: "那就只临时压缩给日记用。", timestamp: "2026-05-07T05:12:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "memory-off-session",
      previousSummary: "",
    }));
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("不会落回摘要库");
  });

  it("rebuilds a legacy in-range summary before using temporary fallback material", async () => {
    const staleSummary = {
      session_id: "stale-session",
      created_at: "2026-05-07T03:00:00.000Z",
      updated_at: "2026-05-07T04:11:00.000Z",
      messageCount: 1,
      summary: "## 事情经过\n[12:10] 用户开始讨论日记链路。",
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([staleSummary]),
        getSummary: vi.fn().mockReturnValue(staleSummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockResolvedValue("## 临时摘要\n[12:20] 后续决定残缺内容用 compaction 补齐，不要落回 session。"),
    });
    makeSession(opts.sessionDir, "stale-session", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我先看摘要。", timestamp: "2026-05-07T04:11:00.000Z" },
      { role: "user", content: "残缺内容用 compaction 补齐，但不要落回 session。", timestamp: "2026-05-07T04:20:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "stale-session",
      previousSummary: staleSummary.summary,
    }));
    expect(diaryPrompt()).not.toContain("用户开始讨论日记链路");
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("不要落回 session");
  });

  it("does not trust a legacy summary when rebuild and temporary fallback both fail", async () => {
    const staleSummary = {
      session_id: "stale-supplement-fails",
      created_at: "2026-05-07T03:00:00.000Z",
      updated_at: "2026-05-07T04:11:00.000Z",
      messageCount: 1,
      summary: "## 事情经过\n[12:10] 用户开始讨论日记链路。",
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([staleSummary]),
        getSummary: vi.fn().mockReturnValue(staleSummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockRejectedValue(new Error("simulated supplement failure")),
    });
    makeSession(opts.sessionDir, "stale-supplement-fails", [
      { role: "user", content: "今天想把日记链路改成摘要优先。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "我先看摘要。", timestamp: "2026-05-07T04:11:00.000Z" },
      { role: "user", content: "后面这句补齐失败也不能毁掉已有摘要。", timestamp: "2026-05-07T04:20:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toContain("日记材料准备失败");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "stale-supplement-fails",
        stage: "temporary-summary",
        message: "simulated supplement failure",
      }),
    ]));
    expect(callText).not.toHaveBeenCalled();
  });

  it("rebuilds diary material from the current sibling branch only", async () => {
    const sessionDir = path.join(tempRoot, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "branch-session.jsonl");
    const entries = [
      { type: "session", version: 3, id: "branch-session", timestamp: "2026-05-07T04:00:00.000Z", cwd: tempRoot },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-05-07T04:10:00.000Z", message: { role: "user", content: "共同问题" } },
      { type: "message", id: "a-old", parentId: "u1", timestamp: "2026-05-07T04:11:00.000Z", message: { role: "assistant", content: "废弃回答" } },
      { type: "message", id: "a-new", parentId: "u1", timestamp: "2026-05-07T04:12:00.000Z", message: { role: "assistant", content: "当前回答" } },
    ];
    fs.writeFileSync(sessionPath, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
    const oldProjection = readCurrentSessionBranch(sessionPath, {
      branchHead: { sessionId: "branch-session", leafId: "a-old", observedTailLeafId: "a-new", revision: 1, reason: "test" },
    });
    const oldSummary = {
      session_id: "branch-session",
      created_at: "2026-05-07T04:11:00.000Z",
      updated_at: "2026-05-07T04:11:00.000Z",
      summary: "废弃分支摘要",
      cursor: { coveredLeafId: oldProjection.selectedLeafId, lineageHash: oldProjection.lineageHash },
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([oldSummary]),
        getSummary: vi.fn().mockReturnValue(oldSummary),
        rollingSummary: vi.fn().mockResolvedValue("### 事情经过\n- [2026-05-07 12:12] 当前回答已生效。"),
      },
    });

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    const messages = opts.summaryManager.rollingSummary.mock.calls[0][1];
    expect(messages.map((message) => message.content)).toEqual(["共同问题", "当前回答"]);
    expect(messages.map((message) => message.content)).not.toContain("废弃回答");
    expect(diaryPrompt()).toContain("当前回答已生效");
    expect(diaryPrompt()).not.toContain("废弃分支摘要");
  });

  it("slices cross-day sessions before using them as diary material", async () => {
    const crossDaySummary = {
      session_id: "cross-day-session",
      created_at: "2026-05-07T04:15:00.000Z",
      updated_at: "2026-05-07T04:15:00.000Z",
      messageCount: 4,
      source_time_range: {
        start: "2026-05-06T19:40:00.000Z",
        end: "2026-05-07T04:12:00.000Z",
        timezone: "Asia/Shanghai",
        localDates: ["2026-05-06", "2026-05-07"],
      },
      summary: [
        "## 事情经过",
        "- 2026-05-06 03:40 用户和小王讨论了昨晚的角色设定。",
        "- 2026-05-07 12:10 用户开始整理今天的日记材料。",
      ].join("\n"),
    };
    const opts = baseOpts({
      summaryManager: {
        getSummariesInRange: vi.fn().mockReturnValue([crossDaySummary]),
        getSummary: vi.fn().mockReturnValue(crossDaySummary),
        rollingSummary: vi.fn(),
      },
      generateTemporarySummary: vi.fn().mockResolvedValue(
        "## 临时摘要\n[12:10] 用户开始整理今天的日记材料。"
      ),
    });
    makeSession(opts.sessionDir, "cross-day-session", [
      { role: "user", content: "昨晚和小王聊角色设定。", timestamp: "2026-05-06T19:40:00.000Z" },
      { role: "assistant", content: "我把这件事记在昨晚。", timestamp: "2026-05-06T19:45:00.000Z" },
      { role: "user", content: "今天开始整理日记材料。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "今天的材料应该只写今天。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(opts.summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "cross-day-session",
      messages: [
        expect.objectContaining({ content: "今天开始整理日记材料。" }),
        expect.objectContaining({ content: "今天的材料应该只写今天。" }),
      ],
      previousSummary: "",
      reason: "date-slice",
    }));
    expect(diaryPrompt()).toContain("临时补齐");
    expect(diaryPrompt()).toContain("今天的日记材料");
    expect(diaryPrompt()).not.toContain("昨晚的角色设定");
    expect(diaryPrompt()).not.toContain("小王");
  });

  it("uses an explicit target date and scans the full session file for old diary material", async () => {
    const opts = baseOpts({
      targetDate: "2026-05-06",
      memory: "长期背景里提到 2026-05-07 小王去了靓妹家。",
      generateTemporarySummary: vi.fn().mockResolvedValue(
        "## 临时摘要\n[23:40] 用户补录 5 月 6 日的散步。"
      ),
    });
    const largeTail = "后来发生的其它日期内容。".repeat(20000);
    makeSession(opts.sessionDir, "large-cross-day-session", [
      { role: "user", content: "补录 5 月 6 日晚上散步。", timestamp: "2026-05-06T15:40:00.000Z" },
      { role: "assistant", content: "我只把它放进 5 月 6 日。", timestamp: "2026-05-06T15:45:00.000Z" },
      { role: "assistant", content: largeTail, timestamp: "2026-05-07T04:05:00.000Z" },
      { role: "user", content: "今天小王去了靓妹家。", timestamp: "2026-05-07T04:10:00.000Z" },
    ]);

    const result = await writeDiary(opts);

    expect(result.error).toBeUndefined();
    expect(result.logicalDate).toBe("2026-05-06");
    expect(opts.generateTemporarySummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "large-cross-day-session",
      messages: [
        expect.objectContaining({ content: "补录 5 月 6 日晚上散步。" }),
        expect.objectContaining({ content: "我只把它放进 5 月 6 日。" }),
      ],
      previousSummary: "",
      reason: "date-slice",
    }));
    expect(diaryPrompt()).toContain("5 月 6 日的散步");
    expect(diaryPrompt()).toContain("长期背景不能作为当天事实来源");
    expect(diaryPrompt()).toContain("你的长期背景（只用于语气，不作为当天事实）");
  });

  it("returns diagnostics when every matching session fails material collection", async () => {
    const opts = baseOpts({
      generateTemporarySummary: vi.fn().mockRejectedValue(new Error("simulated temporary failure")),
    });
    makeSession(opts.sessionDir, "unusable-session", [
      { role: "user", content: "今天只有一个会话，但摘要和临时压缩都失败了。", timestamp: "2026-05-07T04:10:00.000Z" },
      { role: "assistant", content: "这时应该返回可诊断的错误。", timestamp: "2026-05-07T04:12:00.000Z" },
    ]);
    opts.summaryManager.rollingSummary.mockRejectedValue(new Error("simulated summary failure"));

    const result = await writeDiary(opts);

    expect(result.error).toContain("日记材料准备失败");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "unusable-session",
        stage: "rolling-summary",
        message: "simulated summary failure",
      }),
      expect.objectContaining({
        sessionId: "unusable-session",
        stage: "temporary-summary",
        message: "simulated temporary failure",
      }),
    ]));
    expect(callText).not.toHaveBeenCalled();
  });
});
