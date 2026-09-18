/**
 * BridgeManager._handleMessage 测试
 *
 * 关键路径：
 * - 群聊：直接发送，不 debounce 不 abort（guest 快速回复）
 * - 私聊：debounce 2s 聚合 → 合并发送
 * - 私聊新消息到达：abort 正在进行的生成
 * - /stop 命令：abort + 清空 pending
 * - 处理锁：防止并发 flush
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock adapter imports (避免拉真实 SDK) ──

const bridgeDebugMock = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const bridgeModuleLoggerMock = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: vi.fn(),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => bridgeDebugMock,
  createModuleLogger: () => bridgeModuleLoggerMock,
}));

import os from "os";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createSlashSystem } from "../core/slash-commands/index.ts";

// ── Helpers ──

/** 匹配 timeTag 前缀（<t>MM-DD HH:mm</t> ）后跟预期文本 */
const tagged = (text) => expect.stringMatching(new RegExp(`^<t>\\d{2}-\\d{2} \\d{2}:\\d{2}</t> ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

/** executeExternalMessage 的结构化结果（#1607）：正文 / 错误 / 截断正交 */
const bridgeReply = (text) => ({ text, toolMedia: [], error: null, truncated: false });

function createMocks() {
  const adapter = {
    sendReply: (vi.fn().mockResolvedValue as any)(),
    sendBlockReply: (vi.fn().mockResolvedValue as any)(),
    sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
    stop: vi.fn(),
  };

  const engine: any = {
    getAgent: vi.fn().mockImplementation((id) => {
      if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } }, sessionDir: os.tmpdir() };
      return null;
    }),
    getBridgeReceiptEnabled: vi.fn().mockReturnValue(true),
    getBridgeRichStreamingEnabled: vi.fn().mockReturnValue(true),
    isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
    abortBridgeSession: vi.fn().mockResolvedValue(false),
    steerBridgeSession: vi.fn().mockReturnValue(false),
    bridgeSessionManager: {
      injectMessage: vi.fn(() => true),
      recordAssistantMessage: vi.fn(() => true),
      readIndex: () => ({}),
      writeIndex: () => {},
    },
    agentName: "TestAgent",
    hanakoHome: os.tmpdir(),
    currentAgentId: "hana",
  };

  const hub = {
    send: vi.fn().mockResolvedValue(bridgeReply("AI response")),
    eventBus: { emit: vi.fn() },
  };

  // 注入真实 slashSystem（Phase 3 接入 bridge-manager 后必需）
  const slashSystem = createSlashSystem({ engine, hub });
  engine.slashDispatcher = slashSystem.dispatcher;
  engine.slashRegistry = slashSystem.registry;

  const bm = new BridgeManager({ engine, hub });
  // Inject mock adapter directly (bypass startPlatform) — use composite key
  bm._platforms.set("telegram:hana", { adapter, status: "connected", agentId: "hana", platform: "telegram" });
  // Disable block streaming for simpler assertions
  bm.blockStreaming = false;

  return { bm, adapter, engine, hub };
}

// ── Tests ──

describe("BridgeManager._handleMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridgeDebugMock.log.mockClear();
    bridgeDebugMock.warn.mockClear();
    bridgeDebugMock.error.mockClear();
    bridgeModuleLoggerMock.log.mockClear();
    bridgeModuleLoggerMock.warn.mockClear();
    bridgeModuleLoggerMock.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Group messages ──

  describe("group fast path", () => {
    it("sends immediately without debounce", async () => {
      const { bm, hub, adapter } = createMocks();

      // _flushGroupMessage is fire-and-forget (not awaited), wait for it
      const promise = bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "hello",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });
      await promise;
      // flush the unresolved group message promise
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Alice: hello"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalled());
      expect(adapter.sendReply).toHaveBeenCalledWith("g1", "AI response");
    });

    it("carries QQ message ids through group replies as passive reply context", async () => {
      const { bm, hub, adapter: telegramAdapter } = createMocks();
      const qqAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("qq:hana", { adapter: qqAdapter, status: "connected", agentId: "hana", platform: "qq" });

      await bm._handleMessage("qq", {
        sessionKey: "qq_group_g1@hana",
        text: "hello",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
        _msgId: "qq-mid-1",
        replyTargetType: "group",
      });

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(qqAdapter.sendReply).toHaveBeenCalledWith(
        "g1",
        "AI response",
        expect.objectContaining({
          messageId: "qq-mid-1",
          isGroup: true,
          targetScope: "group",
          targetType: "group",
        }),
      ));
      expect(telegramAdapter.sendReply).not.toHaveBeenCalledWith("g1", "AI response", expect.anything());
    });

    it("carries Telegram forum topic ids through group replies", async () => {
      const { bm, hub, adapter } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "topic ping",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
        messageThreadId: 42,
      });

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith(
        "g1",
        "AI response",
        expect.objectContaining({
          messageThreadId: 42,
          isGroup: true,
          targetScope: "group",
        }),
      ));
    });

    it("prefixes sender name in group messages", async () => {
      const { bm, hub } = createMocks();

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "hi there",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledOnce());
      expect(hub.send).toHaveBeenCalledWith(tagged("Bob: hi there"), expect.any(Object));
    });

    it("serializes group messages for the same sessionKey", async () => {
      const { bm, hub } = createMocks();

      let resolveFirst;
      hub.send.mockImplementationOnce(() =>
        new Promise((resolve) => { resolveFirst = resolve; })
      );

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "first",
        senderName: "Alice",
        userId: "user1",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));

      await bm._handleMessage("telegram", {
        sessionKey: "tg_group_g1@hana",
        text: "second",
        senderName: "Bob",
        userId: "user2",
        isGroup: true,
        chatId: "g1",
        agentId: "hana",
      });

      expect(hub.send).toHaveBeenCalledTimes(1);

      resolveFirst(bridgeReply("response 1"));
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2));

      expect(hub.send).toHaveBeenNthCalledWith(
        1,
        tagged("Alice: first"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
      expect(hub.send).toHaveBeenNthCalledWith(
        2,
        tagged("Bob: second"),
        expect.objectContaining({ sessionKey: "tg_group_g1@hana", role: "guest", isGroup: true }),
      );
    });
  });

  // ── DM debounce ──

  describe("DM debounce", () => {
    it("sends the pre-reply receipt prompt only when the LLM reply starts", async () => {
      const { bm, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(adapter.sendReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendReply).toHaveBeenNthCalledWith(1, "owner123", "（TestAgent正在输入...）");
      expect(adapter.sendReply).toHaveBeenLastCalledWith("owner123", "AI response");
    });

    it("does not send any pre-reply receipt prompt when globally disabled", async () => {
      const { bm, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(adapter.sendReply).not.toHaveBeenCalledWith("owner123", "（TestAgent正在输入...）");
      expect(adapter.sendTypingIndicator).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response");
      expect(adapter.sendTypingIndicator).not.toHaveBeenCalled();
    });

    it("uses declared native typing receipt instead of a text prompt", async () => {
      const { bm, adapter } = createMocks();
      (adapter as any).receiptCapabilities = {
        mode: "native_typing",
        scopes: ["dm"],
        refreshIntervalMs: 0,
      };

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response"));
      expect(adapter.sendTypingIndicator).toHaveBeenCalledWith("owner123", expect.any(Object));
      expect(adapter.sendReply).not.toHaveBeenCalledWith("owner123", "（TestAgent正在输入...）");
    });

    it("cancels declared native typing receipt after reply generation settles", async () => {
      const { bm, adapter } = createMocks();
      (adapter as any).receiptCapabilities = {
        mode: "native_typing",
        scopes: ["dm"],
        refreshIntervalMs: 0,
        cancellable: true,
      };
      (adapter as any).cancelTypingIndicator = (vi.fn().mockResolvedValue as any)();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response"));
      expect((adapter as any).cancelTypingIndicator).toHaveBeenCalledWith("owner123", expect.any(Object));
    });

    it("buffers messages and sends merged after 2s", async () => {
      const { bm, hub, adapter } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "world",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> hello\nworld$/),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@hana", role: "owner" }),
      );
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "AI response");
    });

    it("uses the latest QQ DM message id for debounced passive replies", async () => {
      const { bm, adapter: telegramAdapter } = createMocks();
      const qqAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("qq:hana", { adapter: qqAdapter, status: "connected", agentId: "hana", platform: "qq" });

      bm._handleMessage("qq", {
        sessionKey: "qq_dm_owner123@hana",
        text: "first",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
        _msgId: "qq-dm-1",
        replyTargetType: "user",
      });
      bm._handleMessage("qq", {
        sessionKey: "qq_dm_owner123@hana",
        text: "second",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
        _msgId: "qq-dm-2",
        replyTargetType: "user",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(qqAdapter.sendReply).toHaveBeenCalledWith(
        "owner123",
        "AI response",
        expect.objectContaining({ messageId: "qq-dm-2", targetType: "user" }),
      );
      expect(telegramAdapter.sendReply).not.toHaveBeenCalledWith("owner123", "AI response", expect.anything());
    });

    it("resets debounce timer on each new message", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "first",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "second",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(hub.send).toHaveBeenCalledOnce();
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringMatching(/^<t>\d{2}-\d{2} \d{2}:\d{2}<\/t> first\nsecond$/),
        expect.any(Object),
      );
    });

    it("uses owner role for owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("hi"),
        expect.objectContaining({ role: "owner" }),
      );
    });

    it("uses guest role for non-owner DMs", async () => {
      const { bm, hub } = createMocks();

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@hana",
        text: "hi",
        senderName: "Stranger",
        userId: "stranger",
        chatId: "stranger",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: hi"),
        expect.objectContaining({ role: "guest" }),
      );
    });

    it("sends proactive WeChat replies to the unique known DM user when owner is not configured", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(true),
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: {} } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "wx_dm_wx-user@hana": {
          file: "owner/wx.jsonl",
          userId: "wx-user",
          name: "微信用户",
        },
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(wechatAdapter.canReply).toHaveBeenCalledWith("wx-user");
      expect(wechatAdapter.sendReply).toHaveBeenCalledWith("wx-user", "hello");
      expect(engine.bridgeSessionManager.recordAssistantMessage).toHaveBeenCalledWith(
        "wx_dm_wx-user@hana",
        "hello",
        expect.objectContaining({
          agentId: "hana",
          createIfMissing: true,
          meta: expect.objectContaining({
            userId: "wx-user",
            chatId: "wx-user",
          }),
        }),
      );
      expect(result).toMatchObject({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hana",
      });
    });

    it("does not record proactive WeChat context when the reply window is unavailable", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(false),
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: {} } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "wx_dm_wx-user@hana": {
          file: "owner/wx.jsonl",
          userId: "wx-user",
          name: "微信用户",
        },
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(result).toMatchObject({
        ok: false,
        error: "reply_context_unavailable",
        deliveries: [{
          status: "failed",
          platform: "wechat",
          chatId: "wx-user",
          error: "reply_context_unavailable",
        }],
      });
      expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
      expect(engine.bridgeSessionManager.recordAssistantMessage).not.toHaveBeenCalled();
    });

    it("returns reply_context_unavailable when an explicit deliveryTarget lacks WeChat reply context", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(false),
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: { owner: "wx-user" } } }, sessionDir: os.tmpdir() };
        return null;
      });

      const result = await bm.sendProactive("hello", "hana", {
        deliveryTarget: {
          kind: "bridge",
          platform: "wechat",
          chatId: "wx-user",
          sessionKey: "wx_dm_wx-user@hana",
          agentId: "hana",
        },
      });

      expect(wechatAdapter.canReply).toHaveBeenCalledWith("wx-user");
      expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        error: "reply_context_unavailable",
        deliveries: [{
          status: "failed",
          platform: "wechat",
          chatId: "wx-user",
          error: "reply_context_unavailable",
        }],
      });
    });

    it("returns send_failed when a connected adapter with reply context throws from sendReply", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(true),
        sendReply: vi.fn().mockRejectedValue(new Error("upstream 503")),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: { owner: "wx-user" } } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "wx_dm_wx-user@hana": {
          file: "owner/wx.jsonl",
          userId: "wx-user",
          name: "微信用户",
        },
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(wechatAdapter.canReply).toHaveBeenCalledWith("wx-user");
      expect(wechatAdapter.sendReply).toHaveBeenCalledWith("wx-user", "hello");
      expect(result).toMatchObject({
        ok: false,
        error: "send_failed",
        message: "upstream 503",
        deliveries: [{
          status: "failed",
          platform: "wechat",
          chatId: "wx-user",
          error: "upstream 503",
        }],
      });
      expect(engine.bridgeSessionManager.recordAssistantMessage).not.toHaveBeenCalled();
    });

    it("returns target_missing when no owner delivery target can be resolved", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(true),
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: {} } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({});

      const result = await bm.sendProactive("hello", "hana");

      expect(result).toMatchObject({
        ok: false,
        error: "target_missing",
      });
      expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
    });

    it("returns disconnected when Bridge platforms exist but none are connected", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        capabilities: { proactive: false },
        canReply: vi.fn().mockReturnValue(true),
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "disconnected",
        agentId: "hana",
        platform: "wechat",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { wechat: { owner: "wx-user" } } }, sessionDir: os.tmpdir() };
        return null;
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(result).toMatchObject({
        ok: false,
        error: "disconnected",
      });
      expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
    });

    it("does not send proactive replies through a Bridge entry owned by another agent", async () => {
      const { bm } = createMocks();
      const otherAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      const unboundAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("telegram:other", {
        adapter: otherAdapter,
        status: "connected",
        agentId: "other",
        platform: "telegram",
      });
      bm._platforms.set("telegram", {
        adapter: unboundAdapter,
        status: "connected",
        agentId: null,
        platform: "telegram",
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(result).toMatchObject({
        ok: false,
        error: "target_missing",
      });
      expect(otherAdapter.sendReply).not.toHaveBeenCalled();
      expect(unboundAdapter.sendReply).not.toHaveBeenCalled();
    });

    it("sends proactive Feishu replies to the stored DM chatId instead of the owner user id", async () => {
      const { bm, engine } = createMocks();
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("feishu:hana", {
        adapter: feishuAdapter,
        status: "connected",
        agentId: "hana",
        platform: "feishu",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { feishu: { owner: "owner-user-id" } } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "fs_dm_owner-open-id@hana": {
          file: "owner/fs.jsonl",
          userId: "owner-user-id",
          chatId: "oc_owner_chat",
          name: "Owner",
        },
      });

      const result = await bm.sendProactive("hello", "hana");

      expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_owner_chat", "hello");
      expect(result).toMatchObject({
        platform: "feishu",
        chatId: "oc_owner_chat",
        sessionKey: "fs_dm_owner-open-id@hana",
      });
    });

    it("only sends proactive replies through the requested Bridge platform", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      bm._platforms.set("feishu:hana", {
        adapter: feishuAdapter,
        status: "connected",
        agentId: "hana",
        platform: "feishu",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") {
          return {
            agentName: "TestAgent",
            config: {
              bridge: {
                wechat: { owner: "wx-user" },
                feishu: { owner: "owner-user-id" },
              },
            },
            sessionDir: os.tmpdir(),
          };
        }
        return null;
      });
      engine.getBridgeIndex = vi.fn((agentId) => {
        expect(agentId).toBe("hana");
        return {
          "wx_dm_wx-user@hana": {
            file: "owner/wx.jsonl",
            userId: "wx-user",
          },
          "fs_dm_owner-open-id@hana": {
            file: "owner/fs.jsonl",
            userId: "owner-user-id",
            chatId: "oc_owner_chat",
          },
        };
      });

      const result = await bm.sendProactive("hello", "hana", {
        bridgePlatforms: ["feishu"],
      });

      expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
      expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_owner_chat", "hello");
      expect(result).toMatchObject({
        platform: "feishu",
        chatId: "oc_owner_chat",
        sessionKey: "fs_dm_owner-open-id@hana",
      });
    });

    it("fans proactive replies out to every explicitly requested Bridge platform", async () => {
      const { bm, engine } = createMocks();
      const wechatAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("wechat:hana", {
        adapter: wechatAdapter,
        status: "connected",
        agentId: "hana",
        platform: "wechat",
      });
      bm._platforms.set("feishu:hana", {
        adapter: feishuAdapter,
        status: "connected",
        agentId: "hana",
        platform: "feishu",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") {
          return {
            agentName: "TestAgent",
            config: {
              bridge: {
                wechat: { owner: "wx-user" },
                feishu: { owner: "owner-user-id" },
              },
            },
            sessionDir: os.tmpdir(),
          };
        }
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "wx_dm_wx-user@hana": {
          file: "owner/wx.jsonl",
          userId: "wx-user",
        },
        "fs_dm_owner-open-id@hana": {
          file: "owner/fs.jsonl",
          userId: "owner-user-id",
          chatId: "oc_owner_chat",
        },
      });

      const result = await bm.sendProactive("hello", "hana", {
        bridgePlatforms: ["wechat", "feishu"],
      });

      expect(wechatAdapter.sendReply).toHaveBeenCalledWith("wx-user", "hello");
      expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_owner_chat", "hello");
      expect(result).toMatchObject({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hana",
        deliveries: [
          {
            status: "sent",
            platform: "wechat",
            chatId: "wx-user",
            sessionKey: "wx_dm_wx-user@hana",
          },
          {
            status: "sent",
            platform: "feishu",
            chatId: "oc_owner_chat",
            sessionKey: "fs_dm_owner-open-id@hana",
          },
        ],
      });
    });

    it("deduplicates proactive sends with the same explicit idempotency key", async () => {
      const { bm, engine } = createMocks();
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
      };
      bm._platforms.clear();
      bm._platforms.set("feishu:hana", {
        adapter: feishuAdapter,
        status: "connected",
        agentId: "hana",
        platform: "feishu",
      });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { feishu: { owner: "owner-user-id" } } }, sessionDir: os.tmpdir() };
        return null;
      });
      engine.getBridgeIndex = vi.fn().mockReturnValue({
        "fs_dm_owner-open-id@hana": {
          file: "owner/fs.jsonl",
          userId: "owner-user-id",
          chatId: "oc_owner_chat",
          name: "Owner",
        },
      });

      const first = await bm.sendProactive("hello", "hana", {
        bridgePlatforms: ["feishu"],
        idempotencyKey: "notify:job:once",
      });
      const second = await bm.sendProactive("hello", "hana", {
        bridgePlatforms: ["feishu"],
        idempotencyKey: "notify:job:once",
      });

      expect(feishuAdapter.sendReply).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({
        platform: "feishu",
        chatId: "oc_owner_chat",
        sessionKey: "fs_dm_owner-open-id@hana",
      });
      expect(second).toMatchObject({
        platform: "feishu",
        chatId: "oc_owner_chat",
        sessionKey: "fs_dm_owner-open-id@hana",
        skipped: true,
      });
    });

    it("passes message_id when downloading feishu image attachments", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
        downloadImage: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "",
        userId: "stranger",
        senderName: "Stranger",
        chatId: "oc_123",
        agentId: "hana",
        attachments: [{
          type: "image",
          platformRef: "img_123",
          _messageId: "om_123",
          mimeType: "image/jpeg",
        }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(feishuAdapter.downloadImage).toHaveBeenCalledWith("img_123", "om_123");
      expect(hub.send).toHaveBeenCalledWith(
        tagged("Stranger: "),
        expect.objectContaining({
          images: [expect.objectContaining({ mimeType: "image/png" })],
          inboundFiles: [expect.objectContaining({
            type: "image",
            filename: "image.png",
            mimeType: "image/png",
            buffer: expect.any(Buffer),
          })],
        }),
      );
    });

    it("reads wechat text file attachments through the platform-specific file downloader", async () => {
      const { bm, hub } = createMocks();
      const wechatAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
        downloadFileByRef: vi.fn().mockResolvedValue(Buffer.from("hello from wechat txt", "utf-8")),
      };
      bm._platforms.set("wechat:hana", { adapter: wechatAdapter, status: "connected", agentId: "hana", platform: "wechat" });

      bm._handleMessage("wechat", {
        sessionKey: "wx_dm_owner123@hana",
        text: "",
        userId: "owner123",
        chatId: "wx_123",
        agentId: "hana",
        attachments: [{
          type: "file",
          filename: "notes.txt",
          platformRef: "{\"encrypt_query_param\":\"abc\",\"aes_key\":\"def\"}",
          size: 21,
        }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(wechatAdapter.downloadFileByRef).toHaveBeenCalledWith("{\"encrypt_query_param\":\"abc\",\"aes_key\":\"def\"}");
      expect(hub.send).toHaveBeenCalledWith(
        expect.stringContaining("hello from wechat txt"),
        expect.objectContaining({
          sessionKey: "wx_dm_owner123@hana",
          inboundFiles: [expect.objectContaining({
            type: "file",
            filename: "notes.txt",
            mimeType: "text/plain",
            buffer: expect.any(Buffer),
          })],
        }),
      );
    });

    it("persists Feishu chatId in bridge session metadata for later proactive delivery", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner-open-id@hana",
        text: "hi",
        userId: "owner-user-id",
        senderName: "Owner",
        chatId: "oc_owner_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledWith(
        tagged("Owner: hi"),
        expect.objectContaining({
          meta: expect.objectContaining({
            userId: "owner-user-id",
            chatId: "oc_owner_chat",
          }),
        }),
      );
    });
  });

  describe("streaming delivery", () => {
    it("uses Telegram draft streaming for deltas and sends one final message", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      (adapter as any).streamingCapabilities = {
        mode: "draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 4096,
      };
      (adapter as any).sendDraft = (vi.fn().mockResolvedValue as any)();
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "Hello"));

      expect((adapter as any).sendDraft).toHaveBeenCalled();
      expect(adapter.sendBlockReply).not.toHaveBeenCalled();
      const draftIds = (adapter as any).sendDraft.mock.calls.map(call => call[2]?.draftId);
      expect(new Set(draftIds).size).toBe(1);
    });

    it("prefers Telegram rich draft streaming when the rich switch is enabled", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      (adapter as any).richStreamingCapabilities = {
        mode: "rich_draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 32768,
        requiresRichStreaming: true,
      };
      (adapter as any).streamingCapabilities = {
        mode: "draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 4096,
      };
      (adapter as any).sendRichDraft = (vi.fn().mockResolvedValue as any)();
      (adapter as any).sendRichReply = (vi.fn().mockResolvedValue as any)();
      (adapter as any).sendDraft = (vi.fn().mockResolvedValue as any)();
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("**Hel", "**Hel");
        opts.onDelta("lo**", "**Hello**");
        return bridgeReply("**Hello**");
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect((adapter as any).sendRichReply).toHaveBeenCalledWith(
        "owner123",
        "**Hello**",
        expect.any(Object),
      ));

      expect((adapter as any).sendRichDraft).toHaveBeenCalled();
      expect((adapter as any).sendDraft).not.toHaveBeenCalled();
      expect(adapter.sendReply).not.toHaveBeenCalledWith("owner123", "**Hello**");
    });

    it("falls back from Telegram rich drafts to the legacy draft capability when rich streaming is disabled", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      engine.getBridgeRichStreamingEnabled.mockReturnValue(false);
      (adapter as any).richStreamingCapabilities = {
        mode: "rich_draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 32768,
        requiresRichStreaming: true,
      };
      (adapter as any).streamingCapabilities = {
        mode: "draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 4096,
      };
      (adapter as any).sendRichDraft = (vi.fn().mockResolvedValue as any)();
      (adapter as any).sendRichReply = (vi.fn().mockResolvedValue as any)();
      (adapter as any).sendDraft = (vi.fn().mockResolvedValue as any)();
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "Hello"));

      expect((adapter as any).sendRichDraft).not.toHaveBeenCalled();
      expect((adapter as any).sendRichReply).not.toHaveBeenCalled();
      expect((adapter as any).sendDraft).toHaveBeenCalled();
    });

    it("updates one Feishu stream message instead of sending block replies", async () => {
      const { bm, hub, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      const feishuAdapter = {
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
        },
        startStreamReply: vi.fn().mockResolvedValue({ messageId: "om_stream_001" }),
        updateStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.finishStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hello",
        expect.any(Object),
      ));

      expect(feishuAdapter.startStreamReply).toHaveBeenCalledWith("oc_chat", "Hel", expect.any(Object));
      expect(feishuAdapter.updateStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hello",
        expect.any(Object),
      );
      expect(feishuAdapter.sendBlockReply).not.toHaveBeenCalled();
      expect(feishuAdapter.sendReply).not.toHaveBeenCalledWith("oc_chat", "Hello");
    });

    it("prefers Feishu CardKit rich streaming when the rich switch is enabled", async () => {
      const { bm, hub, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      const feishuAdapter = {
        richStreamingCapabilities: {
          mode: "cardkit_stream",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          requiresRichStreaming: true,
          receiptMode: "fold_into_stream",
        },
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
        },
        startRichStreamReply: vi.fn().mockResolvedValue({ cardId: "card_stream_001" }),
        updateRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        startStreamReply: vi.fn().mockResolvedValue({ messageId: "om_stream_001" }),
        updateStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.finishRichStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { cardId: "card_stream_001" },
        "Hello",
        expect.any(Object),
      ));

      expect(feishuAdapter.startRichStreamReply).toHaveBeenCalledWith("oc_chat", "Hel", expect.any(Object));
      expect(feishuAdapter.updateRichStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { cardId: "card_stream_001" },
        "Hello",
        expect.any(Object),
      );
      expect(feishuAdapter.startStreamReply).not.toHaveBeenCalled();
      expect(feishuAdapter.sendReply).not.toHaveBeenCalledWith("oc_chat", "Hello");
    });

    it("finalizes Feishu CardKit receipts with a user-safe failure when generation has no body", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        richStreamingCapabilities: {
          mode: "cardkit_stream",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          requiresRichStreaming: true,
          receiptMode: "fold_into_stream",
        },
        startRichStreamReply: vi.fn().mockResolvedValue({ cardId: "card_stream_001" }),
        updateRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockResolvedValue({ text: "", toolMedia: [], error: "provider timeout", truncated: false });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.finishRichStreamReply).toHaveBeenCalledOnce());
      const finalText = feishuAdapter.finishRichStreamReply.mock.calls[0][2];
      expect(finalText).not.toContain("正在输入");
      expect(finalText).toContain("失败");
      expect(feishuAdapter.sendReply).not.toHaveBeenCalled();
    });

    it("falls back to a normal Feishu message when CardKit finalization fails", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        richStreamingCapabilities: {
          mode: "cardkit_stream",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          requiresRichStreaming: true,
          receiptMode: "fold_into_stream",
        },
        startRichStreamReply: vi.fn().mockResolvedValue({ cardId: "card_stream_001" }),
        updateRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishRichStreamReply: vi.fn().mockRejectedValue(new Error("CardKit unavailable")),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_chat", "Hello"));
      expect(feishuAdapter.finishRichStreamReply).toHaveBeenCalledOnce();
      expect(bridgeDebugMock.error).toHaveBeenCalledWith(
        "bridge",
        expect.stringContaining("platform=feishu mode=cardkit_stream chatId=oc_chat stage=finish error=CardKit unavailable"),
      );
      expect(bm._processing.has("fs_dm_owner123@hana")).toBe(false);
    });

    it("logs Feishu edit-message update failures and falls back to a normal message", async () => {
      const { bm, hub, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      const feishuAdapter = {
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          renderer: "post",
          receiptMode: "fold_into_stream",
        },
        startStreamReply: vi.fn().mockResolvedValue({ messageId: "om_stream_001" }),
        updateStreamReply: vi.fn().mockRejectedValue(new Error("update denied")),
        finishStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_chat", "Hello"));

      expect(feishuAdapter.finishStreamReply).not.toHaveBeenCalled();
      expect(bridgeDebugMock.error).toHaveBeenCalledWith(
        "bridge",
        expect.stringContaining("platform=feishu mode=edit_message chatId=oc_chat stage=update error=update denied"),
      );
    });

    it("logs CardKit start and fallback-send failures", async () => {
      const { bm, hub, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      const feishuAdapter = {
        richStreamingCapabilities: {
          mode: "cardkit_stream",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          requiresRichStreaming: true,
          receiptMode: "fold_into_stream",
        },
        startRichStreamReply: vi.fn().mockRejectedValue(new Error("CardKit start denied")),
        updateRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: vi.fn().mockRejectedValue(new Error("plain send denied")),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_chat", "Hello"));

      expect(bridgeDebugMock.error).toHaveBeenCalledWith(
        "bridge",
        expect.stringContaining("platform=feishu mode=cardkit_stream chatId=oc_chat stage=start error=CardKit start denied"),
      );
      expect(bridgeDebugMock.error).toHaveBeenCalledWith(
        "bridge",
        expect.stringContaining("platform=feishu mode=cardkit_stream chatId=oc_chat stage=finish:fallback error=plain send denied"),
      );
    });

    it("folds Feishu waiting receipts into the edit-message stream lifecycle", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          renderer: "post",
          receiptMode: "fold_into_stream",
        },
        startStreamReply: vi.fn().mockResolvedValue({ messageId: "om_stream_001" }),
        updateStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockImplementation(async (_text, opts) => {
        opts.onDelta("Hel", "Hel");
        opts.onDelta("lo", "Hello");
        return bridgeReply("Hello");
      });

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(feishuAdapter.finishStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hello",
        expect.any(Object),
      ));

      expect(feishuAdapter.sendReply).not.toHaveBeenCalledWith("oc_chat", "（TestAgent正在输入...）", expect.anything());
      expect(feishuAdapter.startStreamReply).toHaveBeenCalledTimes(1);
      expect(feishuAdapter.startStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        "（TestAgent正在输入...）",
        expect.any(Object),
      );
      expect(feishuAdapter.updateStreamReply).toHaveBeenCalledWith(
        "oc_chat",
        { messageId: "om_stream_001" },
        "Hel",
        expect.any(Object),
      );
    });

    it("falls back to a normal Feishu message when a created stream has no message id", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        streamingCapabilities: {
          mode: "edit_message",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          renderer: "post",
          receiptMode: "fold_into_stream",
        },
        startStreamReply: vi.fn().mockResolvedValue({ messageId: null, missingMessageId: true }),
        updateStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockResolvedValue(bridgeReply("Hello"));

      bm._handleMessage("feishu", {
        sessionKey: "fs_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "oc_chat",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

      expect(feishuAdapter.startStreamReply).toHaveBeenCalledTimes(1);
      expect(feishuAdapter.finishStreamReply).not.toHaveBeenCalled();
      expect(feishuAdapter.sendReply).toHaveBeenCalledWith("oc_chat", "Hello");
    });

    it("fails an RC-attached Feishu CardKit receipt when the desktop session returns only an error", async () => {
      const { bm, hub } = createMocks();
      const feishuAdapter = {
        richStreamingCapabilities: {
          mode: "cardkit_stream",
          scopes: ["dm"],
          minIntervalMs: 0,
          maxChars: 150_000,
          requiresRichStreaming: true,
          receiptMode: "fold_into_stream",
        },
        startRichStreamReply: vi.fn().mockResolvedValue({ cardId: "card_stream_001" }),
        updateRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        finishRichStreamReply: (vi.fn().mockResolvedValue as any)(),
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      };
      bm._platforms.set("feishu:hana", { adapter: feishuAdapter, status: "connected", agentId: "hana", platform: "feishu" });
      hub.send.mockResolvedValue({ text: "", toolMedia: [], error: "provider timeout", truncated: false });

      await bm._flushAttachedDesktopSession({
        sessionKey: "fs_dm_owner123@hana",
        desktopSessionPath: "/tmp/desktop-session.jsonl",
        platform: "feishu",
        chatId: "oc_chat",
        agentId: "hana",
        text: "hi",
        images: [],
        inboundFiles: [],
        alreadyLocked: false,
      });

      await vi.waitFor(() => expect(feishuAdapter.finishRichStreamReply).toHaveBeenCalledOnce());
      const finalText = feishuAdapter.finishRichStreamReply.mock.calls[0][2];
      expect(finalText).toContain("失败");
      expect(finalText).not.toContain("provider timeout");
      expect(bm._processing.has("fs_dm_owner123@hana")).toBe(false);
    });

    it("does not use legacy block streaming without an explicit streaming capability", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      bm.blockStreaming = true;
      hub.send.mockImplementation(async (_text, opts) => {
        expect(opts.onDelta).toBeUndefined();
        return bridgeReply("final only");
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(adapter.sendBlockReply).not.toHaveBeenCalled();
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "final only");
    });

    it("falls back to batch when a rich-only streaming capability is disabled globally", async () => {
      const { bm, hub, adapter, engine } = createMocks();
      engine.getBridgeReceiptEnabled.mockReturnValue(false);
      engine.getBridgeRichStreamingEnabled.mockReturnValue(false);
      (adapter as any).streamingCapabilities = {
        mode: "draft",
        scopes: ["dm"],
        minIntervalMs: 0,
        maxChars: 4096,
        requiresRichStreaming: true,
      };
      (adapter as any).sendDraft = (vi.fn().mockResolvedValue as any)();
      hub.send.mockImplementation(async (_text, opts) => {
        expect(opts.onDelta).toBeUndefined();
        return bridgeReply("compatible final");
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect((adapter as any).sendDraft).not.toHaveBeenCalled();
      expect(adapter.sendReply).toHaveBeenCalledWith("owner123", "compatible final");
    });
  });

  // ── Reply error layering (#1607) ──

  describe("reply error layering (#1607)", () => {
    it("sends partial text first plus a brief interruption note, never the raw error string", async () => {
      const { bm, hub, adapter } = createMocks();
      hub.send.mockResolvedValue({
        text: "我查到一半的内容",
        toolMedia: [],
        error: "terminated",
        truncated: true,
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      const replies = adapter.sendReply.mock.calls.map((c) => c[1]);
      expect(replies).toContain("我查到一半的内容");
      const bodyIndex = replies.indexOf("我查到一半的内容");
      const noteIndex = replies.findIndex((r) => /回复中断/.test(r));
      expect(noteIndex).toBeGreaterThan(bodyIndex);
      expect(replies.some((r) => /\[Error\]/.test(r))).toBe(false);
      expect(replies.some((r) => /terminated/.test(r))).toBe(false);
    });

    it("sends a human-readable failure notice when no text was generated", async () => {
      const { bm, hub, adapter } = createMocks();
      hub.send.mockResolvedValue({
        text: null,
        toolMedia: [],
        error: "terminated",
        truncated: false,
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      const replies = adapter.sendReply.mock.calls.map((c) => c[1]);
      expect(replies.some((r) => /回复生成失败/.test(r))).toBe(true);
      expect(replies.some((r) => /\[Error\]/.test(r))).toBe(false);
      expect(replies.some((r) => /terminated/.test(r))).toBe(false);
    });

    it("sends nothing extra for a clean reply without error", async () => {
      const { bm, hub, adapter } = createMocks();
      hub.send.mockResolvedValue({
        text: "一切正常的回复",
        toolMedia: [],
        error: null,
        truncated: false,
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hi",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      const replies = adapter.sendReply.mock.calls.map((c) => c[1]);
      expect(replies).toContain("一切正常的回复");
      expect(replies.some((r) => /回复中断|回复生成失败/.test(r))).toBe(false);
    });
  });

  // ── Abort ──

  describe("abort on new message", () => {
    it("uses steer (not abort) when session is streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      // streaming 时 debounce 缩短到 1s（steer 路径），不 abort
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });

    it("does not steer if session is not streaming", async () => {
      const { bm, engine } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "new msg",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
    });
  });

  // ── /stop command ──

  describe("/stop command", () => {
    it("aborts active session and clears pending buffer", async () => {
      const { bm, engine, hub } = createMocks();
      engine.abortBridgeSession.mockResolvedValue(true);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "/stop",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      expect(engine.abortBridgeSession).toHaveBeenCalledWith("tg_dm_owner123@hana");

      await vi.advanceTimersByTimeAsync(3000);
      expect(hub.send).not.toHaveBeenCalled();
    });

    it("non-owner /slash-like text flows to LLM as plain text (Phase 2-F: guest slash not eaten by dispatcher)", async () => {
      // 新 spec：guest 发的 /stop 不再被 dispatcher 静默吞掉——直接当文本进 LLM，
      // agent 可以正常回应。这样群里的其他人发 /xxx 不会像消息消失一样。
      const { bm, engine, hub, adapter } = createMocks();
      engine.isBridgeSessionStreaming.mockReturnValue(false);

      await bm._handleMessage("telegram", {
        sessionKey: "tg_dm_stranger@hana",
        text: "/stop",
        senderName: "Stranger",
        userId: "stranger",  // 非 owner（config.bridge.telegram.owner === "owner123"）
        chatId: "stranger",
        agentId: "hana",
      });

      // abort 不应被调用（不是真正的斜杠命令路径）
      expect(engine.abortBridgeSession).not.toHaveBeenCalled();
      // 2s debounce 后，消息进 LLM
      await vi.advanceTimersByTimeAsync(2100);
      expect(hub.send).toHaveBeenCalledOnce();
      // hub.send 的 text 参数包含 "/stop" 原文（会带 timeTag 前缀和 sender prefix）
      expect(hub.send.mock.calls[0][0]).toContain("/stop");
      // agent 的回复送回 adapter
      await vi.waitFor(() => expect(adapter.sendReply).toHaveBeenCalled());
    });

    it("treats a QQ principal alias as owner for slash dispatch", async () => {
      const { bm, engine, hub } = createMocks();
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") {
          return {
            agentName: "TestAgent",
            config: { bridge: { qq: { owner: "c2c-openid" } } },
            sessionDir: os.tmpdir(),
          };
        }
        return null;
      });
      engine.abortBridgeSession.mockResolvedValue(true);
      bm._platforms.set("qq:hana", {
        adapter: {
          sendReply: (vi.fn().mockResolvedValue as any)(),
          sendBlockReply: (vi.fn().mockResolvedValue as any)(),
          sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
          stop: vi.fn(),
        },
        status: "connected",
        agentId: "hana",
        platform: "qq",
      });

      await bm._handleMessage("qq", {
        sessionKey: "qq_dm_c2c-openid@hana",
        text: "/stop",
        senderName: "QQ stable",
        userId: "stable-user-id",
        chatId: "c2c-openid",
        qqPrincipal: {
          principalId: "stable-user-id",
          aliases: ["stable-user-id", "c2c-openid"],
        },
        isGroup: false,
        agentId: "hana",
      });

      expect(engine.abortBridgeSession).toHaveBeenCalledWith("qq_dm_c2c-openid@hana");
      expect(hub.send).not.toHaveBeenCalled();
    });
  });

  it("carries QQ principal metadata into bridge session writes", async () => {
    const { bm, engine, hub } = createMocks();
    engine.getAgent.mockImplementation((id) => {
      if (id === "hana") {
        return {
          agentName: "TestAgent",
          config: { bridge: { qq: { owner: "c2c-openid" } } },
          sessionDir: os.tmpdir(),
        };
      }
      return null;
    });
    bm._platforms.set("qq:hana", {
      adapter: {
        sendReply: (vi.fn().mockResolvedValue as any)(),
        sendBlockReply: (vi.fn().mockResolvedValue as any)(),
        sendTypingIndicator: (vi.fn().mockResolvedValue as any)(),
        stop: vi.fn(),
      },
      status: "connected",
      agentId: "hana",
      platform: "qq",
    });

    const qqPrincipal = {
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "c2c-openid"],
      fallbackName: "QQ stab…r-id",
    };

    await bm._handleMessage("qq", {
      sessionKey: "qq_dm_c2c-openid@hana",
      text: "hello",
      senderName: "QQ stab…r-id",
      userId: "stable-user-id",
      chatId: "c2c-openid",
      qqPrincipal,
      isGroup: false,
      agentId: "hana",
    });

    await vi.advanceTimersByTimeAsync(2100);

    expect(hub.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({
          userId: "stable-user-id",
          chatId: "c2c-openid",
          qqPrincipal,
        }),
      }),
    );
  });

  // ── Agent isolation ──

  describe("agent isolation via sessionKey", () => {
    it("same userId with different agentId produces different sessionKeys", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: (vi.fn().mockResolvedValue as any)(), sendBlockReply: (vi.fn().mockResolvedValue as any)(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "msg to hana",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "msg to kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Both messages should have been sent with their respective sessionKeys
      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@hana" }),
      );
      expect(hub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "tg_dm_owner123@kuro" }),
      );
    });

    it("messages are properly isolated between agents (debounce per sessionKey)", async () => {
      const { bm, hub, engine } = createMocks();
      // Register a second agent adapter
      const kuroAdapter = { sendReply: (vi.fn().mockResolvedValue as any)(), sendBlockReply: (vi.fn().mockResolvedValue as any)(), stop: vi.fn() };
      bm._platforms.set("telegram:kuro", { adapter: kuroAdapter, status: "connected", agentId: "kuro", platform: "telegram" });
      engine.getAgent.mockImplementation((id) => {
        if (id === "hana") return { agentName: "TestAgent", config: { bridge: { telegram: { owner: "owner123" } } } };
        if (id === "kuro") return { agentName: "Kuro", config: { bridge: { telegram: { owner: "owner123" } } } };
        return null;
      });

      // Send two messages with different agentIds — they should NOT merge
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "hello hana",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@kuro",
        text: "hello kuro",
        userId: "owner123",
        chatId: "owner123",
        agentId: "kuro",
      });

      await vi.advanceTimersByTimeAsync(2100);

      // Each agent gets its own message, not merged
      expect(hub.send).toHaveBeenCalledTimes(2);
      const calls = hub.send.mock.calls;
      const hanaCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@hana");
      const kuroCall = calls.find(c => c[1].sessionKey === "tg_dm_owner123@kuro");
      expect(hanaCall[0]).toMatch(/hello hana/);
      expect(kuroCall[0]).toMatch(/hello kuro/);
      // Neither message contains the other agent's text
      expect(hanaCall[0]).not.toMatch(/hello kuro/);
      expect(kuroCall[0]).not.toMatch(/hello hana/);
    });
  });

  // ── Processing lock ──

  describe("processing lock", () => {
    it("prevents concurrent _flushPending for same sessionKey", async () => {
      const { bm, hub } = createMocks();

      let resolveFirst;
      hub.send.mockImplementationOnce(() =>
        new Promise((r) => { resolveFirst = r; })
      );

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "msg1",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      bm._handleMessage("telegram", {
        sessionKey: "tg_dm_owner123@hana",
        text: "msg2",
        userId: "owner123",
        chatId: "owner123",
        agentId: "hana",
      });
      await vi.advanceTimersByTimeAsync(2100);

      expect(hub.send).toHaveBeenCalledOnce();

      resolveFirst(bridgeReply("response 1"));
      await vi.advanceTimersByTimeAsync(600);

      expect(hub.send).toHaveBeenCalledTimes(2);
      expect(hub.send).toHaveBeenLastCalledWith(tagged("msg2"), expect.any(Object));
    });
  });
});
