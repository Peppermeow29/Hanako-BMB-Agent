/**
 * core/message-sanitizer.ts 单元测试
 *
 * 覆盖：
 *   - 支持 image 的模型：放行不改
 *   - 不支持 image 的模型：UserMessage / ToolResultMessage 里的 ImageContent
 *     替换为 TextContent 占位；其他消息不动
 *   - input 缺失/非数组：放行（未知视作允许，与 API 决定一致）
 *   - 只含 text 的 messages：无副作用、stripped=0
 *   - 幂等：重复调用结果一致
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeMessagesForModel,
  stripAllInlineMediaForHistory,
  stripHistoricalInlineMediaForReplay,
  modelSupportsImage,
  modelSupportsVideo,
} from "../core/message-sanitizer.ts";

const IMG_BLOCK = { type: "image", data: "BASE64DATA", mimeType: "image/png" };
const VIDEO_BLOCK = { type: "video", data: "BASE64VIDEO", mimeType: "video/mp4" };
const AUDIO_BLOCK = { type: "audio", data: "BASE64AUDIO", mimeType: "audio/wav" };
const TEXT_BLOCK = (text) => ({ type: "text", text });

describe("modelSupportsImage", () => {
  it("input 含 image → true", () => {
    expect(modelSupportsImage({ input: ["text", "image"] })).toBe(true);
  });
  it("input 只有 text → false", () => {
    expect(modelSupportsImage({ input: ["text"] })).toBe(false);
  });
  it("input 缺失 → false（调用方应按未知处理而不是直接信任）", () => {
    expect(modelSupportsImage({})).toBe(false);
    expect(modelSupportsImage(null)).toBe(false);
    expect(modelSupportsImage(undefined)).toBe(false);
  });
  it("input 非数组 → false", () => {
    expect(modelSupportsImage({ input: "image" })).toBe(false);
  });
});

describe("modelSupportsVideo", () => {
  it("input 含 video → true", () => {
    expect(modelSupportsVideo({ input: ["text", "video"] })).toBe(true);
  });
  it("Hana compat 标记视频能力 → true", () => {
    expect(modelSupportsVideo({ input: ["text", "image"], compat: { hanaVideoInput: true } })).toBe(true);
  });
  it("input 缺失或只有 image → false", () => {
    expect(modelSupportsVideo({ input: ["text", "image"] })).toBe(false);
    expect(modelSupportsVideo({})).toBe(false);
  });
});

describe("sanitizeMessagesForModel", () => {
  const textOnlyModel = { input: ["text"] };
  const imageModel = { input: ["text", "image"] };
  const deepseekImageDeclaredModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    input: ["text", "image"],
  };
  const customImageDeclaredModel = {
    id: "custom-vision",
    provider: "custom",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    input: ["text", "image"],
  };
  const videoModel = {
    id: "qwen3-vl-plus",
    provider: "dashscope",
    api: "openai-completions",
    input: ["text"],
    compat: { hanaVideoInput: true },
  };

  it("支持 image 的模型：放行不改", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("hi"), IMG_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("there")] },
    ];
    const res = sanitizeMessagesForModel(messages, imageModel);
    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("用户声明 image 的未知 provider：默认信任并直传图片", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("hi"), IMG_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, customImageDeclaredModel);
    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("官方 DeepSeek 声明 image 时直传 image_url，不再按 provider 拦截", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("what is this?"), IMG_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, deepseekImageDeclaredModel);
    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("不支持 image 的模型：user 消息里的 image block 换占位", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("what is this?"), IMG_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("what is this?"),
      { type: "text", text: "[图片已省略：当前模型不支持图像输入]" },
    ]);
    // 原数组不变（纯函数）
    expect(messages[0].content).toEqual([TEXT_BLOCK("what is this?"), IMG_BLOCK]);
  });

  it("不支持 video 的模型：user 消息里的 video block 换占位并单独计数", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("what is this?"), VIDEO_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(1);
    expect(res.strippedVideos).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("what is this?"),
      { type: "text", text: "[视频已省略：当前模型不支持视频输入]" },
    ]);
    expect(messages[0].content).toEqual([TEXT_BLOCK("what is this?"), VIDEO_BLOCK]);
  });

  it("不支持 audio 的模型：user 消息里的 audio block 换占位并单独计数", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("what is this?"), AUDIO_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(1);
    expect(res.strippedAudios).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("what is this?"),
      { type: "text", text: "[音频已省略：当前模型不支持音频输入]" },
    ]);
    expect(messages[0].content).toEqual([TEXT_BLOCK("what is this?"), AUDIO_BLOCK]);
  });

  it("显式声明 openai-input-audio transport 的模型直传当前轮 audio", () => {
    const audioModel = {
      id: "future-audio-model",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text"],
      compat: { hanaAudioInput: true, audioTransport: "openai-input-audio" },
    };
    const messages = [
      { role: "user", content: [TEXT_BLOCK("listen"), AUDIO_BLOCK] },
    ];

    const res = sanitizeMessagesForModel(messages, audioModel);

    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("支持 video 但不支持 image 的模型只剥 image", () => {
    const messages = [
      { role: "user", content: [IMG_BLOCK, VIDEO_BLOCK] },
    ];
    const res = sanitizeMessagesForModel(messages, videoModel);
    expect(res.stripped).toBe(1);
    expect(res.strippedImages).toBe(1);
    expect(res.strippedVideos).toBe(0);
    expect(res.messages[0].content).toEqual([
      { type: "text", text: "[图片已省略：当前模型不支持图像输入]" },
      VIDEO_BLOCK,
    ]);
  });

  it("视频语义能力存在但 provider 传输不支持时仍剥离 video", () => {
    const unsupportedTransportModel = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "anthropic-messages",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    };
    const messages = [
      { role: "user", content: [VIDEO_BLOCK] },
    ];

    const res = sanitizeMessagesForModel(messages, unsupportedTransportModel);

    expect(res.stripped).toBe(1);
    expect(res.strippedVideos).toBe(1);
    expect(res.messages[0].content).toEqual([
      { type: "text", text: "[视频已省略：当前模型不支持视频输入]" },
    ]);
  });

  it("不支持 image 的模型：toolResult 里的 image block 换占位", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "screenshot",
        content: [TEXT_BLOCK("Screenshot saved"), IMG_BLOCK, IMG_BLOCK],
      },
    ];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(2);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("Screenshot saved"),
      { type: "text", text: "[图片已省略：当前模型不支持图像输入]" },
      { type: "text", text: "[图片已省略：当前模型不支持图像输入]" },
    ]);
  });

  it("assistant 消息不被扫描（其 content 里无 image 类型）", () => {
    const messages = [
      { role: "assistant", content: [TEXT_BLOCK("foo")] },
    ];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("user 消息 content 为字符串：放行", () => {
    const messages = [{ role: "user", content: "plain text" }];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(0);
    expect(res.messages).toBe(messages);
  });

  it("input 缺失时放行（未知视作允许）", () => {
    const messages = [{ role: "user", content: [IMG_BLOCK] }];
    // modelSupportsImage 对 {} 返回 false，因此这里会剥；
    // sanitizer 的契约就是"不支持就剥"，未知场景的"放行"在调用侧由
    // session-coordinator 的 `Array.isArray(input) &&` 保护。此测试固定行为。
    const res = sanitizeMessagesForModel(messages, {});
    expect(res.stripped).toBe(1);
  });

  it("幂等：对已净化过的 messages 再次调用不再产生变化", () => {
    const messages = [{ role: "user", content: [IMG_BLOCK] }];
    const first = sanitizeMessagesForModel(messages, textOnlyModel);
    const second = sanitizeMessagesForModel(first.messages, textOnlyModel);
    expect(second.stripped).toBe(0);
    expect(second.messages).toBe(first.messages);
  });

  it("messages 非数组或 null：防御式放行", () => {
    expect(sanitizeMessagesForModel(null, textOnlyModel)).toEqual({ messages: null, stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 });
    expect(sanitizeMessagesForModel(undefined, textOnlyModel)).toEqual({ messages: undefined, stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 });
    expect(sanitizeMessagesForModel("oops", textOnlyModel).stripped).toBe(0);
  });

  it("混合场景：部分消息有图、部分无图，只动必要的", () => {
    const pure = { role: "user", content: [TEXT_BLOCK("pure")] };
    const dirty = { role: "user", content: [TEXT_BLOCK("dirty"), IMG_BLOCK] };
    const tr = { role: "toolResult", toolCallId: "t", toolName: "shot", content: [IMG_BLOCK] };
    const messages = [pure, dirty, tr];
    const res = sanitizeMessagesForModel(messages, textOnlyModel);
    expect(res.stripped).toBe(2);
    expect(res.messages[0]).toBe(pure);  // 纯文本未复制
    expect(res.messages[1]).not.toBe(dirty);  // 脏消息已复制
    expect(res.messages[2]).not.toBe(tr);
  });
});

describe("stripHistoricalInlineMediaForReplay", () => {
  it("剥离上一个 assistant 之前的历史图片，避免后续请求重放 base64", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("[attached_image: /tmp/a.png]\nfirst"), IMG_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("seen")] },
      { role: "user", content: [TEXT_BLOCK("follow up")] },
    ];

    const res = stripHistoricalInlineMediaForReplay(messages);

    expect(res.strippedImages).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("[attached_image: /tmp/a.png]\nfirst"),
    ]);
    expect(res.messages[1]).toBe(messages[1]);
    expect(res.messages[2]).toBe(messages[2]);
    expect(messages[0].content).toEqual([TEXT_BLOCK("[attached_image: /tmp/a.png]\nfirst"), IMG_BLOCK]);
  });

  it("保留最后一个 assistant 之后的当前轮图片，让用户刚发的图仍能直接进入视觉模型", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("[attached_image: /tmp/old.png]\nold"), IMG_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("seen")] },
      { role: "user", content: [TEXT_BLOCK("[attached_image: /tmp/current.png]\ncurrent"), IMG_BLOCK] },
    ];

    const res = stripHistoricalInlineMediaForReplay(messages);

    expect(res.strippedImages).toBe(1);
    expect(res.messages[0].content).not.toContain(IMG_BLOCK);
    expect(res.messages[2]).toBe(messages[2]);
    expect(res.messages[2].content).toEqual([TEXT_BLOCK("[attached_image: /tmp/current.png]\ncurrent"), IMG_BLOCK]);
  });

  it("剥离历史音频但保留最后一个 assistant 之后的当前轮音频", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("[attached_audio: /tmp/old.wav]\nold"), AUDIO_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("heard")] },
      { role: "user", content: [TEXT_BLOCK("[attached_audio: /tmp/current.wav]\ncurrent"), AUDIO_BLOCK] },
    ];

    const res = stripHistoricalInlineMediaForReplay(messages);

    expect(res.strippedAudios).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("[attached_audio: /tmp/old.wav]\nold"),
    ]);
    expect(res.messages[2]).toBe(messages[2]);
    expect(res.messages[2].content).toEqual([
      TEXT_BLOCK("[attached_audio: /tmp/current.wav]\ncurrent"),
      AUDIO_BLOCK,
    ]);
  });

  it("没有 attached_image 引用的 legacy inline 图片会留下轻量占位", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("legacy image"), IMG_BLOCK] },
      { role: "assistant", content: [TEXT_BLOCK("seen")] },
      { role: "user", content: [TEXT_BLOCK("follow up")] },
    ];

    const res = stripHistoricalInlineMediaForReplay(messages);

    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("legacy image"),
      { type: "text", text: "[图片已省略：历史图片保留为文件引用，避免重复发送原始 base64]" },
    ]);
  });
});

describe("stripAllInlineMediaForHistory", () => {
  it("一轮结束后剥离 audio inline bytes，只留下 attached_audio 引用文本", () => {
    const messages = [
      { role: "user", content: [TEXT_BLOCK("[attached_audio: /tmp/current.wav]\ncurrent"), AUDIO_BLOCK] },
    ];

    const res = stripAllInlineMediaForHistory(messages);

    expect(res.strippedAudios).toBe(1);
    expect(res.messages[0].content).toEqual([
      TEXT_BLOCK("[attached_audio: /tmp/current.wav]\ncurrent"),
    ]);
    expect(messages[0].content).toEqual([
      TEXT_BLOCK("[attached_audio: /tmp/current.wav]\ncurrent"),
      AUDIO_BLOCK,
    ]);
  });
});
