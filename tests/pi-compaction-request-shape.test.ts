import { describe, expect, it, vi } from "vitest";
import * as piSdk from "../lib/pi-sdk/index.ts";

function user(text: string, timestamp = 1) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function buildShape(input: Record<string, any>) {
  const builder = (piSdk as any).buildNativeCompactionRequestShapes;
  expect(typeof builder).toBe("function");
  return builder(input);
}

describe("Pi native compaction request shape adapter", () => {
  it("matches installed Pi's actual split-turn request contexts and output caps", async () => {
    const installedPi = await import("@earendil-works/pi-coding-agent");
    const preparation = {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [user("older history", 1)],
      turnPrefixMessages: [user("split request prefix", 2)],
      isSplitTurn: true,
      tokensBefore: 10_000,
      previousSummary: "prior checkpoint",
      fileOps: {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      },
      settings: {
        enabled: true,
        reserveTokens: 4_000,
        keepRecentTokens: 2_000,
      },
    };
    const model = {
      id: "shape-fixture",
      name: "Shape Fixture",
      provider: "test",
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 1_200,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    const actualRequests: Array<{ context: any; options: any }> = [];
    const streamFn = vi.fn(async (_model, context, options) => {
      actualRequests.push({ context, options });
      return {
        result: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "fixture summary" }],
          stopReason: "stop",
          timestamp: Date.now(),
        }),
      };
    });

    await installedPi.compact(
      preparation as any,
      model as any,
      undefined,
      undefined,
      "focus on migrations",
      undefined,
      "off",
      streamFn as any,
    );
    const adapterRequests = buildShape({
      preparation,
      model,
      customInstructions: "focus on migrations",
    }).requests;

    expect(actualRequests).toHaveLength(2);
    expect(adapterRequests).toHaveLength(2);
    for (const adapterRequest of adapterRequests) {
      const actualRequest = actualRequests.find(({ context }) => (
        context.messages[0].content[0].text === adapterRequest.promptText
      ));
      expect(actualRequest).toBeDefined();
      expect(actualRequest?.context.systemPrompt).toBe(adapterRequest.systemPrompt);
      expect(actualRequest?.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: adapterRequest.promptText }],
      });
      expect(actualRequest?.options.maxTokens).toBe(adapterRequest.maxTokens);
    }
  });

  it("includes serialized conversation overhead, wrapper tags, and the fixed summarization system prompt", () => {
    const message = user("hello from history");
    const result = buildShape({
      preparation: {
        messagesToSummarize: [message],
        turnPrefixMessages: [],
        isSplitTurn: false,
        settings: { reserveTokens: 4_000 },
      },
      model: { maxTokens: 8_000 },
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      kind: "history",
      maxTokens: 3_200,
      systemPrompt: expect.stringContaining("context summarization assistant"),
    });
    expect(result.requests[0].promptText).toContain(
      "<conversation>\n[User]: hello from history\n</conversation>",
    );
    expect(result.requests[0].messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: result.requests[0].promptText }],
      }),
    ]);
  });

  it("uses the update prompt and previous-summary wrapper exactly once", () => {
    const result = buildShape({
      preparation: {
        messagesToSummarize: [user("new progress")],
        turnPrefixMessages: [],
        previousSummary: "prior checkpoint",
        isSplitTurn: false,
        settings: { reserveTokens: 4_000 },
      },
      model: { maxTokens: 8_000 },
      customInstructions: "focus on migrations",
    });
    const prompt = result.requests[0].promptText;

    expect(prompt.match(/prior checkpoint/g)).toHaveLength(1);
    expect(prompt).toContain("<previous-summary>\nprior checkpoint\n</previous-summary>");
    expect(prompt).toContain("messages above are NEW conversation messages");
    expect(prompt).toContain("Additional focus: focus on migrations");
  });

  it("builds the separate installed-Pi split-turn request with its half-reserve output cap", () => {
    const result = buildShape({
      preparation: {
        messagesToSummarize: [user("older history", 1)],
        turnPrefixMessages: [user("split request prefix", 2)],
        isSplitTurn: true,
        settings: { reserveTokens: 4_000 },
      },
      model: { maxTokens: 8_000 },
    });

    expect(result.requests.map((request) => request.kind)).toEqual(["history", "turn-prefix"]);
    expect(result.requests[0].maxTokens).toBe(3_200);
    expect(result.requests[1]).toMatchObject({
      kind: "turn-prefix",
      maxTokens: 2_000,
      promptText: expect.stringContaining("This is the PREFIX of a turn that was too large to keep"),
    });
    expect(result.requests[1].promptText).toContain("[User]: split request prefix");
  });

  it("serializes the original preparation and does not receive a media-stripped substitute", () => {
    const original = {
      role: "user",
      content: [
        { type: "text", text: "[attached_audio: /tmp/original.wav]\ntranscribe this" },
        { type: "audio", data: "BASE64_AUDIO", mimeType: "audio/wav" },
      ],
      timestamp: 1,
    };
    const convertToLlm = vi.fn((messages) => messages);

    const result = buildShape({
      preparation: {
        messagesToSummarize: [original],
        turnPrefixMessages: [],
        isSplitTurn: false,
        settings: { reserveTokens: 4_000 },
      },
      model: { maxTokens: 8_000 },
      convertToLlm,
    });

    expect(convertToLlm).toHaveBeenCalledWith([original]);
    expect(result.requests[0].promptText).toContain("[attached_audio: /tmp/original.wav]");
  });

  it("caps history and turn-prefix output by positive model.maxTokens", () => {
    const capped = buildShape({
      preparation: {
        messagesToSummarize: [user("history")],
        turnPrefixMessages: [user("turn")],
        isSplitTurn: true,
        settings: { reserveTokens: 10_000 },
      },
      model: { maxTokens: 1_200 },
    });
    const reserveLimited = buildShape({
      preparation: {
        messagesToSummarize: [user("history")],
        turnPrefixMessages: [user("turn")],
        isSplitTurn: true,
        settings: { reserveTokens: 10_000 },
      },
      model: { maxTokens: 6_000 },
    });

    expect(capped.requests.map((request) => request.maxTokens)).toEqual([1_200, 1_200]);
    expect(reserveLimited.requests.map((request) => request.maxTokens)).toEqual([6_000, 5_000]);
  });
});
