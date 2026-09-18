/**
 * executeIsolated 的运行中途 abort 语义。
 *
 * 契约（workflow 节点超时 / 父 run 取消 / subagent 超时都依赖它）：
 *   1. abort 后不再开启新 turn，子 session 在有限步数内停下；
 *   2. 返回值收敛成 { error: "aborted" }，与入口早退形态一致；
 *   3. 中止过程不产生未处理的 promise rejection。
 *
 * 这里的假 session 复刻 SDK 的一个关键细节：run 还没真正开跑时 abort() 是空操作
 * （底层是 activeRun?.abortController.abort()，没有 activeRun 就什么都不做）。
 * prompt() 在进入 agent 循环前还有一段异步准备（扩展回调、压缩检查），落在这段
 * 窗口里的 abort 会被吞掉，所以 abort 请求必须"粘住"，等 run 起来再补发一次。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: vi.fn(async () => false),
  SessionManager: {
    create: sessionManagerCreateMock,
    list: vi.fn(async () => []),
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  refreshSessionModelFromRegistry: vi.fn(),
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const MAX_TURNS = 40;

/**
 * 假 session：模拟"pre-run 准备 → 多轮 turn"的执行循环。
 * abortBeforeRunIsNoop 复刻 SDK 语义；abortRejects 用来验证不产生未处理 rejection。
 */
function makeFakeSession({ sessionManager, model, abortRejects = false, onPreRun = null }) {
  const listeners = new Set<(event: any) => void>();
  const stats = { turnsRun: 0, abortCalls: 0, finished: false };
  let running = false;
  let abortedInFlight = false;

  const emit = (event: any) => { for (const cb of [...listeners]) cb(event); };
  const assistantEnd = (stopReason: string, text: string) => ({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text }],
      ...(stopReason === "aborted" ? { errorMessage: "Request aborted by user" } : {}),
    },
  });

  const session: any = {
    sessionManager,
    model,
    subscribe(cb: (event: any) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setActiveToolsByName: vi.fn(),
    get isStreaming() { return running; },
    async abort() {
      stats.abortCalls++;
      if (abortRejects) throw new Error("abort exploded");
      // run 没开跑时 abort 落空——这正是必须补发的原因。
      if (!running) return;
      abortedInFlight = true;
    },
    async prompt() {
      // pre-run 异步准备窗口：此刻到达的 abort 会被 SDK 吞掉。
      await tick();
      onPreRun?.();
      await tick();
      running = true;
      try {
        for (let turn = 1; turn <= MAX_TURNS; turn++) {
          await tick();
          if (abortedInFlight) {
            emit(assistantEnd("aborted", ""));
            return;
          }
          stats.turnsRun = turn;
          emit(assistantEnd(turn === MAX_TURNS ? "stop" : "tool_use", `turn ${turn}`));
        }
        stats.finished = true;
      } finally {
        running = false;
      }
    },
  };
  return { session, stats };
}

describe("executeIsolated 运行中途 abort", () => {
  let tempDir: string;
  let agentDir: string;
  let sessionDir: string;
  let isolatedSessionPath: string;
  let store: any;
  let agent: any;
  let fake: ReturnType<typeof makeFakeSession>;
  let fakeOptions: { abortRejects?: boolean; onPreRun?: (() => void) | null };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeOptions = {};
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-iso-abort-"));
    agentDir = path.join(tempDir, "agents", "hana");
    sessionDir = path.join(agentDir, ".ephemeral");
    fs.mkdirSync(sessionDir, { recursive: true });
    isolatedSessionPath = path.join(sessionDir, "iso.jsonl");
    fs.writeFileSync(isolatedSessionPath, `${JSON.stringify({
      type: "session", version: 3, id: "iso", timestamp: "2026-07-31T00:00:00.000Z", cwd: tempDir,
    })}\n`);

    const sessionManager = {
      getSessionFile: () => isolatedSessionPath,
      getSessionId: () => "iso",
      getCwd: () => tempDir,
      getBranch: () => [],
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    sessionManagerOpenMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockImplementation(async (opts: any) => {
      fake = makeFakeSession({ sessionManager: opts.sessionManager, model: opts.model, ...fakeOptions });
      return { session: fake.session };
    });

    store = new SessionManifestStore({
      dbPath: path.join(tempDir, "session-manifest.db"),
      idGenerator: () => "sess_iso_0001",
      now: () => "2026-07-31T00:00:01.000Z",
    });

    agent = {
      id: "hana",
      agentName: "Hana",
      name: "Hana",
      agentDir,
      sessionDir: path.join(agentDir, "sessions"),
      memoryMasterEnabled: false,
      sessionMemoryEnabled: false,
      config: {},
      tools: [],
      buildSystemPrompt: vi.fn(() => "system"),
    };
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCoordinator() {
    return new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getAgentById: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "m", provider: "test", name: "Test Model" },
        defaultModel: { id: "m", provider: "test", name: "Test Model" },
        availableModels: [{ id: "m", provider: "test", name: "Test Model" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level: any) => level || "medium",
        resolveExecutionModel: (model: any) => model,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => "medium",
        getChannelsEnabled: () => true,
        getSessionPermissionModeDefault: () => "ask",
      }),
      getAgents: () => new Map([["hana", agent]]),
      listAgents: () => [agent],
      getActivityStore: () => null,
      sessionManifestStore: store,
    });
  }

  it("在 run 已开跑后中止：停止后续 turn 并返回 aborted", async () => {
    const coordinator = createCoordinator();
    const controller = new AbortController();
    // 等 run 真正开跑再中止（pre-run 窗口之后）。
    setTimeout(() => controller.abort(), 20);

    const result = await coordinator.executeIsolated("do work", { signal: controller.signal });

    expect(result.error).toBe("aborted");
    expect(fake.stats.finished).toBe(false);
    expect(fake.stats.turnsRun).toBeLessThan(MAX_TURNS);
  });

  it("abort 落在 prompt() 的 pre-run 窗口里也必须生效，不能跑完全程", async () => {
    const controller = new AbortController();
    // 中止发生在 prompt() 已经开始、但 agent run 还没起来的窗口里：
    // 此刻 SDK 的 abort 是空操作，请求必须粘住并在 run 起来后补发。
    fakeOptions.onPreRun = () => controller.abort();
    const coordinator = createCoordinator();

    const result = await coordinator.executeIsolated("do work", { signal: controller.signal });

    expect(result.error).toBe("aborted");
    expect(fake.stats.finished).toBe(false);
    expect(fake.stats.turnsRun).toBeLessThanOrEqual(2);
  });

  it("session.abort() 失败不产生未处理 rejection / uncaught exception", async () => {
    fakeOptions.abortRejects = true;
    const escaped: any[] = [];
    const capture = (reason: any) => escaped.push(reason);
    process.on("unhandledRejection", capture);
    process.on("uncaughtException", capture);
    try {
      const coordinator = createCoordinator();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await coordinator.executeIsolated("do work", { signal: controller.signal });
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", capture);
      process.off("uncaughtException", capture);
    }
    expect(escaped.map((err: any) => String(err?.message || err))).toEqual([]);
  });
});
