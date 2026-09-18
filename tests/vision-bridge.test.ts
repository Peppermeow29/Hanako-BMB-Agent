import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VisionBridge,
  VISUAL_PRIMITIVES_END,
  VISUAL_PRIMITIVES_START,
  VISION_CONTEXT_END,
  VISION_CONTEXT_START,
} from "../core/vision-bridge.ts";

const PNG_BASE64 = "iVBORw0KGgo=";
const JPEG_BASE64 = "/9j/2wBD";
const image = { type: "image", data: PNG_BASE64, mimeType: "image/png" };
const pathA = "/tmp/upload-a.png";
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vision-bridge-"));
  tempDirs.push(dir);
  return dir;
}

async function passthroughResizeImage(input) {
  return {
    data: input.data,
    mimeType: input.mimeType,
    originalWidth: 100,
    originalHeight: 100,
    width: 100,
    height: 100,
    wasResized: false,
  };
}

function makeVisionBridge(options = {}) {
  return new VisionBridge({
    resizeImage: passthroughResizeImage,
    formatDimensionNote: () => undefined,
    ...options,
  });
}

function makeBridge(callText = vi.fn(async () => [
  "image_overview: A desk screenshot with a red error banner.",
  "user_request_answer: The screenshot shows an error state relevant to the question.",
  "evidence: red banner and visible editor layout.",
  "uncertainty: exact line number is unclear.",
].join("\n")), resolveVisionConfig = null) {
  return {
    callText,
    bridge: makeVisionBridge({
      resolveVisionConfig: resolveVisionConfig || (() => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      })),
      callText,
    }),
  };
}

describe("VisionBridge", () => {
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("awaits fresh vision credentials before any analysis request", async () => {
    const callText = vi.fn();
    const { bridge } = makeBridge(callText, async () => {
      throw new Error("oauth refresh failed");
    });

    await expect(bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "text-only", provider: "test", input: ["text"] },
      text: "what is this?",
      images: [image],
    })).rejects.toThrow("oauth refresh failed");
    expect(callText).not.toHaveBeenCalled();
  });

  it("analyzes text-only model images and registers notes by attachment path", async () => {
    const { bridge, callText } = makeBridge();

    const result = await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    const request = (callText.mock.calls as any)[0][0];
    expect(request.systemPrompt).toContain("auxiliary vision model");
    expect(request.systemPrompt).toContain("not final problem solving");
    expect(request.messages[0].content[0].text).toContain("User request");
    expect(request.messages[0].content[0].text).toContain("task_relevant_transcription");
    expect(request.messages[0].content[0].text).toContain("do not solve math/science problems");
    expect(request.messages[0].content[0].text).toContain("what is this?");
    expect(result.images).toBeUndefined();
    expect(result.text).toContain(`[attached_image: ${pathA}]`);

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is this?` }] },
    ], "/tmp/session.jsonl");

    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(injected.messages[0].content[0].text).toContain("user_request_answer");
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_END);
  });

  it("forwards resolved Grok OAuth provider and model headers to auxiliary vision callText", async () => {
    const callText = vi.fn(async () => "image_overview: A screenshot.");
    const { bridge } = makeBridge(callText, () => ({
      model: { id: "grok-4.1", provider: "xai", input: ["text", "image"] },
      api: "openai-completions",
      api_key: "oauth-token",
      base_url: "https://api.x.ai/v1",
      headers: {
        "x-grok-client-version": "0.1.202",
        "x-grok-model-override": "grok-4.1",
      },
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "text-only", provider: "test", input: ["text"] },
      text: "what is this?",
      images: [image],
    });

    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "oauth-token",
      baseUrl: "https://api.x.ai/v1",
      headers: {
        "x-grok-client-version": "0.1.202",
        "x-grok-model-override": "grok-4.1",
      },
    }));
  });

  it("records auxiliary vision usage against sessionId while keeping the path locator", async () => {
    const sessionPath = "/tmp/session.jsonl";
    const sessionId = "sess_vision_usage";
    const callText = vi.fn(async () => "image_overview: A screenshot.");
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      getSessionIdForPath: (candidate) => candidate === sessionPath ? sessionId : null,
    });

    await bridge.prepare({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const request = (callText.mock.calls as any)[0][0];
    expect(request.usageContext.attribution).toMatchObject({
      kind: "session",
      sessionId,
      sessionPath,
    });
  });

  it("restores vision notes from the session sidecar after the in-memory bridge is gone", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const imagePath = path.join(dir, "upload-a.png");
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${imagePath}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [imagePath],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "session-vision-notes.json"), "utf-8"));
    expect(sidecar.sessions["session.jsonl"].images[imagePath]).toMatchObject({
      imagePath,
      visionModel: { id: "qwen-vl", provider: "dashscope" },
      targetModel: { id: "deepseek-chat", provider: "deepseek" },
    });

    const restored = makeVisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });
    const injected = restored.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${imagePath}]\nwhat is this?` }] },
    ], sessionPath);

    expect(injected.injected).toBe(1);
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(injected.messages[0].content[0].text).toContain("user_request_answer");
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_END);
  });

  it("persists and restores resource-key vision notes for tool-produced images", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const resourceKey = "visual-resource:browser-shot-1";
    const { bridge, callText } = makeBridge();

    const prepared = await bridge.prepareResources({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      userRequest: "review the browser screenshot",
      resources: [{
        key: resourceKey,
        label: "browser screenshot",
        image,
      }],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(prepared.notes).toEqual([
      expect.objectContaining({
        key: resourceKey,
        label: "browser screenshot",
        note: expect.stringContaining("image_overview"),
      }),
    ]);

    const restored = makeVisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });
    const entry = restored.lookupNote(sessionPath, resourceKey);

    expect(entry).toMatchObject({
      imagePath: resourceKey,
      note: expect.stringContaining("image_overview"),
      visionModel: { id: "qwen-vl", provider: "dashscope" },
      targetModel: { id: "deepseek-chat", provider: "deepseek" },
    });
  });

  it("keeps persisted resource notes attached to the session id when the session path moves", async () => {
    const dir = makeTempDir();
    const originalSessionPath = path.join(dir, "original.jsonl");
    const movedSessionPath = path.join(dir, "archived", "renamed.jsonl");
    const sessionId = "sess_vision_notes_stable";
    const resourceKey = "visual-resource:browser-shot-moved";
    const getSessionIdForPath = (sessionPath) => (
      sessionPath === originalSessionPath || sessionPath === movedSessionPath
        ? sessionId
        : null
    );
    const callText = vi.fn(async () => "image_overview: moved path screenshot.");
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      getSessionIdForPath,
    });

    await bridge.prepareResources({
      sessionPath: originalSessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      userRequest: "review the moved browser screenshot",
      resources: [{
        key: resourceKey,
        label: "browser screenshot",
        image,
      }],
    });

    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "session-vision-notes.json"), "utf-8"));
    expect(sidecar.sessions[sessionId].images[resourceKey]).toMatchObject({
      imagePath: resourceKey,
      sessionId,
    });
    expect(sidecar.sessions[path.basename(originalSessionPath)]).toBeUndefined();

    const restored = makeVisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
      getSessionIdForPath,
    });
    const entry = restored.lookupNote(movedSessionPath, resourceKey);

    expect(entry).toMatchObject({
      imagePath: resourceKey,
      sessionId,
      sessionPath: movedSessionPath,
      note: "image_overview: moved path screenshot.",
    });
  });

  it("forks only vision notes reachable from the retained session prefix", () => {
    const dir = makeTempDir();
    const sourceSessionPath = path.join(dir, "source.jsonl");
    const targetSessionPath = path.join(dir, "target.jsonl");
    const sourceSessionId = "sess_vision_source";
    const targetSessionId = "sess_vision_target";
    const retainedKey = "visual-resource:retained-shot";
    const hiddenKey = "visual-resource:hidden-shot";
    fs.writeFileSync(path.join(dir, "session-vision-notes.json"), JSON.stringify({
      version: 1,
      sessions: {
        [sourceSessionId]: {
          sessionId: sourceSessionId,
          sessionPath: sourceSessionPath,
          images: {
            [retainedKey]: {
              note: "retained note",
              imagePath: retainedKey,
              sessionId: sourceSessionId,
              sessionPath: sourceSessionPath,
              updatedAt: 10,
            },
            [hiddenKey]: {
              note: "hidden note",
              imagePath: hiddenKey,
              sessionId: sourceSessionId,
              sessionPath: sourceSessionPath,
              updatedAt: 20,
            },
          },
        },
      },
    }), "utf-8");

    const bridge = makeVisionBridge({
      getSessionIdForPath: (candidate) => {
        if (candidate === sourceSessionPath) return sourceSessionId;
        if (candidate === targetSessionPath) return targetSessionId;
        return null;
      },
    });
    const result = bridge.forkSessionNotes({
      sourceSessionId,
      sourceSessionPath,
      targetSessionId,
      targetSessionPath,
      retainedEntries: [{ type: "custom", data: { resourceKey: retainedKey } }],
    });

    expect(result).toEqual({ notes: 1, keys: [retainedKey] });
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "session-vision-notes.json"), "utf-8"));
    expect(sidecar.sessions[sourceSessionId].images[hiddenKey].note).toBe("hidden note");
    expect(sidecar.sessions[targetSessionId].images).toEqual({
      [retainedKey]: expect.objectContaining({
        note: "retained note",
        sessionId: targetSessionId,
        sessionPath: targetSessionPath,
      }),
    });
    expect(bridge.lookupNote(targetSessionPath, retainedKey)).toMatchObject({
      note: "retained note",
      sessionId: targetSessionId,
      sessionPath: targetSessionPath,
    });
    expect(bridge.lookupNote(targetSessionPath, hiddenKey)).toBeNull();
  });

  it("discards forked vision notes without touching the source session", () => {
    const dir = makeTempDir();
    const sourceSessionPath = path.join(dir, "source.jsonl");
    const targetSessionPath = path.join(dir, "target.jsonl");
    const sourceSessionId = "sess_vision_source";
    const targetSessionId = "sess_vision_target";
    const resourceKey = "visual-resource:retained-shot";
    fs.writeFileSync(path.join(dir, "session-vision-notes.json"), JSON.stringify({
      version: 1,
      sessions: {
        [sourceSessionId]: {
          sessionId: sourceSessionId,
          sessionPath: sourceSessionPath,
          images: {
            [resourceKey]: {
              note: "source note",
              imagePath: resourceKey,
              sessionId: sourceSessionId,
              sessionPath: sourceSessionPath,
            },
          },
        },
      },
    }), "utf-8");
    const bridge = makeVisionBridge({
      getSessionIdForPath: (candidate) => candidate === targetSessionPath ? targetSessionId : sourceSessionId,
    });

    bridge.forkSessionNotes({
      sourceSessionId,
      sourceSessionPath,
      targetSessionId,
      targetSessionPath,
      retainedEntries: [{ resourceKey }],
    });
    expect(bridge.discardForkedSessionNotes({
      sessionId: targetSessionId,
      sessionPath: targetSessionPath,
    })).toBe(true);
    expect(bridge.discardForkedSessionNotes({
      sessionId: targetSessionId,
      sessionPath: targetSessionPath,
    })).toBe(false);

    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "session-vision-notes.json"), "utf-8"));
    expect(sidecar.sessions[sourceSessionId].images[resourceKey].note).toBe("source note");
    expect(sidecar.sessions[targetSessionId]).toBeUndefined();
    expect(bridge.lookupNote(targetSessionPath, resourceKey)).toBeNull();
  });

  it("summarizes resources on explicit request without requiring a text-only target model", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const resourceKey = "visual-resource:appearance:user";
    const { bridge, callText } = makeBridge();

    const prepared = await bridge.summarizeResources({
      sessionPath,
      userRequest: "Summarize this avatar appearance.",
      resources: [{
        key: resourceKey,
        label: "user custom avatar",
        image,
      }],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(prepared.notes).toEqual([
      expect.objectContaining({
        key: resourceKey,
        label: "user custom avatar",
        note: expect.stringContaining("image_overview"),
      }),
    ]);

    const restored = makeVisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });
    const entry = restored.lookupNote(sessionPath, resourceKey);

    expect(entry).toMatchObject({
      imagePath: resourceKey,
      note: expect.stringContaining("image_overview"),
      visionModel: { id: "qwen-vl", provider: "dashscope" },
      targetModel: null,
    });
  });

  it("bounds the in-memory note cache while keeping evicted notes recoverable from sidecar", async () => {
    const dir = makeTempDir();
    const firstSession = path.join(dir, "first.jsonl");
    const secondSession = path.join(dir, "second.jsonl");
    const firstImage = path.join(dir, "first.png");
    const secondImage = path.join(dir, "second.png");
    const { callText } = makeBridge();
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      now: (() => {
        let n = 0;
        return () => ++n;
      })(),
      maxCacheEntries: 1,
    });
    const targetModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };

    await bridge.prepare({
      sessionPath: firstSession,
      targetModel,
      text: `[attached_image: ${firstImage}]\nfirst`,
      images: [image],
      imageAttachmentPaths: [firstImage],
    });
    await bridge.prepare({
      sessionPath: secondSession,
      targetModel,
      text: `[attached_image: ${secondImage}]\nsecond`,
      images: [{ ...image, data: JPEG_BASE64, mimeType: "image/jpeg" }],
      imageAttachmentPaths: [secondImage],
    });

    expect(bridge._noteByPath.size).toBeLessThanOrEqual(1);

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${firstImage}]\nfirst` }] },
    ], firstSession);

    expect(injected.injected).toBe(1);
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(bridge._noteByPath.size).toBeLessThanOrEqual(1);
  });

  it("normalizes auxiliary vision image bytes before calling DashScope-compatible models", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const callText = vi.fn(async () => "image_overview: resized image.");
    const resizeImage = vi.fn(async (input, options) => ({
      data: JPEG_BASE64,
      mimeType: "image/jpeg",
      originalWidth: 4000,
      originalHeight: 3000,
      width: 2000,
      height: 1500,
      wasResized: true,
      options,
    }));
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
      model: { id: "qwen3-vl-plus", provider: "dashscope", input: ["text", "image"] },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
      callText,
      resizeImage,
      formatDimensionNote: vi.fn(() => undefined),
    });

    await bridge.prepareResources({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      userRequest: "inspect generated image",
      resources: [{
        key: `visual-resource:mismatch:${path.basename(dir)}`,
        label: "mismatched image",
        image: { type: "image", data: `data:image/png;base64,${JPEG_BASE64}`, mimeType: "image/png" },
      }],
    });

    expect(resizeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        data: JPEG_BASE64,
        mimeType: "image/jpeg",
      }),
      expect.objectContaining({
        maxWidth: 2000,
        maxHeight: 2000,
        jpegQuality: 80,
      }),
    );
    const content = (callText.mock.calls as any)[0][0].messages[0].content;
    expect(content[1]).toMatchObject({
      type: "image",
      data: JPEG_BASE64,
      mimeType: "image/jpeg",
    });
  });

  it("fails closed before auxiliary vision calls when image preprocessing cannot compress", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const callText = vi.fn(async () => "should not be called");
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      resizeImage: vi.fn(async () => null),
      formatDimensionNote: vi.fn(() => undefined),
    });

    await expect(bridge.prepareResources({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      userRequest: "inspect generated image",
      resources: [{
        key: "visual-resource:too-large",
        label: "too large image",
        image,
      }],
    })).rejects.toMatchObject({
      code: "IMAGE_INPUT_PREPROCESS_FAILED",
    });

    expect(callText).not.toHaveBeenCalled();
  });

  it("routes Gemini family models through their native box_2d format", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A UI screenshot with a red error banner near the top.",
      visible_text: ["Error 500"],
      objects_and_layout: "The banner sits above the main editor area.",
      charts_or_data: "none",
      user_request: "Find the error.",
      user_request_answer: "The error is in the red banner.",
      evidence: "The red banner contains the text Error 500.",
      uncertainty: "none",
      visual_primitives: [
        {
          id: "banner",
          type: "box",
          label: "red error banner",
          box_2d: [100, 200, 180, 760],
          confidence: 0.92,
        },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "gemini-3-flash-preview",
        provider: "gemini",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: false,
          coordinateSpace: "norm-1000",
          boxOrder: "yxyx",
          outputFormat: "gemini",
          groundingMode: "native",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhere is the error?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = (callText.mock.calls as any)[0][0].messages[0].content[0].text;
    expect(prompt).toContain("visual_primitives");
    expect(prompt).toContain("box_2d");
    expect(prompt).toContain("[ymin, xmin, ymax, xmax]");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhere is the error?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain(VISUAL_PRIMITIVES_START);
    expect(text).toContain('coord="norm-1000"');
    expect(text).toMatch(/box:\s*\[200,\s*100,\s*760,\s*180\]/);
    expect(text).toContain("red error banner");
    expect(text).toContain("grounding: native");
    expect(text).toContain(VISUAL_PRIMITIVES_END);
  });

  it("routes newer Qwen visual models through the Qwen bbox_2d and point_2d family format", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A settings screen with a primary save button.",
      user_request_answer: "The save button is near the bottom right.",
      evidence: "The button is visually emphasized.",
      visual_primitives: [
        { id: "save", label: "save button", bbox_2d: [710, 820, 930, 890], confidence: 0.84 },
        { id: "toggle", label: "theme toggle", point_2d: [320, 240], confidence: 0.77 },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "qwen3.6-plus",
        provider: "dashscope",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "qwen",
          groundingMode: "native",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhere should I click to save?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = (callText.mock.calls as any)[0][0].messages[0].content[0].text;
    expect(prompt).toContain("bbox_2d");
    expect(prompt).toContain("point_2d");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhere should I click to save?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain("box: [710, 820, 930, 890]");
    expect(text).toContain("point: [320, 240]");
    expect(text).toContain("grounding: native");
  });

  it("routes prompted computer-use style models through visual anchors", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A browser page with a search field and a submit button.",
      user_request_answer: "Use the submit button after entering the query.",
      evidence: "The button is right of the search field.",
      visual_anchors: [
        { id: "submit", label: "submit button", role: "button", center: [840, 310], confidence: 0.71 },
        { id: "search", label: "search field", role: "textbox", box: [180, 270, 760, 350], confidence: 0.74 },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "anchor",
          groundingMode: "prompted",
        },
      },
      api: "anthropic-messages",
      api_key: "sk-test",
      base_url: "https://api.anthropic.com",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat should I interact with?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = (callText.mock.calls as any)[0][0].messages[0].content[0].text;
    expect(prompt).toContain("visual_anchors");
    expect(prompt).toContain("center");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat should I interact with?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain("point: [840, 310]");
    expect(text).toContain("box: [180, 270, 760, 350]");
    expect(text).toContain("grounding: prompted");
  });

  it("keeps a stable unavailable primitive block when structured models return no usable coordinates", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A document screenshot.",
      user_request_answer: "The content is visible, but no reliable target coordinate was found.",
      evidence: "Text is readable.",
      visual_primitives: [],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "gpt-4o",
        provider: "openai",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "anchor",
          groundingMode: "prompted",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is on screen?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is on screen?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain(VISUAL_PRIMITIVES_START);
    expect(text).toContain('grounding="unavailable"');
    expect(text).toContain("reason: no valid coordinates");
  });

  it("keeps note-only routing for vision models without a coordinate contract", async () => {
    const { bridge, callText } = makeBridge(undefined, () => ({
      model: { id: "kimi-k2.6", provider: "kimi-coding", input: ["text", "image"] },
      api: "anthropic-messages",
      api_key: "sk-test",
      base_url: "https://api.kimi.com/coding/",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = (callText.mock.calls as any)[0][0].messages[0].content[0].text;
    expect(prompt).toContain("Return a concise paper note");
    expect(prompt).not.toContain("visual_primitives");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is this?` }] },
    ], "/tmp/session.jsonl");
    expect(injected.messages[0].content[0].text).not.toContain(VISUAL_PRIMITIVES_START);
  });

  it("lets provider defaults choose auxiliary vision temperature and waits up to two minutes", async () => {
    const { bridge, callText } = makeBridge(undefined, () => ({
      model: { id: "LongCat-Flash-Omni-2603", provider: "longcat", input: ["text", "image"] },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://api.longcat.chat/openai/v1",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect((callText.mock.calls as any)[0][0]).not.toHaveProperty("temperature");
    expect((callText.mock.calls as any)[0][0].timeoutMs).toBe(120_000);
  });

  it("does not cap auxiliary vision output from model maxTokens metadata", async () => {
    const callText = vi.fn(async () => "image_overview: capped");
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl-plus", provider: "openrouter", input: ["text", "image"], maxTokens: 2048 },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
    });

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect((callText.mock.calls as any)[0][0]).not.toHaveProperty("maxTokens");
  });

  it("does nothing for image-capable target models", async () => {
    const { bridge, callText } = makeBridge();

    const result = await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "gpt-4o", provider: "openai", input: ["text", "image"] },
      text: "what is this?",
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect(callText).not.toHaveBeenCalled();
    expect(result.images).toEqual([image]);
  });

  it("fails closed when a text-only target has images but no vision model", async () => {
    const bridge = makeVisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });

    await expect(bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "what is this?",
      images: [image],
      imageAttachmentPaths: [pathA],
    })).rejects.toThrow(/vision auxiliary model/i);
  });

  it("reuses cached analysis for the same image and same user request", async () => {
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath: "/tmp/a.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });
    await bridge.prepare({
      sessionPath: "/tmp/b.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "[attached_image: /tmp/other.png]\nwhat is this?",
      images: [image],
      imageAttachmentPaths: ["/tmp/other.png"],
    });

    expect(callText).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached analysis for a different user request on the same image", async () => {
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath: "/tmp/a.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nhow many kittens are there?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });
    await bridge.prepare({
      sessionPath: "/tmp/b.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "[attached_image: /tmp/other.png]\nwhat color is the blanket?",
      images: [image],
      imageAttachmentPaths: ["/tmp/other.png"],
    });

    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached analysis across different auxiliary vision models", async () => {
    let model = { id: "kimi-k2.6", provider: "kimi-coding", input: ["text", "image"] };
    const callText = vi.fn()
      .mockResolvedValueOnce("image_overview: note-only analysis")
      .mockResolvedValueOnce(JSON.stringify({
        image_overview: "Grounded analysis",
        user_request_answer: "The error is marked.",
        evidence: "A highlighted banner.",
        visual_primitives: [
          { id: "v1", type: "box", ref: "highlighted banner", box: [20, 30, 120, 220] },
        ],
      }));
    const { bridge } = makeBridge(callText, () => ({
      model,
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://example.test/v1",
    }));

    const payload = {
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    };

    await bridge.prepare({ ...payload, sessionPath: "/tmp/a.jsonl" });
    model = {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      input: ["text", "image"],
      visionCapabilities: {
        grounding: true,
        boxes: true,
        points: true,
        coordinateSpace: "norm-1000",
        boxOrder: "xyxy",
      },
    } as any;
    await bridge.prepare({ ...payload, sessionPath: "/tmp/b.jsonl" });

    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("injects notes into only the user message that carries an attached image marker", async () => {
    const { bridge } = makeBridge();
    const targetModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel,
      text: `[attached_image: ${pathA}]\nfirst question`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const result = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nfirst question` }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
    ], "/tmp/session.jsonl");

    expect(result.injected).toBe(1);
    expect(result.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[2].content[0].text).toBe("follow-up");
  });
});
