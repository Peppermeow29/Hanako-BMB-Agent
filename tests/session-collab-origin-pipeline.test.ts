import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  MESSAGE_ORIGIN_RECORD_TYPE,
  recordMessageOriginEntry,
} from "../core/desktop-session-submit.ts";
import {
  annotateOriginMessages,
  loadSessionHistoryMessages,
} from "../core/message-utils.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-origin-pipeline-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("annotateOriginMessages", () => {
  it("把 origin custom 消息注释到其后第一条 user 消息，并从输出中移除该 custom 消息", () => {
    const messages = [
      {
        role: "custom",
        customType: MESSAGE_ORIGIN_RECORD_TYPE,
        data: {
          source: "agent_session",
          origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
          displayText: "干净正文",
        },
      },
      { role: "user", content: [{ type: "text", text: "raw text" }] },
    ];

    const result = annotateOriginMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
      displayText: "干净正文",
    });
    expect(result.some(m => m.role === "custom" && m.customType === MESSAGE_ORIGIN_RECORD_TYPE)).toBe(false);
  });

  it("中间隔着 assistant 消息也能注释到「其后第一条 user」", () => {
    const messages = [
      {
        role: "custom",
        customType: MESSAGE_ORIGIN_RECORD_TYPE,
        data: {
          source: "agent_session",
          origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
          displayText: "干净正文",
        },
      },
      { role: "assistant", content: [{ type: "text", text: "在途输出" }] },
      { role: "user", content: [{ type: "text", text: "raw text" }] },
    ];

    const result = annotateOriginMessages(messages);

    expect(result.map(m => m.role)).toEqual(["assistant", "user"]);
    const userMsg = result.find(m => m.role === "user");
    expect(userMsg).toMatchObject({
      origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
      displayText: "干净正文",
    });
  });

  it("无 origin 字段的老载荷：custom 条目被移除但 user 消息不加 origin（读时兼容）", () => {
    const messages = [
      {
        role: "custom",
        customType: MESSAGE_ORIGIN_RECORD_TYPE,
        data: { source: "bridge", bridgeSessionKey: "tg:1", timestamp: 1 },
      },
      { role: "user", content: [{ type: "text", text: "raw text" }] },
    ];

    const result = annotateOriginMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0]).not.toHaveProperty("origin");
    expect(result[0]).not.toHaveProperty("displayText");
  });

  it("普通消息数组原样通过", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const result = annotateOriginMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(result[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });
});

describe("recordMessageOriginEntry", () => {
  it("displayMessage 带 origin 时，载荷含 origin 与 displayText", () => {
    const appendCustomEntry = vi.fn();
    const session = { sessionManager: { appendCustomEntry } };
    const displayMessage = {
      source: "agent_session",
      text: "干净正文",
      origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
    };

    recordMessageOriginEntry(session, "/tmp/desk.jsonl", displayMessage);

    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    const [customType, payload] = appendCustomEntry.mock.calls[0];
    expect(customType).toBe(MESSAGE_ORIGIN_RECORD_TYPE);
    expect(payload).toMatchObject({
      source: "agent_session",
      origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
      displayText: "干净正文",
    });
  });

  it("displayMessage 无 origin 时，载荷不含 origin/displayText 键（老行为不变）", () => {
    const appendCustomEntry = vi.fn();
    const session = { sessionManager: { appendCustomEntry } };
    const displayMessage = { source: "bridge", bridgeSessionKey: "tg:1" };

    recordMessageOriginEntry(session, "/tmp/desk.jsonl", displayMessage);

    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    const [, payload] = appendCustomEntry.mock.calls[0];
    expect(payload).not.toHaveProperty("origin");
    expect(payload).not.toHaveProperty("displayText");
    expect(payload).toMatchObject({ source: "bridge", bridgeSessionKey: "tg:1" });
  });

  it("source 为 desktop 时不写条目（既有 gate 不变）", () => {
    const appendCustomEntry = vi.fn();
    const session = { sessionManager: { appendCustomEntry } };

    recordMessageOriginEntry(session, "/tmp/desk.jsonl", { source: "desktop", text: "hi" });

    expect(appendCustomEntry).not.toHaveBeenCalled();
  });
});

describe("MESSAGE_ORIGIN_RECORD_TYPE 历史白名单", () => {
  it("loadSessionHistoryMessages 输出含 hana-message-origin 的 custom 消息", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    // Pi SDK 在有 assistant 消息前不落盘（session-manager.js _persist 的
    // hasAssistant 门禁），先写一条 assistant 消息让文件真正 flush 到磁盘。
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "before" }] } as any);
    manager.appendCustomEntry(MESSAGE_ORIGIN_RECORD_TYPE, {
      source: "agent_session",
      origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
      displayText: "干净正文",
      timestamp: 1,
    });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "raw text" }] } as any);

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      role: "custom",
      customType: MESSAGE_ORIGIN_RECORD_TYPE,
      data: {
        source: "agent_session",
        origin: { kind: "agent", agentId: "hana", agentName: "Hana" },
        displayText: "干净正文",
      },
      display: false,
    });
  });
});
