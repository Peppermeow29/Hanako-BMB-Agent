/**
 * Compiled memory contract tests
 *
 * Merged from:
 *   - memory-compile-empty-fingerprint.test.ts
 *   - memory-compiled-reset.test.ts
 *
 * Covers:
 *   1. compileToday watermark increment: empty sessions must not leave a stale
 *      watermark; unchanged sessions must not trigger a redundant LLM call;
 *      revised sessions must be flagged as superseding prior mentions
 *   2. Compiled section formatting: heading stripping, think-tag removal, facts compilation
 *   3. Compiled memory reset state: watermark read/write, artifact clearing, section normalization
 *   4. SessionSummaryManager reset support: watermark filtering, clearAll, rolling summary across reset
 *   5. Reset watermark filtering: `since` option propagation through compile functions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("compiled content from llm"),
}));

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

import {
  compileToday,
  compileDaily,
  compileLongterm,
  compileEditableFacts,
  assemble,
  migrateLegacyEditableFacts,
  readCompiledMemorySections,
} from "../lib/memory/compile.ts";
import {
  readCompiledResetAt,
  writeCompiledResetMarker,
  clearCompiledMemoryArtifacts,
  clearCompiledSummarySources,
  normalizeCompiledSectionBody,
} from "../lib/memory/compiled-memory-state.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { callText } from "../core/llm-client.ts";

const RESOLVED_MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };

function makeFakeSummaryManager(summaries) {
  return {
    getAllSummaries: vi.fn(() => summaries),
    getSummariesInRange: vi.fn().mockReturnValue(summaries),
  };
}

// ---------------------------------------------------------------------------
// 1. compileToday watermark increment — empty-sessions / no-duplicate-LLM-call
//    contract (formerly enforced via a `.fingerprint` sidecar; P3 replaced the
//    fingerprint with a today-state.json watermark, mirroring compileEditableFacts)
// ---------------------------------------------------------------------------

// 这个 mock 需要真实模拟 since 过滤（不像其它测试用的 makeFakeSummaryManager 那样
// 无条件返回全量），因为本 describe 块测的就是"水位线之后无新增/修订摘要时不再
// 调用 LLM"这条契约——水位线过滤发生在 summaryManager 侧，假 mock 必须如实模拟。
function makeWatermarkAwareSummaryManager(summaries) {
  return {
    getAllSummaries: vi.fn(() => summaries),
    getSummariesInRange: vi.fn((start, end, opts: any = {}) => {
      const since = opts?.since || null;
      return summaries.filter((s) => {
        const updated = s.updated_at || s.created_at || "";
        if (since && !(updated > since)) return false;
        return true;
      });
    }),
  };
}

describe("compileToday watermark increment", () => {
  let tmpDir;
  let todayPath;
  let statePath;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 17, 10, 0, 0)); // 2026-04-17 10:00 local
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-"));
    todayPath = path.join(tmpDir, "today.md");
    statePath = path.join(tmpDir, "today-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("does not write watermark state when sessions are empty", async () => {
    const mgr = makeWatermarkAwareSummaryManager([]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(fs.existsSync(statePath)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  it("recovers immediately after sessions reappear (no stale watermark lock)", async () => {
    // 1. 先制造"失败期"：sessions 空，导致写 0 bytes today.md（如果已有内容）
    fs.writeFileSync(todayPath, "stale content from yesterday");
    const mgrEmpty = makeWatermarkAwareSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);

    // 失败期：today.md 被清空，没有水位线状态
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("");
    expect(fs.existsSync(statePath)).toBe(false);

    // 2. summary 恢复：有新 session
    const mgrRecovered = makeWatermarkAwareSummaryManager([
      { session_id: "s1", created_at: "2026-04-17T10:00:00Z", updated_at: "2026-04-17T10:00:00Z", summary: "new session summary" },
    ]);
    await compileToday(mgrRecovered, todayPath, RESOLVED_MODEL);

    // 恢复路径：LLM 被调用，文件被写入，水位线状态被落下
    expect(callText).toHaveBeenCalledOnce();
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("compiled content from llm");
    expect(fs.existsSync(statePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      lastCompiledSummaryUpdatedAt: "2026-04-17T10:00:00Z",
    });
  });

  it("does not rewrite today.md when it is already empty and sessions are empty", async () => {
    // today.md 本就不存在
    const mgrEmpty = makeWatermarkAwareSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);

    // 再来一次仍不创建
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);
  });

  it("skips the LLM call when rerun with no summaries newer than the watermark (non-empty case preserved)", async () => {
    const mgr = makeWatermarkAwareSummaryManager([
      { session_id: "s1", created_at: "2026-04-17T10:00:00Z", updated_at: "2026-04-17T10:00:00Z", summary: "real summary" },
    ]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();

    // 相同 sessions 再调：水位线之后无新内容，delta 为空，应 skip，LLM 不再被调用
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();
  });

  it("recompiles when a previously-seen session is revised after the watermark", async () => {
    const summaries = [
      { session_id: "s1", created_at: "2026-04-17T10:00:00Z", updated_at: "2026-04-17T10:00:00Z", summary: "first summary" },
    ];
    const mgr = makeWatermarkAwareSummaryManager(summaries);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();

    // 同一个 session 被 rollingSummary 覆盖式更新（updated_at 前进，created_at 不变）
    summaries[0].updated_at = "2026-04-17T11:00:00Z";
    summaries[0].summary = "revised summary";
    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledTimes(2);
    const secondRequest = (callText as any).mock.calls[1][0];
    // 修订过的摘要应在 delta 里被标注为"取代先前相关记述"，而不是被当成全新事件
    expect(secondRequest.messages[0].content).toContain("取代先前相关记述");
    expect(secondRequest.messages[0].content).toContain("revised summary");
  });

  it("does not include yesterday timeline entries merely because a summary was updated today", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 6, 7, 30, 0)); // 2026-07-06 07:30 local
      const mgr = makeWatermarkAwareSummaryManager([
        {
          session_id: "old-cross-day",
          created_at: "2026-06-28T06:45:05.668Z",
          updated_at: "2026-07-05T23:24:15.044Z",
          source_time_range: {
            start: "2026-06-28T04:12:56.977Z",
            end: "2026-07-04T20:49:25.409Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-06-28", "2026-07-05"],
          },
          summary: "### 重要事实\n- 无\n\n### 事情经过\n- 2026-07-05 04:48 用户询问多个 Claude 账号是否违反 Anthropic ToS，助手搜索并解答",
        },
      ]);

      await compileToday(mgr, todayPath, RESOLVED_MODEL);

      expect(callText).not.toHaveBeenCalled();
      expect(fs.existsSync(todayPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
        logicalDate: "2026-07-06",
        lastCompiledSummaryUpdatedAt: "2026-07-05T23:24:15.044Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("compiles only timeline entries that belong to the current logical day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 6, 7, 30, 0)); // 2026-07-06 07:30 local
      const mgr = makeWatermarkAwareSummaryManager([
        {
          session_id: "cross-day",
          created_at: "2026-07-05T12:00:00.000Z",
          updated_at: "2026-07-05T23:24:15.044Z",
          source_time_range: {
            start: "2026-07-04T20:49:25.409Z",
            end: "2026-07-05T23:24:15.044Z",
            timezone: "Asia/Shanghai",
            localDates: ["2026-07-05", "2026-07-06"],
          },
          summary: [
            "### 重要事实",
            "- 无",
            "",
            "### 事情经过",
            "- 2026-07-05 04:48 用户询问多个 Claude 账号是否违反 Anthropic ToS，助手搜索并解答",
            "- [2026-07-06 07:24] 用户排查生产记忆目录，确认今天记忆被旧摘要污染",
          ].join("\n"),
        },
      ]);
      (callText as any).mockResolvedValueOnce("07:24 左右：用户排查生产记忆目录。");

      await compileToday(mgr, todayPath, RESOLVED_MODEL);

      expect(callText).toHaveBeenCalledOnce();
      const request = (callText as any).mock.calls[0][0];
      expect(request.messages[0].content).toContain("2026-07-06 07:24");
      expect(request.messages[0].content).not.toContain("[2026-07-06 07:24]");
      expect(request.messages[0].content).toContain("用户排查生产记忆目录");
      expect(request.messages[0].content).not.toContain("Anthropic ToS");
      expect(fs.readFileSync(todayPath, "utf-8")).toBe("07:24 左右：用户排查生产记忆目录。");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the draft and watermark when the logical date changes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 3, 17, 10, 0, 0)); // 2026-04-17 10:00 local
      const day1Summaries = [
        { session_id: "s1", created_at: "2026-04-17T10:00:00Z", updated_at: "2026-04-17T10:00:00Z", summary: "day one summary" },
      ];
      const mgr = makeWatermarkAwareSummaryManager(day1Summaries);
      (callText as any).mockResolvedValueOnce("day one draft");
      await compileToday(mgr, todayPath, RESOLVED_MODEL);
      expect(fs.readFileSync(todayPath, "utf-8")).toBe("day one draft");
      expect(JSON.parse(fs.readFileSync(statePath, "utf-8")).logicalDate).toBe("2026-04-17");

      // 日期切换到第二天，且第二天暂无任何摘要（真实场景：编译层扫描候选摘要，
      // 再按 timeline 条目时间筛选，昨天的条目天然落在范围外；这里直接给空数组模拟）
      vi.setSystemTime(new Date(2026, 3, 18, 10, 0, 0)); // 2026-04-18 10:00 local
      const mgrDay2Empty = makeWatermarkAwareSummaryManager([]);
      await compileToday(mgrDay2Empty, todayPath, RESOLVED_MODEL);

      // 新一天：草稿应被清空，不带上前一天的内容
      expect(fs.readFileSync(todayPath, "utf-8")).toBe("");

      // 第二天出现新摘要：应该正常增量编译，且不再看到第一天的旧摘要内容被当成 delta
      const day2Summaries = [
        { session_id: "s2", created_at: "2026-04-18T09:00:00Z", updated_at: "2026-04-18T09:00:00Z", summary: "day two summary" },
      ];
      (callText as any).mockResolvedValueOnce("day two draft");
      const mgrDay2 = makeWatermarkAwareSummaryManager(day2Summaries);
      await compileToday(mgrDay2, todayPath, RESOLVED_MODEL);

      const secondDayRequest = (callText as any).mock.calls[1][0];
      expect(secondDayRequest.messages[0].content).toContain("day two summary");
      expect(secondDayRequest.messages[0].content).not.toContain("day one summary");
      expect(fs.readFileSync(todayPath, "utf-8")).toBe("day two draft");
      expect(JSON.parse(fs.readFileSync(statePath, "utf-8")).logicalDate).toBe("2026-04-18");
    } finally {
      vi.useRealTimers();
    }
  });

  it("migration: treats a pre-existing today.md with no state file as one legitimate delta merge, idempotently", async () => {
    // 老用户升级现场：today.md 已有旧路径产出的合法草稿，today-state.json 不存在
    fs.writeFileSync(todayPath, "既有的旧草稿内容", "utf-8");
    const summaries = [
      { session_id: "s1", created_at: "2026-04-17T09:00:00Z", updated_at: "2026-04-17T09:00:00Z", summary: "当天已有的摘要" },
    ];
    const mgr = makeWatermarkAwareSummaryManager(summaries);
    (callText as any).mockResolvedValueOnce("合并后的新草稿");

    const first = await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(first).toBe("compiled");
    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    // 首次运行必须把既有草稿和当天已有摘要一起送进 LLM 合并，而不是丢弃旧草稿重新开始
    expect(request.messages[0].content).toContain("既有的旧草稿内容");
    expect(request.messages[0].content).toContain("当天已有的摘要");
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("合并后的新草稿");
    expect(fs.existsSync(statePath)).toBe(true);

    // 幂等性：状态文件已经落下后，同样的摘要不再产生新的 delta，不会重复合并
    const second = await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(second).toBe("compiled");
    expect(callText).toHaveBeenCalledOnce(); // 仍然只调用过一次
  });
});

// compileWeek 已退役（week 段改由 assembleWeekFromDaily 纯文件装配，零 LLM）。
// 其"空 sessions 不留 fingerprint"契约的等价覆盖见 compileDaily，
// 详见 tests/memory-daily-conveyor.test.ts。

// ---------------------------------------------------------------------------
// 2. Compiled section formatting
// ---------------------------------------------------------------------------

describe("compiled section formatting", () => {
  let tmpDir;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 29, 10, 0, 0)); // 2026-04-29 10:00 local
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-format-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("strips model-emitted headings before writing today.md", async () => {
    (callText as any).mockResolvedValueOnce("# 今日概要\n\n用户关注记忆系统。");
    const todayPath = path.join(tmpDir, "today.md");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("用户关注记忆系统。");
  });

  it("strips closed think and thinking tags before writing compiled memory sections", async () => {
    (callText as any)
      .mockResolvedValueOnce("<think>先整理内部推理</think>\n用户关注记忆系统。")
      .mockResolvedValueOnce("<thinking>先整理内部推理</thinking>\n用户关注长期记忆。");
    const todayPath = path.join(tmpDir, "today.md");
    const dailyDir = path.join(tmpDir, "daily");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    await compileDaily(mgr, dailyDir, "2026-04-29", RESOLVED_MODEL);

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("用户关注记忆系统。");
    expect(fs.readFileSync(path.join(dailyDir, "2026-04-29.md"), "utf-8")).toBe("## 2026-04-29\n\n用户关注长期记忆。\n");
  });

  it("rejects dangling leading thinking blocks without overwriting memory or fingerprinting the bad output", async () => {
    (callText as any).mockResolvedValueOnce("<thinking>未闭合的内部推理\n这些内容不应进入记忆");
    const todayPath = path.join(tmpDir, "today.md");
    const fpPath = `${todayPath}.fingerprint`;
    fs.writeFileSync(todayPath, "已有记忆", "utf-8");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await expect(compileToday(mgr, todayPath, RESOLVED_MODEL)).rejects.toThrow(
      "unterminated thinking block",
    );

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("已有记忆");
    expect(fs.existsSync(fpPath)).toBe(false);
  });

  it("compiles short facts updates instead of directly appending them", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    // 预先落一个早于本次摘要的水位线，确保新摘要不会被基线回填吞掉，
    // 真正走到 LLM 合并这一步（compileEditableFacts 首次遇到未打过水位线的
    // facts.md 会先回填水位线并直接返回 "compiled"，不调用 LLM）。
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-28T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "## 重要事实\n用户长期关注记忆系统。\n\n## 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(request.systemPrompt).toContain("必须控制在 200 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("不要追加");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户长期关注记忆系统。");
  });

  it("extracts facts from third-level rolling summary headings", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-28T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n用户长期关注记忆系统。\n\n### 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户长期关注记忆系统。");
  });

  it("extracts facts from English rolling summary headings", async () => {
    (callText as any).mockResolvedValueOnce("The user is focused on memory systems.");
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-28T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### Key Facts\nThe user is focused on memory systems.\n\n### Timeline\nNone",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("The user is focused on memory systems.");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("The user is focused on memory systems.");
  });

  it("seeds a fresh facts.md and records existing summaries as already processed", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    // 全新 agent：facts.md 还不存在。首次调用应只建立基线（空文件 + 水位线
    // 回填到最新摘要时间），不应把已经存在的旧摘要当成"新增候选"送进 LLM。
    const factsPath = path.join(memoryDir, "facts.md");
    const statePath = path.join(memoryDir, "editable-facts-state.json");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n用户最近在关注记忆系统。\n\n### 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      lastCompiledSummaryUpdatedAt: "2026-04-29T08:30:00.000Z",
    });
  });

  it("merges editable facts with only summaries after the editable facts watermark", async () => {
    (callText as any).mockResolvedValueOnce("用户喜欢清晰边界。\n用户长期关注记忆系统。");
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const editableFactsPath = path.join(memoryDir, "editable-facts.md");
    const statePath = path.join(memoryDir, "editable-facts-state.json");
    fs.writeFileSync(editableFactsPath, "用户喜欢清晰边界。", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-29T08:30:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "old",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n旧摘要不应再次进入编译。\n\n### 事情经过\n无",
        },
        {
          session_id: "new",
          updated_at: "2026-04-30T09:30:00.000Z",
          summary: "### 重要事实\n用户长期关注记忆系统。\n\n### 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, editableFactsPath, RESOLVED_MODEL, { statePath });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("## 当前可信 Facts");
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("## 新增候选 Facts");
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(request.messages[0].content).not.toContain("旧摘要不应再次进入编译");
    expect(request.systemPrompt).toContain("必须控制在 200 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("不要追加");
    expect(fs.readFileSync(editableFactsPath, "utf-8")).toBe("用户喜欢清晰边界。\n用户长期关注记忆系统。");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      lastCompiledSummaryUpdatedAt: "2026-04-30T09:30:00.000Z",
    });
  });

  it("asks the model to rewrite longterm from previous and newly settled content within a word limit", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const longtermPath = path.join(tmpDir, "longterm.md");
    fs.writeFileSync(longtermPath, "用户喜欢清晰边界。", "utf-8");

    await compileLongterm("用户本周关注记忆系统。", longtermPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("## 上一份长期情况");
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("## 新沉淀内容");
    expect(request.messages[0].content).toContain("用户本周关注记忆系统。");
    expect(request.systemPrompt).toContain("必须控制在 400 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("重写成一份新的长期情况");
    expect(request.systemPrompt).toContain("不要追加");
  });

  it("ignores unordered-list empty fact markers", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-28T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n- 无\n\n### 事情经过\n- 用户在讨论记忆系统。",
        },
        {
          session_id: "s2",
          updated_at: "2026-04-29T09:30:00.000Z",
          summary: "### Key Facts\n- None\n\n### Timeline\n- The user discussed memory systems.",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("");
  });

  it("assemble strips legacy nested headings from source sections", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const todayPath = path.join(tmpDir, "today.md");
    const weekPath = path.join(tmpDir, "week.md");
    const longtermPath = path.join(tmpDir, "longterm.md");
    const memoryPath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(factsPath, "[\"用户喜欢清晰边界\"]", "utf-8");
    fs.writeFileSync(todayPath, "# 今天概要\n\n用户关注记忆系统。", "utf-8");
    fs.writeFileSync(
      weekPath,
      "# 本周主题概要\n\n## 2026-07-09\n\n用户持续关注 Project Hana。\n\n## 2026-07-10\n\n用户修正了记忆日期。\n\n## 2026-99-99\n\n无效日期标题下的正文仍保留。",
      "utf-8",
    );
    fs.writeFileSync(longtermPath, "# 长期背景记录\n\n## 偏好\n\n用户偏好沉静 UI。", "utf-8");

    assemble(factsPath, todayPath, weekPath, longtermPath, memoryPath);

    const output = fs.readFileSync(memoryPath, "utf-8");
    expect(output).toContain("## 重要事实\n\n- 用户喜欢清晰边界");
    expect(output).toContain("## 今天\n\n用户关注记忆系统。");
    expect(output).toContain(
      "## 本周早些时候\n\n### 2026-07-09\n\n用户持续关注 Project Hana。\n\n### 2026-07-10\n\n用户修正了记忆日期。",
    );
    expect(output).toContain("无效日期标题下的正文仍保留。");
    expect(output).toContain("## 长期情况\n\n用户偏好沉静 UI。");
    expect(output).not.toContain("# 本周主题概要");
    expect(output).not.toContain("2026-99-99");
    expect(output).not.toContain("# 长期背景记录");
  });

  it("exposes the same dated week structure through compiled memory sections", () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "week.md"),
      "## 2026-07-09\n\n第一天。\n\n## 2026-07-10\n\n第二天。",
      "utf-8",
    );

    const sections = readCompiledMemorySections(memoryDir);

    expect(sections.week).toBe("### 2026-07-09\n\n第一天。\n\n### 2026-07-10\n\n第二天。");
  });
});

// ---------------------------------------------------------------------------
// 3. Compiled memory reset state
// ---------------------------------------------------------------------------

describe("compiled memory reset state", () => {
  let tmpDir;
  let memoryDir;
  let summariesDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compiled-reset-"));
    memoryDir = path.join(tmpDir, "memory");
    summariesDir = path.join(memoryDir, "summaries");
    fs.mkdirSync(summariesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads the compiled reset watermark", () => {
    const resetAt = "2026-04-29T08:00:00.000Z";
    writeCompiledResetMarker(memoryDir, resetAt);

    expect(readCompiledResetAt(memoryDir)).toBe(resetAt);
    const raw = JSON.parse(fs.readFileSync(path.join(memoryDir, "reset.json"), "utf-8"));
    expect(raw.compiledResetAt).toBe(resetAt);
  });

  it("clears compiled artifacts and fingerprints without deleting summaries", () => {
    for (const name of ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"]) {
      fs.writeFileSync(path.join(memoryDir, name), "old content", "utf-8");
      fs.writeFileSync(path.join(memoryDir, `${name}.fingerprint`), "fingerprint", "utf-8");
    }
    fs.writeFileSync(path.join(summariesDir, "s1.json"), "{}", "utf-8");

    clearCompiledMemoryArtifacts(memoryDir);

    for (const name of ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"]) {
      expect(fs.readFileSync(path.join(memoryDir, name), "utf-8")).toBe("");
      expect(fs.existsSync(path.join(memoryDir, `${name}.fingerprint`))).toBe(false);
    }
    expect(fs.existsSync(path.join(summariesDir, "s1.json"))).toBe(true);
  });

  it("clears summary source files and calls the cache clearer", () => {
    fs.writeFileSync(path.join(summariesDir, "s1.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(summariesDir, "s1.tmp"), "not a summary", "utf-8");
    let cacheCleared = false;

    clearCompiledSummarySources(summariesDir, { clearCache: () => { cacheCleared = true; } });

    expect(fs.existsSync(path.join(summariesDir, "s1.json"))).toBe(false);
    expect(fs.existsSync(path.join(summariesDir, "s1.tmp"))).toBe(true);
    expect(cacheCleared).toBe(true);
  });

  it("normalizes section body content by removing headings and JSON string arrays", () => {
    expect(normalizeCompiledSectionBody("# 本周主题概要\n\n- 用户关注记忆系统")).toBe("- 用户关注记忆系统");
    expect(normalizeCompiledSectionBody("## 长期背景记录\n\n### 偏好\n\n用户喜欢沉静的 UI")).toBe("用户喜欢沉静的 UI");
    expect(normalizeCompiledSectionBody("[\"用户关注 Project Hana\", \"用户喜欢清晰边界\"]")).toBe("- 用户关注 Project Hana\n- 用户喜欢清晰边界");
  });
});

// ---------------------------------------------------------------------------
// 4. SessionSummaryManager reset support
// ---------------------------------------------------------------------------

describe("SessionSummaryManager reset support", () => {
  let tmpDir;
  let summariesDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-summary-reset-"));
    summariesDir = path.join(tmpDir, "summaries");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters summaries at or before the reset watermark", () => {
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("old", {
      session_id: "old",
      created_at: "2026-04-29T07:00:00.000Z",
      updated_at: "2026-04-29T07:30:00.000Z",
      summary: "old summary",
    });
    manager.saveSummary("new", {
      session_id: "new",
      created_at: "2026-04-29T08:30:00.000Z",
      updated_at: "2026-04-29T08:30:00.000Z",
      summary: "new summary",
    });

    const summaries = manager.getSummariesInRange(
      new Date("2026-04-29T00:00:00.000Z"),
      new Date("2026-04-30T00:00:00.000Z"),
      { since: "2026-04-29T08:00:00.000Z" },
    );

    expect(summaries.map((s) => s.session_id)).toEqual(["new"]);
  });

  it("clearAll removes JSON summary files and clears the in-memory cache", () => {
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-04-29T08:30:00.000Z",
      updated_at: "2026-04-29T08:30:00.000Z",
      summary: "summary",
    });

    manager.clearAll();

    expect(manager.getAllSummaries()).toEqual([]);
    expect(fs.readdirSync(summariesDir).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("ignores pre-reset existing summary when rolling a post-reset session", async () => {
    (callText as any).mockResolvedValueOnce("## 重要事实\n新事实\n\n## 事情经过\n新事件");
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-04-29T07:00:00.000Z",
      updated_at: "2026-04-29T07:30:00.000Z",
      summary: "old summary",
      messageCount: 1,
    });
    writeCompiledResetMarker(tmpDir, "2026-04-29T08:00:00.000Z");

    await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "new message", timestamp: "2026-04-29T08:01:00.000Z" }],
      RESOLVED_MODEL,
    );

    const userContent = (callText as any).mock.calls[0][0].messages[0].content;
    expect(userContent).not.toContain("old summary");
    expect(manager.getSummary("s1").summary).toContain("新事实");
  });

  it("does not save a rolling summary that started before reset and finishes after reset", async () => {
    const manager = new SessionSummaryManager(summariesDir);
    (callText as any).mockImplementationOnce(async () => {
      writeCompiledResetMarker(tmpDir, "2026-04-29T08:00:00.000Z");
      return "## 重要事实\n旧事实\n\n## 事情经过\n旧事件";
    });

    await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "old message", timestamp: "2026-04-29T07:59:00.000Z" }],
      RESOLVED_MODEL,
    );

    expect(manager.getSummary("s1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Reset watermark filtering — `since` propagation
// ---------------------------------------------------------------------------

describe("compiled memory reset watermark filtering", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-since-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies since before compiling today and daily", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 3, 29, 10, 0, 0)); // 2026-04-29 10:00 local
      (callText as any)
        .mockResolvedValueOnce("today compiled")
        .mockResolvedValueOnce("daily compiled");

      const summaries = [
        { session_id: "old", updated_at: "2026-04-29T08:00:00.000Z", summary: "old summary" },
        { session_id: "new", updated_at: "2026-04-29T08:30:00.000Z", summary: "new summary" },
      ];
      const mgr = makeFakeSummaryManager(summaries);

      await compileToday(mgr, path.join(tmpDir, "today.md"), RESOLVED_MODEL, { since: "2026-04-29T08:00:00.000Z" });
      await compileDaily(mgr, path.join(tmpDir, "daily"), "2026-04-29", RESOLVED_MODEL, { since: "2026-04-29T08:00:00.000Z" });

      expect(callText).toHaveBeenCalledTimes(2);
      const todayRequest = (callText as any).mock.calls[0][0];
      const dailyRequest = (callText as any).mock.calls[1][0];
      expect(todayRequest.messages[0].content).toContain("new summary");
      expect(todayRequest.messages[0].content).not.toContain("old summary");
      expect(dailyRequest.messages[0].content).toContain("new summary");
      expect(dailyRequest.messages[0].content).not.toContain("old summary");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects the reset watermark (since) when compiling editable facts", async () => {
    (callText as any).mockResolvedValueOnce("用户关注记忆系统。");
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    // facts.md 与增量编译状态文件都预先存在（水位线早于本次 reset），
    // 确保基线回填分支不吞掉本次调用：opts.since（reset watermark）必须
    // 独立生效，排除掉早于/等于它的旧摘要。
    fs.writeFileSync(factsPath, "", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-20T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "before-reset",
          updated_at: "2026-04-29T08:00:00.000Z",
          summary: "## 重要事实\n不应被计入的旧摘要。\n\n## 事情经过\n无",
        },
        {
          session_id: "after-reset",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "## 重要事实\n用户关注记忆系统。\n\n## 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, {
      statePath,
      since: "2026-04-29T08:00:00.000Z",
    });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("用户关注记忆系统。");
    expect(request.messages[0].content).not.toContain("不应被计入的旧摘要");
  });
});

// ---------------------------------------------------------------------------
// 6. Legacy editable-facts.md migration — one-time, idempotent read-time merge
// ---------------------------------------------------------------------------

describe("migrateLegacyEditableFacts", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-facts-migrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when only the legacy facts.md exists (already canonical)", () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");

    const result = migrateLegacyEditableFacts(tmpDir);

    expect(result).toMatchObject({ migrated: false, reason: "no-legacy-file" });
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户喜欢清晰边界。");
    expect(fs.existsSync(path.join(tmpDir, "facts.md.bak"))).toBe(false);
  });

  it("does nothing when neither file exists", () => {
    const result = migrateLegacyEditableFacts(tmpDir);

    expect(result).toMatchObject({ migrated: false, reason: "no-legacy-file" });
    expect(fs.existsSync(path.join(tmpDir, "facts.md"))).toBe(false);
  });

  it("renames editable-facts.md to facts.md when only the editable file exists", () => {
    const editablePath = path.join(tmpDir, "editable-facts.md");
    fs.writeFileSync(editablePath, "用户长期关注记忆系统。", "utf-8");

    const result = migrateLegacyEditableFacts(tmpDir);

    expect(result).toMatchObject({ migrated: true, reason: "renamed" });
    expect(fs.readFileSync(path.join(tmpDir, "facts.md"), "utf-8")).toBe("用户长期关注记忆系统。");
    expect(fs.existsSync(editablePath)).toBe(false);
    expect(fs.readFileSync(`${editablePath}.bak`, "utf-8")).toBe("用户长期关注记忆系统。");
  });

  it("merges both files when they coexist, keeping editable-facts.md as the primary body", () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const editablePath = path.join(tmpDir, "editable-facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。\n用户长期关注记忆系统。", "utf-8");
    fs.writeFileSync(editablePath, "用户长期关注记忆系统。\n用户最近在写论文。", "utf-8");

    const result = migrateLegacyEditableFacts(tmpDir);

    expect(result).toMatchObject({ migrated: true, reason: "merged" });
    const merged = fs.readFileSync(factsPath, "utf-8");
    // editable-facts.md 为主体，且在前
    expect(merged.indexOf("用户长期关注记忆系统。")).toBeLessThan(merged.indexOf("用户喜欢清晰边界。"));
    // 旧 facts.md 独有条目并入
    expect(merged).toContain("用户喜欢清晰边界。");
    // editable-facts.md 已有的条目
    expect(merged).toContain("用户最近在写论文。");
    // 两边都出现的条目不重复
    expect(merged.split("用户长期关注记忆系统。").length - 1).toBe(1);

    // 旧两份各留一份 .bak 快照
    expect(fs.readFileSync(`${factsPath}.bak`, "utf-8")).toBe("用户喜欢清晰边界。\n用户长期关注记忆系统。");
    expect(fs.readFileSync(`${editablePath}.bak`, "utf-8")).toBe("用户长期关注记忆系统。\n用户最近在写论文。");
    expect(fs.existsSync(editablePath)).toBe(false);
  });

  it("is idempotent: re-running after a merge is a no-op", () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const editablePath = path.join(tmpDir, "editable-facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    fs.writeFileSync(editablePath, "用户长期关注记忆系统。", "utf-8");

    const first = migrateLegacyEditableFacts(tmpDir);
    expect(first.migrated).toBe(true);
    const mergedAfterFirstRun = fs.readFileSync(factsPath, "utf-8");

    const second = migrateLegacyEditableFacts(tmpDir);

    expect(second).toMatchObject({ migrated: false, reason: "no-legacy-file" });
    expect(fs.readFileSync(factsPath, "utf-8")).toBe(mergedAfterFirstRun);
  });

  it("is idempotent across repeated startups even with no legacy file ever present", () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");

    migrateLegacyEditableFacts(tmpDir);
    migrateLegacyEditableFacts(tmpDir);
    migrateLegacyEditableFacts(tmpDir);

    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户喜欢清晰边界。");
  });
});
