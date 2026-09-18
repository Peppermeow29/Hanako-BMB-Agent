import { describe, expect, it } from "vitest";

import { isDeepSeekModel, normalizeProviderPayload } from "../../core/provider-compat.ts";
import * as deepseekResponses from "../../core/provider-compat/deepseek-responses.ts";
import defaultModels from "../../lib/default-models.json";
import { deepseekResponsesPlugin } from "../../lib/providers/deepseek-responses.ts";
import {
  getReasoningProfile,
  getReasoningReplayContract,
  getThinkingFormat,
  withThinkingFormatCompat,
} from "../../shared/model-capabilities.ts";

const FLASH_RESPONSES_MODEL = {
  id: "deepseek-v4-flash",
  provider: "deepseek-responses",
  api: "openai-responses",
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  maxOutput: 384_000,
};

const FLASH_COMPLETIONS_MODEL = {
  id: "deepseek-v4-flash",
  provider: "deepseek",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  maxOutput: 384_000,
};

function responsesPayload(extra = {}) {
  return {
    model: "deepseek-v4-flash",
    input: [{ role: "user", content: "hi" }],
    stream: true,
    ...extra,
  };
}

describe("provider-compat/deepseek-responses — matches", () => {
  it("只匹配 DeepSeek 官方 endpoint 上的 Responses 协议", () => {
    expect(deepseekResponses.matches(null)).toBe(false);
    expect(deepseekResponses.matches(undefined)).toBe(false);
    expect(deepseekResponses.matches(FLASH_RESPONSES_MODEL)).toBe(true);

    // provider id 缺失时靠 baseUrl 识别
    expect(deepseekResponses.matches({
      id: "deepseek-v4-flash",
      api: "openai-responses",
      baseUrl: "https://api.deepseek.com",
    })).toBe(true);

    // 同 endpoint 的其它协议不归本模块
    expect(deepseekResponses.matches(FLASH_COMPLETIONS_MODEL)).toBe(false);
    expect(deepseekResponses.matches({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
    })).toBe(false);

    // 其它厂商的 Responses 不归本模块
    expect(deepseekResponses.matches({
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    })).toBe(false);

    // 第三方转售的 deepseek 模型名不构成官方 endpoint
    expect(deepseekResponses.matches({
      id: "deepseek/deepseek-v4-flash",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    })).toBe(false);
  });
});

describe("deepseek-responses provider plugin", () => {
  it("走 Responses 协议，模型元数据自带协议标注", () => {
    expect(deepseekResponsesPlugin).toMatchObject({
      id: "deepseek-responses",
      authType: "api-key",
      defaultBaseUrl: "https://api.deepseek.com",
      defaultApi: "openai-responses",
    });
    expect(deepseekResponsesPlugin.models).toContainEqual(
      expect.objectContaining({
        id: "deepseek-v4-flash",
        api: "openai-responses",
        context: 1_000_000,
        maxOutput: 384_000,
        reasoning: true,
      }),
    );
  });

  it("登记 V4 全系（含视觉模型），三者走同一套协议元数据与官方三档思考", () => {
    expect(deepseekResponsesPlugin.models.map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    for (const model of deepseekResponsesPlugin.models) {
      expect(model).toMatchObject({
        api: "openai-responses",
        reasoning: true,
        thinkingLevels: ["off", "low", "high", "max"],
        defaultThinkingLevel: "high",
      });
    }
    expect(deepseekResponsesPlugin.models.find((m) => m.id === "deepseek-v4-flash-vision-exp")).toMatchObject({
      image: true,
    });
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      expect(deepseekResponsesPlugin.models.find((m) => m.id === id)).toMatchObject({ image: false });
    }
  });

  it("不进 default-models.json，否则带协议元数据的 plugin.models 会被裸 id 覆盖", () => {
    // ProviderRegistry.getDefaultModelEntries 里 default-models.json 优先于 plugin.models。
    expect(defaultModels).not.toHaveProperty("deepseek-responses");
  });

  it("model-sync 投影出协议原生的 reasoning 契约，且不带 ChatCompletions 的 thinkingFormat", () => {
    const projected = withThinkingFormatCompat({
      id: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    }, {
      provider: "deepseek-responses",
      api: "openai-responses",
      baseUrl: "https://api.deepseek.com",
    });

    expect(projected.compat).toEqual({
      supportsDeveloperRole: false,
      reasoningProfile: "deepseek-v4-responses",
      reasoningReplay: { carrier: "reasoning_items", policy: "preserve" },
    });
  });
});

describe("推导链 — Responses 流量不再被 ChatCompletions 语义吞掉", () => {
  it("isDeepSeekModel 只认 ChatCompletions 兼容路径", () => {
    expect(isDeepSeekModel(FLASH_COMPLETIONS_MODEL)).toBe(true);
    expect(isDeepSeekModel(FLASH_RESPONSES_MODEL)).toBe(false);
  });

  it("getThinkingFormat 不把 Responses 判成 deepseek wire 家族", () => {
    expect(getThinkingFormat(FLASH_COMPLETIONS_MODEL)).toBe("deepseek");
    expect(getThinkingFormat(FLASH_RESPONSES_MODEL)).toBe(null);
  });

  it("getReasoningProfile 给 Responses 独立 profile", () => {
    expect(getReasoningProfile(FLASH_COMPLETIONS_MODEL)).toBe("deepseek-v4-openai");
    expect(getReasoningProfile(FLASH_RESPONSES_MODEL)).toBe("deepseek-v4-responses");
  });

  it("Responses profile 的 replay 契约是协议原生的 reasoning items", () => {
    expect(getReasoningReplayContract(FLASH_COMPLETIONS_MODEL)).toEqual({
      carrier: "reasoning_content",
      policy: "require-tool-call",
    });
    expect(getReasoningReplayContract(FLASH_RESPONSES_MODEL)).toEqual({
      carrier: "reasoning_items",
      policy: "preserve",
    });
  });
});

describe("provider-compat/deepseek-responses — effort 翻译", () => {
  it("保留 reasoning 里的其它字段，只动 effort", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "minimal", summary: "auto" } }),
      FLASH_RESPONSES_MODEL,
      { mode: "chat", reasoningLevel: "low" },
    );
    expect(result.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("low 是官方有效档位，不再被吞成 high", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "low" } }),
      FLASH_RESPONSES_MODEL,
      { mode: "chat", reasoningLevel: "low" },
    );
    expect(result.reasoning).toMatchObject({ effort: "low" });
  });

  it("minimal 是 OpenAI 专有档位，归到最接近的 low", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "minimal" } }),
      FLASH_RESPONSES_MODEL,
      { mode: "chat", reasoningLevel: "low" },
    );
    expect(result.reasoning).toMatchObject({ effort: "low" });
  });

  it("medium / xhigh 交给服务端自己映射，不代劳", () => {
    for (const effort of ["medium", "xhigh"]) {
      const result = normalizeProviderPayload(
        responsesPayload({ reasoning: { effort } }),
        FLASH_RESPONSES_MODEL,
        { mode: "chat", reasoningLevel: "high" },
      );
      expect(result.reasoning).toMatchObject({ effort });
    }
  });

  it("关思考发官方的 effort none，而不是删掉 reasoning 字段", () => {
    // DeepSeek 思考模式默认开启，删字段等于落回默认，用户选的 off 档会失效。
    for (const payload of [
      responsesPayload({ reasoning: { effort: "xhigh" } }),
      responsesPayload(),
    ]) {
      const result = normalizeProviderPayload(payload, FLASH_RESPONSES_MODEL, {
        mode: "chat",
        reasoningLevel: "off",
      });
      expect(result.reasoning).toMatchObject({ effort: "none" });
    }
  });
});

describe("provider-compat/deepseek-responses — 字段搬运", () => {
  it("剥掉 ChatCompletions 专属字段，64K 默认预算落到 max_output_tokens", () => {
    const payload = responsesPayload({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 131_072,
      max_completion_tokens: 65_536,
    });

    const result = normalizeProviderPayload(payload, FLASH_RESPONSES_MODEL, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });

    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("max_tokens");
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result.max_output_tokens).toBe(65_536);
  });

  it("默认预算限制到 64K，但不抬高 SDK 已按剩余窗口收紧的值", () => {
    // SDK 的 clampMaxTokensToContext 已经取过 min(模型上限, 剩余窗口 - 安全余量)。
    // 兼容层拿不到真实 token 数，放大只会把请求推过 1M 总窗口的边界。
    for (const cap of [50_000, 120_000, 384_000]) {
      const result = normalizeProviderPayload(
        responsesPayload({ reasoning: { effort: "xhigh" }, max_output_tokens: cap }),
        FLASH_RESPONSES_MODEL,
        { mode: "chat", reasoningLevel: "xhigh" },
      );
      expect(result.max_output_tokens).toBe(Math.min(cap, 65_536));
      expect(result.reasoning).toMatchObject({ effort: "xhigh" });
    }
  });

  it("剩余窗口紧张不会让模型突然停止思考", () => {
    // 预算小只说明这一轮上下文长，思考能力没变。跟着单轮预算关思考是用户没法
    // 预料的静默降级。
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "xhigh" }, max_output_tokens: 20_000 }),
      FLASH_RESPONSES_MODEL,
      { mode: "chat", reasoningLevel: "xhigh" },
    );
    expect(result.reasoning).toMatchObject({ effort: "xhigh" });
    expect(result.max_output_tokens).toBe(20_000);
  });

  it("模型输出上限小也不替用户关思考", () => {
    // 官方对思考模式没有 max_tokens 最小值要求，凭空设阈值只会让用户选的档位失效。
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "xhigh" }, max_output_tokens: 8_000 }),
      { ...FLASH_RESPONSES_MODEL, maxOutput: 8_192 },
      { mode: "chat", reasoningLevel: "xhigh" },
    );
    expect(result.reasoning).toMatchObject({ effort: "xhigh" });
  });

  it("已有的 max_output_tokens 不被 ChatCompletions 残留值覆盖", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ max_output_tokens: 200_000, max_tokens: 4096 }),
      FLASH_RESPONSES_MODEL,
      { mode: "chat", reasoningLevel: "high" },
    );
    expect(result.max_output_tokens).toBe(65_536);
    expect(result).not.toHaveProperty("max_tokens");
  });

  it("显式声明 deepseek thinkingFormat 的模型也不会漏发 thinking 字段", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ thinking: { type: "enabled" } }),
      { ...FLASH_RESPONSES_MODEL, compat: { thinkingFormat: "deepseek" } },
      { mode: "chat", reasoningLevel: "high" },
    );
    expect(result).not.toHaveProperty("thinking");
  });
});

describe("provider-compat/deepseek-responses — utility 与不可变性", () => {
  it("utility 模式显式关闭思考，避免短输出被思考链吃光预算", () => {
    const result = normalizeProviderPayload(
      responsesPayload({ reasoning: { effort: "high", summary: "auto" } }),
      FLASH_RESPONSES_MODEL,
      { mode: "utility" },
    );
    expect(result.reasoning).toMatchObject({ effort: "none" });
  });

  it("apply 不 mutate 输入 payload", () => {
    const payload = responsesPayload({
      thinking: { type: "enabled" },
      max_tokens: 131_072,
      reasoning: { effort: "xhigh" },
    });
    const snapshot = JSON.parse(JSON.stringify(payload));

    const result = deepseekResponses.apply(payload, FLASH_RESPONSES_MODEL, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });

    expect(result).not.toBe(payload);
    expect(payload).toEqual(snapshot);
  });

  it("无需改写时原样返回，不制造无谓的新对象", () => {
    const payload = responsesPayload({
      reasoning: { effort: "max", summary: "auto" },
      max_output_tokens: 384_000,
    });
    expect(deepseekResponses.apply(payload, FLASH_RESPONSES_MODEL, {
      mode: "chat",
      reasoningLevel: "xhigh",
    })).toBe(payload);
  });
});
