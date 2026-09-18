import { describe, expect, it, vi } from "vitest";
import {
  normalizeModelImageInput,
  prepareModelImageInputsForPrompt,
} from "../core/model-image-preprocess.ts";

const PNG_BASE64 = "iVBORw0KGgo=";
const JPEG_BASE64 = "/9j/2wBD";

describe("prepareModelImageInputsForPrompt", () => {
  it("resizes images before the model boundary and keeps dimension notes in the prompt", async () => {
    const resizeImage = vi.fn(async (image, options) => ({
      data: JPEG_BASE64,
      mimeType: "image/jpeg",
      originalWidth: 4000,
      originalHeight: 3000,
      width: 2000,
      height: 1500,
      wasResized: true,
      options,
    }));
    const formatDimensionNote = vi.fn((result) =>
      `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by 2.00 to map to original image.]`
    );

    const result = await prepareModelImageInputsForPrompt({
      text: "[attached_image: /tmp/design.png]\n你挑刺把，这个设计",
      opts: {
        images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/design.png"],
      },
      resizeImage,
      formatDimensionNote,
    });

    expect(resizeImage).toHaveBeenCalledWith(
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      expect.objectContaining({
        maxWidth: 2000,
        maxHeight: 2000,
        jpegQuality: 80,
        maxBytes: 4.5 * 1024 * 1024,
      })
    );
    expect(result.opts.images).toEqual([
      { type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
    ]);
    expect(result.opts.imageAttachmentPaths).toEqual(["/tmp/design.png"]);
    expect(result.opts.modelImageInputsPrepared).toBe(true);
    expect(result.text).toContain("[attached_image: /tmp/design.png]\n");
    expect(result.text).toContain('<file name="image-1">[Image: original 4000x3000, displayed at 2000x1500.');
    expect(result.text).toContain("你挑刺把，这个设计");
  });

  it("splits the total request budget across multiple images", async () => {
    const resizeImage = vi.fn(async (image) => ({
      data: image.data,
      mimeType: image.mimeType,
      originalWidth: 100,
      originalHeight: 100,
      width: 100,
      height: 100,
      wasResized: false,
    }));

    await prepareModelImageInputsForPrompt({
      text: "compare",
      opts: {
        images: [
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      },
      imagePolicy: {
        maxImageBase64Bytes: 100,
        totalBase64BudgetBytes: 36,
      },
      resizeImage,
      formatDimensionNote: vi.fn(),
    });

    expect(resizeImage).toHaveBeenCalledTimes(3);
    expect(resizeImage.mock.calls.map(([, options]: any) => options.maxBytes)).toEqual([12, 12, 12]);
  });

  it("fails closed when an image cannot be normalized", async () => {
    await expect(prepareModelImageInputsForPrompt({
      text: "inspect",
      opts: { images: [{ type: "image", data: "bad", mimeType: "image/png" }] },
      resizeImage: vi.fn(async () => null),
      formatDimensionNote: vi.fn(),
    })).rejects.toThrow(/image input preprocessing failed/i);
  });

  it("sniffs image bytes and corrects a mismatched declared mime type", () => {
    const normalized = normalizeModelImageInput({
      type: "image",
      data: `data:image/png;base64,${JPEG_BASE64}`,
      mimeType: "image/png",
    }, 0);

    expect(normalized).toEqual({
      type: "image",
      data: JPEG_BASE64,
      mimeType: "image/jpeg",
    });
  });

  it("rejects malformed base64 before provider serialization", () => {
    expect(() => normalizeModelImageInput({
      type: "image",
      data: "not-valid-base64!!!",
      mimeType: "image/png",
    }, 0)).toThrow(/image input preprocessing failed/i);
  });

  it("does not preprocess the same prompt twice", async () => {
    const resizeImage = vi.fn();
    const opts = {
      images: [{ type: "image", data: "ready", mimeType: "image/png" }],
      modelImageInputsPrepared: true,
    };

    const result = await prepareModelImageInputsForPrompt({
      text: "already prepared",
      opts,
      resizeImage,
      formatDimensionNote: vi.fn(),
    });

    expect(result).toEqual({ text: "already prepared", opts });
    expect(resizeImage).not.toHaveBeenCalled();
  });
});
