import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
  createAgentSession: vi.fn(async opts => ({ session: { opts }, modelFallbackMessage: null })),
  SessionManager: { create: vi.fn(), open: vi.fn() },
  SettingsManager: { inMemory: vi.fn() },
  createReadTool: vi.fn(),
  createWriteTool: vi.fn(),
  createEditTool: vi.fn(),
  createBashTool: vi.fn(),
  createGrepTool: vi.fn(),
  createFindTool: vi.fn(),
  createLsTool: vi.fn(),
  DefaultResourceLoader: class {},
  formatSkillsForPrompt: vi.fn(),
  getLastAssistantUsage: vi.fn(),
  AuthStorage: class {},
  estimateTokens: vi.fn(),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  serializeConversation: vi.fn(),
  shouldCompact: vi.fn(),
  parseSessionEntries: vi.fn(),
  buildSessionContext: vi.fn(),
  ModelRegistry: { create: vi.fn() },
  resizeImage: vi.fn(),
  formatDimensionNote: vi.fn(),
  convertToLlm: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => ({
  StringEnum: vi.fn(values => values),
  AssistantMessageEventStream: class {},
  createAssistantMessageEventStream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async () => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("../lib/pi-sdk/session-options.js", async () => ({
  PI_BUILTIN_TOOL_NAMES: Object.freeze(["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]),
  normalizeCreateAgentSessionOptions: vi.fn(opts => ({
    ...opts,
    normalizedByAdapter: true,
  })),
}));

describe("Pi SDK createAgentSession adapter", () => {
  it("normalizes options before calling the raw SDK", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const adapter = await import("../lib/pi-sdk/index.ts");
    const sessionOptions = {
      cwd: "/tmp/project",
      tools: [{ name: "read", execute: vi.fn() }],
      customTools: [{ name: "web_search", execute: vi.fn() }],
    };

    await adapter.createAgentSession(sessionOptions);

    expect(adapter.PI_BUILTIN_TOOL_NAMES).toEqual(["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]);
    expect(sdk.createAgentSession).toHaveBeenCalledWith({
      ...sessionOptions,
      normalizedByAdapter: true,
    });
  });

  it("uses the resource loader agentDir as the SDK agentDir when omitted", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const adapter = await import("../lib/pi-sdk/index.ts");
    const resourceLoader = { agentDir: "/hana-home/runtime/pi-sdk/resource-loader/agent" };

    await adapter.createAgentSession({
      cwd: "/tmp/project",
      resourceLoader,
    });

    expect(sdk.createAgentSession).toHaveBeenLastCalledWith({
      cwd: "/tmp/project",
      resourceLoader,
      agentDir: "/hana-home/runtime/pi-sdk/resource-loader/agent",
      normalizedByAdapter: true,
    });
  });

  it("persists MiniCPM5 sessions with thinking off; reasoning is request-local", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const adapter = await import("../lib/pi-sdk/index.ts");

    await adapter.createAgentSession({
      cwd: "/tmp/project",
      model: { provider: "minicpm5-local", id: "default_model" },
      thinkingLevel: "medium",
      miniCPM5SystemPrompt: "compact prompt",
    });

    expect(sdk.createAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({
      model: { provider: "minicpm5-local", id: "default_model" },
      thinkingLevel: "off",
      miniCPM5SystemPrompt: "compact prompt",
    }));
  });

  it("promotes explicit Hana tool failures before the existing Pi hook runs", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const existingHook = vi.fn(async ({ isError }) => ({ isError }));
    const session = { agent: { afterToolCall: existingHook } };
    vi.mocked(sdk.createAgentSession).mockResolvedValueOnce({ session, modelFallbackMessage: null } as any);
    const adapter = await import("../lib/pi-sdk/index.ts");

    await adapter.createAgentSession({ cwd: "/tmp/project" });
    const result = {
      isError: true,
      content: [{ type: "text", text: "permission denied" }],
      details: { error: "permission denied", errorCode: "TOOL_DENIED" },
    };
    const patch = await session.agent.afterToolCall({
      toolCall: { id: "call-1", name: "exec_command" },
      args: {},
      result,
      isError: false,
    });

    expect(existingHook).toHaveBeenCalledWith(expect.objectContaining({ result, isError: true }), undefined);
    expect(patch).toMatchObject({ isError: true });
  });

  it("keeps an existing Pi hook's explicit outcome override", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const existingHook = vi.fn(async (..._args: any[]) => ({ isError: false, details: { recovered: true } }));
    const session = { agent: { afterToolCall: existingHook } };
    vi.mocked(sdk.createAgentSession).mockResolvedValueOnce({ session, modelFallbackMessage: null } as any);
    const adapter = await import("../lib/pi-sdk/index.ts");

    await adapter.createAgentSession({ cwd: "/tmp/project" });
    const patch = await session.agent.afterToolCall({
      toolCall: { id: "call-2", name: "recoverable" },
      args: {},
      result: { isError: true, content: [{ type: "text", text: "recovered" }], details: {} },
      isError: false,
    });

    expect(patch).toMatchObject({ isError: false, details: { recovered: true } });
  });
});
