import { describe, it, expect } from "vitest";
import { buildCompactTranscript } from "../lib/session-collab/transcript.ts";

const META = { sessionId: "s-1", title: "测试会话", agentId: "hana", agentName: "Hana", isStreaming: false };

function turn(userText: string, assistantText: string, extra: any[] = []) {
  return [
    { role: "user", content: userText, timestamp: 1 },
    ...extra,
    { role: "assistant", content: assistantText, timestamp: 2 },
  ];
}

describe("buildCompactTranscript", () => {
  it("头部含 sessionId/标题/归属，用户与 Agent 正文保留", () => {
    const page = buildCompactTranscript(turn("你好", "回复正文"), { meta: META });
    expect(page.header).toContain("s-1");
    expect(page.header).toContain("Hana");
    expect(page.body).toContain("你好");
    expect(page.body).toContain("回复正文");
  });

  it("assistant 工具调用折叠为单行，toolResult 折叠为首行", () => {
    // 实测确认：extractTextContent 的 isToolCallBlock 要求 block.name（不是 toolName），
    // getToolArgs 读 block.input || block.arguments（不是 block.args）。见报告说明。
    const messages = turn("查一下", "查到了", [
      { role: "assistant", content: [{ type: "toolCall", name: "web_search", input: { query: "天气" } }] },
      { role: "toolResult", toolName: "web_search", content: "第一行结果\n第二行不出现" },
    ]);
    const page = buildCompactTranscript(messages, { meta: META });
    expect(page.body).toMatch(/⚙ web_search/);
    expect(page.body).toContain("第一行结果");
    expect(page.body).not.toContain("第二行不出现");
  });

  it("base64/媒体替换为占位符", () => {
    // 实测确认：真实消息里图片是 content 数组里的 {type:"image", data, mimeType} block，
    // 不是消息顶层的 images 字段；extractTextContent 已经从 content 里把 images 解析出来。见报告说明。
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      { role: "assistant", content: "看到了" },
    ];
    const page = buildCompactTranscript(messages, { meta: META });
    expect(page.body).toContain("[image]");
    expect(page.body).not.toContain("AAAA");
  });

  it("从最新往回分页，cursor 可续读", () => {
    const messages = Array.from({ length: 5 }, (_, i) => turn(`问题${i}`, `回答${i}`)).flat();
    const page1 = buildCompactTranscript(messages, { meta: META, count: 2 });
    expect(page1.body).toContain("问题4");
    expect(page1.body).toContain("问题3");
    expect(page1.body).not.toContain("问题2");
    expect(page1.cursor).toBe("t3");
    const page2 = buildCompactTranscript(messages, { meta: META, count: 2, cursor: page1.cursor! });
    expect(page2.body).toContain("问题2");
    expect(page2.body).toContain("问题1");
    expect(page2.body).not.toContain("问题4");
    expect(page2.cursor).toBe("t1");
  });

  it("cursor 越界报错附有效范围", () => {
    const messages = turn("你好", "在");
    expect(() => buildCompactTranscript(messages, { meta: META, cursor: "t999" }))
      .toThrow(/valid range/);
    expect(() => buildCompactTranscript(messages, { meta: META, cursor: "abc" }))
      .toThrow(/valid range/);
  });

  it("custom 消息不进入正文", () => {
    const messages = [
      { role: "custom", customType: "hana-message-origin", data: {} },
      { role: "user", content: "你好" },
      { role: "assistant", content: "在" },
    ];
    const page = buildCompactTranscript(messages, { meta: META });
    expect(page.body).not.toContain("hana-message-origin");
    expect(page.body).toContain("你好");
  });

  it("does not expose reminder blocks through cross-session transcripts", () => {
    const page = buildCompactTranscript(turn(
      "[hana_reminder at 2026-07-05 14:05]\n- Plugin demo loaded\n[/hana_reminder]\n\nhello",
      "world",
    ), { meta: META });

    expect(page.body).toContain("hello");
    expect(page.body).not.toContain("hana_reminder");
    expect(page.body).not.toContain("Plugin demo");
  });
});
