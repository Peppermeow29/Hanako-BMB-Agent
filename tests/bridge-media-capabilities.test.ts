import { describe, expect, it } from "vitest";

import { createMediaCapabilities } from "../lib/bridge/media-capabilities.ts";
import { FEISHU_MEDIA_CAPABILITIES } from "../lib/bridge/feishu-adapter.ts";
import { WECHAT_ILINK_MEDIA_CAPABILITIES } from "../lib/bridge/wechat-adapter.ts";

describe("bridge media capabilities", () => {
  it("uses public source locators for built-in capability declarations", () => {
    expect(FEISHU_MEDIA_CAPABILITIES.source).toBe(
      "lib/bridge/feishu-adapter.ts#FEISHU_MEDIA_CAPABILITIES",
    );
    expect(WECHAT_ILINK_MEDIA_CAPABILITIES.source).toBe(
      "lib/bridge/wechat-adapter.ts#WECHAT_ILINK_MEDIA_CAPABILITIES",
    );
  });

  it("validates supported modes, kinds, and reply context requirements", () => {
    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["buffer"],
      supportedKinds: ["image"],
      requiresReplyContext: false,
      deliveryByKind: { image: "native_image" },
      source: "docs",
    })).not.toThrow();

    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["file_data"],
      supportedKinds: ["image"],
      requiresReplyContext: false,
      deliveryByKind: { image: "native_image" },
      source: "docs",
    })).toThrow(/inputModes/);

    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["buffer"],
      supportedKinds: ["sticker"],
      requiresReplyContext: false,
      deliveryByKind: { sticker: "native_image" },
      source: "docs",
    })).toThrow(/supportedKinds/);
  });


  it("declares Feishu as upload-key based with explicit size limits", () => {
    expect(FEISHU_MEDIA_CAPABILITIES).toMatchObject({
      platform: "feishu",
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: false,
      deliveryByKind: {
        image: "native_image",
        video: "native_file",
        audio: "native_file",
        document: "native_file",
      },
    });
    expect(FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.image).toBe(10 * 1024 * 1024);
    expect(FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.document).toBe(30 * 1024 * 1024);
  });


  it("declares WeChat iLink as reply-context bound", () => {
    expect(WECHAT_ILINK_MEDIA_CAPABILITIES).toMatchObject({
      platform: "wechat",
      productSurface: "ilink",
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: true,
      deliveryByKind: {
        image: "native_image",
        video: "native_file",
        audio: "native_file",
        document: "native_file",
      },
    });
  });
});
