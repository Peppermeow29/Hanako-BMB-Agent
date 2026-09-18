import { describe, expect, it, vi } from "vitest";
import {
  Type,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "../lib/pi-sdk/index.ts";
import {
  runCachePreservingCompactionAgentRun,
  type CachePreservingCompactionAgentRunOptions,
} from "../lib/llm/cache-preserving-compaction-agent-run.ts";

const VALID_SUMMARY = `## Goal
Keep the live session compact.

## Constraints & Preferences
- Preserve the provider-visible prefix.

## Progress
### Done
- [x] Inspected the old region.

### In Progress
- [ ] Produce the checkpoint.

### Blocked
- (none)

## Key Decisions
- Keep recent messages visible for continuity.

## Next Steps
1. Continue from the retained tail.

## Critical Context
- The retained tail is already present above.`;

const VALID_PROGRESS_SECTIONS = `### Done
- [x] Inspected the old region.

### In Progress
- [ ] Produce the checkpoint.

### Blocked
- (none)`;

const usage = {
  input: 10,
  output: 5,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;

function assistant(
  content: any[],
  stopReason: AssistantMessage["stopReason"] = "stop",
  overrides: Partial<AssistantMessage> = {},
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
    ...overrides,
  } as AssistantMessage;
}

function textResponse(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
  return assistant([{ type: "text", text }], stopReason);
}

function toolResponse(calls: Array<{ id: string; name: string; arguments?: Record<string, any> }>) {
  return assistant(calls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments || {},
  })), "toolUse");
}

function streamOf(message: any): Awaited<ReturnType<StreamFn>> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "done",
        reason: message.stopReason,
        message,
      };
    },
    async result() {
      return message;
    },
  } as unknown as Awaited<ReturnType<StreamFn>>;
}

function user(text: string, timestamp: number): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

type BaseFixture = Omit<
  CachePreservingCompactionAgentRunOptions,
  "streamFn" | "liveMessages" | "tools" | "systemPrompt" | "cacheMetadata"
> & {
  liveMessages: AgentMessage[];
  tools: AgentTool<any>[];
  systemPrompt: string;
  cacheMetadata: NonNullable<CachePreservingCompactionAgentRunOptions["cacheMetadata"]>;
  liveExecute: ReturnType<typeof vi.fn>;
};

function baseFixture(overrides: Partial<BaseFixture> = {}): BaseFixture {
  const liveMessages: AgentMessage[] = [
    user("old-1", 1),
    assistant([{ type: "text", text: "old-2" }], "stop", { timestamp: 2 }),
    user("recent-tail-1", 3),
    assistant([{ type: "text", text: "recent-tail-2" }], "stop", { timestamp: 4 }),
  ];
  const instruction = user([
    "Hidden compaction instruction.",
    "Old region: live message indexes [0, 2). Summarize only that old region.",
    "Recent-tail boundary: index 2. Messages from that boundary onward remain visible for continuity.",
    "The recent tail is retained context, not replacement input for the summary.",
    "Return the structured checkpoint only.",
  ].join("\n"), 5);
  const liveExecute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "real tool result" }],
    details: {},
  }));
  const tools: AgentTool<any>[] = [
    {
      name: "read",
      label: "Read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
      execute: liveExecute,
    },
    {
      name: "search",
      label: "Search",
      description: "Search text",
      parameters: Type.Object({ query: Type.String() }),
      execute: liveExecute,
    },
  ];
  const fixture: BaseFixture = {
    liveMessages,
    instruction,
    tools,
    liveExecute,
    model: {
      id: "test-model",
      provider: "test-provider",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    } as AgentLoopConfig["model"],
    systemPrompt: "live system prompt",
    convertToLlm: async (messages: AgentMessage[]) => messages as any,
    cacheMetadata: {
      cacheStrategy: "session_snapshot",
      cacheGroup: "compaction.history",
      templateVersion: "agent-run.v1",
      cachePrefixHash: "b".repeat(64),
      parentCachePrefixHash: "a".repeat(64),
      strict: true,
    },
    usageContext: {
      source: { surface: "session", operation: "compaction" },
      attribution: { sessionId: "session-1" },
    },
  };
  return { ...fixture, ...overrides };
}

function createLedger() {
  const starts: any[] = [];
  const finishes: any[] = [];
  const errors: any[] = [];
  return {
    starts,
    finishes,
    errors,
    start(meta: any) {
      starts.push(meta);
      return { requestId: `request-${starts.length}` };
    },
    finish(requestId: string, result: any) {
      finishes.push({ requestId, result });
    },
    recordError(requestId: string, error: any, status: string, result: any) {
      errors.push({ requestId, error, status, result });
    },
  };
}

describe("cache-preserving compaction AgentRun", () => {
  it("sends the exact full live prefix followed by one hidden instruction", async () => {
    const fixture = baseFixture();
    const requests: any[] = [];
    const result = await runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async (_model: any, context: any) => {
        requests.push({ ...context, messages: [...context.messages] });
        return streamOf(textResponse(VALID_SUMMARY));
      },
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([...fixture.liveMessages, fixture.instruction]);
    expect(requests[0].messages.slice(0, -1)).toEqual(fixture.liveMessages);
    expect(requests[0].messages.at(-1)).toEqual(fixture.instruction);
  });

  it("keeps the old-region identity and recent-tail boundary separate in the hidden instruction", async () => {
    const fixture = baseFixture();
    let providerInstruction = "";
    await runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async (_model: any, context: any) => {
        providerInstruction = context.messages.at(-1).content[0].text;
        return streamOf(textResponse(VALID_SUMMARY));
      },
    });

    expect(providerInstruction).toContain("Old region: live message indexes [0, 2)");
    expect(providerInstruction).toContain("Recent-tail boundary: index 2");
  });

  it("keeps recent-tail messages provider-visible without presenting them as replacement input", async () => {
    const fixture = baseFixture();
    let requestMessages: any[] = [];
    await runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async (_model: any, context: any) => {
        requestMessages = [...context.messages];
        return streamOf(textResponse(VALID_SUMMARY));
      },
    });

    expect(requestMessages[2].content[0].text).toBe("recent-tail-1");
    expect(requestMessages[3].content[0].text).toBe("recent-tail-2");
    expect(requestMessages.at(-1).content[0].text).toContain(
      "The recent tail is retained context, not replacement input",
    );
  });

  it("clones the live tool catalog exactly without mutating or executing live tools", async () => {
    const fixture = baseFixture();
    let providerTools: any[] = [];
    await runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async (_model: any, context: any) => {
        providerTools = context.tools;
        return streamOf(textResponse(VALID_SUMMARY));
      },
    });

    expect(providerTools.map(({ name, description, parameters }: any) => ({
      name,
      description,
      parameters,
    }))).toEqual(fixture.tools.map(({ name, description, parameters }: any) => ({
      name,
      description,
      parameters,
    })));
    expect(providerTools.map((tool) => tool.name)).toEqual(["read", "search"]);
    expect(providerTools[0]).not.toBe(fixture.tools[0]);
    expect(providerTools[0].execute).not.toBe(fixture.tools[0].execute);
    expect(fixture.liveExecute).not.toHaveBeenCalled();
  });

  it("preserves prepareArguments while replacing only the live execute function", async () => {
    const fixture = baseFixture();
    const prepareArguments = vi.fn((args: any) => ({ path: args.inputPath }));
    fixture.tools[0].prepareArguments = prepareArguments;
    const requests: any[] = [];
    const responses = [
      toolResponse([{ id: "call-prepare", name: "read", arguments: { inputPath: "notes.md" } }]),
      textResponse(VALID_SUMMARY),
    ];

    const result = await runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async (_model: any, context: any) => {
        requests.push({ ...context, messages: [...context.messages] });
        return streamOf(responses.shift());
      },
    });

    expect(prepareArguments).toHaveBeenCalledWith({ inputPath: "notes.md" });
    expect(requests[0].tools[0].prepareArguments).toBe(prepareArguments);
    expect(requests[1].messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-prepare",
      isError: false,
    });
    expect(fixture.liveExecute).not.toHaveBeenCalled();
    expect(result.summary).toBe(VALID_SUMMARY);
  });

  it("accepts a structured response with no tool intent", async () => {
    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(textResponse(VALID_SUMMARY)),
    });

    expect(result).toMatchObject({
      summary: VALID_SUMMARY,
      diagnostics: {
        providerRequests: 1,
        toolIntentCount: 0,
        repaired: false,
        sanitizedNarrationTypes: [],
      },
    });
  });

  it("answers one placeholder tool call and permits one provider continuation", async () => {
    const fixture = baseFixture();
    const ledger = createLedger();
    const requests: any[] = [];
    const responses = [
      toolResponse([{ id: "call-1", name: "read", arguments: { path: "notes.md" } }]),
      textResponse(VALID_SUMMARY),
    ];
    const result = await runCachePreservingCompactionAgentRun({
      ...fixture,
      usageLedger: ledger,
      streamFn: async (_model: any, context: any) => {
        requests.push({ ...context, messages: [...context.messages] });
        return streamOf(responses.shift());
      },
    });

    const toolResult = requests[1].messages.at(-1);
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
    });
    expect(toolResult.content[0].text.trim().length).toBeGreaterThan(0);
    expect(fixture.liveExecute).not.toHaveBeenCalled();
    expect(result.diagnostics).toMatchObject({ providerRequests: 2, toolIntentCount: 1 });
    expect(ledger.starts).toHaveLength(2);
    expect(ledger.finishes).toHaveLength(2);
    expect(ledger.starts[1].metadata).toMatchObject({
      cacheStrategy: "cache_recovery",
      strict: false,
      degradeReason: "tool_intent_recovery",
    });
  });

  it("pairs two placeholder tool results then fails before another provider request", async () => {
    const fixture = baseFixture();
    let providerRequests = 0;
    let caught: any;
    try {
      await runCachePreservingCompactionAgentRun({
        ...fixture,
        streamFn: async () => {
          providerRequests += 1;
          return streamOf(toolResponse([
            { id: "call-1", name: "read", arguments: { path: "a.md" } },
            { id: "call-2", name: "search", arguments: { query: "needle" } },
          ]));
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toMatch(/tool intent ceiling/i);
    expect(providerRequests).toBe(1);
    expect(caught.diagnostics.toolResults).toEqual([
      expect.objectContaining({ toolCallId: "call-1", toolName: "read" }),
      expect.objectContaining({ toolCallId: "call-2", toolName: "search" }),
    ]);
    expect(fixture.liveExecute).not.toHaveBeenCalled();
  });

  it("fails when a tool is requested after the first placeholder recovery turn", async () => {
    const fixture = baseFixture();
    let providerRequests = 0;
    await expect(runCachePreservingCompactionAgentRun({
      ...fixture,
      streamFn: async () => {
        providerRequests += 1;
        return streamOf(toolResponse([{
          id: `call-${providerRequests}`,
          name: "read",
          arguments: { path: "a.md" },
        }]));
      },
    })).rejects.toThrow(/tool intent.*recovery/i);
    expect(providerRequests).toBe(2);
    expect(fixture.liveExecute).not.toHaveBeenCalled();
  });

  it("removes well-formed internal narration blocks before accepting the summary", async () => {
    const raw = `<mood>
Vibe: focused
</mood>
${VALID_SUMMARY.replace("## Progress", `<pulse>
Beat: steady
</pulse>
## Progress`).replace("## Next Steps", `<reflect>
Observation: ready
</reflect>
## Next Steps`)}`;
    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(textResponse(raw)),
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(result.summary).not.toMatch(/<\/?(mood|pulse|reflect)>/);
    expect(result.diagnostics.sanitizedNarrationTypes).toEqual(["mood", "pulse", "reflect"]);
  });

  it("removes closed fenced internal narration and records its types without repair", async () => {
    const raw = [
      "```mood",
      "Vibe: focused",
      "```",
      VALID_SUMMARY.replace("## Progress", [
        "```pulse",
        "Beat: steady",
        "```",
        "## Progress",
      ].join("\n")).replace("## Next Steps", [
        "```reflect",
        "Observation: ready",
        "```",
        "## Next Steps",
      ].join("\n")),
    ].join("\n");

    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(textResponse(raw)),
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(result.diagnostics).toMatchObject({
      providerRequests: 1,
      repaired: false,
      sanitizedNarrationTypes: ["mood", "pulse", "reflect"],
    });
  });

  it("uses one corrective turn for an unmatched fenced internal narration opener", async () => {
    const responses = [
      textResponse(`\`\`\`mood\nunfinished\n${VALID_SUMMARY}`),
      textResponse(VALID_SUMMARY),
    ];

    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(result.diagnostics).toMatchObject({ providerRequests: 2, repaired: true });
  });

  it("fails when repair repeats an unmatched fenced internal narration opener", async () => {
    const malformed = `\`\`\`reflect\nunfinished\n${VALID_SUMMARY}`;
    const responses = [textResponse(malformed), textResponse(malformed)];

    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    })).rejects.toThrow(/invalid.*after.*repair/i);
  });

  it("uses one corrective turn for an unmatched internal narration tag", async () => {
    const responses = [
      textResponse(`<mood>\nunfinished\n${VALID_SUMMARY}`),
      textResponse(VALID_SUMMARY),
    ];
    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(result.diagnostics).toMatchObject({ providerRequests: 2, repaired: true });
  });

  it("fails when the corrective turn is still malformed", async () => {
    const responses = [
      textResponse(`<mood>\nunfinished\n${VALID_SUMMARY}`),
      textResponse(`<reflect>\nstill unfinished\n${VALID_SUMMARY}`),
    ];
    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    })).rejects.toThrow(/invalid.*after.*repair/i);
  });

  it.each(["<mood", "</reflect"])(
    "uses one corrective turn for the incomplete known-tag marker %s",
    async (fragment) => {
      const responses = [
        textResponse(`${fragment}\n${VALID_SUMMARY}`),
        textResponse(VALID_SUMMARY),
      ];
      const result = await runCachePreservingCompactionAgentRun({
        ...baseFixture(),
        streamFn: async () => streamOf(responses.shift()),
      });

      expect(result.summary).toBe(VALID_SUMMARY);
      expect(result.diagnostics).toMatchObject({ providerRequests: 2, repaired: true });
    },
  );

  it.each(["<mood", "</reflect"])(
    "fails when repair repeats the incomplete known-tag marker %s",
    async (fragment) => {
      const malformed = `${fragment}\n${VALID_SUMMARY}`;
      const responses = [textResponse(malformed), textResponse(malformed)];
      await expect(runCachePreservingCompactionAgentRun({
        ...baseFixture(),
        streamFn: async () => streamOf(responses.shift()),
      })).rejects.toThrow(/invalid.*after.*repair/i);
    },
  );

  it.each([
    ["missing", VALID_SUMMARY.replace("## Critical Context", "Critical Context")],
    ["duplicated", `${VALID_SUMMARY}\n\n## Goal\nduplicate`],
    ["out-of-order", VALID_SUMMARY.replace(
      /## Goal([\s\S]*?)(?=## Constraints & Preferences)/,
      "",
    ).replace("## Constraints & Preferences", `## Constraints & Preferences\n\n## Goal\nlate goal`)],
  ])("repairs %s headings once and fails when the repair remains invalid", async (_case, malformed) => {
    const responses = [textResponse(malformed), textResponse(malformed)];
    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    })).rejects.toThrow(/invalid.*after.*repair/i);
  });

  it.each([
    ["missing", VALID_SUMMARY.replace("### Blocked", "Blocked")],
    ["extra", VALID_SUMMARY.replace("### Blocked", "### Waiting\n- (none)\n\n### Blocked")],
    ["out-of-order", VALID_SUMMARY
      .replace("### Done", "### TEMP")
      .replace("### In Progress", "### Done")
      .replace("### TEMP", "### In Progress")],
  ])("repairs %s level-three progress headings once and fails when repair remains invalid", async (_case, malformed) => {
    const responses = [textResponse(malformed), textResponse(malformed)];

    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    })).rejects.toThrow(/invalid.*after.*repair/i);
  });

  it("uses one corrective turn when all progress headings appear before Progress", async () => {
    const malformed = VALID_SUMMARY
      .replace(`${VALID_PROGRESS_SECTIONS}\n\n`, "")
      .replace("## Progress", `${VALID_PROGRESS_SECTIONS}\n\n## Progress`);
    const responses = [textResponse(malformed), textResponse(VALID_SUMMARY)];

    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    });

    expect(result.summary).toBe(VALID_SUMMARY);
    expect(result.diagnostics).toMatchObject({ providerRequests: 2, repaired: true });
  });

  it("fails when repair keeps all progress headings after Critical Context", async () => {
    const malformed = `${VALID_SUMMARY.replace(`${VALID_PROGRESS_SECTIONS}\n\n`, "")}\n\n${
      VALID_PROGRESS_SECTIONS
    }`;
    const responses = [textResponse(malformed), textResponse(malformed)];

    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(responses.shift()),
    })).rejects.toThrow(/invalid.*after.*repair/i);
  });

  it.each(["error", "aborted", "length"] as const)("rejects an assistant %s stop reason", async (stopReason) => {
    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      streamFn: async () => streamOf(textResponse(VALID_SUMMARY, stopReason)),
    })).rejects.toThrow(new RegExp(stopReason, "i"));
  });

  it("honors an external abort signal", async () => {
    const controller = new AbortController();
    await expect(runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      signal: controller.signal,
      streamFn: async (_model: any, _context: any, options: any) => {
        controller.abort();
        expect(options.signal.aborted).toBe(true);
        return streamOf(textResponse("", "aborted"));
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("never forwards temporary AgentRun events to a supplied live event collector", async () => {
    const liveEvents: any[] = [];
    await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      emit: (event: any) => liveEvents.push(event),
      streamFn: async () => streamOf(textResponse(VALID_SUMMARY)),
    });
    expect(liveEvents).toEqual([]);
  });

  it("records provider usage for the strict request and the corrective repair request", async () => {
    const ledger = createLedger();
    const malformed = VALID_SUMMARY.replace("## Critical Context", "Critical Context");
    const responses = [textResponse(malformed), textResponse(VALID_SUMMARY)];
    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      usageLedger: ledger,
      streamFn: async () => streamOf(responses.shift()),
    });

    expect(result.diagnostics.providerRequests).toBe(2);
    expect(ledger.starts).toHaveLength(2);
    expect(ledger.finishes).toHaveLength(2);
    expect(ledger.starts[0].metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      strict: true,
      cachePrefixHash: "b".repeat(64),
    });
    expect(ledger.starts[1].metadata).toMatchObject({
      cacheStrategy: "cache_recovery",
      strict: false,
      degradeReason: "summary_format_repair",
    });
    expect(ledger.finishes.map((entry) => entry.result.usage)).toEqual([usage, usage]);
  });

  it("builds the low-level loop config from live options without forcing tool suppression", async () => {
    const transformContext = vi.fn(async (messages: any[]) => messages);
    let requestOptions: any;
    const result = await runCachePreservingCompactionAgentRun({
      ...baseFixture(),
      transformContext,
      streamOptions: {
        apiKey: "test-key",
        headers: { "x-test": "yes" },
        affinity: "affinity-1",
        transport: "sse",
        thinkingLevel: "HIGH",
        toolChoice: "none",
        outputPolicy: "provider-default",
      },
      streamFn: async (_model: any, _context: any, options: any) => {
        requestOptions = options;
        return streamOf(textResponse(VALID_SUMMARY));
      },
    });

    expect(transformContext).toHaveBeenCalledOnce();
    expect(requestOptions).toMatchObject({
      apiKey: "test-key",
      headers: { "x-test": "yes" },
      affinity: "affinity-1",
      transport: "sse",
      reasoning: "high",
      outputPolicy: "provider-default",
      toolExecution: "sequential",
    });
    expect(requestOptions).not.toHaveProperty("thinkingLevel");
    expect(requestOptions).not.toHaveProperty("toolChoice");
    expect(result.summary).toBe(VALID_SUMMARY);
  });
});
