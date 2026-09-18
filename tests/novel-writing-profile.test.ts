import { describe, expect, it } from "vitest";
import {
  applyNovelWritingProviderPayload,
  buildNovelWritingInstruction,
  createNovelWritingExtension,
  limitNovelWritingContextMessages,
  normalizeNovelWritingProfile,
  parseNovelWritingCommand,
} from "../core/novel-writing-profile.ts";

describe("novel writing profile commands", () => {
  it("maps an explicit drafting command to the low-latency continuation profile", () => {
    expect(parseNovelWritingCommand("/novel continue")).toMatchObject({
      type: "set",
      profile: { mode: "continue", activeContextTokens: 16_384, maxOutputTokens: 1_024 },
    });
  });

  it("accepts explicit per-session generation overrides", () => {
    expect(parseNovelWritingCommand("/novel custom detailed output=3072 temperature=0.8 top_p=0.88")).toMatchObject({
      type: "set",
      profile: {
        mode: "detailed",
        maxOutputTokens: 3_072,
        generation: { temperature: 0.8, topP: 0.88 },
      },
    });
  });

  it("does not treat ordinary prompts or an invalid mode as model input commands", () => {
    expect(parseNovelWritingCommand("继续这一章")) .toBeNull();
    expect(parseNovelWritingCommand("/novel epic")).toMatchObject({ type: "invalid" });
    expect(parseNovelWritingCommand("/novel off")).toEqual({ type: "off" });
  });

  it("handles strategy changes before the model is called", async () => {
    let saved: any = "not-called";
    const notifications: Array<{ text: string; level: string }> = [];
    const extension = createNovelWritingExtension({
      sessionPathRef: { current: "/session/story.jsonl" },
      setProfile: async (profile) => { saved = profile; },
      getProfile: () => null,
    });
    const handler = extension.handlers.get("input")?.[0];
    const result = await handler?.({ text: "/novel review", source: "interactive" }, {
      ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
    });

    expect(result).toEqual({ action: "handled" });
    expect(saved).toMatchObject({ mode: "review", activeContextTokens: 65_536 });
    expect(notifications[0]?.text).toContain("review");
  });
});

describe("novel writing context policy", () => {
  it("keeps the persistent transcript untouched but sends only the newest active window", () => {
    const profile = normalizeNovelWritingProfile({ mode: "continue", activeContextTokens: 512 });
    const messages = [
      { role: "system", content: "system policy" },
      { role: "user", content: "old ".repeat(400) },
      { role: "assistant", content: "old reply ".repeat(400) },
      { role: "user", content: "latest scene" },
    ];
    const visible = limitNovelWritingContextMessages(messages, profile);

    expect(messages).toHaveLength(4);
    expect(visible[0]).toMatchObject({ role: "system" });
    expect(visible.at(-1)).toMatchObject({ content: "latest scene" });
    expect(visible).not.toContain(messages[1]);
  });

  it("adds mode-specific prose continuity guidance", () => {
    const profile = normalizeNovelWritingProfile({ mode: "detailed" });
    expect(buildNovelWritingInstruction(profile)).toContain("场景、动作、感官细节");
  });
});

describe("MiniCPM request isolation", () => {
  const profile = normalizeNovelWritingProfile({
    mode: "detailed",
    maxOutputTokens: 3_072,
    generation: { temperature: 0.8, topP: 0.88, topK: 32, minP: 0.03, repetitionPenalty: 1.1 },
  });

  it("overrides only the local MLX request", () => {
    const payload = { model: "default_model", messages: [{ role: "user", content: "continue" }], max_tokens: 512 };
    expect(applyNovelWritingProviderPayload(payload, {
      provider: "minicpm5-local",
      maxTokens: 4_096,
    }, profile)).toMatchObject({
      max_tokens: 3_072,
      temperature: 0.8,
      top_p: 0.88,
      top_k: 32,
      min_p: 0.03,
      repetition_penalty: 1.1,
    });
    expect(applyNovelWritingProviderPayload(payload, { provider: "moonshot" }, profile)).toBe(payload);
  });
});
