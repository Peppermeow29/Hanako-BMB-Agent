/**
 * memory-ticker 编排 + 健康状态 综合测试
 *
 * 合并自 memory-ticker-daily.test.ts 与 memory-ticker-health.test.ts
 *
 * _doDaily 步骤编排（关键路径）：
 * - 5 个步骤各自独立 try-catch
 * - rollDailyWindow 依赖 compileDaily（compileDaily 失败则跳过）
 * - 断点续跑：已完成步骤在重试时跳过
 * - assemble 总是执行（step 4，含 assembleWeekFromDaily 纯文件装配 week.md）
 * - compileFacts 步骤恒走 compileEditableFacts（facts 转正后唯一路径）
 * - migrateLegacyWeekToLongterm 在每次 _doDaily 开头无条件调用一次（自身幂等，
 *   不计入断点续跑 step key）
 *
 * getHealthStatus API：
 * - 验证每步（rollingSummary / compileToday / compileDaily / rollDailyWindow /
 *   compileFacts / deepMemory）的成功/失败都记录在 _health，并通过
 *   getHealthStatus() 暴露，供 UI 层判断"记忆编译是否在静默失败"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// ── Mock compile / deep-memory / debug ──

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileDaily: vi.fn().mockResolvedValue("compiled"),
  assembleWeekFromDaily: vi.fn(),
  rollDailyWindow: vi.fn().mockResolvedValue({ folded: [], failed: [] }),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileEditableFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
  ensureEditableFactsBaseline: vi.fn(),
  migrateLegacyEditableFacts: vi.fn(() => ({ migrated: false, reason: "no-legacy-file" })),
  migrateLegacyWeekToLongterm: vi.fn().mockResolvedValue({ migrated: false }),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Import under test ──

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import {
  compileToday,
  compileDaily,
  rollDailyWindow,
  compileEditableFacts,
  assemble,
  migrateLegacyWeekToLongterm,
} from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

// ── Helpers ──

function writeSession(sessionPath: any) {
  const lines = [
    { type: "message", timestamp: "2026-04-17T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "message", timestamp: "2026-04-17T10:00:10.000Z", message: { role: "assistant", content: "hello" } },
  ];
  fs.writeFileSync(sessionPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function readDailyState(tmpDir: any) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "daily-state.json"), "utf-8"));
}

function makeTicker(tmpDir: any, summaryManagerOverride?: any, tickerOptions: any = {}) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
  const summaryManager = summaryManagerOverride || {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
    listSummaries: vi.fn().mockReturnValue([]),
  };
  return createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
    ...tickerOptions,
  });
}

// ── _doDaily step orchestration ──

describe("_doDaily step orchestration", () => {
  let tmpDir;
  let ticker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-"));
    ticker = makeTicker(tmpDir);
  });

  afterEach(() => {
    ticker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs all 5 steps when everything succeeds", async () => {
    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    expect(compileEditableFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    // daily step 0 + final compileTodayAndAssemble
    expect(compileToday).toHaveBeenCalledTimes(2);
    // assemble: once in _doDaily(step 4) + once in _doCompileTodayAndAssemble
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it("calls the one-time week.md migration unconditionally at the start of _doDaily", async () => {
    await ticker.tick();

    expect(migrateLegacyWeekToLongterm).toHaveBeenCalled();
  });

  it("runs compileDaily before the daily-step compileToday, passing todayMdPath as the draft source", async () => {
    // compileDaily 必须先于 compileToday 读到"昨天最终版今日草稿"——一旦 compileToday
    // 先跑，日期切换会把 today.md 重置成新一天的空白草稿，昨天的内容就再也读不到了。
    await ticker.tick();

    expect((compileDaily as any).mock.invocationCallOrder[0])
      .toBeLessThan((compileToday as any).mock.invocationCallOrder[0]);
    const dailyCallArgs = (compileDaily as any).mock.calls[0];
    expect(dailyCallArgs[4]).toMatchObject({ todayDraftPath: path.join(tmpDir, "today.md") });
  });

  it("skips rollDailyWindow when compileDaily fails (dependency)", async () => {
    (compileDaily as any).mockRejectedValueOnce(new Error("LLM timeout"));

    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).not.toHaveBeenCalled();
    // independent steps still run
    expect(compileEditableFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("retries only failed steps on second tick (checkpoint resume)", async () => {
    // First tick: compileDaily fails
    (compileDaily as any).mockRejectedValueOnce(new Error("network error"));
    await ticker.tick();

    vi.clearAllMocks();

    // Second tick: compileDaily should retry + rollDailyWindow should run
    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    // Already completed in first tick — should be skipped
    expect(compileEditableFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("does not re-run _doDaily after full success", async () => {
    await ticker.tick();
    vi.clearAllMocks();

    // Second tick: _lastDailyJobDate already set → _doDaily skipped
    await ticker.tick();

    expect(compileDaily).not.toHaveBeenCalled();
    expect(rollDailyWindow).not.toHaveBeenCalled();
    expect(compileEditableFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
    // _doCompileTodayAndAssemble always runs regardless
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
  });

  it("restores completed daily state after ticker recreation", async () => {
    await ticker.tick();
    const state = readDailyState(tmpDir);
    expect(state.dailyCompletedAt).toEqual(expect.any(String));
    expect(Object.keys(state.completedSteps).sort()).toEqual([
      "compileDaily",
      "compileFacts",
      "compileToday",
      "deepMemory",
      "rollDailyWindow",
    ]);

    await ticker.stop();
    vi.clearAllMocks();
    ticker = makeTicker(tmpDir);

    await ticker.tick();

    expect(compileDaily).not.toHaveBeenCalled();
    expect(rollDailyWindow).not.toHaveBeenCalled();
    expect(compileEditableFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
  });

  it("persists partial daily checkpoints and retries only unfinished steps after recreation", async () => {
    (compileDaily as any).mockRejectedValueOnce(new Error("network error"));
    await ticker.tick();

    const failedState = readDailyState(tmpDir);
    expect(failedState.dailyCompletedAt).toBeNull();
    expect(failedState.completedSteps.compileToday).toEqual(expect.any(String));
    expect(failedState.completedSteps.compileFacts).toEqual(expect.any(String));
    expect(failedState.completedSteps.deepMemory).toEqual(expect.any(String));
    expect(failedState.completedSteps.compileDaily).toBeUndefined();
    expect(failedState.completedSteps.rollDailyWindow).toBeUndefined();

    await ticker.stop();
    vi.clearAllMocks();
    ticker = makeTicker(tmpDir);

    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    expect(compileEditableFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("invalidates persisted daily state when compiled memory resetAt changes", async () => {
    await ticker.tick();
    await ticker.stop();
    fs.writeFileSync(path.join(tmpDir, "reset.json"), JSON.stringify({
      compiledResetAt: "2026-04-18T00:00:00.000Z",
    }) + "\n");

    vi.clearAllMocks();
    ticker = makeTicker(tmpDir);

    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    expect(compileEditableFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(readDailyState(tmpDir).resetAt).toBe("2026-04-18T00:00:00.000Z");
  });

  it("always compiles facts through the incremental (editable) path with no opt-out option", async () => {
    // facts 转正后不存在开关：默认构造的 ticker（不传任何 facts 相关 option）
    // 必须恒走 compileEditableFacts，daily-state.json 也不再携带 factsMode。
    await ticker.tick();

    expect(compileEditableFacts).toHaveBeenCalledOnce();
    expect(readDailyState(tmpDir)).not.toHaveProperty("factsMode");
  });

  it("clears persisted daily checkpoints when startup recovery writes new summaries", async () => {
    await ticker.tick();
    await ticker.stop();

    const rollingSummary = vi.fn().mockResolvedValue("summary");
    const sessionPath = path.join(tmpDir, "sessions", "recovered.jsonl");
    writeSession(sessionPath);

    vi.clearAllMocks();
    ticker = makeTicker(tmpDir, {
      rollingSummary,
      getSummary: vi.fn().mockReturnValue(null),
    });

    await ticker.tick();

    expect(rollingSummary).toHaveBeenCalledOnce();
    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    expect(compileEditableFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
  });

  it("compileFacts failure does not block other steps", async () => {
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("facts error"));

    await ticker.tick();

    expect(compileDaily).toHaveBeenCalledOnce();
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("deepMemory failure retries on next tick", async () => {
    (processDirtySessions as any).mockRejectedValueOnce(new Error("db locked"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Only deepMemory should retry
    expect(compileDaily).not.toHaveBeenCalled();
    expect(rollDailyWindow).not.toHaveBeenCalled();
    expect(compileEditableFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).toHaveBeenCalledOnce();
  });

  it("multiple failures: both compileDaily and compileFacts retry together", async () => {
    (compileDaily as any).mockRejectedValueOnce(new Error("fail1"));
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("fail2"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Both should retry
    expect(compileDaily).toHaveBeenCalledOnce();
    expect(compileEditableFacts).toHaveBeenCalledOnce();
    // rollDailyWindow depends on compileDaily — should now run
    expect(rollDailyWindow).toHaveBeenCalledOnce();
    // deepMemory already succeeded — skipped
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("assemble runs even when all LLM steps fail", async () => {
    (compileDaily as any).mockRejectedValueOnce(new Error("fail"));
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("fail"));
    (processDirtySessions as any).mockRejectedValueOnce(new Error("fail"));

    await ticker.tick();

    // assemble (step 4) always executes
    expect(assemble).toHaveBeenCalled();
  });

  it("rollDailyWindow reporting failed dates keeps the step incomplete for retry", async () => {
    (rollDailyWindow as any).mockResolvedValueOnce({ folded: [], failed: ["2026-04-10"] });

    await ticker.tick();

    const state = readDailyState(tmpDir);
    expect(state.completedSteps.rollDailyWindow).toBeUndefined();
  });
});

describe("session-derived memory invalidation", () => {
  let tmpDir;
  let ticker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-invalidate-"));
  });

  afterEach(async () => {
    await ticker?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("invalidates the summary, deep facts, and turn counter for exactly one stable session id", () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
      invalidateSession: vi.fn().mockReturnValue(true),
      saveSummary: vi.fn(),
    };
    const factStore = {
      deleteBySession: vi.fn().mockReturnValue(3),
    };
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-retried"),
      getMemoryMasterEnabled: vi.fn(() => false),
    });
    ticker.notifyTurn("/tmp/retried.jsonl");

    expect(ticker.invalidateSessionDerivedState({
      sessionId: "sess-retried",
      sessionPath: "/tmp/retried.jsonl",
    })).toEqual({
      sessionId: "sess-retried",
      summaryInvalidated: true,
      factsDeleted: 3,
      aggregateHistoryPreserved: true,
    });
    expect(summaryManager.invalidateSession).toHaveBeenCalledWith("sess-retried");
    expect(factStore.deleteBySession).toHaveBeenCalledWith("sess-retried");
  });

  it("restores the summary when the following atomic fact deletion fails", () => {
    const originalSummary = {
      session_id: "sess-retried",
      summary: "old active summary",
      messageCount: 4,
    };
    let currentSummary: any = structuredClone(originalSummary);
    const summaryManager = {
      rollingSummary: vi.fn(),
      getSummary: vi.fn(() => currentSummary),
      invalidateSession: vi.fn(() => {
        currentSummary = null;
        return true;
      }),
      saveSummary: vi.fn((_sessionId, snapshot) => {
        currentSummary = structuredClone(snapshot);
      }),
    };
    const factStore = {
      deleteBySession: vi.fn(() => { throw new Error("facts database locked"); }),
    };
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-retried"),
    });

    expect(() => ticker.invalidateSessionDerivedState({
      sessionId: "sess-retried",
      sessionPath: "/tmp/retried.jsonl",
      retainedMessageCount: 2,
    })).toThrow("facts database locked");

    expect(currentSummary).toEqual(originalSummary);
    expect(summaryManager.saveSummary).toHaveBeenCalledWith("sess-retried", originalSummary);
  });

  it("invalidates immediately while an aggregate compile is still in flight (never blocks Retry)", async () => {
    const sessionPath = path.join(tmpDir, "sessions", "compile-race.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeSession(sessionPath);
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("summary"),
      getSummary: vi.fn().mockReturnValue(null),
      invalidateSession: vi.fn().mockReturnValue(true),
      saveSummary: vi.fn(),
    };
    const factStore = {
      deleteBySession: vi.fn().mockReturnValue(2),
    };
    let releaseCompile: ((value: string) => void) | null = null;
    (compileToday as any).mockImplementationOnce(() => new Promise((resolve) => {
      releaseCompile = resolve;
    }));
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-race"),
    });

    const flush = ticker.flushSessionAndCompile(sessionPath);
    await vi.waitFor(() => expect(compileToday).toHaveBeenCalled());

    expect(ticker.invalidateSessionDerivedState({
      sessionId: "sess-race",
      sessionPath,
    })).toEqual({
      sessionId: "sess-race",
      summaryInvalidated: true,
      factsDeleted: 2,
      aggregateHistoryPreserved: true,
    });
    expect(summaryManager.invalidateSession).toHaveBeenCalledWith("sess-race");
    expect(factStore.deleteBySession).toHaveBeenCalledWith("sess-race");

    releaseCompile?.("compiled");
    await flush;
  });

  it("invalidates immediately while the daily job is running (never blocks Retry)", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("summary"),
      getSummary: vi.fn().mockReturnValue(null),
      invalidateSession: vi.fn().mockReturnValue(true),
      saveSummary: vi.fn(),
    };
    const factStore = {
      deleteBySession: vi.fn().mockReturnValue(0),
    };
    let releaseDaily: ((value: string) => void) | null = null;
    (compileDaily as any).mockImplementationOnce(() => new Promise((resolve) => {
      releaseDaily = resolve;
    }));
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-daily-race"),
    });

    const tickJob = ticker.tick();
    await vi.waitFor(() => expect(compileDaily).toHaveBeenCalled());

    expect(() => ticker.invalidateSessionDerivedState({
      sessionId: "sess-daily-race",
      sessionPath: path.join(tmpDir, "sessions", "daily-race.jsonl"),
    })).not.toThrow();
    expect(summaryManager.invalidateSession).toHaveBeenCalledWith("sess-daily-race");

    releaseDaily?.("compiled");
    await tickJob;
  });

  it("does not self-lock when Retry's own branch-head rewind is still marking the session busy", () => {
    // Retry 第一步 setSessionBranchHead 会同步调用 notifyBranchChanged，
    // 其内部 _doRollingSummary 在第一个 await 之前就把 sessionId 记为“摘要在途”。
    // 紧随其后（不等待这个后台任务）的 invalidate 曾经会撞上自己触发的任务而报 busy。
    const sessionPath = path.join(tmpDir, "sessions", "self-lock.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeSession(sessionPath);
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue({}),
      getSummary: vi.fn().mockReturnValue(null),
      invalidateSession: vi.fn().mockReturnValue(true),
      saveSummary: vi.fn(),
    };
    const factStore = {
      deleteBySession: vi.fn().mockReturnValue(1),
    };
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-selflock"),
    });

    const branchJob = ticker.notifyBranchChanged(sessionPath);

    expect(() => ticker.invalidateSessionDerivedState({
      sessionId: "sess-selflock",
      sessionPath,
    })).not.toThrow();
    expect(summaryManager.invalidateSession).toHaveBeenCalledWith("sess-selflock");
    expect(factStore.deleteBySession).toHaveBeenCalledWith("sess-selflock");

    return branchJob;
  });

  it("has an in-flight stale summary write-back overwritten by the branch-replacement rerun", async () => {
    // 时间线：
    // 1) 一个按旧分支启动的摘要任务在途（LLM 调用被挡住）
    // 2) 在途期间 Retry 改写分支头（bump epoch）并 invalidate 作废当前摘要/事实
    // 3) 放行旧任务，它把“旧分支”的摘要写回（这是被接受的语义：在途任务只是把
    //    重试前的历史沉淀进去，不追溯改写）
    // 4) 既有的 epoch 收尾机制自动重跑一次，覆盖掉第 3 步写回的旧摘要
    const sessionPath = path.join(tmpDir, "sessions", "rerun-race.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeSession(sessionPath);

    let currentSummary: any = null;
    let callCount = 0;
    const releases: Array<() => void> = [];
    const summaryManager = {
      rollingSummary: vi.fn(() => {
        callCount += 1;
        const thisCall = callCount;
        return new Promise((resolve) => {
          releases[thisCall] = () => {
            currentSummary = {
              session_id: "sess-rerun",
              summary: thisCall === 1 ? "stale-old-branch" : "fresh-new-branch",
              messageCount: thisCall,
            };
            resolve({});
          };
        });
      }),
      getSummary: vi.fn(() => currentSummary),
      invalidateSession: vi.fn(() => { currentSummary = null; return true; }),
      saveSummary: vi.fn((_id, snapshot) => { currentSummary = snapshot; }),
    };
    const factStore = {
      deleteBySession: vi.fn().mockReturnValue(0),
    };
    ticker = makeTicker(tmpDir, summaryManager, {
      factStore,
      getSessionIdForPath: vi.fn(() => "sess-rerun"),
    });

    // 1) 旧分支摘要任务在途
    const firstFlush = ticker.flushSession(sessionPath);
    await vi.waitFor(() => expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(1));

    // 2) Retry 改写分支头 + invalidate
    const branchJob = ticker.notifyBranchChanged(sessionPath);
    expect(() => ticker.invalidateSessionDerivedState({
      sessionId: "sess-rerun",
      sessionPath,
    })).not.toThrow();
    expect(currentSummary).toBeNull();

    // 3) 放行旧任务，写回旧分支的摘要
    releases[1]();
    await firstFlush;
    expect(currentSummary?.summary).toBe("stale-old-branch");

    // 4) epoch 收尾机制应已自动重跑，最终摘要是新分支的产物
    await vi.waitFor(() => expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(2));
    releases[2]();
    await vi.waitFor(() => expect(currentSummary?.summary).toBe("fresh-new-branch"));

    await branchJob;
  });
});

describe("fork memory reset watermark", () => {
  let tmpDir;
  let ticker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-fork-reset-"));
  });

  afterEach(async () => {
    await ticker?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes the child's post-reset transcript even when the source retained many messages", async () => {
    const sessionPath = path.join(tmpDir, "sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeSession(sessionPath);
    fs.writeFileSync(path.join(tmpDir, "reset.json"), JSON.stringify({
      compiledResetAt: "2026-04-17T10:00:05.000Z",
    }) + "\n");

    const summaryManager = new SessionSummaryManager(path.join(tmpDir, "summaries"));
    summaryManager.initializeForkBaseline("sess-child", {
      sourceSessionId: "sess-source",
      throughEntryId: "source-entry-100",
      messageCount: 100,
      forkedAt: "2026-04-17T10:01:00.000Z",
    });
    const rollingLLM = vi.fn().mockResolvedValue(
      "### 重要事实\n- 子会话继续独立工作。\n\n### 事情经过\n- [2026-04-17 10:00] 助手作出了回复。",
    );
    (summaryManager as any)._callRollingLLM = rollingLLM;
    ticker = makeTicker(tmpDir, summaryManager, {
      getSessionIdForPath: vi.fn(() => "sess-child"),
    });

    await ticker.notifyForkCreated(sessionPath);

    expect(rollingLLM).toHaveBeenCalledTimes(1);
    expect(rollingLLM.mock.calls[0][0]).toContain("hello");
    expect(rollingLLM.mock.calls[0][0]).not.toContain("hi");
    expect(summaryManager.getSummary("sess-child")?.messageCount).toBe(1);
  });

  it("recovers an unmaterialized blank Fork baseline after restart inside the timestamp grace window", async () => {
    const sessionPath = path.join(tmpDir, "sessions", "child-restart.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeSession(sessionPath);

    const summaryManager = new SessionSummaryManager(path.join(tmpDir, "summaries"));
    summaryManager.initializeForkBaseline("sess-child-restart", {
      sourceSessionId: "sess-source",
      throughEntryId: "source-entry-2",
      messageCount: 2,
      forkedAt: new Date(Date.now() + 4_000).toISOString(),
    });
    const rollingLLM = vi.fn().mockResolvedValue(
      "### 重要事实\n- 分叉记忆已在重启后独立物化。\n\n### 事情经过\n- 助手完成了共同前缀的摘要。",
    );
    (summaryManager as any)._callRollingLLM = rollingLLM;
    ticker = makeTicker(tmpDir, summaryManager, {
      getSessionIdForPath: vi.fn(() => "sess-child-restart"),
    });

    await ticker.tick();

    expect(rollingLLM).toHaveBeenCalledTimes(1);
    expect(summaryManager.getSummary("sess-child-restart")?.summary).toContain("分叉记忆已在重启后独立物化");
    expect(summaryManager.getSummary("sess-child-restart")?.messageCount).toBe(2);
  });
});

describe("memory facts environment ledger", () => {
  let tmpDir: string;
  let ticker: any;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-ledger-"));
  });

  afterEach(() => {
    ticker?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records at most five newly compiled non-empty trimmed fact lines", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, " existing fact \n\n");
    (compileEditableFacts as any).mockImplementationOnce(async () => {
      fs.writeFileSync(factsPath, [
        "existing fact",
        " new one ",
        "new two",
        "new two",
        "new three",
        "new four",
        "new five",
        "new six",
        "",
      ].join("\n"));
    });
    const append = vi.fn();
    ticker = makeTicker(tmpDir, undefined, {
      agentId: "memory-owner",
      envChangeLedger: { append },
    });

    await ticker.tick();

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({
      type: "memory_facts",
      scope: { kind: "agent", agentId: "memory-owner" },
      payload: { addedLines: ["new one", "new two", "new three", "new four", "new five"] },
    });
  });

  it("does not record an event when successful compilation adds no fact", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "existing fact\n");
    (compileEditableFacts as any).mockImplementationOnce(async () => {
      fs.writeFileSync(factsPath, "  existing fact  \n\n");
    });
    const append = vi.fn();
    ticker = makeTicker(tmpDir, undefined, {
      agentId: "memory-owner",
      envChangeLedger: { append },
    });

    await ticker.tick();

    expect(append).not.toHaveBeenCalled();
  });

  it("does not record an event when fact compilation fails", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "existing fact\n");
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("compile failed"));
    const append = vi.fn();
    ticker = makeTicker(tmpDir, undefined, {
      agentId: "memory-owner",
      envChangeLedger: { append },
    });

    await ticker.tick();

    expect(append).not.toHaveBeenCalled();
  });
});

// ── getHealthStatus API ──

describe("memory-ticker getHealthStatus", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-health-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes initial health status with all null fields", () => {
    const ticker = makeTicker(tmpDir);
    const h: any = ticker.getHealthStatus();

    for (const key of ["rollingSummary", "compileToday", "compileDaily", "rollDailyWindow", "compileFacts", "deepMemory"]) {
      expect(h[key]).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        lastErrorMsg: null,
        failCount: 0,
      });
    }
    expect(h).not.toHaveProperty("cacheSnapshotReflection");
  });

  it("records lastSuccessAt for each step after a successful tick", async () => {
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileToday.lastSuccessAt).not.toBeNull();
    expect(h.compileDaily.lastSuccessAt).not.toBeNull();
    expect(h.rollDailyWindow.lastSuccessAt).not.toBeNull();
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
    expect(h.deepMemory.lastSuccessAt).not.toBeNull();
    // 所有步骤都应无错误
    for (const key of ["compileToday", "compileDaily", "rollDailyWindow", "compileFacts", "deepMemory"]) {
      expect(h[key].lastErrorMsg).toBeNull();
      expect(h[key].failCount).toBe(0);
    }
  });

  it("records lastErrorMsg + increments failCount on step failure", async () => {
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("boom"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBe("boom");
    expect(h.compileFacts.lastErrorAt).not.toBeNull();
    expect(h.compileFacts.failCount).toBe(1);
    // 其他步骤不受影响
    expect(h.compileDaily.failCount).toBe(0);
    expect(h.compileToday.failCount).toBe(0);
  });

  it("clears error state once a failing step recovers", async () => {
    (compileEditableFacts as any).mockRejectedValueOnce(new Error("boom1"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();
    expect((ticker.getHealthStatus() as any).compileFacts.failCount).toBe(1);

    // 第二次 tick：compileFacts 成功（mock 默认返回）
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBeNull();
    expect(h.compileFacts.lastErrorAt).toBeNull();
    expect(h.compileFacts.failCount).toBe(0);
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
  });

  it("increments failCount on consecutive failures", async () => {
    (compileEditableFacts as any).mockRejectedValue(new Error("persistent"));
    const ticker = makeTicker(tmpDir);

    await ticker.tick();
    await ticker.tick();
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.failCount).toBeGreaterThanOrEqual(2);
    expect(h.compileFacts.lastErrorMsg).toBe("persistent");
  });

  it("tracks rollingSummary failure only on the tenth notifyTurn", async () => {
    const rollingSummary = vi.fn().mockRejectedValue(new Error("llm down"));
    const ticker = makeTicker(tmpDir, {
      rollingSummary,
      getSummary: vi.fn().mockReturnValue(null),
    });

    const sessionPath = path.join(tmpDir, "sessions", "s1.jsonl");
    writeSession(sessionPath);

    for (let i = 0; i < 9; i++) ticker.notifyTurn(sessionPath);
    await new Promise((r) => setTimeout(r, 50));
    expect(rollingSummary).not.toHaveBeenCalled();

    ticker.notifyTurn(sessionPath);
    await new Promise((r) => setTimeout(r, 50));

    const h: any = ticker.getHealthStatus();
    expect(h.rollingSummary.lastErrorMsg).toBe("llm down");
    expect(h.rollingSummary.failCount).toBeGreaterThanOrEqual(1);
  });

  it("returns a deep copy that cannot mutate internal state", () => {
    const ticker = makeTicker(tmpDir);
    const h1: any = ticker.getHealthStatus();
    h1.compileToday.failCount = 999;
    const h2: any = ticker.getHealthStatus();
    expect(h2.compileToday.failCount).toBe(0);
  });
});
