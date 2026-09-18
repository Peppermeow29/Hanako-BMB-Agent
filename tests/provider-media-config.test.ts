import { describe, expect, it } from "vitest";
import { normalizeProviderMediaConfigMap } from "../core/provider-media-config.ts";

describe("provider media config migration", () => {
  it("moves legacy image model entries out of chat models into media.image_generation", () => {
    const { providers, changed } = normalizeProviderMediaConfigMap({
      "openai-codex-oauth": {
        models: [
          "gpt-5.4",
          "gpt-5.5",
          { id: "gpt-image-2", type: "image", name: "GPT Image 2" },
        ],
      },
    });

    expect(changed).toBe(true);
    expect(providers["openai-codex-oauth"].models).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(providers["openai-codex-oauth"].media.image_generation.models).toEqual([
      { id: "gpt-image-2", name: "GPT Image 2", protocolId: "openai-codex-responses-image" },
    ]);
  });

  it("moves legacy string image models when known-model metadata marks them as image", () => {
    const { providers, changed } = normalizeProviderMediaConfigMap({
      openai: {
        models: ["gpt-5.5", "gpt-image-1.5"],
      },
    });

    expect(changed).toBe(true);
    expect((providers as any).openai.models).toEqual(["gpt-5.5"]);
    expect((providers as any).openai.media.image_generation.models).toEqual([
      { id: "gpt-image-1.5", protocolId: "openai-images" },
    ]);
  });

  it("moves custom provider image models without guessing a protocol at migration time", () => {
    // 自定义 provider 的 protocol 由 ProviderRegistry 读时根据 api/来源推断，
    // 迁移层不知道 provider 是否内置，不允许猜测
    const { providers, changed } = normalizeProviderMediaConfigMap({
      "my-proxy": {
        api_key: "proxy-key",
        base_url: "https://proxy.example.com/v1",
        models: [{ id: "flux-1.1-pro", type: "image" }],
      },
    });

    expect(changed).toBe(true);
    expect(providers["my-proxy"].models).toEqual([]);
    expect(providers["my-proxy"].media.image_generation.models).toEqual([
      { id: "flux-1.1-pro" },
    ]);
  });

  it("is idempotent when media models already use the new shape", () => {
    const input = {
      openai: {
        models: ["gpt-5.5"],
        media: {
          image_generation: {
            models: [{ id: "gpt-image-2", name: "GPT Image 2" }],
          },
        },
      },
    };

    const { providers, changed } = normalizeProviderMediaConfigMap(input);

    expect(changed).toBe(false);
    expect(providers).toEqual(input);
  });
});
