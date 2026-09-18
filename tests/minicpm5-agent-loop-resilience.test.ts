import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type, runAgentLoop } from "../lib/pi-sdk/index.ts";

const model = {
  provider: "minicpm5-local",
  id: "default_model",
  name: "MiniCPM5-2B",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8080/v1",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: any[], stopReason: "stop" | "toolUse" | "aborted" = "stop", errorMessage?: string) {
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions" as const,
    provider: "minicpm5-local",
    model: "default_model",
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function textResponse(text: string) {
  return assistant([{ type: "text", text }]);
}

function toolResponse(name: string, id = `call-${name}`) {
  return assistant([{ type: "toolCall", id, name, arguments: {} }], "toolUse");
}

function streamOf(message: any) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: assistant([]) });
  if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
  else stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

function baseContext(tool: any) {
  return {
    systemPrompt: "Use tools when requested, then answer concisely.",
    messages: [],
    tools: [tool],
  };
}

const callTool = {
  name: "ping",
  description: "Return a small result.",
  parameters: Type.Object({}),
};

describe("MiniCPM5 Agent loop resilience", () => {
  it("executes consecutive tool turns and resumes with the tool result", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], details: {} }));
    const requests: any[] = [];
    const streamFn = (_model: any, context: any) => {
      requests.push({ ...context, messages: [...context.messages] });
      return streamOf(requests.length === 1 ? toolResponse("ping") : textResponse("已收到 pong"));
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "调用 ping，然后回复结果。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute }),
      { model, convertToLlm: messages => messages as any, toolExecution: "sequential" },
      () => {},
      undefined,
      streamFn,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "toolResult", isError: false });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "已收到 pong" }] });
  });

  it("turns a tool failure into an error result that the next turn can recover from", async () => {
    const execute = vi.fn(async () => { throw new Error("temporary failure"); });
    const requests: any[] = [];
    const streamFn = (_model: any, context: any) => {
      requests.push({ ...context, messages: [...context.messages] });
      return streamOf(requests.length === 1 ? toolResponse("ping") : textResponse("工具失败后已恢复"));
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "调用 ping。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute }),
      { model, convertToLlm: messages => messages as any, toolExecution: "sequential" },
      () => {},
      undefined,
      streamFn,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "工具失败后已恢复" }] });
  });

  it("blocks a rejected approval without executing the tool", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "must not run" }], details: {} }));
    const requests: any[] = [];
    const streamFn = (_model: any, context: any) => {
      requests.push({ ...context, messages: [...context.messages] });
      return streamOf(requests.length === 1 ? toolResponse("ping") : textResponse("审批被拒绝"));
    };

    await runAgentLoop(
      [{ role: "user", content: "调用 ping。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute }),
      {
        model,
        convertToLlm: messages => messages as any,
        toolExecution: "sequential",
        beforeToolCall: async () => ({ block: true, reason: "user denied" }),
      },
      () => {},
      undefined,
      streamFn,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
  });

  it("supports a caller-owned turn cap through shouldStopAfterTurn", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], details: {} }));
    let requests = 0;
    const streamFn = () => {
      requests++;
      return streamOf(toolResponse("ping"));
    };
    const messages = await runAgentLoop(
      [{ role: "user", content: "只执行一轮工具。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute }),
      {
        model,
        convertToLlm: messages => messages as any,
        toolExecution: "sequential",
        shouldStopAfterTurn: ({ newMessages }) => newMessages.filter(message => message.role === "toolResult").length >= 1,
      },
      () => {},
      undefined,
      streamFn,
    );

    expect(requests).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
  });

  it("returns aborted cleanly and accepts a fresh follow-up request", async () => {
    const aborted = assistant([], "aborted", "cancelled");
    const firstRequests: any[] = [];
    const first = await runAgentLoop(
      [{ role: "user", content: "取消这次请求。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute: vi.fn() }),
      { model, convertToLlm: messages => messages as any },
      () => {},
      undefined,
      () => {
        firstRequests.push(true);
        return streamOf(aborted);
      },
    );
    expect(firstRequests).toHaveLength(1);
    expect(first.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });

    const second = await runAgentLoop(
      [{ role: "user", content: "新请求正常回答。", timestamp: Date.now() }],
      baseContext({ ...callTool, execute: vi.fn() }),
      { model, convertToLlm: messages => messages as any },
      () => {},
      undefined,
      () => streamOf(textResponse("正常")),
    );
    expect(second.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });
});
