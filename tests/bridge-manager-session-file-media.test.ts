import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
// 期望值必须与生产代码同一条规范化路径（native realpath 会展开 Windows 8.3
// 短名，JS 版 fs.realpathSync 不会；CI runner 的 TEMP 恰好是短名形式）。
import { canonicalFilesystemPathSync } from "../shared/link-aware-fs.ts";

vi.mock("../lib/bridge/feishu-adapter.js", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.js", () => ({ createWechatAdapter: vi.fn() }));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

const TELEGRAM_CAPS = {
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
};
const QQ_CAPS = {
  inputModes: ["local_file", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
};

describe("BridgeManager session_file media delivery", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeManager(sessionFile) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      getSessionFile: vi.fn((id) => id === sessionFile?.id ? sessionFile : null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    return new BridgeManager({ engine, hub });
  }

  it("sends a session_file through sendMediaBuffer on buffer-capable platforms", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const filePath = path.join(tmpDir, "image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    const sessionFile = {
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    };
    const bm = makeManager(sessionFile);
    const adapter = {
      mediaCapabilities: TELEGRAM_CAPS,
      sendMediaBuffer: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };

    await bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_image" }, { platform: "telegram" });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(Buffer.isBuffer(adapter.sendMediaBuffer.mock.calls[0][1])).toBe(true);
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("sends QQ local staged files through direct local file upload", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const filePath = path.join(tmpDir, "image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const bm = makeManager({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: QQ_CAPS,
      sendMediaFile: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };

    await bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_image" }, { platform: "qq" });

    expect(adapter.sendMediaFile).toHaveBeenCalledWith("chat-1", canonicalFilesystemPathSync(filePath), {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("sends QQ staged images through publicUrl when available", async () => {
    const bm = makeManager({
      id: "sf_public",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_CAPS,
      sendMediaBuffer: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };

    await bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_public" }, { platform: "qq" });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("sends deferred_result sessionFiles to the originating bridge chat", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const sessionPath = path.join(tmpDir, "bridge-session.jsonl");
    const filePath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    const sessionFile = {
      id: "sf_generated",
      sessionPath,
      filePath,
      realPath: filePath,
      filename: "generated.png",
      mime: "image/png",
      kind: "image",
    };
    let subscribed = null;
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      agentName: "Hana",
      deferredResults: {
        markDelivered: vi.fn(),
      },
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionFile: vi.fn((id) => id === "sf_generated" ? sessionFile : null),
      getBridgeContextForSessionPath: vi.fn((sp) => sp === sessionPath ? {
        isBridgeSession: true,
        platform: "telegram",
        chatType: "dm",
        chatId: "chat-1",
        sessionKey: "tg_dm_chat-1@agent-a",
        agentId: "agent-a",
      } : null),
    };
    const hub = {
      subscribe: vi.fn((fn) => {
        subscribed = fn;
        return vi.fn();
      }),
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });
    const adapter = {
      mediaCapabilities: TELEGRAM_CAPS,
      sendMediaBuffer: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };
    bm._platforms.set("telegram:agent-a", {
      platform: "telegram",
      agentId: "agent-a",
      status: "connected",
      adapter,
    });

    subscribed({
      type: "deferred_result",
      taskId: "task_1",
      status: "success",
      result: { sessionFiles: [sessionFile] },
    }, sessionPath);
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(engine.deferredResults.markDelivered).toHaveBeenCalledWith("task_1");
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(Buffer.isBuffer(adapter.sendMediaBuffer.mock.calls[0][1])).toBe(true);
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "generated.png",
      isGroup: false,
      targetScope: "dm",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("deduplicates repeated deferred_result media events by task id", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const sessionPath = path.join(tmpDir, "bridge-session.jsonl");
    const filePath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    const sessionFile = {
      id: "sf_generated",
      sessionPath,
      filePath,
      realPath: filePath,
      filename: "generated.png",
      mime: "image/png",
      kind: "image",
    };
    let subscribed = null;
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      agentName: "Hana",
      deferredResults: {
        markDelivered: vi.fn(),
      },
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionFile: vi.fn((id) => id === "sf_generated" ? sessionFile : null),
      getBridgeContextForSessionPath: vi.fn((sp) => sp === sessionPath ? {
        isBridgeSession: true,
        platform: "telegram",
        chatType: "dm",
        chatId: "chat-1",
        sessionKey: "tg_dm_chat-1@agent-a",
        agentId: "agent-a",
      } : null),
    };
    const hub = {
      subscribe: vi.fn((fn) => {
        subscribed = fn;
        return vi.fn();
      }),
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });
    const adapter = {
      mediaCapabilities: TELEGRAM_CAPS,
      sendMediaBuffer: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };
    bm._platforms.set("telegram:agent-a", {
      platform: "telegram",
      agentId: "agent-a",
      status: "connected",
      adapter,
    });
    const event = {
      type: "deferred_result",
      taskId: "task_1",
      status: "success",
      result: { sessionFiles: [sessionFile] },
    };

    subscribed(event, sessionPath);
    subscribed(event, sessionPath);
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.sendMediaBuffer).toHaveBeenCalledTimes(1);
    expect(engine.deferredResults.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("sends bridge deferred failure events back as text and marks them delivered", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-failure-"));
    const sessionPath = path.join(tmpDir, "bridge-session.jsonl");
    let subscribed = null;
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      agentName: "Hana",
      deferredResults: {
        markDelivered: vi.fn(),
      },
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getBridgeContextForSessionPath: vi.fn((sp) => sp === sessionPath ? {
        isBridgeSession: true,
        platform: "qq",
        chatType: "group",
        chatId: "group-1",
        sessionKey: "qq_group_group-1@agent-a",
        agentId: "agent-a",
      } : null),
    };
    const hub = {
      subscribe: vi.fn((fn) => {
        subscribed = fn;
        return vi.fn();
      }),
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });
    const adapter = {
      sendReply: (vi.fn().mockResolvedValue as any)(),
    };
    bm._platforms.set("qq:agent-a", {
      platform: "qq",
      agentId: "agent-a",
      status: "connected",
      adapter,
    });

    subscribed({
      type: "deferred_result",
      taskId: "task_fail_1",
      status: "failed",
      reason: "provider quota exceeded",
      meta: {
        type: "image-generation",
        deliveryTarget: {
          kind: "bridge",
          platform: "qq",
          chatId: "group-1",
          sessionKey: "qq_group_group-1@agent-a",
          agentId: "agent-a",
          chatType: "group",
        },
      },
    }, sessionPath);
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.sendReply).toHaveBeenCalledWith(
      "group-1",
      expect.stringContaining("provider quota exceeded"),
      expect.objectContaining({ isGroup: true, targetScope: "group" }),
    );
    expect(engine.deferredResults.markDelivered).toHaveBeenCalledWith("task_fail_1");
  });

  it("sends deferred_result sessionFiles to an attached RC bridge target", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const sessionPath = path.join(tmpDir, "desktop-session.jsonl");
    const filePath = path.join(tmpDir, "desktop-generated.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    const sessionFile = {
      id: "sf_rc_generated",
      sessionPath,
      filePath,
      realPath: filePath,
      filename: "desktop-generated.png",
      mime: "image/png",
      kind: "image",
    };
    let subscribed = null;
    const rcState = {
      getAttachedBridgeSessionKey: vi.fn((sp) => sp === sessionPath ? "tg_dm_chat-1@agent-a" : null),
      getAttachment: vi.fn(() => ({
        platform: "telegram",
        agentId: "agent-a",
        chatId: "chat-1",
        messageThreadId: "thread-1",
      })),
    };
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      agentName: "Hana",
      rcState,
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionFile: vi.fn((id) => id === "sf_rc_generated" ? sessionFile : null),
      getBridgeContextForSessionPath: vi.fn(() => null),
    };
    const hub = {
      subscribe: vi.fn((fn) => {
        subscribed = fn;
        return vi.fn();
      }),
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });
    const adapter = {
      mediaCapabilities: TELEGRAM_CAPS,
      sendMediaBuffer: (vi.fn().mockResolvedValue as any)(),
      sendMedia: (vi.fn().mockResolvedValue as any)(),
    };
    bm._platforms.set("telegram:agent-a", {
      platform: "telegram",
      agentId: "agent-a",
      status: "connected",
      adapter,
    });

    subscribed({
      type: "deferred_result",
      taskId: "task_rc_1",
      status: "success",
      result: { sessionFiles: [sessionFile] },
    }, sessionPath);
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "desktop-generated.png",
      isGroup: false,
      targetScope: "dm",
      replyContext: {
        messageThreadId: "thread-1",
        isGroup: false,
        targetScope: "dm",
      },
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });
});
