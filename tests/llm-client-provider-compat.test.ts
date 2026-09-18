import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { callText } from "../core/llm-client.ts";

function makeCodexJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function makeSseBody(blocks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
}

describe("callText provider-compat routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies response body read aborts from timeout as LLM_TIMEOUT", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        const err = new Error("body read aborted");
        err.name = "AbortError";
        throw err;
      },
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("裸 model id + opts.quirks 仍走 qwen utility 兼容层", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      quirks: ["enable_thinking"],
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.enable_thinking).toBe(false);
  });

  it("disables LongCat thinking for utility callText requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.longcat.chat/openai/v1",
      model: {
        id: "LongCat-2.0-Preview",
        provider: "longcat",
        api: "openai-completions",
        baseUrl: "https://api.longcat.chat/openai/v1",
        reasoning: true,
      },
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("uses the exact OpenCode Go DeepSeek buffered contract without exposing reasoning as text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: [{ type: "text", text: "memory compiled" }],
            reasoning: "private chain",
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: {
        id: "deepseek-v4-flash",
        provider: "opencode-go",
        api: "openai-completions",
        reasoning: true,
        compat: { thinkingFormat: "deepseek", outputCapField: "max_tokens" },
      },
      messages: [{ role: "user", content: "compile memory" }],
      maxTokens: 128,
      outputPolicy: "bounded",
      timeoutMs: 5_000,
    } as any)).resolves.toBe("memory compiled");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 128,
      thinking: { type: "disabled" },
    });
  });

  it("keeps provider-default output unbounded at Hana's request layer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: {
        id: "deepseek-v4-flash",
        provider: "opencode-go",
        reasoning: true,
        compat: { thinkingFormat: "deepseek", outputCapField: "max_tokens" },
      },
      messages: [{ role: "user", content: "compile memory" }],
      outputPolicy: "provider-default",
      timeoutMs: 5_000,
    } as any);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("fails closed for native APIs without a Hana buffered adapter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(callText({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: { id: "gemini-native", provider: "google", api: "google-generative-ai" },
      messages: [{ role: "user", content: "hi" }],
    } as any)).rejects.toThrow(/buffered adapter.*google-generative-ai/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits temperature from utility requests unless the caller sets it explicitly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "kimi-k2.5", provider: "moonshot", input: ["text", "image"] },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("temperature");
  });

  it("keeps explicit utility temperature values in the request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0);
  });

  it("sends MiniCPM5 local output and sampling settings in the final HTTP body", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const server = http.createServer(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    expect(address && typeof address !== "string").toBe(true);
    const port = (address as { port: number }).port;

    try {
      await callText({
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: {
          id: "default_model",
          provider: "minicpm5-local",
          api: "openai-completions",
          contextWindow: 32768,
          maxTokens: 4096,
          generation: {
            temperature: 0.25,
            topP: 0.82,
            topK: 32,
            minP: 0.04,
            repetitionPenalty: 1.08,
          },
        },
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 4096,
        timeoutMs: 5_000,
      } as any);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }

    expect(requestBody).toMatchObject({
      model: "default_model",
      max_tokens: 4096,
      temperature: 0.25,
      top_p: 0.82,
      top_k: 32,
      min_p: 0.04,
      repetition_penalty: 1.08,
    });
  });

  it("normalizes kimi-for-coding utility temperature before sending the payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
      model: {
        id: "kimi-for-coding",
        provider: "kimi-coding",
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
        reasoning: true,
        compat: {
          thinkingFormat: "kimi",
          reasoningProfile: "kimi-openai",
        },
      },
      messages: [{ role: "user", content: "summarize" }],
      temperature: 0.3,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.6);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("serializes MiMo audio content to provider-visible input_audio parts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        input: ["text", "image"],
        compat: { hanaAudioInput: true },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "[attached_audio: /tmp/voice.wav]\n听一下" },
          { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "听一下" },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("disables MiMo thinking for custom proxy utility requests inferred from model ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
      model: {
        id: "mimo-v2.5-pro",
        provider: "ch",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        reasoning: true,
        compat: { supportsDeveloperRole: false },
      },
      messages: [{ role: "user", content: "remember this" }],
      maxTokens: 80,
      timeoutMs: 5_000,
    } as any);

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://proxy.example.test/v1/chat/completions");
    expect(body.model).toBe("mimo-v2.5-pro");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });

  it("lets future OpenAI-compatible audio providers opt in through an explicit transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: {
        id: "deepseek-v4.1-audio",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        input: ["text"],
        compat: {
          hanaAudioInput: true,
          audioTransport: "openai-input-audio",
        },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "listen" },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("fails before fetch when OpenAI-compatible audio input uses an unsupported format", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        compat: { hanaAudioInput: true },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "audio", data: "T2dnUw==", mimeType: "audio/ogg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any)).rejects.toThrow(/unsupported OpenAI input_audio payload.*audio\/ogg/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not synthesize utility output caps from model capability metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps explicit utility output caps as task-owned request budgets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 80,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(80);
  });

  it("serializes image content for openai-compatible chat completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image_url", image_url: { url: "data:image/png;base64,BASE64" } },
    ]);
  });

  it("serializes image content for anthropic messages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-sonnet", provider: "anthropic", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "BASE64",
        },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("marks auxiliary vision calls as utility intent and disables Kimi Anthropic-compatible thinking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-k2.6",
        provider: "kimi-coding",
        api: "anthropic-messages",
        input: ["text", "image"],
        reasoning: true,
        compat: { thinkingFormat: "anthropic" },
      },
      callPurpose: "auxiliary_vision",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/jpeg", data: "BASE64" },
    });
  });

  it("adds cache_control to anthropic utility system prompts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      systemPrompt: "Stable writing system prompt",
      messages: [{ role: "user", content: "write" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([
      {
        type: "text",
        text: "Stable writing system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("forwards model request headers on utility requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-test",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-for-coding",
        provider: "kimi-coding",
        headers: { "User-Agent": "KimiCLI/1.5" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      "User-Agent": "KimiCLI/1.5",
      "x-api-key": "sk-test",
    });
  });

  it("uses a stable default User-Agent without overriding model headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "custom-model", provider: "custom" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-model",
        provider: "custom",
        headers: { "User-Agent": "ExistingClient/2.0" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("HanaAgent/1.0");
    expect(fetchMock.mock.calls[1][1].headers["User-Agent"]).toBe("ExistingClient/2.0");
  });

  it("lets provider request headers override protocol auth headers case-insensitively", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      apiKey: "sk-default",
      baseUrl: "https://gateway.example/v1",
      model: {
        id: "gateway-model",
        provider: "gateway-provider",
        headers: { authorization: "Gateway gateway-token" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const authHeaders = Object.entries(init.headers as Record<string, string>)
      .filter(([name]) => name.toLowerCase() === "authorization");
    expect(authHeaders).toEqual([["authorization", "Gateway gateway-token"]]);
  });

  it("keeps only the explicit Anthropic API key when header casing differs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      apiKey: "stale-default-key",
      baseUrl: "https://gateway.example",
      model: { id: "gateway-model", provider: "gateway-provider" },
      headers: { "X-API-Key": "explicit-gateway-key" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const apiKeyHeaders = Object.entries(init.headers as Record<string, string>)
      .filter(([name]) => name.toLowerCase() === "x-api-key");
    expect(apiKeyHeaders).toEqual([["X-API-Key", "explicit-gateway-key"]]);
  });

  it("does not append a duplicate v1 segment for Anthropic-compatible base URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-test",
      baseUrl: "https://anthropic-compatible.example/v1",
      model: { id: "claude-compatible", provider: "custom" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic-compatible.example/v1/messages");
  });

  it("keeps callText string-compatible by default and returns usage only when requested", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      } as any);

    const defaultResult = await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const detailedResult = await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
      returnUsage: true,
    } as any);

    expect(defaultResult).toBe("ok");
    expect(detailedResult).toEqual({
      text: "ok",
      usage: expect.objectContaining({
        input: { totalTokens: 100, uncachedTokens: 100 },
        output: { totalTokens: 20, reasoningTokens: null },
        cache: expect.objectContaining({
          readTokens: 80,
          writeTokens: 40,
          hit: true,
          created: true,
        }),
      }),
    });
  });

  it("classifies responses that become empty only after thinking cleanup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<think>The user asked for OK.</think>\n\n" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "MiniMax-M2.7", provider: "minimax", reasoning: true },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      message: "模型未回复正文，请检查思考内容或稍后重试。",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });

  it("classifies OpenAI-compatible message.reasoning without using it as utility text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: null, reasoning: "private chain" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: {
        id: "deepseek-v4-flash",
        provider: "opencode-go",
        reasoning: true,
        compat: { thinkingFormat: "deepseek" },
      },
      messages: [{ role: "user", content: "compile memory" }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      context: expect.objectContaining({ reason: "empty_after_thinking", stopReason: "stop" }),
    });
  });

  it("returns visible text after stripping a leading thinking block", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<think>The user asked for OK.</think>\n\nOK" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "MiniMax-M2.7", provider: "minimax", reasoning: true },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK");
  });

  it("classifies anthropic thinking-only content blocks as empty-after-thinking", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "thinking", thinking: "The answer is OK." }],
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        reasoning: true,
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      message: "模型未回复正文，请检查思考内容或稍后重试。",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });

  it("includes provider error details when the upstream rejects a request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_image",
          message: "Invalid request Error",
        },
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-k2.6",
        provider: "kimi-coding",
        api: "anthropic-messages",
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("Invalid request Error"),
      context: expect.objectContaining({
        provider: "kimi-coding",
        model: "kimi-k2.6",
        status: 400,
        errorType: "invalid_request_error",
        errorCode: "invalid_image",
      }),
    });
  });

  it("returns anthropic visible text while ignoring thinking content blocks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [
          { type: "thinking", thinking: "Need to answer briefly." },
          { type: "text", text: "OK" },
        ],
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        reasoning: true,
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK");
  });

  it("extracts Responses output_text content from message items without relying on role", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "OK from Responses" }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5.4-codex", provider: "openai-codex", accountId: "acct_123" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK from Responses");
  });

  it("sends Codex Responses utility requests to ChatGPT /codex/responses with account headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Codex " })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.4-codex",
        provider: "openai-codex-oauth",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Codex OK");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect((init.headers as any).Authorization).toBe("Bearer oauth-token");
    expect((init.headers as any)["chatgpt-account-id"]).toBe("acct_123");
    expect((init.headers as any)["OpenAI-Beta"]).toBe("responses=experimental");
    expect((init.headers as any).originator).toBe("pi");
    expect(JSON.parse(init.body as string)).toMatchObject({
      store: false,
      stream: true,
    });
  });

  it("always sends non-empty instructions for Codex Responses utility calls (#1664)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    } as any);

    await callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.4-codex",
        provider: "openai-codex-oauth",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.instructions).toEqual(expect.stringContaining("utility model"));
    expect(body.instructions.trim().length).toBeGreaterThan(0);
  });

  it("strips unsupported Codex Responses utility controls through provider-compat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    } as any);

    await callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.5",
        provider: "openai-codex-oauth",
        api: "openai-codex-responses",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      maxTokens: 1234,
      temperature: 0,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("maxOutputTokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.input).toEqual([{ role: "user", content: "Reply OK." }]);
  });

  it("derives the Codex account id from the OAuth token when the model omits it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    } as any);

    await callText({
      api: "openai-codex-responses",
      apiKey: makeCodexJwt("acct_from_token"),
      baseUrl: "https://chatgpt.com/backend-api/codex",
      model: { id: "gpt-5.4-codex", provider: "openai-codex-oauth" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers["chatgpt-account-id"]).toBe("acct_from_token");
  });

  it("fails closed when Codex Responses credentials do not carry an account id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "should not be called" }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      apiKey: "opaque-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: { id: "gpt-5.4-codex", provider: "openai-codex-oauth" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_AUTH_FAILED",
      message: expect.stringContaining("account id"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Responses top-level output_text extraction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Top-level OK" }),
    } as any);

    await expect(callText({
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5", provider: "openai" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Top-level OK");
  });

  it("preserves Responses assistant role message text extraction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Assistant role OK" }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5", provider: "openai" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Assistant role OK");
  });

  it("does not treat Responses non-message output as visible text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "reasoning",
          content: [{ type: "output_text", text: "Hidden reasoning is not a reply." }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5.4-codex", provider: "openai-codex", reasoning: true, accountId: "acct_123" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });
});
