import { describe, expect, it } from "vitest";

import {
  MODEL_IMAGE_TRANSPORTS,
  modelSupportsDirectImageInput,
  modelSupportsImageInput,
  resolveModelImageInputTransport,
} from "../shared/model-capabilities.ts";

describe("model image capability transport", () => {
  it("keeps user-declared image support direct for unknown providers", () => {
    const model = {
      id: "custom-vision",
      provider: "custom",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://api.example.com/v1",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL);
    expect(modelSupportsDirectImageInput(model)).toBe(true);
  });

  it("trusts a model's explicit image capability declaration on the official DeepSeek endpoint", () => {
    const model = {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://api.deepseek.com",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL);
    expect(modelSupportsDirectImageInput(model)).toBe(true);
  });

  it("trusts user-declared image support for custom DeepSeek-compatible endpoints", () => {
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://vision-proxy.example.com/v1",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL);
    expect(modelSupportsDirectImageInput(model)).toBe(true);
  });

  it("does not infer image support when the model does not declare image input", () => {
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text"],
      baseUrl: "https://api.deepseek.com",
    };

    expect(modelSupportsImageInput(model)).toBe(false);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.NONE);
    expect(modelSupportsDirectImageInput(model)).toBe(false);
  });
});
