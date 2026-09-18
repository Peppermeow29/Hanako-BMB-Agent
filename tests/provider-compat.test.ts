import { describe, expect, it } from "vitest";
import {
  normalizeProviderPayload,
  normalizeProviderContextMessages,
  isDeepSeekModel,
  isAnthropicModel,
  getThinkingFormat,
  getReasoningProfile,
} from "../core/provider-compat.ts";
import {
  resolveOutputBudgetPolicy,
  resolveOutputCapCapability,
} from "../core/provider-compat/output-budget.ts";

describe("isDeepSeekModel", () => {
  it("只把官方 DeepSeek provider / baseUrl 视为 DeepSeek 兼容路径", () => {
    expect(isDeepSeekModel({ provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    expect(isDeepSeekModel({ provider: "openrouter", id: "deepseek/deepseek-v3.2" })).toBe(false);
  });
});

describe("MiniCPM5 local generation settings", () => {
  it("removes stale reasoning controls even when an old session asks for medium thinking", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [{ role: "user", content: "solve this" }],
      reasoning_effort: "medium",
      reasoning: { effort: "medium" },
      thinking: { type: "enabled" },
      enable_thinking: true,
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "medium" });

    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("reasoning");
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("enable_thinking");
  });

  it("serializes configured sampling and output limits into the MLX OpenAI-compatible request", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8192,
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
      maxTokens: 4096,
      generation: {
        temperature: 0.35,
        topP: 0.8,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1.1,
      },
    }, { mode: "chat" });

    expect(result).toMatchObject({
      max_tokens: 4096,
      temperature: 0.35,
      top_p: 0.8,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.1,
    });
  });

  it("enables the native think channel only for an explicit math/algorithm turn", () => {
    const model = {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
      maxTokens: 4096,
    };
    const math = normalizeProviderPayload({
      model: "default_model",
      messages: [{ role: "user", content: "请证明这个积分恒等式，并给出推导过程。" }],
      max_tokens: 1024,
    }, model, { mode: "chat" });
    const ordinary = normalizeProviderPayload({
      model: "default_model",
      messages: [{ role: "user", content: "把这句话改写得更自然。" }],
      max_tokens: 1024,
    }, model, { mode: "chat" });

    expect(math.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(math.max_tokens).toBe(2048);
    expect(ordinary.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(ordinary.max_tokens).toBe(1024);
  });

  it("keeps an explicit thinking override and honors an explicit user output cap", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [{ role: "user", content: "请解这道算法题。" }],
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false, custom_flag: "keep" },
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      maxTokens: 4096,
    }, { mode: "chat", outputBudgetSource: "user" });

    expect(result.chat_template_kwargs).toEqual({ enable_thinking: false, custom_flag: "keep" });
    expect(result.max_tokens).toBe(512);
  });

  it("does not add MLX sampling fields to cloud provider payloads", () => {
    const result = normalizeProviderPayload({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hello" }],
    }, {
      id: "kimi-k2.6",
      provider: "moonshot",
      api: "openai-completions",
      maxTokens: 4096,
      generation: { temperature: 0.35, topP: 0.8 },
    }, { mode: "chat" });

    expect(result).not.toHaveProperty("top_p");
    expect(result).not.toHaveProperty("min_p");
    expect(result).not.toHaveProperty("repetition_penalty");
  });

  it("keeps the native MLX tools contract for an explicit file operation", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [
        { role: "system", content: "MiniCPM5 protocol" },
        { role: "user", content: "请把内容写入 notes.md" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "write",
          description: "Create or replace a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
    }, { mode: "chat" });

    expect(result.tools).toHaveLength(1);
    expect(result).not.toHaveProperty("tool_choice");
    expect(result).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps a named tool when the request forbids only other tools", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [{
        role: "user",
        content: "只调用一次 write，写入 hanako-real-tool-probe.md；不要调用其他工具。",
      }],
      tools: [
        { type: "function", function: { name: "write", parameters: { type: "object" } } },
        { type: "function", function: { name: "read", parameters: { type: "object" } } },
      ],
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
    }, { mode: "chat" });

    expect(result.tools).toHaveLength(2);
  });

  it("omits native tools for an ordinary algorithm answer", () => {
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [
        { role: "system", content: "MiniCPM5 protocol" },
        { role: "user", content: "请解这道算法题，只给出思路和答案，不要调用工具。" },
      ],
      tools: [{ type: "function", function: { name: "write", parameters: { type: "object" } } }],
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
    }, { mode: "chat" });

    expect(result).not.toHaveProperty("tools");
  });

  it("keeps vision OCR turns tool-free and asks MiniCPM for complete LaTeX answers", () => {
    const visionContext = "<vision-context>\ntask_relevant_transcription: Let z=z(x,y), x-az=e^(y+az).\n</vision-context>";
    const result = normalizeProviderPayload({
      model: "default_model",
      messages: [{
        role: "user",
        content: [{ type: "text", text: `${visionContext}\n\n[attached_image: /tmp/math.png]\n解答这道题` }],
      }],
      tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
    }, {
      id: "default_model",
      provider: "minicpm5-local",
      api: "openai-completions",
    }, { mode: "chat" });

    expect(result).not.toHaveProperty("tools");
    expect(result.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(result.messages[0].content[0].text).toContain("do not call an OCR tool");
    expect(result.messages[0].content[0].text).toContain("correct LaTeX");
    expect(result.messages[0].content[0].text).toContain("Do not truncate the answer");
  });
});

describe("isAnthropicModel", () => {
  it("匹配 anthropic provider", () => {
    expect(isAnthropicModel({ provider: "anthropic" })).toBe(true);
    expect(isAnthropicModel({ provider: "openai" })).toBe(false);
  });
});

describe("Anthropic Max effort normalization", () => {
  it("maps Hana's unified Max level to Anthropic max effort", () => {
    const result = normalizeProviderPayload({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
      max_tokens: 42666,
    }, {
      id: "claude-opus-4-7",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 128000,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(64000);
  });

  it("does not overwrite an explicit non-default Anthropic output cap", () => {
    const result = normalizeProviderPayload({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      max_tokens: 12000,
    }, {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 64000,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(12000);
  });

  it("maps Claude Fable/Mythos budget thinking to adaptive thinking with effort", () => {
    const payload = {
      model: "claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192, display: "omitted" },
      max_tokens: 42666,
    };
    const result = normalizeProviderPayload(payload, {
      id: "claude-fable-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 128000,
      compat: {
        thinkingFormat: "anthropic",
        reasoningProfile: "anthropic-adaptive-only",
      },
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result).not.toBe(payload);
    expect(result.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(64000);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 8192, display: "omitted" });
  });

  it.each(["claude-opus-5", "claude-sonnet-5"])(
    "maps %s Max to native Anthropic adaptive max effort",
    (modelId) => {
      const result = normalizeProviderPayload({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 8192 },
        max_tokens: 42666,
      }, {
        id: modelId,
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        maxTokens: 128000,
      }, { mode: "chat", reasoningLevel: "xhigh" });

      expect(result.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(result.output_config).toEqual({ effort: "max" });
      expect(result.max_tokens).toBe(64000);
    },
  );

  it("keeps Claude Fable/Mythos adaptive thinking explicit when no thinking field is present", () => {
    const result = normalizeProviderPayload({
      model: "claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 12000,
    }, {
      id: "claude-mythos-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 128000,
      compat: {
        thinkingFormat: "anthropic",
        reasoningProfile: "anthropic-adaptive-only",
      },
    }, { mode: "chat", reasoningLevel: "medium" });

    expect(result.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(result.output_config).toEqual({ effort: "medium" });
    expect(result.max_tokens).toBe(12000);
  });

  it("fails closed when Claude Fable/Mythos thinking is explicitly disabled", () => {
    expect(() => normalizeProviderPayload({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      max_tokens: 12000,
    }, {
      id: "claude-fable-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      compat: {
        thinkingFormat: "anthropic",
        reasoningProfile: "anthropic-adaptive-only",
      },
    }, { mode: "chat", reasoningLevel: "off" })).toThrow(/does not support disabling adaptive thinking/);
  });
});

describe("getThinkingFormat", () => {
  it("优先读取模型显式 thinkingFormat 声明", () => {
    expect(getThinkingFormat({
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    })).toBe("anthropic");
    expect(getThinkingFormat({
      provider: "dashscope",
      api: "openai-completions",
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    })).toBe("qwen");
  });

  it("仅 api=anthropic-messages 但无 reasoning/format 声明时不猜 thinking 格式", () => {
    expect(getThinkingFormat({
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
      reasoning: false,
      compat: { supportsDeveloperRole: false },
    })).toBe(null);
  });

  it("兼容旧 models.json：reasoning + anthropic-messages 可读时派生 anthropic 格式", () => {
    expect(getThinkingFormat({
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("anthropic");
  });

  it("兼容旧 models.json：官方 MiMo reasoning 模型派生 chat template thinking 格式", () => {
    expect(getThinkingFormat({
      id: "mimo-v2-flash",
      provider: "mimo",
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("qwen-chat-template");
  });

  it("兼容旧 models.json：Xiaomi Token Plan MiMo reasoning 模型派生 chat template thinking 格式", () => {
    expect(getThinkingFormat({
      id: "mimo-v2.5-pro",
      provider: "xiaomi-token",
      api: "openai-completions",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("qwen-chat-template");
  });

  it("OpenRouter reasoning 模型派生 openrouter thinking 格式，不套官方 provider 格式", () => {
    expect(getThinkingFormat({
      id: "deepseek/deepseek-v3.2",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("openrouter");

    expect(getThinkingFormat({
      id: "xiaomi/mimo-v2-flash",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("openrouter");
  });

  it("Claude Fable/Mythos adaptive-only 模型派生供应商专属 profile", () => {
    expect(getReasoningProfile({
      id: "claude-fable-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
    })).toBe("anthropic-adaptive-only");

    expect(getReasoningProfile({
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    })).toBe("openrouter-anthropic-adaptive");
  });
});

describe("getReasoningProfile", () => {
  it("显式 reasoningProfile 优先于派生规则", () => {
    expect(getReasoningProfile({
      provider: "custom",
      api: "anthropic-messages",
      reasoning: true,
      compat: { reasoningProfile: "deepseek-v4-anthropic" },
    })).toBe("deepseek-v4-anthropic");
  });

  it("DeepSeek V4 官方 Anthropic endpoint 派生为 deepseek-v4-anthropic", () => {
    expect(getReasoningProfile({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      reasoning: true,
    })).toBe("deepseek-v4-anthropic");
  });

  it("Kimi / MiniMax Anthropic-compatible 模型不被误判成 DeepSeek profile", () => {
    expect(getReasoningProfile({
      id: "kimi-k2.6",
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    })).toBe(null);
    expect(getReasoningProfile({
      id: "MiniMax-M2.7",
      provider: "minimax",
      api: "anthropic-messages",
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    })).toBe(null);
  });

  it("官方 MiMo reasoning 模型派生 mimo-openai profile", () => {
    expect(getReasoningProfile({
      id: "mimo-v2-flash",
      provider: "mimo",
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      reasoning: true,
    })).toBe("mimo-openai");
  });

  it("Xiaomi Token Plan MiMo reasoning 模型派生 mimo-openai profile", () => {
    expect(getReasoningProfile({
      id: "mimo-v2.5-pro",
      provider: "xiaomi-token",
      api: "openai-completions",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      reasoning: true,
    })).toBe("mimo-openai");
  });
});

describe("resolveOutputCapCapability", () => {
  it("marks Anthropic-compatible message protocol as requiring an output cap", () => {
    const capability = resolveOutputCapCapability({
      id: "claude-compatible",
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
    });
    expect(capability).toMatchObject({
      id: "anthropic-messages",
      required: true,
      preserveImplicitSdkDefault: true,
    });
  });

  it("marks official DeepSeek as owned by the DeepSeek provider compat path", () => {
    const capability = resolveOutputCapCapability({
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(capability).toMatchObject({
      id: "official-deepseek",
      required: false,
      preserveImplicitSdkDefault: true,
    });
  });
});

describe("resolveOutputBudgetPolicy", () => {
  it("bounds SDK-default chat caps to Hana's 64K target", () => {
    const policy = resolveOutputBudgetPolicy({
      id: "deepseek-v4-flash",
      provider: "dashscope",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat", outputBudgetSource: "sdk-default" });

    expect(policy).toMatchObject({
      mode: "chat",
      source: "sdk-default",
      preserveForSource: false,
      applyChatDefault: true,
      defaultMaxTokens: 65536,
      modelLimit: 384000,
      capability: {
        id: "default-optional",
        required: false,
        preserveImplicitSdkDefault: false,
      },
    });
  });

  it("preserves system-owned chat caps even when the value equals the SDK default", () => {
    const policy = resolveOutputBudgetPolicy({
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat", outputBudgetSource: "system" });

    expect(policy).toMatchObject({
      source: "system",
      preserveForSource: true,
      applyChatDefault: false,
      modelLimit: 384000,
    });
  });

  it("marks protocol-required output caps as non-removable regardless of source", () => {
    const policy = resolveOutputBudgetPolicy({
      id: "claude-compatible",
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
      maxTokens: 128000,
    }, { mode: "chat", outputBudgetSource: "sdk-default" });

    expect(policy).toMatchObject({
      source: "sdk-default",
      preserveForSource: false,
      applyChatDefault: true,
      defaultMaxTokens: 65536,
      capability: {
        id: "anthropic-messages",
        required: true,
        preserveImplicitSdkDefault: true,
      },
    });
  });
});

describe("normalizeProviderPayload — 通用层", () => {
  it("剥离空 tools 数组（dashscope/volcengine 兼容）", () => {
    const payload = {
      model: "qwen3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const result = normalizeProviderPayload(payload, { provider: "dashscope" });
    expect(result).not.toHaveProperty("tools");
  });

  it("剥离未声明 thinking 格式的 provider thinking 字段", () => {
    const payload = {
      model: "custom-chat",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, {
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
      reasoning: false,
      compat: { supportsDeveloperRole: false },
    });
    expect(result).not.toHaveProperty("thinking");
  });

  it("Kimi Coding 这类 Anthropic-compatible reasoning 模型保留 thinking", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    };
    const result = normalizeProviderPayload(payload, {
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { supportsDeveloperRole: false, thinkingFormat: "anthropic" },
    });
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("MiniMax Anthropic-compatible reasoning 模型保留 thinking", () => {
    const payload = {
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    const result = normalizeProviderPayload(payload, {
      provider: "minimax",
      api: "anthropic-messages",
      reasoning: true,
      compat: { supportsDeveloperRole: false, thinkingFormat: "anthropic" },
    });
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("Kimi Anthropic-compatible utility 请求显式关闭 thinking", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "describe image" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    };
    const result = normalizeProviderPayload(payload, {
      id: "kimi-k2.6",
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { supportsDeveloperRole: false, thinkingFormat: "anthropic" },
    }, { mode: "utility" });
    expect(result).not.toBe(payload);
    expect(result.thinking).toEqual({ type: "disabled" });
  });

  it("anthropic 模型保留 thinking", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, { provider: "anthropic" });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("无 model 信息时保留 thinking 不误删", () => {
    const payload = {
      model: "unknown",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, null);
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("把 SDK 从模型能力投影出的 chat 输出上限收紧到 64K", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      max_completion_tokens: 384000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-flash",
      provider: "dashscope",
      api: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      maxTokens: 384000,
    }, { mode: "chat", reasoningLevel: "high" });
    expect(result).not.toBe(payload);
    expect(result.max_completion_tokens).toBe(65536);
    expect(result).not.toHaveProperty("max_tokens");
    expect(result.reasoning_effort).toBe("high");
    expect(payload.max_completion_tokens).toBe(384000);
  });

  it("模型能力低于 64K 时保留更小的真实能力上限", () => {
    const payload = {
      model: "custom-small-output",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 8192,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-small-output",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 8192,
    }, { mode: "chat" });
    expect(result.max_completion_tokens).toBe(8192);
    expect(payload.max_completion_tokens).toBe(8192);
  });

  it("chat serializer 没有给 output cap 时也补上 64K 默认值", () => {
    const payload = {
      model: "custom-large-output",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-large-output",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 262144,
    }, { mode: "chat" });
    expect(result.max_tokens).toBe(65536);
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("Responses serializer 只有 input 时也补上 64K 默认值", () => {
    const result = normalizeProviderPayload({
      model: "custom-responses-model",
      input: [{ role: "user", content: "hi" }],
    }, {
      id: "custom-responses-model",
      provider: "openai-compatible",
      api: "openai-responses",
      maxTokens: 262144,
    }, { mode: "chat" });

    expect(result.max_output_tokens).toBe(65536);
  });

  it("保留 SDK 按剩余上下文收紧后的更小输出预算，不反向抬高", () => {
    const payload = {
      model: "custom-large-output",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 20000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-large-output",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 262144,
    }, { mode: "chat", outputBudgetSource: "sdk-default" });
    expect(result.max_completion_tokens).toBe(20000);
  });

  it("保留用户或调用方显式给出的非 SDK 默认输出上限", () => {
    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 12000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat" });
    expect(result).toBe(payload);
    expect(result.max_completion_tokens).toBe(12000);
  });

  it("保留系统显式给出的输出上限，即使数值等于 SDK 隐式默认", () => {
    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat", outputBudgetSource: "system" });
    expect(result).toBe(payload);
    expect(result.max_completion_tokens).toBe(32000);
  });

  it("保留用户显式给出的输出上限，即使数值等于 SDK 隐式默认", () => {
    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat", outputBudgetSource: "user" });
    expect(result).toBe(payload);
    expect(result.max_completion_tokens).toBe(32000);
  });

  it("显式标记为 SDK 默认来源时把模型能力值收紧到 64K", () => {
    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 384000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 384000,
    }, { mode: "chat", outputBudgetSource: "sdk-default" });
    expect(result.max_completion_tokens).toBe(65536);
  });

  it("协议必填 provider 也使用 64K chat 默认值", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "claude-opus-4-7",
      provider: "anthropic",
      api: "anthropic-messages",
      maxTokens: 128000,
    }, { mode: "chat" });
    expect(result.max_tokens).toBe(65536);
    expect(payload.max_tokens).toBe(128000);
  });

  it("自定义 Anthropic-compatible provider 也使用 64K chat 默认值", () => {
    const payload = {
      model: "claude-compatible",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "claude-compatible",
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
      maxTokens: 128000,
      compat: { thinkingFormat: "anthropic" },
    }, { mode: "chat" });
    expect(result.max_tokens).toBe(65536);
    expect(payload.max_tokens).toBe(128000);
  });

  it("用户显式选择可以高于 64K，但不会超过模型声明的真实上限", () => {
    const payload = {
      model: "custom-model",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 262144,
    };
    const result = normalizeProviderPayload(payload, {
      id: "custom-model",
      provider: "openai-compatible",
      api: "openai-completions",
      maxTokens: 131072,
    }, { mode: "chat", outputBudgetSource: "user" });
    expect(result.max_completion_tokens).toBe(131072);
    expect(payload.max_completion_tokens).toBe(262144);
  });

  it("协议必填输出上限缺失时从 resolved model maxTokens 补齐", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = normalizeProviderPayload(payload, {
      id: "kimi-k2.6",
      provider: "kimi-coding",
      api: "anthropic-messages",
      maxTokens: 98304,
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    }, { mode: "utility" });
    expect(result).not.toBe(payload);
    expect(result.max_tokens).toBe(98304);
  });

  it("官方 DeepSeek 只把输出预算搬到官方字段名，不改数值", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: true,
      maxTokens: 384000,
    }, { mode: "chat", reasoningLevel: "high" });
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result.max_tokens).toBe(32000);
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("OpenRouter DeepSeek / MiMo 保留 OpenRouter reasoning 协议，不误套官方补丁", () => {
    for (const model of [
      {
        id: "deepseek/deepseek-v3.2",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        maxTokens: 163840,
        compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
      },
      {
        id: "xiaomi/mimo-v2-flash",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
      },
    ]) {
      const payload = {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "high" },
        max_completion_tokens: model.maxTokens,
      };
      const result = normalizeProviderPayload(payload, model, {
        mode: "chat",
        reasoningLevel: "high",
        outputBudgetSource: "sdk-default",
      });

      expect(result.reasoning).toEqual({ effort: "high" });
      expect(result).not.toHaveProperty("thinking");
      expect(result).not.toHaveProperty("reasoning_effort");
      expect(result).not.toHaveProperty("chat_template_kwargs");
      expect(result.max_completion_tokens).toBe(Math.min(model.maxTokens, 65536));

      const offPayload = {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "none" },
      };
      const offResult = normalizeProviderPayload(offPayload, model, {
        mode: "chat",
        reasoningLevel: "off",
      });
      expect(offResult.reasoning).toEqual({ effort: "none" });
      expect(offResult).not.toHaveProperty("reasoning_effort");
    }
  });

  it.each([
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
  ])("OpenRouter %s adaptive thinking 用 verbosity 控制 effort，不发送无效 reasoning.effort", (modelId) => {
    const payload = {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "medium" },
      thinking: { type: "enabled", budget_tokens: 8192 },
      max_completion_tokens: 128000,
    };
    const model = {
      id: modelId,
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      maxTokens: 128000,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
        reasoningProfile: "openrouter-anthropic-adaptive",
      },
    };

    const result = normalizeProviderPayload(payload, model, {
      mode: "chat",
      reasoningLevel: "xhigh",
      outputBudgetSource: "sdk-default",
    });

    expect(result).not.toBe(payload);
    expect(result.verbosity).toBe("max");
    expect(result.reasoning).toEqual({ enabled: true });
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_completion_tokens).toBe(65536);
    expect(payload.reasoning).toEqual({ effort: "medium" });
  });

  it("OpenRouter Claude Fable adaptive thinking 显式 off 时 fail closed", () => {
    expect(() => normalizeProviderPayload({
      model: "anthropic/claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
    }, {
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
        reasoningProfile: "openrouter-anthropic-adaptive",
      },
    }, {
      mode: "chat",
      reasoningLevel: "off",
    })).toThrow(/does not support disabling adaptive thinking/);
  });

  it("DashScope Qwen video models convert SDK image_url data:video blocks to video_url", () => {
    const payload = {
      model: "qwen3-vl-plus",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看一下这段视频" },
          { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }, { mode: "chat" });

    expect(result).not.toBe(payload);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "看一下这段视频" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ]);
    expect(payload.messages[0].content[1].type).toBe("image_url");
  });

  it("DashScope Qwen video conversion composes with utility enable_thinking=false", () => {
    const payload = {
      model: "qwen3-vl-plus",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:video/webm;base64,AAAA" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
      quirks: ["enable_thinking"],
    }, { mode: "utility" });

    expect(result.enable_thinking).toBe(false);
    expect(result.messages[0].content[0]).toEqual({
      type: "video_url",
      video_url: { url: "data:video/webm;base64,AAAA" },
    });
  });

  it("MiMo official video models convert SDK image_url data:video blocks to video_url", () => {
    const payload = {
      model: "mimo-v2.5",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看一下这段视频" },
          { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "mimo-v2.5",
      provider: "mimo",
      api: "openai-completions",
      input: ["text", "image"],
      video: true,
      audio: true,
      baseUrl: "https://api.xiaomimimo.com/v1",
    }, { mode: "chat" });

    expect(result).not.toBe(payload);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "看一下这段视频" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
    ]);
  });

  it("Zhipu payloads remove OpenAI-only fields and normalize reasoning/output controls", () => {
    const payload = {
      model: "glm-4.7-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          strict: true,
          parameters: {
            type: "object",
            properties: {},
          },
        },
      }],
      store: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      max_completion_tokens: 32000,
    };

    const result = normalizeProviderPayload(payload, {
      id: "glm-4.7-flash",
      provider: "zhipu",
      api: "openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "high", outputBudgetSource: "system" });

    expect(result).not.toBe(payload);
    expect(result).not.toHaveProperty("store");
    expect(result).not.toHaveProperty("stream_options");
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_tokens).toBe(32000);
    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.tools[0].function).not.toHaveProperty("strict");
    expect(payload.store).toBe(true);
    expect(payload.tools[0].function.strict).toBe(true);
  });

  it("Zhipu utility payloads explicitly disable thinking instead of falling back to hidden provider defaults", () => {
    const payload = {
      model: "glm-4.7-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      max_completion_tokens: 100,
    };

    const result = normalizeProviderPayload(payload, {
      id: "glm-4.7-flash",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      reasoning: true,
    }, { mode: "utility" });

    expect(result).toMatchObject({
      max_tokens: 100,
      thinking: { type: "disabled" },
    });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("max_completion_tokens");
  });

  it("OpenCode Go GLM first-turn payload enables thinking without clear_thinking", () => {
    const payload = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, {
      id: "glm-5.2",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      compat: { thinkingFormat: "zhipu", reasoningProfile: "zhipu-openai" },
    }, { mode: "chat", reasoningLevel: "high" });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("thinking");
  });

  it("OpenCode Go GLM replay preserves reasoning_content without clear_thinking=false", () => {
    const payload = {
      model: "glm-5.2",
      messages: [
        { role: "user", content: "需要查天气" },
        {
          role: "assistant",
          content: [{
            type: "thinking",
            thinking: "Need to call the weather tool.",
            thinkingSignature: "reasoning_content",
          }],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        { role: "user", content: "继续" },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, {
      id: "glm-5.2",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      compat: { thinkingFormat: "zhipu", reasoningProfile: "zhipu-openai" },
    }, { mode: "chat", reasoningLevel: "high" });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.thinking).not.toHaveProperty("clear_thinking");
    expect(result.messages[1]).toMatchObject({
      content: "",
      reasoning_content: "Need to call the weather tool.",
    });
    expect(payload.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("Zhipu GLM replay still sends clear_thinking=false for preserved thinking", () => {
    const payload = {
      model: "glm-5.2",
      messages: [
        { role: "user", content: "需要查天气" },
        {
          role: "assistant",
          content: [{
            type: "thinking",
            thinking: "Need to call the weather tool.",
            thinkingSignature: "reasoning_content",
          }],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        { role: "user", content: "继续" },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, {
      id: "glm-5.2",
      provider: "zhipu-coding",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      reasoning: true,
      compat: { thinkingFormat: "zhipu", reasoningProfile: "zhipu-openai" },
    }, { mode: "chat", reasoningLevel: "high" });

    expect(result.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(result.messages[1]).toHaveProperty("reasoning_content", "Need to call the weather tool.");
  });
});

describe("normalizeProviderPayload — DeepSeek Anthropic 模式", () => {
  const deepseekAnthropicModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    reasoning: true,
    maxTokens: 384000,
    compat: { thinkingFormat: "anthropic", reasoningProfile: "deepseek-v4-anthropic" },
  };

  it("xhigh 映射到 Anthropic 格式 output_config.effort=max，且不泄漏 OpenAI reasoning_effort", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" },
      reasoning_effort: "high",
      max_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).not.toBe(payload);
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(result.output_config).toEqual({ effort: "max" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_tokens).toBe(32000);
    expect(payload).toHaveProperty("reasoning_effort", "high");
  });

  it("high 映射到 Anthropic 格式 output_config.effort=high", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    };
    const result = normalizeProviderPayload(payload, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "high",
    });
    expect(result.output_config).toEqual({ effort: "high" });
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("off 显式关闭 Anthropic thinking，并移除 output_config / reasoning_effort", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
      output_config: { effort: "max" },
      reasoning_effort: "max",
    };
    const result = normalizeProviderPayload(payload, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "off",
    });
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("output_config");
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("Kimi Anthropic-compatible payload 不被加 DeepSeek output_config", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    };
    const result = normalizeProviderPayload(payload, {
      id: "kimi-k2.6",
      provider: "kimi-coding",
      api: "anthropic-messages",
      reasoning: true,
      compat: { thinkingFormat: "anthropic" },
    }, { mode: "chat", reasoningLevel: "xhigh" });
    expect(result).not.toBe(payload);
    expect(result.max_tokens).toBe(65536);
    expect(result).not.toHaveProperty("output_config");
  });
});

describe("normalizeProviderContextMessages — DeepSeek Anthropic replay", () => {
  const deepseekAnthropicModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    reasoning: true,
    compat: { thinkingFormat: "anthropic", reasoningProfile: "deepseek-v4-anthropic" },
  };

  it("thinking 开启时，Anthropic tool replay 缺少非空 thinking 原文会 fail closed", () => {
    const messages = [
      { role: "user", content: "look up date" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "sig" },
          { type: "toolCall", id: "call_1", name: "date", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "date", content: [{ type: "text", text: "ok" }] },
    ];
    expect(() => normalizeProviderContextMessages(messages, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "high",
    })).toThrow(/DeepSeek.*Anthropic.*thinking.*tool/);
  });

  it("thinking 开启且 tool replay 有非空 thinking 原文时不改消息引用", () => {
    const messages = [
      { role: "user", content: "look up date" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "need date", thinkingSignature: "sig" },
          { type: "toolCall", id: "call_1", name: "date", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "date", content: [{ type: "text", text: "ok" }] },
    ];
    expect(normalizeProviderContextMessages(messages, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "high",
    })).toBe(messages);
  });

  it("thinking off 时不校验 Anthropic tool replay", () => {
    const messages = [
      { role: "user", content: "look up date" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "date", arguments: {} },
        ],
      },
    ];
    expect(normalizeProviderContextMessages(messages, deepseekAnthropicModel, {
      mode: "chat",
      reasoningLevel: "off",
    })).toBe(messages);
  });
});

describe("normalizeProviderContextMessages — MCP resource projection", () => {
  it("projects toolResult resource.text blocks into model-visible text without mutating input", () => {
    const textBlock = { type: "text", text: "plain tool output" };
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "file:///workspace/note.md",
        name: "note.md",
        mimeType: "text/markdown",
        text: "# Notes\nUse this context.",
      },
    };
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_resource",
        content: [textBlock, resourceBlock],
      },
    ];

    const result = normalizeProviderContextMessages(messages, {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
    }, { mode: "chat" });

    expect(result).not.toBe(messages);
    expect(result[0]).not.toBe(messages[0]);
    expect(result[0].content[0]).toBe(textBlock);
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: expect.stringContaining("# Notes\nUse this context."),
    });
    expect(result[0].content[1].text).toContain("uri: file:///workspace/note.md");
    expect(result[0].content[1].text).toContain("name: note.md");
    expect(result[0].content[1].text).toContain("mimeType: text/markdown");
    expect(messages[0].content[1]).toBe(resourceBlock);
  });

  it("uses a text placeholder for resource.blob without injecting base64", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_resource",
        content: [{
          type: "resource",
          resource: {
            uri: "file:///workspace/pixel.png",
            name: "pixel.png",
            mimeType: "image/png",
            blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          },
        }],
      },
    ];

    const result = normalizeProviderContextMessages(messages, null, { mode: "chat" });
    const text = result[0].content[0].text;

    expect(result).not.toBe(messages);
    expect(text).toContain("uri: file:///workspace/pixel.png");
    expect(text).toContain("name: pixel.png");
    expect(text).toContain("mimeType: image/png");
    expect(text).toContain("binary resource omitted");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(messages[0].content[0].resource.blob).toContain("iVBORw0KGgo");
  });

  it("leaves non-toolResult resource blocks untouched", () => {
    const messages = [
      {
        role: "user",
        content: [{
          type: "resource",
          resource: {
            uri: "file:///workspace/user.md",
            name: "user.md",
            mimeType: "text/markdown",
            text: "do not project here",
          },
        }],
      },
    ];

    expect(normalizeProviderContextMessages(messages, null, { mode: "chat" })).toBe(messages);
  });
});

describe("normalizeProviderPayload — DeepSeek chat 模式", () => {
  const deepseekModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    reasoning: true,
    maxTokens: 384000,
  };

  it("非 DeepSeek 模型不动 DeepSeek 专用字段", () => {
    const payload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, { provider: "openai", reasoning: true }, { mode: "chat" });
    expect(result.reasoning_effort).toBe("medium");
    expect(result.max_completion_tokens).toBe(32000);
  });

  it("通用 OpenAI-compatible provider 移除关闭型 reasoning_effort", () => {
    const payload = {
      model: "minimax-m2.5",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "none",
    };
    const result = normalizeProviderPayload(payload, {
      id: "minimax-m2.5",
      provider: "scnet",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "none" });
    expect(result).not.toBe(payload);
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(payload.reasoning_effort).toBe("none");
  });

  it("DeepSeek 无工具思考请求把预算搬到官方 max_tokens 字段", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, { mode: "chat" });
    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "deepseek-v4-pro",
      // medium 由服务端自己映射到 high，兼容层不代劳。
      reasoning_effort: "medium",
      max_tokens: 32000,
    });
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(payload).toHaveProperty("max_completion_tokens", 32000);
  });

  it("DeepSeek V4 xhigh 会按官方兼容规则转成 max", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 32000,
    });
  });

  it("DeepSeek low 是官方有效档位，不被吞成 high", () => {
    // 官方 reasoning_effort 取值为 low / high / max，吞掉 low 等于让用户少一档，
    // 且被迫用更贵更慢的档位。
    const result = normalizeProviderPayload({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100_000,
    }, deepseekModel, { mode: "chat", reasoningLevel: "low" });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });

  it("DeepSeek minimal 是 OpenAI 专有档位，归到最接近的 low", () => {
    const result = normalizeProviderPayload({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "minimal",
      max_tokens: 100_000,
    }, deepseekModel, { mode: "chat" });
    expect(result.reasoning_effort).toBe("low");
  });

  it("DeepSeek V4 把默认预算限制到 64K，但不抬高 SDK 已按剩余窗口收紧的值", () => {
    // SDK 的 clampMaxTokensToContext 已经取过 min(模型上限, 剩余窗口 - 安全余量)，
    // 兼容层拿不到真实 token 数。放大只会把请求推过 1M 总窗口的边界，而且恰好
    // 发生在剩余窗口最紧张的时候。思考档位与能输出多长是两个正交的维度。
    for (const [level, effort] of [["high", "high"], ["xhigh", "max"]]) {
      for (const cap of [20_000, 65_536, 384_000]) {
        const result = normalizeProviderPayload({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: cap,
        }, deepseekModel, { mode: "chat", reasoningLevel: level });
        expect(result).toMatchObject({
          thinking: { type: "enabled" },
          reasoning_effort: effort,
          max_tokens: Math.min(cap, 65536),
        });
      }
    }
  });

  it("DeepSeek 模型输出上限小也不替用户关思考", () => {
    // 官方对思考模式没有 max_tokens 最小值要求，凭空设阈值只会让用户选的档位失效。
    const result = normalizeProviderPayload({
      model: "deepseek-small",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8000,
    }, { ...deepseekModel, maxTokens: 8192 }, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 8000,
    });
  });

  it("DeepSeek V4 off 会显式关闭官方思考模式", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "off",
    });
    expect(result).toMatchObject({ thinking: { type: "disabled" } });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_tokens).toBe(32000);
  });

  it("DeepSeek 已经足够大的 max_tokens 不被放大", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      max_tokens: 50000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, { mode: "chat" });
    expect(result.max_tokens).toBe(50000);
  });

  it("DeepSeek V4 工具请求保留官方思考协议和 reasoning_content", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "look up date" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Need to call the date tool.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "2026-04-24" },
      ],
      tools: [{ type: "function", function: { name: "date", parameters: { type: "object" } } }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 32000,
    });
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result.messages[1]).toHaveProperty("reasoning_content", "Need to call the date tool.");
    expect(payload.messages[1]).toHaveProperty("reasoning_content");
  });

  it("DeepSeek v4 即使缺少本地 reasoning 标记，也按默认思考模式防护", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "look up date" }],
      tools: [{ type: "function", function: { name: "date", parameters: { type: "object" } } }],
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
    }, { mode: "chat" });
    // 请求完全没带预算：供应商默认只给 4K，思考链一开正文就没了，这里补兜底值。
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      max_tokens: 65536,
    });
  });
});

describe("normalizeProviderPayload — DeepSeek utility 模式", () => {
  const deepseekV4 = {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    reasoning: true,
    maxTokens: 384000,
  };

  it("utility 模式下 DeepSeek reasoning 模型主动 disableThinking（避免短输出耗光思考预算）", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    };
    const result = normalizeProviderPayload(payload, deepseekV4, { mode: "utility" });
    expect(result).toMatchObject({ thinking: { type: "disabled" } });
    // utility 不放大 max_tokens：保留调用方传入的 50
    expect(result.max_tokens).toBe(50);
  });

  it("utility 模式下普通 DeepSeek 非 reasoning 模型不被改", () => {
    const payload = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-chat",
      provider: "deepseek",
      reasoning: false,
    }, { mode: "utility", reasoningLevel: "high" });
    expect(result).not.toHaveProperty("thinking");
    expect(result.max_tokens).toBe(100);
  });

  it("不传 mode 时按 chat 处理，不套用 utility 的关思考规则", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    };
    const result = normalizeProviderPayload(payload, deepseekV4);
    expect(result.thinking).toEqual({ type: "enabled" });
    // 调用方显式声明的预算就是意图，兼容层不替它改主意。
    expect(result.max_tokens).toBe(50);
  });

  it("utility 模式尊重自定义 provider 显式声明的 DeepSeek thinking format", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 80,
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-pro",
      provider: "opencode-go",
      api: "openai-completions",
      reasoning: true,
      maxTokens: 384000,
      compat: { thinkingFormat: "deepseek" },
    }, { mode: "utility" });

    expect(result).toMatchObject({ thinking: { type: "disabled" } });
    expect(result.max_tokens).toBe(80);
  });
});

describe("normalizeProviderPayload — 边界条件", () => {
  it("payload 非对象时原样返回", () => {
    expect(normalizeProviderPayload(null, { provider: "deepseek" })).toBe(null);
    expect(normalizeProviderPayload(undefined, { provider: "deepseek" })).toBe(undefined);
  });

  it("无 messages 字段的 DeepSeek payload 不抛错", () => {
    const payload = { model: "deepseek-v4-pro" };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      reasoning: true,
    }, { mode: "chat" });
    // 没 messages 数组，DeepSeek 兼容层直接放过
    expect(result).toBe(payload);
  });
});

describe("normalizeProviderPayload — 孤儿 toolResult 配对兜底（#1285，通用补丁）", () => {
  it("DeepSeek payload 里父 tool_calls 已丢失的孤儿 role:tool 被删除", () => {
    // 复现 #1285：error assistant 被 SDK transform-messages 丢弃后，序列化 payload
    // 里残留孤儿 role:"tool"，DeepSeek 会返回 400。
    const payload = {
      model: "deepseek-chat",
      messages: [
        { role: "user", content: "调用工具" },
        { role: "tool", tool_call_id: "call_orphan", content: "工具结果" },
        { role: "user", content: "继续" },
      ],
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: false,
    }, { mode: "chat" });

    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "user"]);
    // 不可变契约：返回新对象，不 mutate 输入
    expect(payload.messages).toHaveLength(3);
  });

  it("普通 OpenAI-compatible provider 同样剥离孤儿（provider-agnostic）", () => {
    const payload = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "q" },
        { role: "tool", tool_call_id: "ghost", content: "orphan" },
        { role: "assistant", content: "answer" },
      ],
    };
    const result = normalizeProviderPayload(payload, {
      id: "gpt-4o",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
    }, { mode: "chat" });
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("正常成对 toolCall+toolResult 序列原样保留（关键回归保护）", () => {
    const payload = {
      model: "deepseek-chat",
      messages: [
        { role: "user", content: "今天几号" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "2026-05-29" },
        { role: "assistant", content: "今天是 2026-05-29" },
      ],
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: false,
    }, { mode: "chat" });
    // 成对序列：tool 消息全部保留
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(result.messages.find((m) => m.role === "tool").tool_call_id).toBe("call_1");
  });

  it("混合场景：删孤儿、留成对", () => {
    const payload = {
      model: "deepseek-chat",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [{ id: "good", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "good", content: "ok" },
        { role: "tool", tool_call_id: "orphan", content: "leftover" },
        { role: "user", content: "继续" },
      ],
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: false,
    }, { mode: "chat" });
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].tool_call_id).toBe("good");
  });
});
