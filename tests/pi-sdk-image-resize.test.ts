/**
 * 回归测试：门面 resizeModelImageInput 对 Pi SDK resizeImage 的签名适配。
 *
 * 背景（2026-07-08，pi 0.80.3 升级）：上游 resizeImage 签名从
 * `(img: ImageContent, options?)` 变为 `(inputBytes: Uint8Array, mimeType, options?)`
 * 且内部吞错返回 null。门面若按旧约定透传 image 对象，得到 null，
 * 下游 core/model-image-preprocess.ts 会把所有图片输入误报为
 * "could not be compressed"。本测试不 mock SDK，直接走真实包，
 * 专门捕捉这类签名漂移。
 */
import { describe, expect, it } from "vitest";
import {
  resizeModelImageInput,
  formatModelImageDimensionNote,
} from "../lib/pi-sdk/index.ts";

// 8x8 RGB 渐变 PNG（164 字节，程序生成后硬编码）
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAa0lEQVR42g3JQQEAMAgDMZwgpVIqhXOCFKTUypZvqoouVLiYYosrUlQ13ahxM80216R/iBYSFiNWnIh+mDYyNmPWnIl/DD1o8DDDDjdkfiy9aPEyyy63ZH8cfejwMcced+R+hA4KDhM2XEh4nZNXkTSLioEAAAAASUVORK5CYII=";

describe("pi-sdk resizeModelImageInput signature adapter", () => {
  it("resizes an oversized image and returns the ResizedImage contract", async () => {
    const result = await resizeModelImageInput(
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      { maxWidth: 4, maxHeight: 4 },
    );

    expect(result).not.toBeNull();
    expect(typeof result.data).toBe("string");
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.mimeType).toMatch(/^image\//);
    expect(result.originalWidth).toBe(8);
    expect(result.originalHeight).toBe(8);
    expect(result.width).toBeLessThanOrEqual(4);
    expect(result.height).toBeLessThanOrEqual(4);
    expect(result.wasResized).toBe(true);

    const note = formatModelImageDimensionNote(result);
    expect(typeof note).toBe("string");
    expect(note).toContain("8x8");
  });

  it("passes through an image already within bounds without resizing", async () => {
    const result = await resizeModelImageInput(
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      { maxWidth: 64, maxHeight: 64 },
    );

    expect(result).not.toBeNull();
    expect(result.wasResized).toBe(false);
    expect(result.originalWidth).toBe(8);
    expect(result.originalHeight).toBe(8);
    // 未缩放时 pi 的 formatDimensionNote 约定返回 undefined
    expect(formatModelImageDimensionNote(result)).toBeUndefined();
  });
});
