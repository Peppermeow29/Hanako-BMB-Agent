import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

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

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { compileToday, assemble } from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-03-12T15:47:53.599Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      timestamp: "2026-03-12T15:48:04.225Z",
      message: { role: "assistant", content: "world" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function writeMixedSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-04-29T07:59:00.000Z",
      message: { role: "user", content: "old user message" },
    },
    {
      type: "message",
      timestamp: "2026-04-29T07:59:10.000Z",
      message: { role: "assistant", content: "old assistant message" },
    },
    {
      type: "message",
      timestamp: "2026-04-29T08:01:00.000Z",
      message: { role: "user", content: "new user message" },
    },
    {
      type: "message",
      timestamp: "2026-04-29T08:01:10.000Z",
      message: { role: "assistant", content: "new assistant message" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function writeResetMarker(memoryDir, resetAt) {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "reset.json"), JSON.stringify({ compiledResetAt: resetAt }, null, 2), "utf-8");
}

function makeTicker(tmpDir, isSessionMemoryEnabled, overrides: any = {}) {
  const summaryManager = {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
  };

  const memoryDir = path.join(tmpDir, "memory");
  const ticker = createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled,
    ...overrides,
    getTimezone: () => "Asia/Shanghai",
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    todayMdPath: path.join(memoryDir, "today.md"),
    weekMdPath: path.join(memoryDir, "week.md"),
    longtermMdPath: path.join(memoryDir, "longterm.md"),
    factsMdPath: path.join(memoryDir, "facts.md"),
  });

  return { ticker, summaryManager };
}

describe("memory ticker respects session-level memory toggle", () => {
  let tmpDir;
  let sessionPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-toggle-"));
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    sessionPath = path.join(tmpDir, "sessions", "2026-03-12T15-47-53-568Z_test.jsonl");
    writeSession(sessionPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips summary + compile when the session memory is disabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => false);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("keys rolling summaries by stable sessionId when the manifest resolver can provide it", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true, {
      getSessionIdForPath: () => "sess_memory_1",
    });

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "sess_memory_1",
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("never summarizes agent phone sessions even if session memory is enabled", async () => {
    const phoneSessionPath = path.join(tmpDir, "phone", "sessions", "ch_crew", "phone.jsonl");
    fs.mkdirSync(path.dirname(phoneSessionPath), { recursive: true });
    writeSession(phoneSessionPath);
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(phoneSessionPath);
    await ticker.notifySessionEnd(phoneSessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it("still summarizes the session when the session memory is enabled", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalled();
    expect(assemble).toHaveBeenCalled();
  });

  it("awaits an asynchronous fresh memory-model resolver before invoking memory LLM work", async () => {
    let releaseModel;
    const modelPromise = new Promise((resolve) => { releaseModel = resolve; });
    const getResolvedMemoryModel = vi.fn(() => modelPromise);
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true, { getResolvedMemoryModel });

    ticker.notifyTurn(sessionPath);
    const pending = ticker.flushSessionAndCompile(sessionPath);
    await Promise.resolve();
    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();

    const freshModel = {
      model: "fresh-model",
      provider: "oauth-provider",
      api: "openai-completions",
      api_key: "fresh-token",
      base_url: "https://fresh.example/v1",
    };
    releaseModel(freshModel);
    await pending;

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      freshModel,
      expect.any(Object),
    );
  });

  it("flushSessionAndCompile summarizes an unfinished turn bucket and resets the turn count", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    for (let i = 0; i < 9; i++) ticker.notifyTurn(sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();

    await ticker.flushSessionAndCompile(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();

    ticker.notifyTurn(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
  });

  it("notifySessionEnd 是 fire-and-forget：即使 rollingSummary 永不 resolve，caller 也能立即继续", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(() => new Promise(() => {})), // 永不 resolve
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryDir = path.join(tmpDir, "memory");
    const ticker = createMemoryTicker({
      summaryManager,
      configPath: path.join(tmpDir, "config.yaml"),
      factStore: {},
      getResolvedMemoryModel: () => ({ model: "m", provider: "p", api: "openai-completions", api_key: "k", base_url: "http://x" }),
      getMemoryMasterEnabled: () => true,
      isSessionMemoryEnabled: () => true,
      onCompiled: vi.fn(),
      sessionDir: path.join(tmpDir, "sessions"),
      memoryDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      todayMdPath: path.join(memoryDir, "today.md"),
      weekMdPath: path.join(memoryDir, "week.md"),
      longtermMdPath: path.join(memoryDir, "longterm.md"),
      factsMdPath: path.join(memoryDir, "facts.md"),
    });

    ticker.notifyTurn(sessionPath);
    // 不 await：caller 必须能立即继续而不被挂起
    const pending = ticker.notifySessionEnd(sessionPath);
    // 同步断言：返回值是 Promise，但调用方这一行不应被 LLM 挡住
    expect(pending).toBeInstanceOf(Promise);
    // fresh resolver 是异步边界；让一个 microtask 通过后，后台 rollingSummary 启动。
    await Promise.resolve();
    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    // 关键：不 await pending，测试仍能走到下一行 —— 证明 fire-and-forget
  });

  it("没有新轮次（count===0）时跳过，返回 resolved Promise", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    // 不调 notifyTurn，count 保持 0
    await ticker.notifySessionEnd(sessionPath);
    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
  });

  it("summarizes only post-reset messages in an existing session", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    writeResetMarker(memoryDir, "2026-04-29T08:00:00.000Z");
    writeMixedSession(sessionPath);
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    const messages = summaryManager.rollingSummary.mock.calls[0][1];
    expect(messages.map((m) => m.content)).toEqual(["new user message", "new assistant message"]);
    expect(summaryManager.rollingSummary.mock.calls[0][3]).toEqual(expect.objectContaining({
      resetAt: "2026-04-29T08:00:00.000Z",
      timeZone: "Asia/Shanghai",
      projection: expect.objectContaining({ selectedLeafId: "legacy-line-4" }),
    }));
  });

  it("passes the injected session memory reflection snapshot into rollingSummary", async () => {
    const snapshot = {
      version: 1,
      agentName: "Hana",
      userName: "测试用户",
      identityAndPersonality: "Hana 的人格设定。",
      userProfile: "测试用户的主人设定。",
      existingMemory: "已有长期记忆。",
      roster: "同处于这个系统里的别的 Agent：Butter。",
    };
    const readMemoryReflectionSnapshot = vi.fn(() => snapshot);
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true, {
      readMemoryReflectionSnapshot,
    });

    ticker.notifyTurn(sessionPath);
    await ticker.notifySessionEnd(sessionPath);

    expect(readMemoryReflectionSnapshot).toHaveBeenCalledWith(sessionPath);
    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.rollingSummary.mock.calls[0][3]).toEqual(expect.objectContaining({
      resetAt: null,
      timeZone: "Asia/Shanghai",
      memoryReflectionSnapshot: snapshot,
      projection: expect.any(Object),
    }));
  });

  it("startup recovery skips sessions whose file mtime is before the reset watermark", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    writeResetMarker(memoryDir, "2026-04-29T08:00:00.000Z");
    writeSession(sessionPath);
    fs.utimesSync(sessionPath, new Date("2026-04-29T07:00:00.000Z"), new Date("2026-04-29T07:00:00.000Z"));
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    await ticker.tick();

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
  });

  it("stop waits for active background session work before resolving", async () => {
    let resolveSummary;
    const summaryManager = {
      rollingSummary: vi.fn(() => new Promise((resolve) => { resolveSummary = resolve; })),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryDir = path.join(tmpDir, "memory");
    const ticker = createMemoryTicker({
      summaryManager,
      configPath: path.join(tmpDir, "config.yaml"),
      factStore: {},
      getResolvedMemoryModel: () => ({ model: "m", provider: "p", api: "openai-completions", api_key: "k", base_url: "http://x" }),
      getMemoryMasterEnabled: () => true,
      isSessionMemoryEnabled: () => true,
      onCompiled: vi.fn(),
      sessionDir: path.join(tmpDir, "sessions"),
      memoryDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      todayMdPath: path.join(memoryDir, "today.md"),
      weekMdPath: path.join(memoryDir, "week.md"),
      longtermMdPath: path.join(memoryDir, "longterm.md"),
      factsMdPath: path.join(memoryDir, "facts.md"),
    });

    ticker.notifyTurn(sessionPath);
    void ticker.notifySessionEnd(sessionPath);
    const stopPromise = ticker.stop();
    let stopped = false;
    stopPromise.then(() => { stopped = true; });
    await Promise.resolve();

    expect(stopped).toBe(false);

    resolveSummary("summary");
    await stopPromise;

    expect(stopped).toBe(true);
  });

  it("stop prevents later turn notifications from starting new memory work", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);

    await ticker.stop();
    for (let i = 0; i < 10; i++) ticker.notifyTurn(sessionPath);
    await Promise.resolve();

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(compileToday).not.toHaveBeenCalled();
  });

  it("recovers a persisted branch fact replacement after restart even when the JSONL is older than the summary", async () => {
    let replacementPending = true;
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true, {
      getSessionIdForPath: () => "sess_branch_recovery",
    });
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(sessionPath, oldMtime, oldMtime);
    summaryManager.getSummary.mockImplementation(() => ({
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      factReplacementRequired: replacementPending,
    }));
    summaryManager.rollingSummary.mockResolvedValue({
      mode: "append",
      data: null,
      reason: "",
    });
    (processDirtySessions as any).mockImplementationOnce(async () => {
      replacementPending = false;
      return { processed: 1, factsAdded: 1 };
    });

    await ticker.tick();

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "sess_branch_recovery",
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({ projection: expect.any(Object) }),
    );
    expect(processDirtySessions).toHaveBeenCalledWith(
      summaryManager,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sessionIds: ["sess_branch_recovery"] }),
    );
    expect(compileToday).toHaveBeenCalled();
  });

  it("recovers a rewind-only branch change even when JSONL mtime and summary look current", async () => {
    const updatedAt = new Date(Date.now() + 60_000).toISOString();
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true, {
      getSessionIdForPath: () => "sess_rewind_only",
      getSessionBranchHeadForPath: () => ({ updatedAt, revision: 2 }),
      readSessionBranchForPath: () => ({
        selectedLeafId: "u-root",
        rootLineageHash: "root-hash",
        lineageHash: "current-hash",
        prefixHashes: { "u-root": "current-hash" },
        lineage: [{ id: "u-root", lineageHash: "current-hash" }],
        messages: [{ role: "user", content: "current root", lineageIndex: 0 }],
      }),
    });
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(sessionPath, oldMtime, oldMtime);
    summaryManager.getSummary.mockReturnValue({
      updated_at: new Date(Date.now() + 30_000).toISOString(),
      cursor: { coveredLeafId: "a-discarded", lineageHash: "discarded-hash" },
      factReplacementRequired: false,
    });
    summaryManager.rollingSummary.mockResolvedValue({
      mode: "replace",
      data: { factReplacementRequired: true },
      reason: "",
    });

    await ticker.tick();

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "sess_rewind_only",
      expect.arrayContaining([expect.objectContaining({ content: "current root" })]),
      expect.any(Object),
      expect.objectContaining({ projection: expect.objectContaining({ selectedLeafId: "u-root" }) }),
    );
  });

  it("keeps forced branch replacement pending, skips compile on fact failure, and retries next turn", async () => {
    let replacementPending = true;
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    summaryManager.rollingSummary.mockResolvedValue({
      mode: "replace",
      data: { factReplacementRequired: true },
      reason: "",
    });
    summaryManager.getSummary.mockImplementation(() => ({
      factReplacementRequired: replacementPending,
    }));
    (processDirtySessions as any)
      .mockRejectedValueOnce(new Error("replaceBySession failed"))
      .mockImplementationOnce(async () => {
        replacementPending = false;
        return { processed: 1, factsAdded: 1 };
      });

    await ticker.notifyTurn(sessionPath, { forceSummary: true });

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(1);
    expect(compileToday).not.toHaveBeenCalled();

    await ticker.notifyTurn(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(2);
    expect(processDirtySessions).toHaveBeenCalledTimes(2);
    expect(compileToday).toHaveBeenCalledOnce();
  });

  it("keeps forced replacement pending when the branch changes during summary generation", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    summaryManager.rollingSummary
      .mockResolvedValueOnce({ mode: "replace", data: null, reason: "branch_changed" })
      .mockResolvedValueOnce({ mode: "append", data: null, reason: "" });

    await ticker.notifyTurn(sessionPath, { forceSummary: true });

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(1);
    expect(compileToday).not.toHaveBeenCalled();

    await ticker.notifyTurn(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(2);
    expect(compileToday).toHaveBeenCalledOnce();
  });

  it("keeps forced replacement pending when the replacement summary is empty", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    summaryManager.rollingSummary
      .mockResolvedValueOnce({ mode: "replace", data: null, reason: "empty_output" })
      .mockResolvedValueOnce({ mode: "append", data: null, reason: "" });

    await ticker.notifyTurn(sessionPath, { forceSummary: true });

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(1);
    expect(compileToday).not.toHaveBeenCalled();

    await ticker.notifyTurn(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(2);
    expect(compileToday).toHaveBeenCalledOnce();
  });

  it("starts branch replacement as soon as a rewind is persisted", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    summaryManager.rollingSummary.mockResolvedValue({ mode: "replace", data: {}, reason: "" });

    await ticker.notifyBranchChanged(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(compileToday).toHaveBeenCalledOnce();
  });

  it("queues a newer forced replacement when a rewind summary is already running", async () => {
    const { ticker, summaryManager } = makeTicker(tmpDir, () => true);
    let resolveFirst: (value: any) => void = () => {};
    summaryManager.rollingSummary
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue({ mode: "append", data: null, reason: "" });

    const firstJob = ticker.notifyBranchChanged(sessionPath);
    await vi.waitFor(() => expect(summaryManager.rollingSummary).toHaveBeenCalledOnce());
    fs.appendFileSync(sessionPath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-03-12T15:49:00.000Z",
      message: { role: "user", content: "replacement leaf" },
    })}\n`, "utf-8");
    await ticker.notifyTurn(sessionPath, { forceSummary: true });

    resolveFirst({ mode: "replace", data: { factReplacementRequired: true }, reason: "" });
    await firstJob;
    await vi.waitFor(() => expect(summaryManager.rollingSummary).toHaveBeenCalledTimes(2));
    await ticker.stop();

    const rerunMessages = summaryManager.rollingSummary.mock.calls[1][1];
    expect(rerunMessages.map((message) => message.content)).toContain("replacement leaf");
  });
});
