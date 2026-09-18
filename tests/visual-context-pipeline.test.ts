import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionBridge, VISION_CONTEXT_END, VISION_CONTEXT_START } from "../core/vision-bridge.ts";
import { adaptVisualContextMessages } from "../core/visual-context-pipeline.ts";

const tempDirs = [];
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

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

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-visual-context-"));
  tempDirs.push(dir);
  return dir;
}

function makeBridge() {
  const callText = vi.fn(async (_opts?: unknown) => [
    "image_overview: A browser screenshot with a red error banner.",
    "visible_text: Error 500.",
    "objects_and_layout: The banner sits at the top of the page.",
    "charts_or_data: none.",
    "user_request_answer: The visible state is an error page.",
    "evidence: red banner and Error 500 text.",
    "uncertainty: exact route is unclear.",
  ].join("\n"));
  return {
    callText,
    bridge: new VisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      resizeImage: passthroughResizeImage,
      formatDimensionNote: () => undefined,
    }),
  };
}

describe("VisualContextPipeline", () => {
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("injects vision context for tool result image blocks before text-only model calls", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const { bridge, callText } = makeBridge();
    const messages = [
      { role: "user", content: "check the page" },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "browser screenshot captured" },
          { type: "image", mimeType: "image/png", data: PNG_BASE64 },
        ],
      },
    ];

    const result = await adaptVisualContextMessages({
      messages,
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => true,
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0]).toMatchObject({
      callPurpose: "auxiliary_vision",
    });
    expect(result.injected).toBe(1);
    expect(result.messages[1].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[1].content[0].text).toContain("browser screenshot");
    expect(result.messages[1].content[0].text).toContain("image_overview");
    expect(result.messages[1].content[0].text).toContain(VISION_CONTEXT_END);
    expect(result.messages[1].content[2]).toEqual(
      expect.objectContaining({ type: "image", data: PNG_BASE64 }),
    );
  });

  it("resolves image session files from tool media details and injects their notes", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const imagePath = path.join(dir, "generated.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const { bridge, callText } = makeBridge();
    const sessionFile = {
      id: "sf_generated",
      fileId: "sf_generated",
      sessionPath,
      filePath: imagePath,
      label: "generated.png",
      filename: "generated.png",
      mime: "image/png",
      kind: "image",
      status: "available",
    };

    const messages = [
      { role: "user", content: "review the generated image" },
      {
        role: "toolResult",
        content: [{ type: "text", text: "generated.png staged" }],
        details: {
          media: {
            items: [{ type: "session_file", fileId: "sf_generated", sessionPath }],
          },
        },
      },
    ];

    const result = await adaptVisualContextMessages({
      messages,
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => true,
      resolveSessionFile: vi.fn(() => sessionFile),
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(result.injected).toBe(1);
    expect(result.messages[1].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[1].content[0].text).toContain("generated.png");
    expect(result.messages[1].content[0].text).toContain("image_overview");
  });

  it("deduplicates the same image when a tool result has both image content and session file media", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const imagePath = path.join(dir, "browser.png");
    const bytes = PNG_BYTES;
    fs.writeFileSync(imagePath, bytes);
    const base64 = bytes.toString("base64");
    const { bridge, callText } = makeBridge();
    const sessionFile = {
      id: "sf_browser",
      fileId: "sf_browser",
      sessionPath,
      filePath: imagePath,
      label: "browser.png",
      mime: "image/png",
      kind: "image",
      status: "available",
    };

    const messages = [
      { role: "user", content: "check the page" },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "browser screenshot captured" },
          { type: "image", mimeType: "image/png", data: base64 },
        ],
        details: {
          media: {
            items: [{ type: "session_file", fileId: "sf_browser", sessionPath }],
          },
        },
      },
    ];

    const result = await adaptVisualContextMessages({
      messages,
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => true,
      resolveSessionFile: vi.fn(() => sessionFile),
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(result.injected).toBe(1);
  });

  it("does not bypass a rejected SessionFile id by reading its raw legacy path", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const hiddenImagePath = path.join(dir, "hidden-branch.png");
    fs.writeFileSync(hiddenImagePath, PNG_BYTES);
    const { bridge, callText } = makeBridge();
    const messages = [{
      role: "toolResult",
      content: [{ type: "text", text: "old branch output" }],
      details: {
        media: {
          items: [{
            type: "session_file",
            fileId: "sf-hidden",
            sessionPath,
            filePath: hiddenImagePath,
            mime: "image/png",
            kind: "image",
          }],
        },
      },
    }];
    const resolveSessionFile = vi.fn(() => null);

    const result = await adaptVisualContextMessages({
      messages,
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => true,
      resolveSessionFile,
    });

    expect(resolveSessionFile).toHaveBeenCalled();
    expect(callText).not.toHaveBeenCalled();
    expect(result).toEqual({ messages, injected: 0 });
  });

  it("leaves image-capable model context unchanged", async () => {
    const { bridge, callText } = makeBridge();
    const messages = [{
      role: "toolResult",
      content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
    }];

    const result = await adaptVisualContextMessages({
      messages,
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "gpt-4o", provider: "openai", input: ["text", "image"] },
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => true,
    });

    expect(callText).not.toHaveBeenCalled();
    expect(result).toEqual({ messages, injected: 0 });
  });
});
