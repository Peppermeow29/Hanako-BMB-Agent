import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const {
  completeSimpleMock,
  convertAgentMessagesToLlmMock,
  estimateTokensMock,
  findCutPointMock,
  prepareCompactionMock,
} = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  convertAgentMessagesToLlmMock: vi.fn(async (messages) => messages),
  estimateTokensMock: vi.fn((message) => {
    const content = Array.isArray(message?.content)
      ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
      : String(message?.content || message?.summary || "");
    return Math.ceil(content.length / 4);
  }),
  findCutPointMock: vi.fn(() => ({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false })),
  prepareCompactionMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => ({
  ...await importOriginal<any>(),
  completeSimple: completeSimpleMock,
  convertAgentMessagesToLlm: convertAgentMessagesToLlmMock,
  estimateTokens: estimateTokensMock,
  findCutPoint: findCutPointMock,
  prepareCompaction: prepareCompactionMock,
}));

import {
  appendCompactionResultToSession,
  compactSessionWithCachePreservation,
  compactSessionWithCachePreservationRecoveringRuntime,
  createCachePreservingCompactionResult,
  createColdUtilitySummaryResult,
  estimateCachePreservingCompactionRequest,
  normalizeCompactionProviderPayload,
  isDirectCompactionInProgress,
  projectMessagesToLatestCompactionUsageEpoch,
  runCachePreservingCompactionForSession,
  runLossyLocalCompactionForSession,
  shouldHardTruncateCachePreservingCompaction,
} from "../core/session-compactor.ts";
import * as sessionCompactorModule from "../core/session-compactor.ts";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";
import { runSessionSnapshotSideTask } from "../lib/llm/session-snapshot-side-task-runner.ts";

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

function validCompactionSummary(label: string) {
  return VALID_COMPACTION_SUMMARY.replace(
    "- The recent tail remains verbatim.",
    `- ${label}`,
  );
}

function agentStreamOf(text = VALID_COMPACTION_SUMMARY, usageOverrides: Record<string, any> = {}) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usageOverrides,
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
    },
    async result() {
      return message;
    },
  };
}

function piUser(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function piAssistant(text: string, timestamp: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

const REAL_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 1000,
  keepRecentTokens: 1,
};

describe("session-compactor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertAgentMessagesToLlmMock.mockImplementation(async (messages) => messages);
    estimateTokensMock.mockImplementation((message) => {
      const content = Array.isArray(message?.content)
        ? message.content.map((block) => block?.text || block?.thinking || JSON.stringify(block || {})).join("")
        : String(message?.content || message?.summary || "");
      return Math.ceil(content.length / 4);
    });
    findCutPointMock.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("starts a fresh usage epoch at a live compaction summary", () => {
    const staleUsage = {
      input: 120_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 121_000,
      cost: { total: 1 },
    };
    const retainedAssistant = {
      ...piAssistant("retained suffix", 100),
      usage: staleUsage,
    };
    const messages = [
      { role: "compactionSummary", summary: "checkpoint", tokensBefore: 121_000, timestamp: 200 },
      retainedAssistant,
      piUser("continue", 201),
    ];

    const projected = projectMessagesToLatestCompactionUsageEpoch(messages);

    expect(projected).not.toBe(messages);
    expect(projected[1]).not.toBe(retainedAssistant);
    expect(projected[1].usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    expect(retainedAssistant.usage).toBe(staleUsage);
    expect(retainedAssistant.usage.totalTokens).toBe(121_000);
  });

  it("uses the latest summary for repeated compactions and preserves only proven newer usage", () => {
    const oldEpochUsage = { input: 80_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 80_100 };
    const retainedUsage = { input: 60_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 60_100 };
    const currentEpochUsage = { input: 4_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 4_500 };
    const messages = [
      { role: "compactionSummary", summary: "first", tokensBefore: 80_100, timestamp: 100 },
      { ...piAssistant("first epoch", 250), usage: oldEpochUsage },
      { role: "compactionSummary", summary: "second", tokensBefore: 60_100, timestamp: 300 },
      { ...piAssistant("retained after second summary", 250), usage: retainedUsage },
      { ...piAssistant("new answer", 350), usage: currentEpochUsage },
      piUser("next", 360),
    ];

    const projected = projectMessagesToLatestCompactionUsageEpoch(messages);

    expect(projected[1].usage.totalTokens).toBe(0);
    expect(projected[3].usage.totalTokens).toBe(0);
    expect(projected[4]).toBe(messages[4]);
    expect(projected[4].usage).toBe(currentEpochUsage);
  });

  it("treats missing timestamps as stale but leaves non-compacted budgeting untouched", () => {
    const usage = {
      input: 10_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const ordinaryMessages = [{ ...piAssistant("ordinary", 100), usage }];
    expect(projectMessagesToLatestCompactionUsageEpoch(ordinaryMessages)).toBe(ordinaryMessages);

    const legacyRetained: ReturnType<typeof piAssistant> & { timestamp: number | undefined } = {
      ...piAssistant("legacy retained", 0),
      timestamp: undefined,
      usage,
    };
    const legacyMessages = [
      { role: "compactionSummary", summary: "checkpoint", tokensBefore: 10_100, timestamp: 200 },
      legacyRetained,
    ];
    const projected = projectMessagesToLatestCompactionUsageEpoch(legacyMessages);

    expect(projected[1].usage.totalTokens).toBe(0);
    expect(legacyRetained.usage).toBe(usage);
  });

  it("sends the full live prefix once, keeps the previous summary in place, and scopes the retained tail in one hidden instruction", async () => {
    const signal = new AbortController().signal;
    let providerContext: any;
    const streamFn = vi.fn(async (_model, context) => {
      providerContext = { ...context, messages: [...context.messages], tools: [...context.tools] };
      return agentStreamOf();
    });
    const convertToLlm = vi.fn(async (messages) => messages);
    const previousSummaryMessage = {
      role: "user",
      content: [{ type: "text", text: "The conversation history before this point was compacted:\nprevious checkpoint" }],
      timestamp: 0,
    };
    const oldMessage = {
      role: "user",
      content: [{ type: "text", text: "old history to summarize" }],
      timestamp: 1,
    };
    const retainedTail = {
      role: "assistant",
      content: [{ type: "text", text: "KEPT_TAIL_REMAINS_VERBATIM" }],
      timestamp: 2,
    };

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        previousSummary: "previous checkpoint",
        messagesToSummarize: [oldMessage],
        turnPrefixMessages: [],
        isSplitTurn: false,
        settings: { reserveTokens: 1000 },
        fileOps: {
          read: new Set(["/tmp/read.md", "/tmp/edited.md"]),
          written: new Set(["/tmp/written.md"]),
          edited: new Set(["/tmp/edited.md"]),
        },
      },
      model: { id: "model", reasoning: true },
      systemPrompt: "agent system prompt",
      messages: [previousSummaryMessage, oldMessage, retainedTail],
      retainedMessageCount: 1,
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      customInstructions: "focus on decisions",
      signal,
      thinkingLevel: "high",
      outputPolicy: "bounded",
      streamFn,
      convertToLlm,
    } as any);

    expect(convertToLlm).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledOnce();
    const [model, , options] = (streamFn.mock.calls as any)[0];
    const context = providerContext;
    expect(model).toEqual({ id: "model", reasoning: true });
    expect(context!.systemPrompt).toBe("agent system prompt");
    expect(context!.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(context!.messages).toHaveLength(4);
    expect(context!.messages.slice(0, -1)).toEqual([
      previousSummaryMessage,
      oldMessage,
      retainedTail,
    ]);
    const instruction = context!.messages.at(-1).content[0].text;
    expect(instruction).toContain("compaction-only");
    expect(instruction).toContain("live message indexes [0, 2)");
    expect(instruction).toContain("boundary onward remain verbatim");
    expect(instruction).toContain("never restate");
    expect(instruction).toContain("focus on decisions");
    expect(instruction).not.toContain("<previous-summary>");
    expect(JSON.stringify(context!.messages).match(/previous checkpoint/g)).toHaveLength(1);
    expect(JSON.stringify(context!.messages)).toContain("KEPT_TAIL_REMAINS_VERBATIM");
    expect(options).toEqual(expect.objectContaining({
      maxTokens: 800,
      reasoning: "high",
      signal,
    }));

    expect(result).toEqual({
      summary: [
        VALID_COMPACTION_SUMMARY,
        "",
        "<read-files>",
        "/tmp/read.md",
        "</read-files>",
        "",
        "<modified-files>",
        "/tmp/edited.md",
        "/tmp/written.md",
        "</modified-files>",
      ].join("\n"),
      firstKeptEntryId: "entry-keep",
      tokensBefore: 1234,
      details: {
        readFiles: ["/tmp/read.md"],
        modifiedFiles: ["/tmp/edited.md", "/tmp/written.md"],
      },
    });
  });

  it("uses one temporary AgentRun for a split turn and explains retained-suffix continuity", async () => {
    let providerMessages: any[] = [];
    const streamFn = vi.fn(async (_model, context) => {
      providerMessages = [...context.messages];
      return agentStreamOf();
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: "old history" }], timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "original split-turn request" }], timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "retained suffix progress" }], timestamp: 3 },
    ];

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "retained-entry",
        tokensBefore: 4321,
        messagesToSummarize: [messages[0]],
        turnPrefixMessages: [messages[1]],
        isSplitTurn: true,
        settings: { reserveTokens: 1000 },
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      model: { id: "model", provider: "test-provider", api: "openai-completions", reasoning: false },
      systemPrompt: "system",
      messages,
      retainedMessageCount: 1,
      tools: [],
      streamFn,
      convertToLlm: vi.fn(async (input) => input),
    } as any);

    expect(streamFn).toHaveBeenCalledOnce();
    const instruction = providerMessages.at(-1).content[0].text;
    expect(instruction).toContain("original request and early progress");
    expect(instruction).toContain("retained suffix");
    expect(result).toMatchObject({
      summary: VALID_COMPACTION_SUMMARY,
      firstKeptEntryId: "retained-entry",
      tokensBefore: 4321,
      details: { readFiles: [], modifiedFiles: [] },
    });
  });

  it("records an explicit checkpoint notice when malformed old history was safely removed", async () => {
    const historyRecovery = {
      kind: "reasoning-replay-prefix-trim",
      removedMessageCount: 4,
    };
    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "retained-entry",
        tokensBefore: 4321,
        messagesToSummarize: [piUser("valid old suffix", 1)],
        turnPrefixMessages: [],
        settings: { reserveTokens: 1000 },
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      systemPrompt: "system",
      messages: [piUser("valid old suffix", 1)],
      retainedMessageCount: 0,
      messagesAreNormalized: true,
      cacheMetadataOverride: {
        cacheStrategy: "cache_recovery",
        cacheGroup: "compaction.history",
        strict: false,
        degradeReason: "malformed_reasoning_history_trim",
      },
      customInstructions: undefined,
      signal: undefined,
      thinkingLevel: "off",
      streamFn: vi.fn(async () => agentStreamOf()),
      usageLedger: undefined,
      usageContext: undefined,
      historyRecovery,
    });

    expect(result.summary).toContain("<history-recovery>");
    expect(result.summary).toContain("Removed provider-visible messages: 4.");
    expect(result.details).toMatchObject({ historyRecovery });
  });

  it("proves a first-compaction boundary from a real Pi SessionManager context", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    manager.appendMessage(piUser("old request", 1));
    manager.appendMessage(piAssistant("old response", 2));
    manager.appendMessage(piUser("retained tail", 3));
    const preparation = actualPiSdk.prepareCompaction(manager.getBranch(), REAL_COMPACTION_SETTINGS);
    const liveMessages = manager.buildSessionContext().messages;

    const boundary = await (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary({
      liveMessages,
      preparation,
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    });

    expect(preparation.previousSummary).toBeUndefined();
    expect(boundary).toMatchObject({
      retainedMessageCount: 1,
      previousSummaryRepresented: false,
    });
  });

  it("uses the live compactionSummary as the sole previous-summary representation", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    manager.appendMessage(piUser("old request", 1));
    manager.appendMessage(piAssistant("old response", 2));
    const firstKeptEntryId = manager.appendMessage(piUser("tail kept by the first compaction", 3));
    manager.appendCompaction("previous checkpoint", firstKeptEntryId, 100, {
      readFiles: [],
      modifiedFiles: [],
    }, true);
    manager.appendMessage(piUser("new work after compaction", 4));
    manager.appendMessage(piAssistant("new progress after compaction", 5));
    manager.appendMessage(piUser("new retained tail", 6));
    const preparation = actualPiSdk.prepareCompaction(manager.getBranch(), REAL_COMPACTION_SETTINGS);
    const liveMessages = manager.buildSessionContext().messages;

    const boundary = await (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary({
      liveMessages,
      preparation,
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    });
    const providerMessages = actualPiSdk.convertAgentMessagesToLlm(liveMessages);

    expect(preparation.previousSummary).toBe("previous checkpoint");
    expect(liveMessages[0]).toMatchObject({
      role: "compactionSummary",
      summary: "previous checkpoint",
    });
    expect(JSON.stringify(providerMessages).match(/previous checkpoint/g)).toHaveLength(1);
    expect(boundary).toMatchObject({
      retainedMessageCount: 1,
      previousSummaryRepresented: true,
    });
  });

  it("composes a second real Pi compaction from Summary-1 plus the retained tail and new turns", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    prepareCompactionMock.mockImplementation(actualPiSdk.prepareCompaction);
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    const oldUser = piUser("DELETED_BY_SUMMARY_ONE_USER", 1);
    const oldAssistant = piAssistant("DELETED_BY_SUMMARY_ONE_ASSISTANT", 2);
    const retainedAfterFirst = piUser("TAIL_RETAINED_AFTER_SUMMARY_ONE", 3);
    manager.appendMessage(oldUser);
    manager.appendMessage(oldAssistant);
    manager.appendMessage(retainedAfterFirst);

    const model = {
      id: "test-model",
      provider: "test-provider",
      api: "openai-completions",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    const systemPrompt = "stable ordinary AgentRun system prompt";
    const tools = [{
      name: "read",
      description: "Read files",
      parameters: { type: "object" },
      execute: vi.fn(),
    }];
    const capturedRequests: any[][] = [];
    const summaries = [
      validCompactionSummary("Summary-1 checkpoint."),
      validCompactionSummary("Summary-2 checkpoint."),
    ];
    const cacheReads = [undefined, 73];
    let requestIndex = 0;
    const streamFn = vi.fn(async (_model, context) => {
      capturedRequests.push(structuredClone(context.messages));
      const index = requestIndex++;
      return agentStreamOf(summaries[index], {
        input: 100 + index,
        output: 20 + index,
        cacheRead: cacheReads[index],
        totalTokens: 120 + index,
      });
    });
    const replaceMessages = vi.fn((messages) => {
      session.agent.state.messages = messages;
    });
    const session: any = {
      model,
      settingsManager: {
        getCompactionSettings: () => REAL_COMPACTION_SETTINGS,
      },
      sessionManager: manager,
      agent: {
        state: {
          systemPrompt,
          messages: manager.buildSessionContext().messages,
          tools,
          thinkingLevel: "off",
        },
        transformContext: async (messages) => messages,
        streamFn,
        convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
        replaceMessages,
      },
    };
    const ledger = createUsageLedger({
      requestIdFactory: (() => {
        let id = 0;
        return () => `two-compact-${++id}`;
      })(),
    });
    const usageContext = {
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: "desktop",
        trigger: "overflow",
      },
      attribution: {
        kind: "session",
        agentId: "agent-1",
        sessionPath: "/sessions/two-compactions.jsonl",
      },
    };

    const liveBeforeFirst = actualPiSdk.convertAgentMessagesToLlm(
      manager.buildSessionContext().messages,
    );
    const result1 = await runCachePreservingCompactionForSession(session, {
      usageLedger: ledger,
      usageContext,
    });
    expect(capturedRequests[0].slice(0, -1)).toEqual(liveBeforeFirst);

    const newUser = piUser("NEW_USER_AFTER_SUMMARY_ONE", 4);
    const newAssistant = piAssistant("NEW_ASSISTANT_AFTER_SUMMARY_ONE", 5);
    const retainedAfterSecond = piUser("TAIL_RETAINED_AFTER_SUMMARY_TWO", 6);
    manager.appendMessage(newUser);
    manager.appendMessage(newAssistant);
    const secondFirstKeptEntryId = manager.appendMessage(retainedAfterSecond);
    const liveBeforeSecondRaw = manager.buildSessionContext().messages;
    const liveBeforeSecond = actualPiSdk.convertAgentMessagesToLlm(liveBeforeSecondRaw);
    const ordinaryNextSnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/two-compactions.jsonl",
      reason: "ordinary.next-agent-run",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt,
      tools,
      messages: liveBeforeSecond,
    });

    const result2 = await runCachePreservingCompactionForSession(session, {
      usageLedger: ledger,
      usageContext,
    });
    const secondPrefix = capturedRequests[1].slice(0, -1);
    const secondSerialized = JSON.stringify(secondPrefix);
    expect(secondPrefix).toEqual(liveBeforeSecond);
    expect(secondSerialized).toContain("Summary-1 checkpoint.");
    expect(secondSerialized).toContain("TAIL_RETAINED_AFTER_SUMMARY_ONE");
    expect(secondSerialized).toContain("NEW_USER_AFTER_SUMMARY_ONE");
    expect(secondSerialized).toContain("NEW_ASSISTANT_AFTER_SUMMARY_ONE");
    expect(secondSerialized).toContain("TAIL_RETAINED_AFTER_SUMMARY_TWO");
    expect(secondSerialized).not.toContain("DELETED_BY_SUMMARY_ONE_USER");
    expect(secondSerialized).not.toContain("DELETED_BY_SUMMARY_ONE_ASSISTANT");
    expect(secondSerialized.match(/Summary-1 checkpoint\./g)).toHaveLength(1);
    expect(secondSerialized).not.toContain("<previous-summary>");

    const rebuilt = manager.buildSessionContext().messages;
    expect(result1.summary).toContain("Summary-1 checkpoint.");
    expect(result2).toMatchObject({
      summary: expect.stringContaining("Summary-2 checkpoint."),
      firstKeptEntryId: secondFirstKeptEntryId,
    });
    expect(rebuilt[0]).toMatchObject({
      role: "compactionSummary",
      summary: expect.stringContaining("Summary-2 checkpoint."),
    });
    expect(rebuilt.slice(1)).toEqual([retainedAfterSecond]);
    expect(rebuilt[1]).toBe(retainedAfterSecond);

    const usageEntries = ledger.list({ subsystem: "compaction" }).entries;
    expect(usageEntries).toHaveLength(2);
    expect(usageEntries[0]).toMatchObject({
      metadata: {
        cacheStrategy: "session_snapshot",
        strict: true,
      },
      usage: {
        cache: { readTokens: 0, hit: false },
      },
    });
    expect(usageEntries[1]).toMatchObject({
      metadata: {
        cacheStrategy: "session_snapshot",
        strict: true,
        cachePrefixHash: ordinaryNextSnapshot.cachePrefixHash,
      },
      usage: {
        cache: { readTokens: 73, hit: true },
      },
    });
  });

  it("labels deleted-agent transcript summaries as a cold utility contract", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "cold-summary-1" });
    const transcriptMessages = [
      piUser("old deleted-agent transcript", 1),
      piAssistant("old deleted-agent response", 2),
    ];
    const streamFn = vi.fn(async (_model, context) => {
      expect(context.tools).toEqual([]);
      expect(context.messages.slice(0, -1)).toEqual(transcriptMessages);
      return agentStreamOf();
    });

    const result = await createColdUtilitySummaryResult({
      preparation: {
        firstKeptEntryId: null,
        tokensBefore: 42,
        messagesToSummarize: transcriptMessages,
        turnPrefixMessages: [],
        previousSummary: null,
        isSplitTurn: false,
        settings: { reserveTokens: 1000 },
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      transcriptMessages,
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        reasoning: false,
      },
      systemPrompt: "new primary agent prompt",
      customInstructions: "carry the deleted-agent transcript forward",
      streamFn,
      convertToLlm: vi.fn(async (messages) => messages),
      usageLedger: ledger,
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "deleted_agent_continue",
          surface: "desktop",
          trigger: "user",
        },
        attribution: {
          kind: "session",
          agentId: "hana",
          sessionPath: "/sessions/continued.jsonl",
        },
      },
    } as any);

    expect(result.summary).toBe(VALID_COMPACTION_SUMMARY);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(ledger.list({ subsystem: "compaction" }).entries[0]).toMatchObject({
      metadata: {
        cacheStrategy: "utility_template",
        cacheGroup: "compaction.deleted-agent-continuation",
        strict: false,
      },
    });
  });

  it("proves a split-turn boundary with one retained provider-visible suffix", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    manager.appendMessage(piUser("older request", 1));
    manager.appendMessage(piAssistant("older answer", 2));
    manager.appendMessage(piUser("original request whose early progress must survive", 3));
    manager.appendMessage(piAssistant("retained suffix from the same turn", 4));
    const preparation = actualPiSdk.prepareCompaction(manager.getBranch(), REAL_COMPACTION_SETTINGS);
    const liveMessages = manager.buildSessionContext().messages;

    const boundary = await (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary({
      liveMessages,
      preparation,
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    });

    expect(preparation.isSplitTurn).toBe(true);
    expect(preparation.turnPrefixMessages).toEqual([
      expect.objectContaining({ role: "user" }),
    ]);
    expect(boundary.retainedMessageCount).toBe(1);
  });

  it("derives the provider boundary after convertToLlm filters non-visible messages", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    manager.appendMessage(piUser("old request", 1));
    manager.appendMessage({
      role: "bashExecution",
      command: "secret helper",
      output: "not provider-visible",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 2,
    });
    manager.appendMessage(piAssistant("old answer", 3));
    manager.appendMessage(piUser("retained tail", 4));
    const preparation = actualPiSdk.prepareCompaction(manager.getBranch(), REAL_COMPACTION_SETTINGS);
    const liveMessages = manager.buildSessionContext().messages;

    const boundary = await (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary({
      liveMessages,
      preparation,
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    });
    const providerMessages = actualPiSdk.convertAgentMessagesToLlm(liveMessages);

    expect(liveMessages).toHaveLength(4);
    expect(providerMessages).toHaveLength(3);
    expect(boundary).toMatchObject({
      oldMessageCount: 2,
      retainedMessageCount: 1,
    });
  });

  it("throws a typed prefix-contract error when the live partition cannot be proven", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const deriveBoundary = (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary;

    await expect(deriveBoundary({
      liveMessages: [piUser("different live message", 1), piUser("tail", 2)],
      preparation: {
        previousSummary: undefined,
        messagesToSummarize: [piUser("expected old message", 1)],
        turnPrefixMessages: [],
      },
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    })).rejects.toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it("materializes tool-result rewrites through the ordinary transform context before prefix conversion", async () => {
    const oldUser = piUser("old request", 1);
    const oldToolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "raw tool output" }],
      timestamp: 2,
    };
    const retained = piUser("retained tail", 3);
    let boundaryPlaceholder = "";
    const transformContext = vi.fn(async (messages) => {
      boundaryPlaceholder = messages.at(-1).content[0].text.match(
        /<hana\.compaction\.boundary:[^>]+>/,
      )?.[0] || "";
      return messages.map((message) => (
        message.role === "toolResult"
          ? {
              ...message,
              content: [{ type: "text", text: "rewritten tool output" }],
            }
          : message
      ));
    });
    const convertToLlm = vi.fn((messages) => messages);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    const result = await buildPrefix({
      liveMessages: [oldUser, oldToolResult, retained],
      preparation: {
        messagesToSummarize: [oldUser, oldToolResult],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm,
      normalizeMessages: (messages) => messages,
    });

    expect(transformContext).toHaveBeenCalledTimes(1);
    expect(result.messages[1].content).toEqual([
      { type: "text", text: "rewritten tool output" },
    ]);
    expect(result).toMatchObject({
      oldMessageCount: 2,
      retainedMessageCount: 1,
    });
    expect(boundaryPlaceholder).toMatch(/^<hana\.compaction\.boundary:/);
    for (const [messages] of convertToLlm.mock.calls) {
      expect(messages.every((message) => Object.getOwnPropertySymbols(message).length === 0)).toBe(true);
      expect(JSON.stringify(messages)).not.toContain(boundaryPlaceholder);
    }
    expect(
      [...result.messages, result.instruction]
        .every((message) => Object.getOwnPropertySymbols(message).length === 0),
    ).toBe(true);
  });

  it("trims only a malformed old tool turn at a complete transaction boundary", async () => {
    const malformedToolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-old", name: "read", arguments: {} }],
      timestamp: 2,
    };
    const malformedToolResult = {
      role: "toolResult",
      toolCallId: "call-old",
      toolName: "read",
      content: [{ type: "text", text: "old result" }],
      timestamp: 3,
    };
    const validOldUser = piUser("newer old request", 5);
    const validOldAssistant = piAssistant("newer old answer", 6);
    const retained = piUser("retained tail", 7);
    const liveMessages = [
      piUser("malformed old request", 1),
      malformedToolCall,
      malformedToolResult,
      piAssistant("old tool answer", 4),
      validOldUser,
      validOldAssistant,
      retained,
    ];
    const normalizeMessages = vi.fn((messages) => {
      const missingReasoning = messages.some((message) => (
        message.role === "assistant"
        && Array.isArray(message.content)
        && message.content.some((block) => block?.type === "toolCall")
        && typeof message.reasoning_content !== "string"
      ));
      if (missingReasoning) {
        throw new Error(
          "DeepSeek Anthropic thinking mode history is missing non-empty thinking content for a tool call.",
        );
      }
      return messages;
    });

    const result = await sessionCompactorModule.buildCachePreservingCompactionPrefix({
      liveMessages,
      preparation: {
        messagesToSummarize: liveMessages.slice(0, -1),
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
      },
      transformContext: async (messages) => messages,
      convertToLlm: (messages) => messages,
      normalizeMessages,
    });

    expect(result.messages).toEqual([validOldUser, validOldAssistant, retained]);
    expect(result).toMatchObject({
      oldMessageCount: 2,
      retainedMessageCount: 1,
      historyRecovery: {
        kind: "reasoning-replay-prefix-trim",
        removedMessageCount: 4,
      },
    });
    expect(result.instruction.content[0].text).toContain("live message indexes [0, 2)");
  });

  it("returns a typed 422 when malformed old reasoning has no complete tool boundary", async () => {
    const oldUser = piUser("old request", 1);
    const incompleteToolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-incomplete", name: "read", arguments: {} }],
      timestamp: 2,
    };
    const retained = piUser("retained tail", 3);
    const normalizeMessages = (messages) => {
      if (messages.some((message) => (
        message.role === "assistant"
        && Array.isArray(message.content)
        && message.content.some((block) => block?.id === "call-incomplete")
      ))) {
        throw new Error(
          "DeepSeek thinking mode reasoning_content is missing for tool_calls history (assistant tool call).",
        );
      }
      return messages;
    };

    await expect(sessionCompactorModule.buildCachePreservingCompactionPrefix({
      liveMessages: [oldUser, incompleteToolCall, retained],
      preparation: {
        messagesToSummarize: [oldUser, incompleteToolCall],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
      },
      transformContext: async (messages) => messages,
      convertToLlm: (messages) => messages,
      normalizeMessages,
    })).rejects.toMatchObject({
      name: "CompactionHistoryReplayError",
      code: "COMPACTION_HISTORY_REPLAY_UNPROCESSABLE",
      statusCode: 422,
      details: { boundaryRegion: "old" },
    });
  });

  it("never trims valid old history when the retained suffix itself cannot replay", async () => {
    const oldUser = piUser("valid old request", 1);
    const retainedToolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-retained", name: "read", arguments: {} }],
      timestamp: 2,
    };
    const normalizeMessages = (messages) => {
      if (messages.some((message) => (
        message.role === "assistant"
        && Array.isArray(message.content)
        && message.content.some((block) => block?.id === "call-retained")
      ))) {
        throw new Error(
          "DeepSeek thinking mode reasoning_content is missing for tool_calls history (assistant tool call).",
        );
      }
      return messages;
    };

    await expect(sessionCompactorModule.buildCachePreservingCompactionPrefix({
      liveMessages: [oldUser, retainedToolCall],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
      },
      transformContext: async (messages) => messages,
      convertToLlm: (messages) => messages,
      normalizeMessages,
    })).rejects.toMatchObject({
      name: "CompactionHistoryReplayError",
      code: "COMPACTION_HISTORY_REPLAY_UNPROCESSABLE",
      statusCode: 422,
      details: { boundaryRegion: "retained" },
    });
  });

  it("survives the installed Pi ExtensionRunner structured-clone boundary without leaking proof carriers", async () => {
    const oldUser = {
      ...piUser("old request", 1),
      "__hana_compaction_transform_proof_user_owned": "preserve me",
    };
    const retained = piAssistant("retained tail", 2);
    const clonedContexts: any[][] = [];
    const extension = {
      path: "test://capture-context",
      handlers: new Map([
        ["context", [
          async (event) => {
            clonedContexts.push(event.messages);
            return { messages: event.messages };
          },
        ]],
      ]),
      tools: new Map(),
    };
    const runner = new ExtensionRunner(
      [extension] as any,
      { pendingProviderRegistrations: [] } as any,
      process.cwd(),
      {} as any,
      {} as any,
    );
    const convertedInputs: any[][] = [];
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    const result = await buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext: runner.emitContext.bind(runner),
      convertToLlm: (messages) => {
        convertedInputs.push(messages);
        return messages;
      },
      normalizeMessages: (messages) => messages,
    });

    expect(clonedContexts).toHaveLength(1);
    const clonedKeys = clonedContexts[0].map((message) => Object.keys(message));
    const proofKeys = clonedKeys[0].filter((key) => (
      key !== "role"
      && key !== "content"
      && key !== "timestamp"
      && key !== "__hana_compaction_transform_proof_user_owned"
      && clonedKeys.every((keys) => keys.includes(key))
    ));
    expect(proofKeys).toHaveLength(1);
    const proofKey = proofKeys[0];
    const proofValues = clonedContexts[0].map((message) => message[proofKey]);
    expect(new Set(proofValues).size).toBe(clonedContexts[0].length);
    expect(
      clonedContexts[0].every((message) => (
        Object.getOwnPropertyDescriptor(message, proofKey)?.enumerable === true
      )),
    ).toBe(true);

    expect(result.messages[0].__hana_compaction_transform_proof_user_owned).toBe("preserve me");
    for (const messages of convertedInputs) {
      expect(messages.every((message) => !Reflect.has(message, proofKey))).toBe(true);
      expect(JSON.stringify(messages)).not.toContain(proofKey);
      for (const proofValue of proofValues) {
        expect(JSON.stringify(messages)).not.toContain(proofValue);
      }
    }
    expect(JSON.stringify(result)).not.toContain(proofKey);
    for (const proofValue of proofValues) {
      expect(JSON.stringify(result)).not.toContain(proofValue);
    }
  });

  it("typed-fails before conversion when a Pi context handler nests a proof-carrying source message", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    let proofKey = "";
    let leakedCarrierAtConverter = false;
    let nestedGetterCalls = 0;
    const extension = {
      path: "test://nest-source-context",
      handlers: new Map([
        ["context", [
          async (event) => {
            const keysByMessage = event.messages.map((message) => Object.keys(message));
            proofKey = keysByMessage[0].find((key) => (
              key !== "role"
              && key !== "content"
              && key !== "timestamp"
              && keysByMessage.every((keys) => keys.includes(key))
            )) || "";
            const nestedMetadata: any = { sourceMessage: event.messages[0] };
            Object.defineProperty(nestedMetadata, "trap", {
              enumerable: true,
              get() {
                nestedGetterCalls += 1;
                throw new Error("proof scan invoked a nested getter");
              },
            });
            return {
              messages: [
                {
                  ...event.messages[0],
                  metadata: nestedMetadata,
                },
                ...event.messages.slice(1),
              ],
            };
          },
        ]],
      ]),
      tools: new Map(),
    };
    const runner = new ExtensionRunner(
      [extension] as any,
      { pendingProviderRegistrations: [] } as any,
      process.cwd(),
      {} as any,
      {} as any,
    );
    const convertToLlm = vi.fn((messages) => {
      if (
        proofKey
        && messages.some((message) => (
          message.metadata?.sourceMessage?.[proofKey] !== undefined
        ))
      ) {
        leakedCarrierAtConverter = true;
        throw new Error("nested proof carrier reached converter");
      }
      return messages;
    });
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;
    let caught: any;

    try {
      await buildPrefix({
        liveMessages: [oldUser, retained],
        preparation: {
          messagesToSummarize: [oldUser],
          turnPrefixMessages: [],
          isSplitTurn: false,
        },
        model: { reasoning: false },
        transformContext: runner.emitContext.bind(runner),
        convertToLlm,
        normalizeMessages: (messages) => messages,
      });
    } catch (error) {
      caught = error;
    }

    expect(leakedCarrierAtConverter).toBe(false);
    expect(nestedGetterCalls).toBe(0);
    expect(caught).toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it("typed-fails deterministically when nested proof metadata contains a cycle", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    await expect(buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext: async (messages) => {
        const metadata: any = { sourceMessage: messages[0] };
        metadata.self = metadata;
        return [
          {
            ...messages[0],
            metadata,
          },
          ...messages.slice(1),
        ];
      },
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    })).rejects.toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it("preserves inserted context and applies a latest-user rewrite to the hidden instruction", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const transformContext = vi.fn(async (messages) => [
      piUser("injected system context", 0),
      ...messages.slice(0, -1),
      {
        ...messages.at(-1),
        content: [{
          type: "text",
          text: `rewritten before\n${messages.at(-1).content[0].text}\nrewritten after`,
        }],
      },
    ]);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    const result = await buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    });

    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "injected system context" }],
    });
    expect(result.instruction).toMatchObject({
      role: "user",
      content: [{
        type: "text",
        text: expect.stringMatching(
          /^rewritten before\nInternal compaction-only run\.[\s\S]*Old region: live message indexes \[0, 2\)\.[\s\S]*\nrewritten after$/,
        ),
      }],
    });
    expect(JSON.stringify(result)).not.toContain("hana.compaction.boundary");
    expect(result).toMatchObject({
      oldMessageCount: 2,
      retainedMessageCount: 1,
    });
  });

  it("preserves a transformed instruction's prototype, timestamp, and token-free field identities", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const instructionPrototype = { source: "session-transform" };
    const metadata = { stable: true };
    const transformContext = vi.fn(async (messages) => {
      const transformedInstruction = Object.assign(
        Object.create(instructionPrototype),
        messages.at(-1),
        {
          timestamp: 42,
          metadata,
          content: [{
            type: "text",
            text: `wrapped\n${messages.at(-1).content[0].text}`,
          }],
        },
      );
      return [...messages.slice(0, -1), transformedInstruction];
    });
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    const result = await buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    });

    expect(Object.getPrototypeOf(result.instruction)).toBe(instructionPrototype);
    expect(result.instruction.timestamp).toBe(42);
    expect(result.instruction.metadata).toBe(metadata);
    expect(result.instruction.content[0].text).toContain(
      "Old region: live message indexes [0, 1).",
    );
  });

  it("runs a one-shot transform exactly once even when it has observable side effects", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    let transformCalls = 0;
    const transformContext = vi.fn(async (messages) => {
      transformCalls += 1;
      if (transformCalls > 1) throw new Error("one-shot transform was reused");
      return [
        piUser(`transform side effect ${transformCalls}`, 0),
        ...messages,
      ];
    });
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    const result = await buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    });

    expect(transformContext).toHaveBeenCalledTimes(1);
    expect(result.messages[0]).toMatchObject({
      content: [{ type: "text", text: "transform side effect 1" }],
    });
    expect(result.instruction.content[0].text).toContain(
      "Old region: live message indexes [0, 2).",
    );
  });

  it.each([
    {
      name: "removes the boundary placeholder from the instruction",
      transformContext: async (messages) => [
        ...messages.slice(0, -1),
        {
          ...messages.at(-1),
          content: [{ type: "text", text: "instruction without the required boundary" }],
        },
      ],
    },
    {
      name: "duplicates the boundary placeholder inside the instruction",
      transformContext: async (messages) => [
        ...messages.slice(0, -1),
        {
          ...messages.at(-1),
          content: [{
            type: "text",
            text: `${messages.at(-1).content[0].text}\n${messages.at(-1).content[0].text}`,
          }],
        },
      ],
    },
    {
      name: "copies the boundary placeholder outside the instruction",
      transformContext: async (messages) => [
        {
          role: "user",
          content: messages.at(-1).content,
          timestamp: 0,
        },
        ...messages,
      ],
    },
  ])("typed-fails when transformContext $name", async ({ transformContext }) => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    await expect(buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    })).rejects.toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it.each([
    {
      name: "filters a live message",
      transformContext: async (messages) => messages.filter((message) => (
        message.content?.[0]?.text !== "old request"
      )),
    },
    {
      name: "reorders live messages",
      transformContext: async (messages) => [
        messages[1],
        messages[0],
        ...messages.slice(2),
      ],
    },
  ])("typed-fails when transformContext $name", async ({ transformContext }) => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;

    await expect(buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext,
      convertToLlm: (messages) => messages,
      normalizeMessages: (messages) => messages,
    })).rejects.toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it("typed-fails when normalization changes full-prefix cardinality across the old/retained partition", async () => {
    const oldUser = piUser("old request", 1);
    const retained = piAssistant("retained tail", 2);
    const buildPrefix = (sessionCompactorModule as any).buildCachePreservingCompactionPrefix;
    const normalizeMessages = vi.fn((messages) => (
      messages.length === 2
        ? [piUser("collapsed normalized context", 10)]
        : messages
    ));

    await expect(buildPrefix({
      liveMessages: [oldUser, retained],
      preparation: {
        messagesToSummarize: [oldUser],
        turnPrefixMessages: [],
        isSplitTurn: false,
      },
      model: { reasoning: false },
      transformContext: async (messages) => messages,
      convertToLlm: (messages) => messages,
      normalizeMessages,
    })).rejects.toMatchObject({
      name: "CachePreservingCompactionPrefixContractError",
      code: "CACHE_PRESERVING_COMPACTION_PREFIX_CONTRACT",
    });
  });

  it("appends Pi's exact firstKeptEntryId and rebuilds summary plus an unchanged recent tail", async () => {
    const actualPiSdk = await vi.importActual<any>("../lib/pi-sdk/index.ts");
    const manager = actualPiSdk.SessionManager.inMemory("/workspace");
    manager.appendMessage(piUser("old request", 1));
    manager.appendMessage(piAssistant("old response", 2));
    const firstRetained = piUser("retained user request", 3);
    const firstKeptEntryId = manager.appendMessage(firstRetained);
    const retainedAssistant = piAssistant("retained assistant response", 4);
    manager.appendMessage(retainedAssistant);
    const preparation = actualPiSdk.prepareCompaction(manager.getBranch(), {
      ...REAL_COMPACTION_SETTINGS,
      keepRecentTokens: 10,
    });
    const rawLiveMessages = manager.buildSessionContext().messages;
    const providerMessages = actualPiSdk.convertAgentMessagesToLlm(rawLiveMessages);
    const boundary = await (sessionCompactorModule as any).deriveCachePreservingCompactionBoundary({
      liveMessages: rawLiveMessages,
      preparation,
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    });
    const model = {
      id: "test-model",
      provider: "test-provider",
      api: "openai-completions",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/in-memory.jsonl",
      reason: "compaction.history",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "system",
      tools: [],
      messages: providerMessages,
    });

    const result = await createCachePreservingCompactionResult({
      preparation,
      model,
      systemPrompt: "system",
      messages: providerMessages,
      retainedMessageCount: boundary.retainedMessageCount,
      tools: snapshot.tools,
      sessionSnapshot: snapshot,
      cacheKeyParams: snapshot.cacheKeyParams,
      thinkingLevel: "off",
      streamFn: vi.fn(async () => agentStreamOf()),
      convertToLlm: actualPiSdk.convertAgentMessagesToLlm,
    } as any);
    const replaceMessages = vi.fn();
    await appendCompactionResultToSession({
      sessionManager: manager,
      agent: { replaceMessages },
    }, result);
    const rebuilt = manager.buildSessionContext().messages;

    expect(preparation.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(result.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(rebuilt[0]).toMatchObject({
      role: "compactionSummary",
      summary: VALID_COMPACTION_SUMMARY,
    });
    expect(rebuilt.slice(1)).toEqual([firstRetained, retainedAssistant]);
    expect(rebuilt[1]).toBe(firstRetained);
    expect(rebuilt[2]).toBe(retainedAssistant);
    expect(replaceMessages).toHaveBeenCalledWith(rebuilt);
  });

  it("reports A-over/B-fit as native fallback eligible without hard truncation", () => {
    const messages = [
      piUser("old", 1),
      piAssistant("x".repeat(8_000), 2),
    ];
    const preparation = {
      messagesToSummarize: [messages[0]],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 640, keepRecentTokens: 100 },
    };
    const estimate = estimateCachePreservingCompactionRequest({
      preparation,
      messages,
      retainedMessageCount: 1,
      systemPrompt: "",
    } as any);
    const fit = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages,
      retainedMessageCount: 1,
      model: { contextWindow: 3_000 },
      systemPrompt: "",
      hardTruncateThreshold: 1,
    } as any);

    expect(estimate.cachePreservingBudget.instructionTokens).toBeGreaterThan(0);
    expect(estimate.cachePreservingBudget.totalTokens)
      .toBeGreaterThan(estimate.nativeSummaryBudget.totalTokens);
    expect(fit).toMatchObject({
      cachePreservingFits: false,
      nativeSummaryFits: true,
      shouldUseNativeFallback: true,
      shouldHardTruncate: false,
    });
  });

  it("hard truncates only when both full-prefix A and native-summary B exceed the threshold", () => {
    const oversized = piUser("x".repeat(20_000), 1);
    const preparation = {
      messagesToSummarize: [oversized],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 640, keepRecentTokens: 100 },
    };

    const fit = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages: [oversized, piUser("tail", 2)],
      retainedMessageCount: 1,
      model: { contextWindow: 3_000 },
      systemPrompt: "",
      hardTruncateThreshold: 1,
    } as any);

    expect(fit).toMatchObject({
      cachePreservingFits: false,
      nativeSummaryFits: false,
      shouldUseNativeFallback: false,
      shouldHardTruncate: true,
    });
  });

  it("counts provider-visible tool schemas in budget A and lets them flip the fit boundary", () => {
    const messages = [piUser("old", 1), piAssistant("tail", 2)];
    const preparation = {
      messagesToSummarize: [messages[0]],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 640, keepRecentTokens: 100 },
    };
    const tools = [{
      name: "large_schema_tool",
      label: "Large schema tool",
      description: "x".repeat(4_000),
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "y".repeat(4_000),
          },
        },
      },
      execute: vi.fn(),
    }];
    const withoutTools = estimateCachePreservingCompactionRequest({
      preparation,
      messages,
      retainedMessageCount: 1,
      model: { maxTokens: 512 },
      systemPrompt: "",
      tools: [],
    } as any);
    const withTools = estimateCachePreservingCompactionRequest({
      preparation,
      messages,
      retainedMessageCount: 1,
      model: { maxTokens: 512 },
      systemPrompt: "",
      tools,
    } as any);
    const contextWindow = withoutTools.cachePreservingBudget.totalTokens;
    const baseFit = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages,
      retainedMessageCount: 1,
      model: { contextWindow, maxTokens: 512 },
      systemPrompt: "",
      tools: [],
      hardTruncateThreshold: 1,
    } as any);
    const toolFit = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages,
      retainedMessageCount: 1,
      model: { contextWindow, maxTokens: 512 },
      systemPrompt: "",
      tools,
      hardTruncateThreshold: 1,
    } as any);

    expect(withTools.cachePreservingBudget.toolSchemaTokens).toBeGreaterThan(0);
    expect(
      withTools.cachePreservingBudget.totalTokens
      - withoutTools.cachePreservingBudget.totalTokens,
    ).toBe(withTools.cachePreservingBudget.toolSchemaTokens);
    expect(baseFit.cachePreservingFits).toBe(true);
    expect(toolFit.cachePreservingFits).toBe(false);
  });

  it("uses the exact native request total at the B-fit threshold boundary", () => {
    const old = piUser("serialized history with wrapper overhead", 1);
    const retained = piAssistant("x".repeat(20_000), 2);
    const preparation = {
      messagesToSummarize: [old],
      turnPrefixMessages: [],
      previousSummary: "prior checkpoint",
      isSplitTurn: false,
      settings: { reserveTokens: 640, keepRecentTokens: 100 },
    };
    const estimate = estimateCachePreservingCompactionRequest({
      preparation,
      messages: [old, retained],
      retainedMessageCount: 1,
      systemPrompt: "",
      model: { maxTokens: 512 },
    } as any);
    const nativeTotal = estimate.nativeSummaryBudget.totalTokens;

    const bFits = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages: [old, retained],
      retainedMessageCount: 1,
      model: { contextWindow: nativeTotal, maxTokens: 512 },
      systemPrompt: "",
      hardTruncateThreshold: 1,
    } as any);
    const bOver = shouldHardTruncateCachePreservingCompaction({
      preparation,
      messages: [old, retained],
      retainedMessageCount: 1,
      model: { contextWindow: nativeTotal - 1, maxTokens: 512 },
      systemPrompt: "",
      hardTruncateThreshold: 1,
    } as any);

    expect(estimate.nativeSummaryBudget.systemPromptTokens).toBeGreaterThan(0);
    expect(estimate.nativeSummaryBudget.messageTokens)
      .toBeGreaterThan(Math.ceil("serialized history with wrapper overhead".length / 4));
    expect(bFits).toMatchObject({
      cachePreservingFits: false,
      nativeSummaryFits: true,
      shouldUseNativeFallback: true,
      shouldHardTruncate: false,
    });
    expect(bOver).toMatchObject({
      cachePreservingFits: false,
      nativeSummaryFits: false,
      shouldUseNativeFallback: false,
      shouldHardTruncate: true,
    });
  });

  it("uses provider-default output for reasoning compaction without a Hana numeric cap", async () => {
    const messages = [{ role: "user", content: "history" }];
    const streamFn = vi.fn(async () => agentStreamOf());

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: messages,
        settings: { reserveTokens: 1000 },
      },
      model: {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        reasoning: true,
        maxTokens: 64_000,
        contextWindow: 128_000,
      },
      systemPrompt: "system prompt",
      messages,
      retainedMessageCount: 0,
      thinkingLevel: "high",
      outputPolicy: "provider-default",
      streamFn,
      convertToLlm: vi.fn(async (messages) => messages),
    } as any);

    expect(result.summary).toBe(VALID_COMPACTION_SUMMARY);
    const [, , options] = streamFn.mock.calls[0] as any;
    expect(options).toMatchObject({ reasoning: "high" });
    expect(options).not.toHaveProperty("toolChoice");
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("normalizes provider-default and bounded compaction payloads without changing global chat policy", () => {
    const model = {
      id: "deepseek-reasoner",
      provider: "deepseek",
      api: "openai-completions",
      reasoning: true,
      maxTokens: 64_000,
      contextWindow: 128_000,
    };
    const payload = {
      model: model.id,
      messages: [{ role: "user", content: "summarize" }],
      max_tokens: 800,
      reasoning_effort: "auto",
    };

    const providerDefault = normalizeCompactionProviderPayload(payload, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    });
    expect(providerDefault).toMatchObject({
      model: model.id,
      messages: payload.messages,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(providerDefault).not.toHaveProperty("max_tokens");
    expect(normalizeCompactionProviderPayload({
      model: "summary-model",
      messages: payload.messages,
      max_tokens: 800,
    }, {
      id: "summary-model",
      provider: "custom",
      api: "openai-completions",
      reasoning: false,
      maxTokens: 16_000,
      contextWindow: 128_000,
    }, {
      outputPolicy: "bounded",
      boundedMaxTokens: 800,
      reasoningLevel: "off",
    })).toMatchObject({ max_tokens: 800 });
  });

  it("synthesizes a safe cap when a provider protocol requires one", () => {
    const model = {
      id: "claude-sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 64_000,
      contextWindow: 128_000,
    };

    expect(normalizeCompactionProviderPayload({ messages: [] }, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    })).toMatchObject({ max_tokens: 64_000 });
    expect(normalizeCompactionProviderPayload({ messages: [], max_tokens: 0 }, model, {
      outputPolicy: "provider-default",
      boundedMaxTokens: 800,
      reasoningLevel: "high",
    })).toMatchObject({ max_tokens: 64_000 });
  });

  it("records cache-preserving compaction usage in the usage ledger", async () => {
    const ledger = createUsageLedger({ requestIdFactory: () => "compact-usage-1" });
    const messages = [{ role: "user", content: "hello" }];

    await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: messages,
        settings: { reserveTokens: 1000 },
      },
      model: {
        id: "gpt-5",
        provider: "openai",
        api: "openai-responses",
        reasoning: false,
      },
      systemPrompt: "system prompt",
      messages,
      retainedMessageCount: 0,
      streamFn: vi.fn(async () => agentStreamOf(VALID_COMPACTION_SUMMARY, {
        input: 100,
        output: 25,
        cacheRead: 80,
        totalTokens: 125,
      })),
      convertToLlm: vi.fn(async (messages) => messages),
      usageLedger: ledger,
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "desktop",
          trigger: "overflow",
        },
        attribution: {
          kind: "session",
          agentId: "agent-1",
          sessionPath: "/sessions/current.jsonl",
        },
      },
    } as any);

    const [entry] = ledger.list({ subsystem: "compaction" }).entries;
    expect(entry).toMatchObject({
      requestId: "compact-usage-1",
      status: "ok",
      source: { subsystem: "compaction", operation: "compact" },
      attribution: { kind: "session", sessionPath: "/sessions/current.jsonl" },
      model: { provider: "openai", modelId: "gpt-5", api: "openai-responses" },
      usage: {
        input: { totalTokens: 100, uncachedTokens: 100 },
        output: { totalTokens: 25 },
        cache: { readTokens: 80, hit: true },
      },
    });
    expect(entry.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      cacheGroup: "compaction.history",
      strict: true,
    });
  });

  it("uses supplied session snapshot cache params as the strict side-task contract", async () => {
    const messages = [{ role: "user", content: "history before compaction" }];
    const model = {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
    };
    const sessionSnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/current.jsonl",
      reason: "compaction.history",
      model,
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "system prompt",
      tools: [],
      messages,
    });
    const streamFn = vi.fn(async () => agentStreamOf());

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: messages,
        settings: { reserveTokens: 1000 },
      },
      model,
      systemPrompt: "system prompt",
      messages,
      retainedMessageCount: 0,
      sessionSnapshot,
      cacheKeyParams: { thinkingLevel: "off" },
      thinkingLevel: "off",
      streamFn,
      convertToLlm: vi.fn(async (input) => input),
    } as any);

    expect(result.summary).toBe(VALID_COMPACTION_SUMMARY);
    expect((streamFn.mock.calls as any)[0][2]).toMatchObject({
      reasoning: "medium",
    });
  });

  it("projects MCP resource content before cache-preserving compaction provider calls", async () => {
    const streamFn = vi.fn(async () => agentStreamOf());
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "file:///workspace/spec.md",
        name: "spec.md",
        mimeType: "text/markdown",
        text: "Compaction must keep this visible.",
      },
    };

    await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        messagesToSummarize: [
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read_resource",
            content: [resourceBlock],
          },
        ],
        settings: { reserveTokens: 1000 },
      },
      model: { id: "gpt-5", provider: "openai", api: "openai-responses", reasoning: false },
      systemPrompt: "system prompt",
      messages: [{
        role: "toolResult",
        toolCallId: "call_read",
        toolName: "read_resource",
        content: [resourceBlock],
      }],
      retainedMessageCount: 0,
      streamFn,
      convertToLlm: vi.fn(async (messages) => messages),
    } as any);

    const [, context] = streamFn.mock.calls[0] as any;
    const projected = context.messages[0].content[0];
    expect(projected.type).toBe("text");
    expect(projected.text).toContain("uri: file:///workspace/spec.md");
    expect(projected.text).toContain("name: spec.md");
    expect(projected.text).toContain("mimeType: text/markdown");
    expect(projected.text).toContain("Compaction must keep this visible.");
    expect(resourceBlock.resource.text).toBe("Compaction must keep this visible.");
  });

  it("writes cache-preserving compaction results back into the session branch", async () => {
    const oldMessage = { role: "user", content: "before compaction" };
    const retainedMessage = { role: "assistant", content: [{ type: "text", text: "retained tail" }] };
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      messagesToSummarize: [oldMessage],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const replaceMessages = vi.fn();
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn()
          .mockReturnValueOnce({ messages: [oldMessage, retainedMessage] })
          .mockReturnValue({ messages: compactedMessages }),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        transformContext: vi.fn(async (messages) => [
          { role: "user", content: "session context extension", timestamp: 0 },
          ...structuredClone(messages),
        ]),
        streamFn: vi.fn(async () => agentStreamOf()),
        convertToLlm: vi.fn((messages) => messages),
        replaceMessages,
      },
    };

    const onCompacted = vi.fn();
    const result = await runCachePreservingCompactionForSession(session, { onCompacted });

    expect(prepareCompactionMock).toHaveBeenCalledWith(branch, { enabled: true, reserveTokens: 2000 });
    expect(session.agent.transformContext).toHaveBeenCalledTimes(1);
    expect(appendCompaction).toHaveBeenCalledWith(
      VALID_COMPACTION_SUMMARY,
      "entry-keep",
      4321,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(onCompacted).toHaveBeenCalledOnce();
    expect(onCompacted).toHaveBeenCalledWith(session);
    expect(result.summary).toBe(VALID_COMPACTION_SUMMARY);
  });

  it("hard truncates direct session compaction when the cache-preserving request cannot fit", async () => {
    const oldMessage = { role: "user", content: "old " + "x".repeat(2000) };
    const retainedMessage = { role: "assistant", content: [{ type: "text", text: "keep" }] };
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      messagesToSummarize: [oldMessage],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: oldMessage },
      { type: "message", id: "entry-keep", message: retainedMessage },
    ];
    const compactedMessages = [{ role: "compactionSummary", summary: "truncated" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const replaceMessages = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "tiny", reasoning: false, contextWindow: 1000 },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn()
          .mockReturnValueOnce({ messages: [oldMessage, retainedMessage] })
          .mockReturnValue({ messages: compactedMessages }),
      },
      agent: {
        state: {
          systemPrompt: "system " + "x".repeat(2000),
          messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(6000) }] }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn((messages) => messages),
        replaceMessages,
      },
    };

    const onCompacted = vi.fn();
    const result = await runCachePreservingCompactionForSession(session, { onCompacted });

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(onCompacted).toHaveBeenCalledWith(session);
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("calls onCompacted only after append, message replacement, and compact event succeed", async () => {
    const order: string[] = [];
    const onCompacted = vi.fn(() => order.push("callback"));
    const session = {
      sessionManager: {
        appendCompaction: vi.fn(() => {
          order.push("append");
          return "compaction-entry";
        }),
        buildSessionContext: vi.fn(() => ({ messages: [{ role: "compactionSummary", summary: "done" }] })),
        getEntry: vi.fn(() => ({ id: "compaction-entry", type: "compaction" })),
      },
      agent: {
        replaceMessages: vi.fn(() => order.push("replace")),
      },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { order.push("event"); }),
      },
    };
    const result = {
      summary: "done",
      firstKeptEntryId: "keep",
      tokensBefore: 12,
      details: {},
    };

    await appendCompactionResultToSession(session, result, { onCompacted });

    expect(order).toEqual(["append", "replace", "event", "callback"]);
  });

  it("does not call onCompacted when replacement or compact event fails", async () => {
    const result = {
      summary: "done",
      firstKeptEntryId: "keep",
      tokensBefore: 12,
      details: {},
    };
    const onReplaceFailure = vi.fn();
    const replaceFailure = {
      sessionManager: {
        appendCompaction: vi.fn(() => "entry"),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
      },
      agent: { replaceMessages: vi.fn(() => { throw new Error("replace failed"); }) },
    };
    await expect(appendCompactionResultToSession(replaceFailure, result, {
      onCompacted: onReplaceFailure,
    })).rejects.toThrow("replace failed");
    expect(onReplaceFailure).not.toHaveBeenCalled();

    const onEventFailure = vi.fn();
    const eventFailure = {
      sessionManager: {
        appendCompaction: vi.fn(() => "entry"),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getEntry: vi.fn(() => ({ id: "entry", type: "compaction" })),
      },
      agent: { replaceMessages: vi.fn() },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { throw new Error("event failed"); }),
      },
    };
    await expect(appendCompactionResultToSession(eventFailure, result, {
      onCompacted: onEventFailure,
    })).rejects.toThrow("event failed");
    expect(onEventFailure).not.toHaveBeenCalled();
  });

  it("hard truncates direct session compaction when model context window is unknown", async () => {
    const oldMessage = { role: "user", content: "old context" };
    const retainedMessage = { role: "assistant", content: "keep" };
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 9000,
      messagesToSummarize: [oldMessage],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 2000, keepRecentTokens: 100 },
    };
    const branch = [
      { type: "message", id: "entry-old", message: oldMessage },
      { type: "message", id: "entry-keep", message: retainedMessage },
    ];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "should not run" }],
      })),
    }));
    const session = {
      model: { id: "missing-window", reasoning: false },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000, keepRecentTokens: 100 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn()
          .mockReturnValueOnce({ messages: [oldMessage, retainedMessage] })
          .mockReturnValue({ messages: [{ role: "compactionSummary", summary: "truncated" }] }),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn,
        convertToLlm: vi.fn((messages) => messages),
        replaceMessages: vi.fn(),
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(streamFn).not.toHaveBeenCalled();
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("早期对话历史已被硬截断"),
      "entry-keep",
      expect.any(Number),
      expect.objectContaining({ reason: "cache-preserving-compaction-hard-truncate" }),
      true,
    );
    expect(result.details.reason).toBe("cache-preserving-compaction-hard-truncate");
  });

  it("emits lifecycle events for direct model-switch compaction", async () => {
    const oldMessage = { role: "user", content: "before compaction" };
    const retainedMessage = { role: "assistant", content: "retained tail" };
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      messagesToSummarize: [oldMessage],
      turnPrefixMessages: [],
      isSplitTurn: false,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn(() => "compaction-entry");
    const emit = vi.fn();
    const extensionEmit = vi.fn(async () => {});
    const session = {
      model: { id: "model", reasoning: false, contextWindow: 128000 },
      _emit: emit,
      extensionRunner: {
        hasHandlers: vi.fn((event) => event === "session_compact"),
        emit: extensionEmit,
      },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        getEntry: vi.fn(() => ({
          type: "compaction",
          id: "compaction-entry",
          summary: VALID_COMPACTION_SUMMARY,
        })),
        buildSessionContext: vi.fn()
          .mockReturnValueOnce({ messages: [oldMessage, retainedMessage] })
          .mockReturnValue({ messages: compactedMessages }),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        streamFn: vi.fn(async () => agentStreamOf()),
        convertToLlm: vi.fn((messages) => messages),
        replaceMessages: vi.fn(),
      },
    };

    await runCachePreservingCompactionForSession(session, {
      emitLifecycle: true,
      lifecycleReason: "model_switch",
    });

    expect(emit).toHaveBeenNthCalledWith(1, { type: "compaction_start", reason: "model_switch" });
    expect(extensionEmit).toHaveBeenCalledWith({
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-entry",
        summary: VALID_COMPACTION_SUMMARY,
      },
      fromExtension: true,
    });
    expect(emit).toHaveBeenLastCalledWith({
      type: "compaction_end",
      reason: "model_switch",
      result: expect.objectContaining({ summary: VALID_COMPACTION_SUMMARY }),
      aborted: false,
      willRetry: false,
    });
  });

  it("refuses the manual wrapper when the compaction hook is missing", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };

    await expect((compactSessionWithCachePreservation as any)(session)).rejects.toThrow(
      "Cache-preserving compaction extension is not installed",
    );
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("reloads the session runtime once when the compaction hook is missing", async () => {
    const staleSession = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    const reloadedSession = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn((event) => event === "session_before_compact") },
    };
    const reloadSessionRuntime = vi.fn(async () => reloadedSession);

    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: staleSession,
      sessionPath: "/sessions/a.jsonl",
      customInstructions: "focus",
      reloadSessionRuntime,
    })).resolves.toMatchObject({ result: "ok", session: reloadedSession, recovered: true });

    expect(staleSession.compact).not.toHaveBeenCalled();
    expect(reloadSessionRuntime).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(reloadedSession.compact).toHaveBeenCalledWith("focus");
  });

  it("reports stale extension runners before invoking manual compaction", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(() => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        }),
        hasHandlers: vi.fn(() => true),
      },
    };

    await expect((compactSessionWithCachePreservation as any)(session)).rejects.toThrow(
      "This extension ctx is stale after session replacement or reload",
    );
    expect(session.extensionRunner.hasHandlers).not.toHaveBeenCalled();
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("keeps Pi lifecycle events by delegating manual compaction through session.compact", async () => {
    const session = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn(() => true) },
    };

    await expect(compactSessionWithCachePreservation(session, "extra focus")).resolves.toBe("ok");
    expect(session.compact).toHaveBeenCalledWith("extra focus");
  });
});

describe("session snapshot side-task runner", () => {
  function sideTaskSnapshot() {
    return buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      reason: "memory.reflection",
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "stable system",
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    });
  }

  it("appends the suffix after the exact parent prefix and keeps tools", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 10 },
      })),
    }));

    const result = await runSessionSnapshotSideTask({
      snapshot: sideTaskSnapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "medium" },
      suffixMessage: { role: "user", content: [{ type: "text", text: "internal task" }] },
      streamFn,
      options: { reasoning: "medium", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    expect(result.text).toBe("side result");
    expect(result.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      strict: true,
      cacheGroup: "memory.reflection",
    });
    const [, context, options] = streamFn.mock.calls[0] as any;
    expect(context.systemPrompt).toBe("stable system");
    expect(context.tools).toEqual([{ name: "read", description: "Read files", parameters: { type: "object" } }]);
    expect(context.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "text", text: "internal task" }] },
    ]);
    expect(options).toMatchObject({ reasoning: "medium", toolChoice: "none" });
  });

  it("canonicalizes legacy auto in side-task cache params and request options", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
      })),
    }));
    const snap = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      reason: "memory.reflection",
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      systemPrompt: "stable system",
      tools: [],
      messages: [{ role: "user", content: "hello" }],
    });

    await runSessionSnapshotSideTask({
      snapshot: snap,
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "auto", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    const [, , options] = streamFn.mock.calls[0] as any;
    expect(options).toEqual({ reasoning: "medium", toolChoice: "none" });
  });

  it("throws before provider call when strict request contract is broken", async () => {
    const streamFn = vi.fn();
    await expect(runSessionSnapshotSideTask({
      snapshot: sideTaskSnapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "off" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "off", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    })).rejects.toThrow("Session snapshot request is not strict");
    expect(streamFn).not.toHaveBeenCalled();
  });
});

describe("direct compaction mutual exclusion", () => {
  const settings = { enabled: true, reserveTokens: 2000 };
  const model = { id: "m", provider: "p", contextWindow: 128_000 };

  it("refuses to start while the SDK's own compaction holds the session", async () => {
    const session = {
      isCompacting: true,
      agent: {},
      sessionManager: { getBranch: () => [] },
    };

    await expect(runCachePreservingCompactionForSession(session, { model, settings }))
      .rejects.toThrow(/compaction already in progress/);
  });

  it("refuses a second direct compaction on the same session", async () => {
    let reentry: Promise<string> | null = null;
    const session: any = {
      agent: {},
      sessionManager: {
        getBranch: () => {
          // Re-enter while the first run still holds this session. Two
          // compactions on one session would write two summaries over the same
          // history, so the second has to be told, not quietly queued.
          reentry ??= runCachePreservingCompactionForSession(session, { model, settings })
            .then(() => "resolved", (err) => err.message);
          return [];
        },
      },
    };

    await expect(runCachePreservingCompactionForSession(session, { model, settings }))
      .rejects.toThrow();
    await expect(reentry).resolves.toMatch(/compaction already in progress/);
  });

  it("releases the session again once the compaction fails", async () => {
    const session: any = {
      agent: {},
      sessionManager: { getBranch: () => [] },
    };

    await expect(runCachePreservingCompactionForSession(session, { model, settings }))
      .rejects.toThrow();
    expect(isDirectCompactionInProgress(session)).toBe(false);
    // A failed attempt must not leave the session permanently locked: the next
    // one gets to fail on its own merits, not on a stale lock.
    await expect(runCachePreservingCompactionForSession(session, { model, settings }))
      .rejects.not.toThrow(/compaction already in progress/);
  });
});

describe("runLossyLocalCompactionForSession", () => {
  it("persists a local checkpoint, replaces live messages, and emits a mode-aware lifecycle", async () => {
    const branchEntries = [
      { id: "u1", parentId: null, type: "message", message: piUser("old", 1), timestamp: 1 },
      { id: "a1", parentId: "u1", type: "message", message: piAssistant("answer", 2), timestamp: 2 },
      { id: "u2", parentId: "a1", type: "message", message: piUser("retained", 3), timestamp: 3 },
    ];
    prepareCompactionMock.mockReturnValueOnce({
      firstKeptEntryId: "u2",
      tokensBefore: 500,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    });
    const rebuiltMessages = [{ role: "compactionSummary", summary: "rebuilt" }];
    const appendCompaction = vi.fn(() => "compaction-1");
    const replaceMessages = vi.fn();
    const emit = vi.fn();
    const getSummarySource = vi.fn(async () => null);
    const session: any = {
      isCompacting: false,
      agent: { replaceMessages },
      settingsManager: { getCompactionSettings: () => REAL_COMPACTION_SETTINGS },
      sessionManager: {
        getBranch: () => branchEntries,
        appendCompaction,
        buildSessionContext: () => ({ messages: rebuiltMessages }),
      },
      _emit: emit,
    };

    const result = await runLossyLocalCompactionForSession(session, {
      getSummarySource,
      emitLifecycle: true,
      lifecycleReason: "threshold",
    });

    expect(result).toMatchObject({
      firstKeptEntryId: "u2",
      tokensBefore: 500,
      details: { strategy: "lossy_local", zeroModelRequest: true },
    });
    expect(getSummarySource).toHaveBeenCalledWith(session);
    expect(appendCompaction).toHaveBeenCalledWith(
      expect.stringContaining("### User\nold"),
      "u2",
      500,
      expect.objectContaining({ strategy: "lossy_local" }),
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(rebuiltMessages);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "compaction_start", mode: "lossy_local" }),
      expect.objectContaining({ type: "compaction_end", mode: "lossy_local", aborted: false }),
    ]);
    expect(isDirectCompactionInProgress(session)).toBe(false);
  });
});
