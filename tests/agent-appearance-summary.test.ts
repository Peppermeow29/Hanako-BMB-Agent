import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_APPEARANCE_SUMMARY_REQUEST,
  formatAgentAppearancePrompt,
  hasAgentAppearanceSummaryCapability,
  readCachedAgentAppearanceSummary,
  readAgentAvatarResource,
  refreshAgentAppearanceSummary,
  sanitizeAgentAppearanceSummary,
  writeCachedAgentAppearanceSummary,
} from "../lib/agent-appearance-summary.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw6N6wAAAABJRU5ErkJggg==",
  "base64",
);

describe("agent appearance summary", () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-appearance-"));
    agentDir = path.join(tmpDir, "agents", "agent-a");
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), PNG_BYTES);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses a neutral request for self-appearance rather than image-description examples", () => {
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("这个 Agent 的样子");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("你的形象");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).toContain("判断某个元素是否保留");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).not.toContain("花");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).not.toContain("花环");
    expect(AGENT_APPEARANCE_SUMMARY_REQUEST).not.toContain("来自图片");
  });

  it("reads the agent avatar as a stable visual resource", () => {
    const resource = readAgentAvatarResource(agentDir);

    expect(resource?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(resource?.image.mimeType).toBe("image/png");
    expect(resource?.image.data).toBe(PNG_BYTES.toString("base64"));
    expect(resource?.key).toContain(resource?.hash);
  });

  it("injects only summaries that read as self-appearance", () => {
    expect(sanitizeAgentAppearanceSummary("你的形象是银白色短发，神情安静。")).toBe("你的形象是银白色短发，神情安静。");
    expect(sanitizeAgentAppearanceSummary("图片中是一位银白色短发角色。")).toBe("");
    expect(sanitizeAgentAppearanceSummary("这张头像展示了一个角色。")).toBe("");
  });

  it("does not hard-truncate natural self-appearance summaries", () => {
    const longSummary = `你的形象是${"银白色发丝与深色外套".repeat(120)}。`;

    expect(sanitizeAgentAppearanceSummary(longSummary)).toBe(longSummary);
  });

  it("formats the cached summary as natural self-knowledge", () => {
    const section = formatAgentAppearancePrompt("你的形象是银白色短发，神情安静。", "zh-CN");

    expect(section).toContain("## 你的样子");
    expect(section).toContain("你的形象是银白色短发，神情安静。");
    expect(section).not.toContain("图片");
    expect(section).not.toContain("头像");
    expect(section).not.toContain("分析");
  });

  it("ignores stale cached summaries when the avatar hash changes", () => {
    const first = readAgentAvatarResource(agentDir);
    expect(first).not.toBeNull();
    writeCachedAgentAppearanceSummary(agentDir, {
      avatarHash: first!.hash,
      summary: "你的形象是银白色短发，神情安静。",
      model: "vision-a",
    });
    expect(readCachedAgentAppearanceSummary(agentDir)?.summary).toContain("银白色短发");

    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), Buffer.from("changed-avatar"));

    expect(readCachedAgentAppearanceSummary(agentDir)).toBeNull();
  });

  it("summarizes through a configured vision model and stores the self-appearance cache", async () => {
    const callText = vi.fn().mockResolvedValue("你的形象是银白色短发，神情安静，穿着深色外套。");
    const visionConfig = {
      api: "openai",
      api_key: "test-key",
      base_url: "https://example.test",
      model: { id: "vision-a", provider: "openai", input: ["text", "image"] },
      headers: { "x-test": "yes" },
    };

    const summary = await refreshAgentAppearanceSummary({
      agentDir,
      agentName: "Hana",
      visionConfig,
      callText,
    });

    expect(summary).toBe("你的形象是银白色短发，神情安静，穿着深色外套。");
    expect(callText).toHaveBeenCalledOnce();
    expect(callText.mock.calls[0][0]).toMatchObject({
      api: "openai",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: visionConfig.model,
    });
    expect(callText.mock.calls[0][0].messages[0].content[0].text).toContain("这个 Agent 的样子");
    expect(callText.mock.calls[0][0].messages[0].content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(callText.mock.calls[0][0]).not.toHaveProperty("maxTokens");
    expect(readCachedAgentAppearanceSummary(agentDir)?.summary).toBe(summary);
  });

  it("falls back to the current chat model when it can read images", async () => {
    const callText = vi.fn().mockResolvedValue("你的样子带着温和而专注的气质。");
    const resolveModelWithCredentialsFresh = vi.fn(async () => ({
      api: "openai",
      api_key: "chat-key",
      base_url: "https://chat.example.test",
      model: { id: "chat-vision", provider: "openai", input: ["text", "image"] },
      headers: {},
    }));

    const summary = await refreshAgentAppearanceSummary({
      agentDir,
      agentName: "Hana",
      targetModel: { id: "chat-vision", provider: "openai", input: ["text", "image"] },
      resolveModelWithCredentialsFresh,
      callText,
    });

    expect(summary).toBe("你的样子带着温和而专注的气质。");
    expect(resolveModelWithCredentialsFresh).toHaveBeenCalledWith({ id: "chat-vision", provider: "openai" });
    expect(callText).toHaveBeenCalledOnce();
  });

  it("keeps existing behavior when no vision-capable model is available", async () => {
    const callText = vi.fn();

    const summary = await refreshAgentAppearanceSummary({
      agentDir,
      agentName: "Hana",
      targetModel: { id: "text-only", provider: "openai", input: ["text"] },
      callText,
    });

    expect(summary).toBeNull();
    expect(callText).not.toHaveBeenCalled();
    expect(readCachedAgentAppearanceSummary(agentDir)).toBeNull();
  });

  it("recognizes auxiliary vision and current chat image capability as the prompt gate", () => {
    expect(hasAgentAppearanceSummaryCapability({
      visionConfig: {
        api: "openai",
        base_url: "https://example.test",
        model: { id: "vision-a", provider: "openai", input: ["text", "image"] },
      },
    })).toBe(true);
    expect(hasAgentAppearanceSummaryCapability({
      targetModel: { id: "chat-vision", provider: "openai", input: ["text", "image"] },
    })).toBe(true);
    expect(hasAgentAppearanceSummaryCapability({
      targetModel: { id: "text-only", provider: "openai", input: ["text"] },
    })).toBe(false);
  });
});
