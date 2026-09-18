import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../core/llm-utils.js", () => ({
  isToolCallBlock: (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name,
  getToolArgs: (b) => b.input || b.arguments,
}));

import {
  TOOL_ARG_SUMMARY_KEYS,
  stripThinkTags,
  extractTextContent,
  loadSessionHistoryMessages,
  loadLatestAssistantSummaryFromSessionFile,
  filterUnreferencedInlineImages,
  isValidSessionPath,
  isActiveSessionPath,
  isActiveDesktopSessionPath,
  isArchivedDesktopSessionPath,
  isDesktopSessionPath,
} from "../core/message-utils.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { TURN_INPUT_CONSUMPTION_EVENT_TYPE } from "../lib/turn-input-presentation.ts";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-message-utils-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TOOL_ARG_SUMMARY_KEYS", () => {
  it("存在并包含常用字段", () => {
    expect(Array.isArray(TOOL_ARG_SUMMARY_KEYS)).toBe(true);
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("file_path");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("command");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("cmd");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("chars");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("process_id");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("url");
  });
});

describe("stripThinkTags", () => {
  it("提取并剥离 think 标签", () => {
    const input = "<think>inner thought</think>\nactual text";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner thought");
  });

  it("无 think 标签时原样返回", () => {
    const { text, thinkContent } = stripThinkTags("plain text");
    expect(text).toBe("plain text");
    expect(thinkContent).toBe("");
  });

  it("多个 think 块合并", () => {
    const input = "<think>A</think>\n<think>B</think>\nresult";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("result");
    expect(thinkContent).toBe("A\nB");
  });
});

describe("extractTextContent", () => {
  it("字符串输入直接返回", () => {
    const result = extractTextContent("hello world");
    expect(result.text).toBe("hello world");
    expect(result.thinking).toBe("");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("字符串输入 + stripThink 剥离 think 标签", () => {
    const result = extractTextContent("<think>inner</think>\nresult", { stripThink: true });
    expect(result.text.trim()).toBe("result");
    expect(result.thinking).toBe("inner");
  });

  it("null/undefined 输入返回空结构", () => {
    const nullResult = extractTextContent(null);
    expect(nullResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });

    const undefinedResult = extractTextContent(undefined);
    expect(undefinedResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });
  });

  it("content block 数组提取文本", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("hello world");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("过滤 OpenAI Responses commentary 文本，只把 final_answer 当正文", () => {
    const content = [
      {
        type: "text",
        text: "I need to inspect the current status before deciding.",
        textSignature: JSON.stringify({
          v: 1,
          id: "msg_commentary",
          phase: "commentary",
        }),
      },
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "current_status",
        arguments: { action: "read", key: "ui_context" },
      },
      {
        type: "text",
        text: "已经查到当前状态。",
        textSignature: JSON.stringify({
          v: 1,
          id: "msg_final",
          phase: "final_answer",
        }),
      },
    ];

    const result = extractTextContent(content);
    expect(result.text).toBe("已经查到当前状态。");
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      id: "call_1|fc_1",
      name: "current_status",
      args: { action: "read", key: "ui_context" },
    });
  });

  it("content block 数组提取 thinking block", () => {
    const content = [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "my thoughts" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("answer");
    expect(result.thinking).toBe("my thoughts");
  });

  it("content block 数组提取 tool_use block", () => {
    const content = [
      { type: "tool_use", id: "call_read_1", name: "read_file", input: { file_path: "/tmp/test.txt", extra: "ignored" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].id).toBe("call_read_1");
    expect(result.toolUses[0].name).toBe("read_file");
    expect(result.toolUses[0].args).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("content block 数组提取 exec_command / write_stdin 命令摘要", () => {
    const content = [
      { type: "toolCall", id: "call_exec_1", name: "exec_command", arguments: { cmd: "npm test", secret: "nope" } },
      { type: "tool_use", id: "call_stdin_1", name: "write_stdin", input: { process_id: "term_1", chars: "q\n", secret: "nope" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses).toHaveLength(2);
    expect(result.toolUses[0]).toMatchObject({
      id: "call_exec_1",
      name: "exec_command",
      args: { cmd: "npm test" },
    });
    expect(result.toolUses[1]).toMatchObject({
      id: "call_stdin_1",
      name: "write_stdin",
      args: { chars: "q\n", process_id: "term_1" },
    });
  });

  it("tool_use block 无摘要字段时 args 为 undefined", () => {
    const content = [
      { type: "tool_use", name: "some_tool", input: { nonSummaryKey: "value" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses[0].args).toBeUndefined();
  });

  it("content block 数组提取 image block（source.data 格式）", () => {
    const content = [
      {
        type: "image",
        source: { data: "base64data", media_type: "image/jpeg" },
      },
    ];
    const result = extractTextContent(content);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe("base64data");
    expect(result.images[0].mimeType).toBe("image/jpeg");
  });
});

describe("filterUnreferencedInlineImages", () => {
  it("不把已有 attached_image 路径引用覆盖的图片 base64 返回给历史接口", () => {
    const images = [
      { data: "BASE64_A", mimeType: "image/png" },
      { data: "BASE64_B", mimeType: "image/png" },
    ];

    expect(filterUnreferencedInlineImages(
      "[attached_image: /tmp/a.png]\n[attached_image: /tmp/b.png]\ncompare",
      images,
    )).toEqual([]);
  });

  it("保留没有路径引用的 legacy inline 图片", () => {
    const images = [
      { data: "BASE64_A", mimeType: "image/png" },
      { data: "BASE64_B", mimeType: "image/png" },
    ];

    expect(filterUnreferencedInlineImages(
      "[attached_image: /tmp/a.png]\ncompare",
      images,
    )).toEqual([{ data: "BASE64_B", mimeType: "image/png" }]);
  });
});

describe("isValidSessionPath", () => {
  it("合法子路径通过校验", () => {
    expect(isValidSessionPath("/tmp/agents/agent1/sessions/abc.jsonl", "/tmp/agents")).toBe(true);
  });

  it("恰好等于 baseDir 时通过校验", () => {
    expect(isValidSessionPath("/tmp/agents", "/tmp/agents")).toBe(true);
  });

  it("路径穿越被拒绝", () => {
    expect(isValidSessionPath("/tmp/agents/../etc/passwd", "/tmp/agents")).toBe(false);
  });

  it("完全不同的路径被拒绝", () => {
    expect(isValidSessionPath("/etc/shadow", "/tmp/agents")).toBe(false);
  });

  it("前缀相似但不是子路径时被拒绝", () => {
    // /tmp/agents-evil 不是 /tmp/agents 的子路径
    expect(isValidSessionPath("/tmp/agents-evil/session.jsonl", "/tmp/agents")).toBe(false);
  });
});

describe("desktop session path predicates", () => {
  it("splits active and archived desktop session paths", () => {
    const agentsDir = "/tmp/agents";
    const active = "/tmp/agents/agent1/sessions/abc.jsonl";
    const archived = "/tmp/agents/agent1/sessions/archived/abc.jsonl";
    const subagent = "/tmp/agents/agent1/subagent-sessions/child.jsonl";

    expect(isActiveDesktopSessionPath(active, agentsDir)).toBe(true);
    expect(isActiveSessionPath(active, agentsDir)).toBe(true);
    expect(isArchivedDesktopSessionPath(active, agentsDir)).toBe(false);
    expect(isDesktopSessionPath(active, agentsDir)).toBe(true);

    expect(isActiveDesktopSessionPath(archived, agentsDir)).toBe(false);
    expect(isActiveSessionPath(archived, agentsDir)).toBe(false);
    expect(isArchivedDesktopSessionPath(archived, agentsDir)).toBe(true);
    expect(isDesktopSessionPath(archived, agentsDir)).toBe(true);

    expect(isActiveDesktopSessionPath(subagent, agentsDir)).toBe(false);
    expect(isArchivedDesktopSessionPath(subagent, agentsDir)).toBe(false);
    expect(isDesktopSessionPath(subagent, agentsDir)).toBe(false);
  });

  it("rejects repair artifacts as desktop session paths", () => {
    const agentsDir = "/tmp/agents";
    const activeRepair = "/tmp/agents/agent1/sessions/abc.jsonl.repair.jsonl";
    const archivedRepair = "/tmp/agents/agent1/sessions/archived/abc.jsonl.repair.jsonl";

    expect(isActiveDesktopSessionPath(activeRepair, agentsDir)).toBe(false);
    expect(isArchivedDesktopSessionPath(archivedRepair, agentsDir)).toBe(false);
    expect(isDesktopSessionPath(activeRepair, agentsDir)).toBe(false);
    expect(isDesktopSessionPath(archivedRepair, agentsDir)).toBe(false);
  });
});

describe("loadSessionHistoryMessages", () => {
  it("无 sessionPath 时返回空数组", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, null);
    expect(result).toEqual([]);
  });

  it("explicitPath 为 undefined 时返回空数组", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, undefined);
    expect(result).toEqual([]);
  });

  it("从 JSONL entry 透传消息写入时间", async () => {
    const sessionPath = path.join(tmpDir, "with-timestamps.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-07T05:42:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-07T05:43:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
      "",
    ].join("\n"), "utf-8");

    const result = await loadSessionHistoryMessages({}, sessionPath);

    expect(result).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: "2026-05-07T05:42:00.000Z",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: "2026-05-07T05:43:00.000Z",
      },
    ]);
  });

  it("read-time projects only known legacy Hana tool failures", async () => {
    const sessionPath = path.join(tmpDir, "legacy-tool-outcomes.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "known",
          isError: false,
          content: [{ type: "text", text: "context changed" }],
          details: { errorCode: "TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "plugin-warning",
          isError: false,
          content: [{ type: "text", text: "completed with diagnostics" }],
          details: { error: "recoverable warning" },
        },
      }),
      "",
    ].join("\n"), "utf-8");

    const result = await loadSessionHistoryMessages({}, sessionPath);

    expect(result[0].isError).toBe(true);
    expect(result[1].isError).toBe(false);
  });

  it("projects legacy reminder-prefixed JSONL user messages without internal reminder text", async () => {
    const sessionPath = path.join(tmpDir, "legacy-reminder.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "[hana_reminder at 2026-07-05 14:05]\n- Plugin demo loaded\n[/hana_reminder]\n\nhello",
          }],
        },
      }),
      "",
    ].join("\n"), "utf-8");

    const result = await loadSessionHistoryMessages({}, sessionPath);

    expect(result[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("只恢复当前 leaf 所在分支上的消息", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    const userA = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old prompt" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }] } as any);
    manager.branch(userA);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "new prompt" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "new answer" }] } as any);

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result.map(message => ({
      id: message.id,
      role: message.role,
      text: message.content?.[0]?.text,
    }))).toEqual([
      { id: userA, role: "user", text: "old prompt" },
      { id: expect.any(String), role: "user", text: "new prompt" },
      { id: expect.any(String), role: "assistant", text: "new answer" },
    ]);
  });

  it("当当前分支只有隐藏提交时不回退到物理文件中的旧消息", async () => {
    const sessionDir = path.join(tmpDir, "sessions-empty-active-branch");
    const manager = SessionManager.create(tmpDir, sessionDir);
    manager.appendMessage({ role: "user", content: "abandoned prompt" } as any);
    manager.appendMessage({ role: "assistant", content: "abandoned answer" } as any);
    manager.resetLeaf();
    manager.appendCustomEntry("hana-session-branch-reset", { sourceEntryId: "old-user" });

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result).toEqual([]);
  });

  it("uses the persisted current branch when the physical tail is a discarded sibling", async () => {
    const sessionDir = path.join(tmpDir, "persisted-branch-sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    const userId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "prompt" }] } as any);
    const selectedAnswerId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "selected answer" }] } as any);
    manager.branch(userId);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "discarded physical tail" }] } as any);
    const sessionPath = manager.getSessionFile();
    const openSessionManagerAtCurrentBranch = vi.fn(() => {
      const reopened = SessionManager.open(sessionPath, sessionDir);
      reopened.branch(selectedAnswerId);
      return reopened;
    });

    const result = await loadSessionHistoryMessages({ openSessionManagerAtCurrentBranch }, sessionPath);

    expect(openSessionManagerAtCurrentBranch).toHaveBeenCalledWith(sessionPath, path.dirname(sessionPath));
    expect(result.map((message) => message.content?.[0]?.text)).toEqual([
      "prompt",
      "selected answer",
    ]);
  });

  it("从 Pi session 分支恢复 custom_message 供后台结果重建 UI 块", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "submitted" }] } as any);
    manager.appendCustomMessageEntry(
      "hana-background-result",
      "<hana-background-result task-id=\"task-img\" status=\"success\" type=\"image-generation\">{}</hana-background-result>",
      false,
      { source: "test" },
    );

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: "custom",
      customType: "hana-background-result",
      content: "<hana-background-result task-id=\"task-img\" status=\"success\" type=\"image-generation\">{}</hana-background-result>",
      display: false,
      details: { source: "test" },
    });
    expect(result[1].id).toEqual(expect.any(String));
    expect(result[1].timestamp).toEqual(expect.any(String));
  });

  it("从 Pi session 分支恢复 custom entry 供非上下文后台结果重建 UI 块", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "submitted" }] } as any);
    manager.appendCustomEntry("hana-deferred-result", {
      schemaVersion: 1,
      taskId: "task-img",
      status: "success",
      type: "image-generation",
      result: { sessionFiles: [{ filePath: "/tmp/generated.png" }] },
    });

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: "custom",
      customType: "hana-deferred-result",
      data: {
        schemaVersion: 1,
        taskId: "task-img",
        status: "success",
        type: "image-generation",
      },
      display: false,
    });
    expect(result[1].id).toEqual(expect.any(String));
    expect(result[1].timestamp).toEqual(expect.any(String));
  });

  it("从 Pi session 分支恢复 turn input consumption 作为可重建的 UI 时间线事件", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const manager = SessionManager.create(tmpDir, sessionDir);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "before" }] } as any);
    manager.appendCustomEntry(TURN_INPUT_CONSUMPTION_EVENT_TYPE, {
      schemaVersion: 1,
      deliveryId: "delivery-1",
      input: {
        entryId: "custom-1",
        customType: "hana-background-result",
        taskId: "task-1",
        deliveryId: "delivery-1",
      },
      assistant: {
        entryId: "assistant-1",
      },
      block: {
        type: "interlude",
        id: "interlude-delivery-1",
        deliveryId: "delivery-1",
        taskId: "task-1",
        variant: "deferred_result",
        text: "Hana 收到了回复",
      },
    });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "after" }] } as any);

    const result = await loadSessionHistoryMessages({}, manager.getSessionFile());

    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      role: "custom",
      customType: TURN_INPUT_CONSUMPTION_EVENT_TYPE,
      data: {
        schemaVersion: 1,
        deliveryId: "delivery-1",
        block: {
          type: "interlude",
          deliveryId: "delivery-1",
          taskId: "task-1",
          text: "Hana 收到了回复",
        },
      },
      display: false,
    });
    expect(result[1].id).toEqual(expect.any(String));
    expect(result[1].timestamp).toEqual(expect.any(String));
  });
});

describe("loadLatestAssistantSummaryFromSessionFile", () => {
  it("从小 session 文件里提取最后 assistant 摘要", async () => {
    const sessionPath = path.join(tmpDir, "child.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done summary" }] } }),
      "",
    ].join("\n"), "utf-8");

    await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBe("done summary");
  });

  it("大 session 文件只读尾部，也能跳过首个截断半行拿到最后 assistant 摘要", async () => {
    const sessionPath = path.join(tmpDir, "large-child.jsonl");
    const hugeUserText = "x".repeat(300 * 1024);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: hugeUserText }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "tail summary" }] } }),
      "",
    ].join("\n"), "utf-8");

    const readFileSpy = vi.spyOn(fsp, "readFile");
    try {
      await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBe("tail summary");
      expect(readFileSpy).not.toHaveBeenCalledWith(sessionPath, "utf-8");
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("最近 assistant 没有文本时返回 null，不继续向前找更早 assistant", async () => {
    const sessionPath = path.join(tmpDir, "empty-last-assistant.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "older summary" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } }),
      "",
    ].join("\n"), "utf-8");

    await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBeNull();
  });
});
