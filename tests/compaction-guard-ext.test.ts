import { describe, it, expect, vi, beforeEach } from "vitest";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

// Mock compaction-utils 以便精准控制 L3 判断和硬截断结果
vi.mock("../core/compaction-utils.js", () => ({
  computeHardTruncation: vi.fn(),
  truncateTextHeadTail: vi.fn(),
}));

import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import { buildSessionCacheSnapshot as buildSessionCacheSnapshotValue } from "../core/session-cache-snapshot.ts";
import { estimateCachePreservingCompactionRequest } from "../core/session-compactor.ts";
import { normalizeProviderPayload } from "../core/provider-compat.ts";
import { resolveRequestReasoningLevelForContext } from "../core/request-reasoning-level.ts";
import {
  computeHardTruncation,
  truncateTextHeadTail,
} from "../core/compaction-utils.ts";
import {
  convertAgentMessagesToLlm,
  Type,
  type AgentMessage,
} from "../lib/pi-sdk/index.ts";

const VALID_COMPACTION_SUMMARY = `## Goal
Keep the session useful.

## Constraints & Preferences
- Preserve the retained suffix.

## Progress
### Done
- [x] Summarized the old region.

### In Progress
- [ ] Continue from the retained suffix.

### Blocked
- (none)

## Key Decisions
- Keep the proven boundary stable.

## Next Steps
1. Continue the session.

## Critical Context
- The recent tail remains verbatim.`;

const usage = {
  input: 10,
  output: 5,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantStream(message: any) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: message.stopReason === "error" ? "error" : "done",
        reason: message.stopReason,
        message,
      };
    },
    async result() {
      return message;
    },
  } as any;
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockPi() {
  const handlers: any = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => ["read"]),
    getAllTools: vi.fn(() => [{
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
    }]),
    trigger(event, ...args) {
      return handlers[event]?.(...args);
    },
    getHandler(event) {
      return handlers[event];
    },
  };
}

const identityTransformContext = async (messages) => messages;

// Stands in for the engine's session-wide resolver. Tests that are not about
// the resolution itself only need the level the mock session runs at.
const sessionReasoningLevel = (ctx: any) => (
  ctx?.getThinkingLevel?.()
  ?? ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel
  ?? null
);

describe("CompactionGuardExtension", () => {
  let pi;
  let cacheCompactor;
  let buildSessionCacheSnapshot;
  let getSessionTransformContext;
  let getSessionAgentRunRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = createMockPi();
    cacheCompactor = vi.fn(async ({ preparation }) => ({
      summary: "cache summary",
      firstKeptEntryId: preparation.firstKeptEntryId || "uuid-42",
      tokensBefore: preparation.tokensBefore ?? 90_000,
      details: { readFiles: [], modifiedFiles: [] },
    }));
    buildSessionCacheSnapshot = vi.fn((sessionPath, { reason, messages } = {}) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      cachePrefixHash: "a".repeat(64),
      tools: [{
        name: "read",
        description: "Read files",
        parameters: { type: "object" },
      }],
      messages,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }));
    getSessionTransformContext = vi.fn(() => identityTransformContext);
    getSessionAgentRunRuntime = vi.fn(() => ({
      streamFn: vi.fn(),
      tools: [{
        name: "read",
        label: "Read",
        description: "Read files",
        parameters: { type: "object" },
        execute: vi.fn(),
      }],
      streamOptions: { sessionId: "runtime-session-id" },
    }));
    createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
      cacheCompactor,
      buildSessionCacheSnapshot,
      getSessionTransformContext,
      getSessionAgentRunRuntime,
    })(pi);
  });

  it("registers context usage epochs, tool_result, and session_before_compact handlers", () => {
    expect(pi.on).toHaveBeenCalledWith("context", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_before_compact", expect.any(Function));
    expect(pi.on).not.toHaveBeenCalledWith("message_end", expect.any(Function));
  });

  describe("live compaction usage epoch", () => {
    it("prevents retained pre-summary usage from collapsing the first answer budget", async () => {
      const model: Model<"openai-completions"> = {
        id: "usage-epoch-model",
        name: "Usage epoch model",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl: "https://example.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
      };
      const retainedAssistant = {
        ...assistantMessage([{ type: "text", text: "retained suffix" }]),
        timestamp: 100,
        usage: {
          ...usage,
          input: 127_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 127_000,
        },
      };
      const messages: AgentMessage[] = [
        { role: "compactionSummary", summary: "checkpoint", tokensBefore: 127_000, timestamp: 200 },
        retainedAssistant,
        { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 201 },
      ];
      const providerContextBefore = {
        systemPrompt: "",
        tools: [],
        messages: await convertAgentMessagesToLlm(messages),
      };
      expect(clampMaxTokensToContext(model, providerContextBefore, 32_000)).toBe(1);

      const result = await pi.trigger("context", { messages });
      const providerContextAfter = {
        systemPrompt: "",
        tools: [],
        messages: await convertAgentMessagesToLlm(result.messages),
      };

      expect(result.messages[1].usage.totalTokens).toBe(0);
      expect(retainedAssistant.usage.totalTokens).toBe(127_000);
      expect(clampMaxTokensToContext(model, providerContextAfter, 32_000)).toBe(32_000);
    });

    it("does not project ordinary non-compacted conversations", async () => {
      const messages = [assistantMessage([{ type: "text", text: "ordinary answer" }])];

      const result = await pi.trigger("context", { messages });

      expect(result).toBeUndefined();
    });
  });

  describe("L1: tool_result truncation", () => {
    it("leaves short text unchanged", async () => {
      (truncateTextHeadTail as any).mockReturnValue({ text: "short", truncated: false, originalBytes: 5 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "short" }],
      });
      expect(res).toBeUndefined();
    });

    it("replaces long text content with truncated version", async () => {
      (truncateTextHeadTail as any).mockReturnValue({
        text: "HEAD...[省略]...TAIL",
        truncated: true,
        originalBytes: 200_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(200_000) }],
      });
      expect(res).toEqual({ content: [{ type: "text", text: "HEAD...[省略]...TAIL" }] });
    });

    it("does NOT truncate error results (preserves diagnostic info)", async () => {
      const res = await pi.trigger("tool_result", {
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("does NOT touch image blocks", async () => {
      (truncateTextHeadTail as any).mockReturnValue({ text: "", truncated: false, originalBytes: 0 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "image", source: { data: "..." } }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("mixes truncated text blocks with untouched image blocks", async () => {
      (truncateTextHeadTail as any).mockReturnValueOnce({
        text: "TRUNCATED",
        truncated: true,
        originalBytes: 100_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "x".repeat(100_000) },
          { type: "image", source: { data: "..." } },
        ],
      });
      expect(res).toEqual({
        content: [
          { type: "text", text: "TRUNCATED" },
          { type: "image", source: { data: "..." } },
        ],
      });
    });

    it("swallows hook exceptions and returns undefined (passthrough)", async () => {
      (truncateTextHeadTail as any).mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
    });

    it("returns undefined when content is not an array", async () => {
      const res = await pi.trigger("tool_result", { toolName: "custom", isError: false, content: null });
      expect(res).toBeUndefined();
    });
  });

  describe("L3: session_before_compact preemptive hard truncate", () => {
    const model = { id: "m", provider: "p", contextWindow: 128_000 };
    const oldMessage = {
      role: "user",
      content: [{ type: "text", text: "old history to summarize" }],
      timestamp: 1,
    };
    const retainedTail = {
      role: "assistant",
      content: [{ type: "text", text: "retained live tail" }],
      timestamp: 2,
    };
    const preparation = {
      firstKeptEntryId: "uuid-42",
      messagesToSummarize: [oldMessage],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 90_000,
      settings: { keepRecentTokens: 20_000, reserveTokens: 4_096 },
    };
    const ctx = {
      model,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "key",
          headers: { "x-test": "1" } as Record<string, string>,
        })),
      },
      getSystemPrompt: vi.fn(() => "system prompt"),
      sessionManager: {
        getSessionFile: () => "/sessions/current.jsonl",
        getBranch: () => [],
        buildSessionContext: () => ({
          thinkingLevel: "off",
          messages: [oldMessage, retainedTail],
        }),
      },
    };

    it("returns cache-preserving compaction when summarize tokens are within threshold", async () => {
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );
      expect(res).toEqual({
        compaction: {
          summary: "cache summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
      });
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        preparation,
        model,
        systemPrompt: "system prompt",
        customInstructions: undefined,
        thinkingLevel: "off",
        outputPolicy: "provider-default",
        sessionSnapshot: expect.objectContaining({
          sessionPath: "/sessions/current.jsonl",
          tools: [{
            name: "read",
            description: "Read files",
            parameters: { type: "object" },
          }],
        }),
        tools: [{
          name: "read",
          label: "Read",
          description: "Read files",
          parameters: { type: "object" },
          execute: expect.any(Function),
        }],
      }));
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: [oldMessage, retainedTail],
      }));
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        messages: [oldMessage, retainedTail],
        retainedMessageCount: 1,
      }));
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("normalizes the compaction payload exactly like a live request on the same session", async () => {
      // The compaction request rides the same cache prefix as the live request.
      // If the two paths normalize differently, the prefix diverges and the
      // cache breaks. This pins them to the same normalization: the roleplay
      // reasoning patch a live request applies has to reach compaction too.
      pi = createMockPi();
      const deepseekModel = {
        ...model,
        id: "deepseek-v4-chat",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
      };
      const providerCompatOptions = {
        deepseekRoleplayReasoningPatch: true,
        deepseekRoleplayReasoningContext: { agentName: "Hana", agentDescription: "", locale: "zh-CN" },
      };
      const getProviderCompatOptions = vi.fn(() => providerCompatOptions);
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getProviderCompatOptions,
      })(pi);

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, model: deepseekModel, getThinkingLevel: () => "medium" },
      );

      const request = cacheCompactor.mock.calls[0][0];
      const rawPayload = {
        model: deepseekModel.id,
        messages: [{ role: "user", content: "hello" }],
      };
      const compactionPayload = await request.streamOptions.onPayload(
        structuredClone(rawPayload),
        deepseekModel,
      );
      // What the live path produces for the same request, through the same
      // provider normalizer with the same options.
      const livePayload = normalizeProviderPayload(structuredClone(rawPayload), deepseekModel, {
        mode: "chat",
        reasoningLevel: "medium",
        ...providerCompatOptions,
      });

      expect(getProviderCompatOptions).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(compactionPayload.messages).toEqual(livePayload.messages);

    });

    // The reasoning level is part of the shared prefix too. The live request and
    // the compaction request for one session have to agree on whether reasoning
    // is on and at which level, or the prefix diverges and the cache is lost
    // without anything reporting it. Each scenario resolves the live answer
    // through the live resolver, hands compaction that same resolver, and
    // compares the two bodies.
    const deepseekModel = {
      ...model,
      id: "deepseek-v4-chat",
      provider: "deepseek",
      api: "openai-completions",
      reasoning: true,
      // Reaches the top effort, so a preference asking for it survives provider
      // normalization instead of being folded back down to "high".
      xhigh: true,
    };
    const identityModels = {
      getModelDefaultThinkingLevel: (_model, preferenceLevel) => preferenceLevel,
      resolveThinkingLevel: (level) => level,
    };

    async function compactionAndLivePayloads({ models: liveModels, prefs, sessionCtx }) {
      pi = createMockPi();
      const getRequestReasoningLevel = (requestCtx) => (
        resolveRequestReasoningLevelForContext(liveModels, prefs, requestCtx)
      );
      createCompactionGuardExtension({
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getRequestReasoningLevel,
      })(pi);

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        sessionCtx,
      );

      const request = cacheCompactor.mock.calls[0][0];
      const rawPayload = {
        model: deepseekModel.id,
        messages: [{ role: "user", content: "hello" }],
      };
      const compactionPayload = await request.streamOptions.onPayload(
        structuredClone(rawPayload),
        deepseekModel,
      );
      const livePayload = normalizeProviderPayload(structuredClone(rawPayload), deepseekModel, {
        mode: "chat",
        reasoningLevel: getRequestReasoningLevel(sessionCtx),
      });
      const reasoningShape = (payload) => ({
        thinking: payload.thinking,
        reasoning_effort: payload.reasoning_effort,
      });
      return {
        compactionReasoning: reasoningShape(compactionPayload),
        liveReasoning: reasoningShape(livePayload),
        compactionPayload,
        livePayload,
      };
    }

    it("reasons in the compaction request whenever the live request reasons", async () => {
      // The session itself states no thinking level, so a live request falls
      // back to the preference and reasons at "high". Compaction reading the
      // session alone would call it off and send a body without thinking.
      const sessionCtx = {
        ...ctx,
        model: deepseekModel,
        sessionManager: {
          ...ctx.sessionManager,
          buildSessionContext: () => ({ messages: [oldMessage, retainedTail] }),
        },
      };
      const { compactionReasoning, liveReasoning } = await compactionAndLivePayloads({
        models: identityModels,
        prefs: { getThinkingLevel: () => "high" },
        sessionCtx,
      });

      expect(liveReasoning).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
      expect(compactionReasoning).toEqual(liveReasoning);
    });

    it("reasons at the same level as the live request when the preference outranks the session", async () => {
      // A session pinned at "high" under a preference asking for "max" runs its
      // live requests at "max". Compaction reading the session level alone would
      // send "high" and pay for a cold prefix.
      const sessionCtx = {
        ...ctx,
        model: deepseekModel,
        getThinkingLevel: () => "high",
        sessionManager: {
          ...ctx.sessionManager,
          buildSessionContext: () => ({
            thinkingLevel: "high",
            messages: [oldMessage, retainedTail],
          }),
        },
      };
      const { compactionReasoning, liveReasoning } = await compactionAndLivePayloads({
        models: identityModels,
        prefs: { getThinkingLevel: () => "max" },
        sessionCtx,
      });

      expect(liveReasoning).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
      expect(compactionReasoning).toEqual(liveReasoning);
    });

    it("turns reasoning off in the compaction request when the live request has it off", async () => {
      // Mirror image of the first case: a session that says "off" must not have
      // its compaction request quietly reason at the preference's level.
      const sessionCtx = {
        ...ctx,
        model: deepseekModel,
        getThinkingLevel: () => "off",
      };
      const { compactionReasoning, liveReasoning } = await compactionAndLivePayloads({
        models: identityModels,
        prefs: { getThinkingLevel: () => "high" },
        sessionCtx,
      });

      expect(liveReasoning).toEqual({ thinking: { type: "disabled" }, reasoning_effort: undefined });
      expect(compactionReasoning).toEqual(liveReasoning);
    });

    it("composes the keyed ordinary payload hook before compaction normalization and cache affinity", async () => {
      pi = createMockPi();
      const streamFn = vi.fn();
      const onResponse = vi.fn();
      const ordinaryOnPayload = vi.fn()
        .mockImplementationOnce(async (payload) => ({
          ...payload,
          max_output_tokens: 777,
          reasoning_effort: "auto",
          ordinaryHook: true,
        }))
        .mockResolvedValueOnce(undefined);
      const runtimeTools = [{
        name: "read",
        label: "Read",
        description: "Read files",
        parameters: { type: "object" },
        execute: vi.fn(),
      }];
      const getSessionAgentRunRuntime = vi.fn(() => ({
        streamFn,
        tools: runtimeTools,
        streamOptions: {
          sessionId: "runtime-session-id",
          onPayload: ordinaryOnPayload,
          onResponse,
          transport: "sse",
          thinkingBudgets: { high: 8192 },
          maxRetryDelayMs: 1234,
        },
      }));
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getSessionProviderCacheAffinityKey: () => "persisted-lineage",
      })(pi);
      const requestModel = {
        ...model,
        api: "openai-responses",
        provider: "openai",
        reasoning: true,
      };

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: requestModel,
          sessionManager: {
            ...ctx.sessionManager,
            getSessionId: () => "ctx-session-id",
          },
        },
      );

      expect(getSessionAgentRunRuntime).toHaveBeenCalledWith("/sessions/current.jsonl");
      const request = cacheCompactor.mock.calls[0][0];
      expect(request.streamFn).toBe(streamFn);
      expect(request.tools).toBe(runtimeTools);
      expect(request.streamOptions).toMatchObject({
        sessionId: "runtime-session-id",
        onResponse,
        transport: "sse",
        thinkingBudgets: { high: 8192 },
        maxRetryDelayMs: 1234,
      });
      const transformed = await request.streamOptions.onPayload({
        prompt_cache_key: "ctx-session-id",
        max_output_tokens: 100,
        input: [],
      }, requestModel);
      expect(transformed).toMatchObject({
        ordinaryHook: true,
        prompt_cache_key: "persisted-lineage",
        reasoning_effort: "medium",
      });
      expect(transformed).not.toHaveProperty("max_output_tokens");
      const undefinedResult = await request.streamOptions.onPayload({
        prompt_cache_key: "ctx-session-id",
        max_output_tokens: 100,
        preservedOriginal: true,
        input: [],
      }, requestModel);
      expect(undefinedResult).toMatchObject({
        prompt_cache_key: "persisted-lineage",
        preservedOriginal: true,
      });
      expect(undefinedResult).not.toHaveProperty("max_output_tokens");
    });

    it("falls back before compaction when the keyed AgentRun runtime has no stream function", async () => {
      pi = createMockPi();
      const getSessionAgentRunRuntime = vi.fn(() => ({
        streamFn: null,
        tools: [],
        streamOptions: {},
      }));
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(result).toBeUndefined();
      expect(getSessionAgentRunRuntime).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    });

    it("runs the default compactor with full keyed tools and placeholder-only tool recovery", async () => {
      pi = createMockPi();
      const prepareArguments = vi.fn((args: any) => ({ path: args.inputPath }));
      const liveExecute = vi.fn(async () => ({
        content: [{ type: "text", text: "real tool output" }],
        details: {},
      }));
      const runtimeTools = [{
        name: "read",
        label: "Read",
        description: "Read files",
        parameters: Type.Object({ path: Type.String() }),
        prepareArguments,
        execute: liveExecute,
      }];
      const responses = [
        assistantMessage([{
          type: "toolCall",
          id: "call-prepare",
          name: "read",
          arguments: { inputPath: "notes.md" },
        }], "toolUse"),
        assistantMessage([{ type: "text", text: VALID_COMPACTION_SUMMARY }]),
      ];
      const providerContexts: any[] = [];
      const streamFn = vi.fn(async (_model, providerContext, options) => {
        providerContexts.push({
          messages: [...providerContext.messages],
          tools: providerContext.tools,
          options,
        });
        return assistantStream(responses.shift());
      });
      const onResponse = vi.fn();
      const getSessionAgentRunRuntime = vi.fn(() => ({
        streamFn,
        tools: runtimeTools,
        streamOptions: {
          sessionId: "runtime-session-id",
          onPayload: vi.fn(async (payload) => payload),
          onResponse,
          transport: "sse",
          thinkingBudgets: { high: 8192 },
          maxRetryDelayMs: 1234,
        },
      }));
      const requestModel = {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        buildSessionCacheSnapshot: (sessionPath, { reason, messages }) => (
          buildSessionCacheSnapshotValue({
            sessionPath,
            reason,
            model: requestModel,
            cacheKeyParams: { thinkingLevel: "off" },
            systemPrompt: "system prompt",
            tools: runtimeTools,
            messages,
          })
        ),
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: requestModel,
          sessionManager: {
            ...ctx.sessionManager,
            getSessionId: () => "runtime-session-id",
          },
        },
      );

      expect(result?.compaction?.summary).toBe(VALID_COMPACTION_SUMMARY);
      expect(prepareArguments).toHaveBeenCalledWith({ inputPath: "notes.md" });
      expect(liveExecute).not.toHaveBeenCalled();
      expect(providerContexts).toHaveLength(2);
      expect(providerContexts[0].tools[0]).toMatchObject({
        name: "read",
        label: "Read",
        prepareArguments,
      });
      expect(providerContexts[1].messages.at(-1)).toMatchObject({
        role: "toolResult",
        toolCallId: "call-prepare",
        isError: false,
      });
      expect(providerContexts[0].options).toMatchObject({
        sessionId: "runtime-session-id",
        onResponse,
        transport: "sse",
        thinkingBudgets: { high: 8192 },
        maxRetryDelayMs: 1234,
      });
    });

    it("hard truncates before a provider call when large runtime tool schemas make A and B exceed the boundary", async () => {
      pi = createMockPi();
      const previousSummary = "prior checkpoint ".repeat(120);
      const previousSummaryMessage = {
        role: "compactionSummary",
        summary: previousSummary,
        timestamp: 0,
      };
      const boundaryPreparation = {
        ...preparation,
        previousSummary,
        messagesToSummarize: [oldMessage],
        settings: { keepRecentTokens: 100, reserveTokens: 640 },
      };
      const boundaryMessages = [previousSummaryMessage, oldMessage];
      const noToolBudget = estimateCachePreservingCompactionRequest({
        preparation: boundaryPreparation,
        messages: boundaryMessages,
        retainedMessageCount: 0,
        model: { maxTokens: 512 },
        systemPrompt: "",
        tools: [],
      } as any);
      expect(noToolBudget.nativeSummaryBudget.totalTokens)
        .toBeGreaterThan(noToolBudget.cachePreservingBudget.totalTokens);
      const contextWindow = noToolBudget.nativeSummaryBudget.totalTokens - 1;
      const streamFn = vi.fn();
      const runtimeTools = [{
        name: "schema_heavy_tool",
        label: "Schema heavy tool",
        description: "x".repeat(8_000),
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "y".repeat(8_000),
            },
          },
        },
        execute: vi.fn(),
      }];
      const getSessionAgentRunRuntime = vi.fn(() => ({
        streamFn,
        tools: runtimeTools,
        streamOptions: { sessionId: "runtime-session-id" },
      }));
      (computeHardTruncation as any).mockReturnValue({
        summary: "[hard truncated]",
        firstKeptEntryId: "uuid-42",
        tokensBefore: 90_000,
        details: { reason: "compaction-guard-hard-truncate" },
      });
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        hardTruncateThreshold: 1,
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation: boundaryPreparation, signal: { aborted: false } },
        {
          ...ctx,
          model: { ...model, contextWindow, maxTokens: 512 },
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: boundaryMessages,
            }),
          },
        },
      );

      expect(result).toMatchObject({
        compaction: {
          summary: "[hard truncated]",
          details: { reason: "compaction-guard-hard-truncate" },
        },
      });
      expect(computeHardTruncation).toHaveBeenCalledOnce();
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(streamFn).not.toHaveBeenCalled();
    });

    it("falls back before compaction decisions when the session path is missing", async () => {
      pi = createMockPi();
      const ownershipResolver = vi.fn(() => identityTransformContext);
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext: ownershipResolver,
        getCompactionMode: () => "auto",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            getSessionFile: () => null,
          },
        },
      );

      expect(result).toBeUndefined();
      expect(ownershipResolver).not.toHaveBeenCalled();
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("cancels explicit cache mode before compaction decisions when the ownership accessor is absent", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "cache_preserving",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(result).toEqual({ cancel: true });
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("falls back before compaction decisions when the keyed session is unknown", async () => {
      pi = createMockPi();
      const ownershipResolver = vi.fn(() => null);
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext: ownershipResolver,
        getCompactionMode: () => "auto",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(result).toBeUndefined();
      expect(ownershipResolver).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("accepts a resolved session whose explicit transform is identity", async () => {
      pi = createMockPi();
      const ownershipResolver = vi.fn(() => identityTransformContext);
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext: ownershipResolver,
        getSessionAgentRunRuntime,
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(result?.compaction?.summary).toBe("cache summary");
      expect(ownershipResolver).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(cacheCompactor).toHaveBeenCalledOnce();
    });

    it("shares the persisted cache lineage during compaction without replacing the child Pi identity", async () => {
      pi = createMockPi();
      const getSessionProviderCacheAffinityKey = vi.fn(() => "pi-source-lineage");
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionProviderCacheAffinityKey,
        getSessionTransformContext,
        getSessionAgentRunRuntime: () => ({
          ...getSessionAgentRunRuntime(),
          streamOptions: { sessionId: "pi-child" },
        }),
      })(pi);
      const codexModel = {
        ...model,
        api: "openai-codex-responses",
        provider: "openai-codex",
      };

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: codexModel,
          sessionManager: {
            ...ctx.sessionManager,
            getSessionId: () => "pi-child",
          },
        },
      );

      expect(getSessionProviderCacheAffinityKey).toHaveBeenCalledWith("/sessions/current.jsonl");
      const streamOptions = cacheCompactor.mock.calls[0][0].streamOptions;
      expect(streamOptions.sessionId).toBe("pi-child");
      await expect(streamOptions.onPayload({
        prompt_cache_key: "pi-child",
        input: [],
      }, codexModel)).resolves.toMatchObject({
        prompt_cache_key: "pi-source-lineage",
        input: [],
      });
    });

    it("accepts resolver-approved header-only credentials", async () => {
      ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
        ok: true,
        apiKey: undefined,
        headers: { Authorization: "Bearer header-owned-token" },
      });

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res?.compaction?.summary).toBe("cache summary");
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        streamOptions: expect.objectContaining({
          apiKey: undefined,
          headers: { Authorization: "Bearer header-owned-token" },
        }),
      }));
    });

    it("lets Pi SDK native compaction run when pi-compatible mode is selected", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getCompactionMode: () => "pi_compatible",
      })(pi);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toBeUndefined();
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("falls back to Pi SDK native compaction when auto cache-preserving compaction fails", async () => {
      pi = createMockPi();
      const failingCompactor = vi.fn(async () => {
        throw new Error("cache prefix mismatch");
      });
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor: failingCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toBeUndefined();
      expect(failingCompactor).toHaveBeenCalledOnce();
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: [oldMessage, retainedTail],
      }));
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("compacts after removing only a complete malformed DeepSeek tool turn from old history", async () => {
      pi = createMockPi();
      const deepseekModel = {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };
      const oldToolCall = {
        ...assistantMessage(
          [{ type: "toolCall", id: "call-old", name: "read", arguments: {} }],
          "toolUse",
        ),
        api: deepseekModel.api,
        provider: deepseekModel.provider,
        model: deepseekModel.id,
        timestamp: 2,
      };
      const oldToolResult = {
        role: "toolResult",
        toolCallId: "call-old",
        toolName: "read",
        content: [{ type: "text", text: "old result" }],
        isError: false,
        timestamp: 3,
      };
      const oldFinal = {
        ...assistantMessage([{ type: "text", text: "old answer" }]),
        timestamp: 4,
      };
      const retainedUser = {
        role: "user",
        content: [{ type: "text", text: "retained request" }],
        timestamp: 5,
      };
      const malformedOldMessages = [oldMessage, oldToolCall, oldToolResult, oldFinal];
      createCompactionGuardExtension({
        getRequestReasoningLevel: () => "high",
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: malformedOldMessages,
          },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: deepseekModel,
          getThinkingLevel: () => "high",
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "high",
              messages: [...malformedOldMessages, retainedUser],
            }),
          },
        },
      );

      expect(result).toMatchObject({ compaction: { summary: "cache summary" } });
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        messages: [retainedUser],
        retainedMessageCount: 1,
        historyRecovery: {
          kind: "reasoning-replay-prefix-trim",
          removedMessageCount: 4,
        },
        cacheMetadataOverride: expect.objectContaining({
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "malformed_reasoning_history_trim",
        }),
      }));
    });

    it("surfaces an unsafe retained reasoning replay error instead of silently using native compaction", async () => {
      pi = createMockPi();
      const deepseekModel = {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };
      const retainedToolCall = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-retained", name: "read", arguments: {} }],
        api: deepseekModel.api,
        provider: deepseekModel.provider,
        model: deepseekModel.id,
        timestamp: 2,
      };
      createCompactionGuardExtension({
        getRequestReasoningLevel: () => "high",
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);

      await expect(pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: deepseekModel,
          getThinkingLevel: () => "high",
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "high",
              messages: [oldMessage, retainedToolCall],
            }),
          },
        },
      )).rejects.toMatchObject({
        name: "CompactionHistoryReplayError",
        code: "COMPACTION_HISTORY_REPLAY_UNPROCESSABLE",
        statusCode: 422,
        details: { boundaryRegion: "retained" },
      });
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    });

    it("cancels instead of falling back when explicit cache-preserving mode fails", async () => {
      pi = createMockPi();
      const failingCompactor = vi.fn(async () => {
        throw new Error("cache prefix mismatch");
      });
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor: failingCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "cache_preserving",
      })(pi);

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toEqual({ cancel: true });
      expect(failingCompactor).toHaveBeenCalledOnce();
    });

    it("preserves the auto fallback and explicit cancel behavior when model auth is unavailable", async () => {
      const authUnavailableCtx = {
        ...ctx,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(async () => ({
            ok: false,
            error: "missing credentials",
          })),
        },
      };
      const autoPi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(autoPi);
      const explicitPi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "cache_preserving",
      })(explicitPi);

      const autoResult = await autoPi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        authUnavailableCtx,
      );
      const explicitResult = await explicitPi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        authUnavailableCtx,
      );

      expect(autoResult).toBeUndefined();
      expect(explicitResult).toEqual({ cancel: true });
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    });

    it("strips inline media from Pi preparation while preserving the full normalized live prefix", async () => {
      const mediaPreparation = {
        ...preparation,
        messagesToSummarize: [
          {
            role: "user",
            content: [
              { type: "text", text: "[attached_audio: /tmp/recording.wav]\n听一下" },
              { type: "audio", data: "BASE64_AUDIO", mimeType: "audio/wav" },
            ],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_screenshot",
            toolName: "browser_screenshot",
            content: [
              { type: "text", text: "Screenshot captured" },
              { type: "image", data: "BASE64_IMAGE", mimeType: "image/png" },
            ],
            timestamp: 2,
          },
        ],
      };

      await pi.trigger(
        "session_before_compact",
        { preparation: mediaPreparation, signal: { aborted: false } },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [...mediaPreparation.messagesToSummarize, retainedTail],
            }),
          },
        },
      );

      const passedPreparation = cacheCompactor.mock.calls[0][0].preparation;
      expect(JSON.stringify(passedPreparation)).not.toContain("BASE64_AUDIO");
      expect(JSON.stringify(passedPreparation)).not.toContain("BASE64_IMAGE");
      expect(passedPreparation.messagesToSummarize[0].content).toEqual([
        { type: "text", text: "[attached_audio: /tmp/recording.wav]\n听一下" },
      ]);
      expect(passedPreparation.messagesToSummarize[1].content).toEqual([
        { type: "text", text: "Screenshot captured" },
        { type: "text", text: "[图片已省略：历史图片保留为文件引用，避免重复发送原始 base64]" },
      ]);

      const passedMessages = cacheCompactor.mock.calls[0][0].messages;
      expect(JSON.stringify(passedMessages)).toContain("BASE64_AUDIO");
      expect(JSON.stringify(passedMessages)).toContain("BASE64_IMAGE");
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith("/sessions/current.jsonl", expect.objectContaining({
        reason: "compaction.history",
        messages: passedMessages,
      }));
    });

    it("uses the full built session context instead of transient extension events", async () => {
      await pi.trigger("context", {
        messages: [{ role: "user", content: [{ type: "text", text: "live context" }], timestamp: 1 }],
      });
      await pi.trigger("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
      });

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(cacheCompactor.mock.calls[0][0].messages).toEqual([oldMessage, retainedTail]);
    });

    it("passes the retained tail to the cache compactor as part of the full live prefix", async () => {
      await pi.trigger("context", {
        messages: [
          { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "KEPT_TAIL_SHOULD_NOT_ENTER_SUMMARY" }], timestamp: 2 },
        ],
      });

      await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [
              { role: "user", content: [{ type: "text", text: "old history to summarize" }], timestamp: 1 },
            ],
          },
          signal: { aborted: false },
        },
        ctx,
      );

      const passedMessages = cacheCompactor.mock.calls[0][0].messages;
      expect(passedMessages).toHaveLength(2);
      expect(JSON.stringify(passedMessages)).toContain("old history to summarize");
      expect(JSON.stringify(passedMessages)).toContain("retained live tail");
      expect(cacheCompactor.mock.calls[0][0].retainedMessageCount).toBe(1);
    });

    it("materializes the keyed session transform exactly once before snapshotting the prefix", async () => {
      pi = createMockPi();
      const toolResult = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "raw tool output" }],
        timestamp: 2,
      };
      const transformedPreparation = {
        ...preparation,
        messagesToSummarize: [oldMessage, toolResult],
      };
      let boundaryPlaceholder = "";
      const transformContext = vi.fn(async (messages) => {
        boundaryPlaceholder = messages.at(-1).content[0].text.match(
          /<hana\.compaction\.boundary:[^>]+>/,
        )?.[0] || "";
        return [
          {
            role: "user",
            content: [{ type: "text", text: "injected system context" }],
            timestamp: 0,
          },
          ...messages.slice(0, -1).map((message) => (
            message.role === "toolResult"
              ? {
                  ...message,
                  content: [{ type: "text", text: "rewritten tool output" }],
                }
              : message
          )),
          {
            ...messages.at(-1),
            content: [{
              type: "text",
              text: `rewritten before\n${messages.at(-1).content[0].text}\nrewritten after`,
            }],
          },
        ];
      });
      getSessionTransformContext = vi.fn(() => transformContext);
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
      })(pi);

      await pi.trigger(
        "session_before_compact",
        { preparation: transformedPreparation, signal: { aborted: false } },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [oldMessage, toolResult, retainedTail],
            }),
          },
        },
      );

      expect(getSessionTransformContext).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(transformContext).toHaveBeenCalledTimes(1);
      expect(boundaryPlaceholder).toMatch(/^<hana\.compaction\.boundary:/);
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [{ type: "text", text: "injected system context" }],
          }),
          oldMessage,
          expect.objectContaining({
            role: "toolResult",
            content: [{ type: "text", text: "rewritten tool output" }],
          }),
          retainedTail,
        ],
        instruction: expect.objectContaining({
          content: [{
            type: "text",
            text: expect.stringMatching(
              /^rewritten before\nInternal compaction-only run\.[\s\S]*Old region: live message indexes \[0, 3\)\.[\s\S]*\nrewritten after$/,
            ),
          }],
        }),
        retainedMessageCount: 1,
      }));
      expect(buildSessionCacheSnapshot).toHaveBeenCalledWith(
        "/sessions/current.jsonl",
        expect.objectContaining({
          messages: cacheCompactor.mock.calls[0][0].messages,
        }),
      );
      expect(JSON.stringify(cacheCompactor.mock.calls[0][0])).not.toContain(boundaryPlaceholder);
      expect(JSON.stringify(buildSessionCacheSnapshot.mock.calls[0][1])).not.toContain(boundaryPlaceholder);
    });

    it("falls back with the typed prefix error when session transform filters a live message", async () => {
      pi = createMockPi();
      const transformContext = vi.fn(async (messages) => messages.filter((message) => (
        message.content?.[0]?.text !== "old history to summarize"
      )));
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext: () => transformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);

      const result = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(result).toBeUndefined();
      expect(cacheCompactor).not.toHaveBeenCalled();
      expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    });

    it("does not read stale session-bound pi helpers during compaction", async () => {
      pi.getThinkingLevel.mockImplementation(() => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      });

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(res).toMatchObject({ compaction: expect.any(Object) });
      expect(pi.getThinkingLevel).not.toHaveBeenCalled();
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        thinkingLevel: "off",
      }));
    });

    it("uses the session snapshot cache params for the side-task request contract", async () => {
      (buildSessionCacheSnapshot as any).mockImplementationOnce((sessionPath: any, { reason, messages }: any = {}) => ({
        strategy: "session_snapshot",
        strict: true,
        sessionPath,
        reason,
        cachePrefixHash: "b".repeat(64),
        cacheKeyParams: { thinkingLevel: "medium" },
        tools: [],
        messages,
        messageCount: Array.isArray(messages) ? messages.length : 0,
      }));

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        ctx,
      );

      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        sessionSnapshot: expect.objectContaining({
          cacheKeyParams: { thinkingLevel: "medium" },
        }),
        cacheKeyParams: { thinkingLevel: "medium" },
      }));
    });

    it("canonicalizes legacy auto thinking before compaction side-task requests", async () => {
      const deepseekModel = {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        maxTokens: 64_000,
        contextWindow: 128_000,
      };
      (buildSessionCacheSnapshot as any).mockImplementationOnce((sessionPath: any, { reason, messages }: any = {}) => ({
        strategy: "session_snapshot",
        strict: true,
        sessionPath,
        reason,
        cachePrefixHash: "b".repeat(64),
        cacheKeyParams: { thinkingLevel: "auto" },
        tools: [],
        messages,
        messageCount: Array.isArray(messages) ? messages.length : 0,
      }));

      await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: deepseekModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "auto",
              messages: [oldMessage, retainedTail],
            }),
          },
        },
      );

      const call = cacheCompactor.mock.calls[0][0];
      expect(call.cacheKeyParams).toEqual({ thinkingLevel: "medium" });
      expect(call.thinkingLevel).toBe("medium");
      const normalizedPayload = await call.streamOptions.onPayload({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "auto",
        max_tokens: 32000,
      }, deepseekModel);
      expect(normalizedPayload).toMatchObject({ reasoning_effort: "high" });
      expect(normalizedPayload).not.toHaveProperty("max_tokens");
    });

    it("uses explicit cache recovery when GLM thinking tool-call history cannot replay reasoning_content", async () => {
      const glmModel = {
        id: "glm-4.5",
        provider: "zhipu",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };
      const glmHistory = {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      };
      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [glmHistory],
          },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: glmModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "high",
              messages: [glmHistory, retainedTail],
            }),
          },
        },
      );

      expect(res).toMatchObject({ compaction: expect.any(Object) });
      expect(cacheCompactor).toHaveBeenCalledWith(expect.objectContaining({
        model: glmModel,
        thinkingLevel: "high",
        cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "clear" },
        cacheMetadataOverride: expect.objectContaining({
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "reasoning_replay_unavailable",
        }),
      }));
      const call = cacheCompactor.mock.calls[0][0];
      const recoveredPayload = await call.streamOptions.onPayload({
        model: "glm-4.5",
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        }],
      }, glmModel);
      expect(recoveredPayload.thinking).toEqual({ type: "enabled", clear_thinking: true });
      expect(recoveredPayload.messages[0]).toMatchObject({ content: "" });
      expect(recoveredPayload.messages[0]).not.toHaveProperty("reasoning_content");
    });

    it("auto-recovers when reasoning replay only fails during the compaction request", async () => {
      pi = createMockPi();
      const requestStageCompactor = vi.fn()
        .mockRejectedValueOnce(new Error(
          "Zhipu thinking mode reasoning_content is missing for tool_calls history. Compact this session or start a new session before continuing with Zhipu thinking mode.",
        ))
        .mockResolvedValueOnce({
          summary: "request-stage recovery summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        });
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor: requestStageCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);
      const glmModel = {
        id: "glm-5.1",
        provider: "zhipu",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
      };

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: glmModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "high",
              messages: [oldMessage, retainedTail],
            }),
          },
        },
      );

      expect(res).toEqual({
        compaction: {
          summary: "request-stage recovery summary",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
      });
      expect(requestStageCompactor).toHaveBeenCalledTimes(2);
      expect(requestStageCompactor.mock.calls[0][0]).toMatchObject({
        model: glmModel,
        cacheMetadataOverride: null,
      });
      expect(requestStageCompactor.mock.calls[1][0]).toMatchObject({
        model: glmModel,
        thinkingLevel: "high",
        cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "clear" },
        cacheMetadataOverride: expect.objectContaining({
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "reasoning_replay_unavailable",
        }),
      });
      const recoveryPayload = await requestStageCompactor.mock.calls[1][0].streamOptions.onPayload({
        model: "glm-5.1",
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        }],
      }, glmModel);
      expect(recoveryPayload.thinking).toEqual({ type: "enabled", clear_thinking: true });
    });

    it("does not clear or retry a Kimi replay contract that requires preserved tool-call reasoning", async () => {
      pi = createMockPi();
      const requestStageCompactor = vi.fn()
        .mockRejectedValueOnce(new Error(
          "Kimi thinking mode reasoning_content is missing for tool_calls history (assistant tool call). Compact this session or start a new session before continuing with Kimi thinking mode.",
        ))
        .mockResolvedValueOnce({
          summary: "must not be used",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { readFiles: [], modifiedFiles: [] },
        });
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor: requestStageCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "auto",
      })(pi);
      const kimiModel = {
        id: "k3",
        provider: "kimi-coding",
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
        reasoning: true,
        contextWindow: 1_048_576,
      };

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          model: kimiModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "max",
              messages: [oldMessage, retainedTail],
            }),
          },
        },
      );

      expect(res).toBeUndefined();
      expect(requestStageCompactor).toHaveBeenCalledTimes(1);
    });

    it("falls back to Pi native in auto when full-prefix A is over but native-summary B fits", async () => {
      const tinyModel = { ...model, contextWindow: 3_000 };
      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: { ...preparation, settings: { keepRecentTokens: 100, reserveTokens: 640 } },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: tinyModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [
                oldMessage,
                { role: "assistant", content: [{ type: "text", text: "x".repeat(8_000) }], timestamp: 2 },
              ],
            }),
          },
        },
      );

      expect(res).toBeUndefined();
      expect(computeHardTruncation).not.toHaveBeenCalled();
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("cancels explicit cache mode when full-prefix A is over but native-summary B fits", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "cache_preserving",
      })(pi);
      const tinyModel = { ...model, contextWindow: 3_000 };

      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: { ...preparation, settings: { keepRecentTokens: 100, reserveTokens: 640 } },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: tinyModel,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [
                oldMessage,
                { role: "assistant", content: [{ type: "text", text: "x".repeat(8_000) }], timestamp: 2 },
              ],
            }),
          },
        },
      );

      expect(res).toEqual({ cancel: true });
      expect(computeHardTruncation).not.toHaveBeenCalled();
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("returns the existing hard truncation only when both request shapes exceed threshold", async () => {
      (computeHardTruncation as any).mockReturnValue({
        summary: "[hard truncated]",
        firstKeptEntryId: "uuid-42",
        tokensBefore: 90_000,
        details: { reason: "compaction-guard-hard-truncate" },
      });
      const branch = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
      const oversizedOld = {
        role: "user",
        content: [{ type: "text", text: "x".repeat(20_000) }],
        timestamp: 1,
      };
      const oversizedPreparation = {
        ...preparation,
        messagesToSummarize: [oversizedOld],
        settings: { keepRecentTokens: 20_000, reserveTokens: 640 },
      };
      const res = await pi.trigger(
        "session_before_compact",
        { preparation: oversizedPreparation, signal: { aborted: false } },
        {
          ...ctx,
          model: { ...model, contextWindow: 3_000 },
          sessionManager: {
            ...ctx.sessionManager,
            getBranch: () => branch,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [oversizedOld, retainedTail],
            }),
          },
        },
      );
      expect(res).toEqual({
        compaction: {
          summary: "[hard truncated]",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { reason: "compaction-guard-hard-truncate" },
        },
      });
      expect(computeHardTruncation).toHaveBeenCalledWith(branch, 20_000, expect.objectContaining({
        reason: "compaction-guard-hard-truncate",
      }));
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("maps an unprovable live boundary to native fallback in auto and cancel in explicit mode", async () => {
      const mismatchedCtx = {
        ...ctx,
        sessionManager: {
          ...ctx.sessionManager,
          buildSessionContext: () => ({
            thinkingLevel: "off",
            messages: [
              { role: "user", content: [{ type: "text", text: "different old history" }], timestamp: 1 },
              retainedTail,
            ],
          }),
        },
      };

      const autoResult = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        mismatchedCtx,
      );

      pi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        cacheCompactor,
        buildSessionCacheSnapshot,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
        getCompactionMode: () => "cache_preserving",
      })(pi);
      const explicitResult = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        mismatchedCtx,
      );

      expect(autoResult).toBeUndefined();
      expect(explicitResult).toEqual({ cancel: true });
      expect(cacheCompactor).not.toHaveBeenCalled();
    });

    it("cancels when hard truncate itself fails", async () => {
      (computeHardTruncation as any).mockReturnValue(null); // 无法截断
      const oversizedOld = {
        role: "user",
        content: [{ type: "text", text: "x".repeat(20_000) }],
        timestamp: 1,
      };
      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [oversizedOld],
            settings: { keepRecentTokens: 100, reserveTokens: 640 },
          },
          signal: { aborted: false },
        },
        {
          ...ctx,
          model: { ...model, contextWindow: 3_000 },
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [oversizedOld, retainedTail],
            }),
          },
        },
      );
      expect(res).toEqual({ cancel: true });
    });

    it("cancels when signal already aborted", async () => {
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: true } },
        ctx,
      );
      expect(res).toEqual({ cancel: true });
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("cancels when model is missing", async () => {
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, model: undefined },
      );
      expect(res).toEqual({ cancel: true });
    });

    it("cancels when contextWindow is 0", async () => {
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { ...ctx, model: { ...model, contextWindow: 0 } },
      );
      expect(res).toEqual({ cancel: true });
    });

    it("falls back to Pi native when an auto-mode hook dependency throws", async () => {
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => {
              throw new Error("boom");
            },
          },
        },
      );
      expect(res).toBeUndefined();
    });

    it("stops instead of starting a native summary when the compaction was aborted", async () => {
      // The session was cancelled mid-request. Handing the work to the native
      // summarizer would start a fresh, uncached request for a compaction
      // nobody is waiting for any more, so the hook stops.
      const signal = { aborted: false };
      cacheCompactor.mockImplementation(async () => {
        signal.aborted = true;
        const err: any = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      });

      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal },
        ctx,
      );

      expect(res).toEqual({ cancel: true });
    });

    it("honors custom hardTruncateThreshold option", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({
        getRequestReasoningLevel: sessionReasoningLevel,
        hardTruncateThreshold: 0.5,
        cacheCompactor,
        getSessionTransformContext,
        getSessionAgentRunRuntime,
      })(pi);
      const oversizedOld = {
        role: "user",
        content: [{ type: "text", text: "x".repeat(300_000) }],
        timestamp: 1,
      };
      (computeHardTruncation as any).mockReturnValue({
        summary: "s", firstKeptEntryId: "id", tokensBefore: 0, details: {},
      });
      const res = await pi.trigger(
        "session_before_compact",
        {
          preparation: {
            ...preparation,
            messagesToSummarize: [oversizedOld],
          },
          signal: { aborted: false },
        },
        {
          ...ctx,
          sessionManager: {
            ...ctx.sessionManager,
            buildSessionContext: () => ({
              thinkingLevel: "off",
              messages: [oversizedOld, retainedTail],
            }),
          },
        },
      );
      expect(res).toMatchObject({ compaction: expect.any(Object) });
      expect(computeHardTruncation).toHaveBeenCalledOnce();
      expect(cacheCompactor).not.toHaveBeenCalled();
    });
  });
});
