import { describe, expect, it } from "vitest";
import { normalizeProviderPayload } from "../../core/provider-compat.ts";

describe("provider-compat/openai-input-audio", () => {
  it("converts OpenAI audio model data URLs to input_audio parts", () => {
    const model = {
      id: "gpt-audio-mini",
      provider: "openai",
      api: "openai-completions",
      input: ["text"],
      audio: true,
    };
    const payload = {
      model: "gpt-audio-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "image_url", image_url: { url: "data:audio/mpeg;base64,//uQZAAA" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, model, { mode: "chat" });

    expect(result.messages[0].content).toEqual([
      { type: "text", text: "listen" },
      {
        type: "input_audio",
        input_audio: {
          data: "//uQZAAA",
          format: "mp3",
        },
      },
    ]);
    expect(payload.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:audio/mpeg;base64,//uQZAAA" },
    });
  });

  it("leaves text-only media parts unchanged while applying the chat output budget", () => {
    const model = {
      id: "gpt-4o",
      provider: "openai",
      api: "openai-completions",
      input: ["text", "image"],
    };
    const payload = {
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:audio/wav;base64,UklGRg==" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, model, { mode: "chat" });
    expect(result).toEqual({ ...payload, max_tokens: 65_536 });
    expect(result.messages).toEqual(payload.messages);
  });

  it("fails closed for unsupported input_audio data URL formats on native audio transports", () => {
    const model = {
      id: "gpt-audio-mini",
      provider: "openai",
      api: "openai-completions",
      input: ["text"],
      audio: true,
    };
    const payload = {
      model: "gpt-audio-mini",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:audio/ogg;base64,T2dnUw==" } },
        ],
      }],
    };

    expect(() => normalizeProviderPayload(payload, model, { mode: "chat" }))
      .toThrow(/unsupported input_audio format.*audio\/ogg/);
  });
});
