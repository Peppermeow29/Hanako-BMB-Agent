import { describe, expect, it } from "vitest";

// 直接 import 上游 SDK 的序列化器，不经 lib/pi-sdk 适配层：本测试钉住的是上游内部
// 行为，不是本产品对外暴露的契约，与 pi-sdk-import-boundary 的生产代码边界扫描无关
// （该扫描只覆盖 core/server/lib/hub，不拦 tests/）。
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

// 动机：DeepSeek 官方 vision API 只允许 user 消息携带图片，system/assistant 消息
// 带图会被 API 拒绝并返回 400。本产品把图片直传给声明了 image 能力的官方 DeepSeek
// 模型，完全依赖上游 SDK 的 OpenAI Chat Completions 序列化器把所有图片都投影到
// user 消息这一行为：assistant 消息只送纯文本，toolResult 里的图片被抽成一条独立
// 的 user 消息。如果上游升级改变了这个投影，图片传输会在真实 API 调用时才炸出
// 400 报错；这个测试的作用是让那类回归提前在这里变红。
describe("Pi openai-completions serializer: images only land on user messages", () => {
  it("keeps every image_url block inside a user-role wire message", () => {
    const model = {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
    };
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Sure, let me check." }],
        timestamp: 2,
        stopReason: "stop",
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read_image",
        content: [
          { type: "text", text: "here is the result" },
          { type: "image", data: "BBBB", mimeType: "image/png" },
        ],
        timestamp: 3,
      },
    ];
    const context = { messages, systemPrompt: undefined };
    const compat = {};

    const wireMessages = convertMessages(model as any, context as any, compat as any);

    // 不变量 1：所有 image_url 块只出现在 role === "user" 的消息里
    for (const wireMessage of wireMessages) {
      const blocks = Array.isArray(wireMessage.content) ? wireMessage.content : [];
      const hasImage = blocks.some((block: any) => block.type === "image_url");
      if (hasImage) {
        expect(wireMessage.role).toBe("user");
      }
    }

    // 不变量 2：toolResult 里的图片被抽到 tool 消息之后一条独立的 user 消息，
    // 文本引导固定为 "Attached image(s) from tool result:"
    const toolMessageIndex = wireMessages.findIndex((m: any) => m.role === "tool");
    expect(toolMessageIndex).toBeGreaterThanOrEqual(0);
    const toolMessage = wireMessages[toolMessageIndex] as any;
    // 不变量 3：tool 角色消息内容是纯字符串，不含图片块
    expect(typeof toolMessage.content).toBe("string");

    const followingUserMessage = wireMessages[toolMessageIndex + 1] as any;
    expect(followingUserMessage.role).toBe("user");
    expect(Array.isArray(followingUserMessage.content)).toBe(true);
    expect(followingUserMessage.content[0]).toEqual({
      type: "text",
      text: "Attached image(s) from tool result:",
    });
    expect(followingUserMessage.content.some((block: any) => block.type === "image_url")).toBe(true);

    // assistant 消息本身完全不携带图片块（纯文本字符串）
    const assistantMessage = wireMessages.find((m: any) => m.role === "assistant") as any;
    expect(typeof assistantMessage.content).toBe("string");
  });
});
