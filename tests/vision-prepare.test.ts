import { describe, expect, it, vi } from "vitest";
import { AppError } from "../shared/errors.ts";
import { prepareVisionInputForTextOnlyModel } from "../core/vision-prepare.ts";

const textOnlyModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };
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
const passthroughPrepareModelImages = async ({ text, opts }) => ({ text, opts });

describe("prepareVisionInputForTextOnlyModel", () => {
  it("passes images through directly for official DeepSeek when the model is user-declared image capable", async () => {
    const prepare = vi.fn(async () => ({
      text: "vision notes\n\nwhat is this?",
      images: undefined,
    }));

    const images = [{ type: "image", data: "b64", mimeType: "image/png" }];
    const result = await prepareVisionInputForTextOnlyModel({
      targetModel: deepseekImageDeclaredModel,
      text: "what is this?",
      opts: { images },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => ({ prepare }),
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
      prepareModelImages: passthroughPrepareModelImages,
    } as any);

    expect(prepare).not.toHaveBeenCalled();
    expect(result.text).toBe("what is this?");
    expect(result.opts.images).toBe(images);
  });

  it("prepares image inputs before sending them to auxiliary vision", async () => {
    const prepareModelImages = vi.fn(async ({ text, opts }) => ({
      text: `dimension note\n${text}`,
      opts: {
        ...opts,
        images: [{ type: "image", data: "compressed-b64", mimeType: "image/jpeg" }],
        modelImageInputsPrepared: true,
      },
    }));
    const prepare = vi.fn(async () => ({
      text: "vision notes\n\nwhat is this?",
      images: undefined,
    }));

    const result = await prepareVisionInputForTextOnlyModel({
      targetModel: textOnlyModel,
      text: "what is this?",
      opts: { images: [{ type: "image", data: "large-b64", mimeType: "image/png" }] },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => ({ prepare }),
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
      prepareModelImages,
    } as any);

    expect(prepareModelImages).toHaveBeenCalledWith(expect.objectContaining({
      text: "what is this?",
      opts: expect.objectContaining({
        images: [{ type: "image", data: "large-b64", mimeType: "image/png" }],
      }),
    }));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      text: "dimension note\nwhat is this?",
      images: [{ type: "image", data: "compressed-b64", mimeType: "image/jpeg" }],
    }));
    expect(result.text).toBe("vision notes\n\nwhat is this?");
    expect(result.opts.images).toBeUndefined();
  });

  it("trusts user-declared image support for unknown providers", async () => {
    const images = [{ type: "image", data: "b64", mimeType: "image/png" }];
    const prepare = vi.fn();

    const result = await prepareVisionInputForTextOnlyModel({
      targetModel: customImageDeclaredModel,
      text: "what is this?",
      opts: { images },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => ({ prepare }),
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
    } as any);

    expect(prepare).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "what is this?", opts: { images } });
  });

  it("degrades recoverable auxiliary vision failures into an explicit text notice", async () => {
    const warn = vi.fn();
    const result = await prepareVisionInputForTextOnlyModel({
      targetModel: textOnlyModel,
      text: "[attached_image: /tmp/a.png]\nwhat is this?",
      opts: { images: [{ type: "image", data: "b64", mimeType: "image/png" }], imageAttachmentPaths: ["/tmp/a.png"] },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => ({
        prepare: vi.fn(async () => {
          throw new AppError("LLM_TIMEOUT");
        }),
      }),
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
      warn,
      prepareModelImages: passthroughPrepareModelImages,
    } as any);

    expect(result.opts.images).toEqual([]);
    expect(result.text).toMatch(/图片分析失败|Image analysis failed/);
    expect(result.text).toContain("[attached_image: /tmp/a.png]");
    expect(warn).toHaveBeenCalled();
  });

  it("fails closed for auxiliary vision configuration errors", async () => {
    await expect(prepareVisionInputForTextOnlyModel({
      targetModel: textOnlyModel,
      text: "what is this?",
      opts: { images: [{ type: "image", data: "b64", mimeType: "image/png" }] },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => null,
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
    } as any)).rejects.toThrow(/vision auxiliary model/i);
  });

  it("propagates user aborts instead of degrading them", async () => {
    const controller = new AbortController();
    const pending = prepareVisionInputForTextOnlyModel({
      targetModel: textOnlyModel,
      text: "what is this?",
      opts: { images: [{ type: "image", data: "b64", mimeType: "image/png" }] },
      sessionPath: "/tmp/session.jsonl",
      getVisionBridge: () => ({
        prepare: vi.fn(async () => {
          controller.abort();
          return { text: "ignored", images: [] };
        }),
      }),
      visionPolicyTarget: { isVisionAuxiliaryEnabled: () => true },
      signal: controller.signal,
      prepareModelImages: passthroughPrepareModelImages,
    } as any);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
