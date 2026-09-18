import { createMediaCapabilities } from "../../lib/bridge/media-capabilities.ts";

// Test-only transports preserve shared delivery coverage after platform removal.
export const BUFFER_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "telegram", inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"], requiresReplyContext: false,
  deliveryByKind: { image: "native_image", video: "native_video", audio: "native_audio", document: "native_document" },
  maxBytes: {
    buffer: { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, audio: 50 * 1024 * 1024, document: 50 * 1024 * 1024 },
    remote_url: { image: 5 * 1024 * 1024, video: 20 * 1024 * 1024, audio: 20 * 1024 * 1024, document: 20 * 1024 * 1024 },
  },
  source: "test-only buffer transport fixture",
});

export const LOCAL_FILE_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "qq", inputModes: ["local_file", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"], requiresReplyContext: false,
  deliveryByKind: { image: "native_image", video: "native_video", audio: "native_audio", document: "native_file" },
  maxBytes: { local_file: { image: 30 * 1024 * 1024, video: 100 * 1024 * 1024, audio: 20 * 1024 * 1024, document: 100 * 1024 * 1024 } },
  source: "test-only local-file transport fixture",
});
