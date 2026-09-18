import { describe, expect, it, vi } from "vitest";
import {
  createMiniCPM5LoopGuard,
  normalizeMiniCPM5Model,
  projectMiniCPM5ContextMessages,
} from "../lib/pi-sdk/minicpm5-agent-profile.ts";

function user(text: string, timestamp: number) {
  return { role: "user", content: text, timestamp };
}

function toolCall(name: string, id: string, args: any) {
  return { role: "assistant", content: [{ type: "toolCall", name, id, arguments: args }] };
}

function toolResult(name: string, id: string, isError = false) {
  return { role: "toolResult", toolName: name, toolCallId: id, isError, content: [{ type: "text", text: "ok" }] };
}

describe("MiniCPM5 agent profile", () => {
  it("projects ordinary history to a bounded model-facing copy without mutating the transcript", () => {
    const messages = [
      user("old ".repeat(2_000), 1),
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      user("current request", 2),
    ];
    const projected = projectMiniCPM5ContextMessages(messages, { defaultBudget: 120 });

    expect(projected).not.toBe(messages);
    expect(projected.at(-1)).toMatchObject({ role: "user", content: "current request" });
    expect(JSON.stringify(messages)).toContain("old ".repeat(100));
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(messages).length);
  });

  it("allows the larger window only for an explicit long-context request", () => {
    const history = Array.from({ length: 20 }, (_, index) => user("x".repeat(1_000), index));
    const ordinary = projectMiniCPM5ContextMessages([...history, user("answer briefly", 100)], {
      contextWindow: 10_000,
      defaultBudget: 1_200,
    });
    const long = projectMiniCPM5ContextMessages([...history, user("请回顾全文并使用32k上下文", 100)], {
      contextWindow: 10_000,
      defaultBudget: 1_200,
    });

    expect(long.length).toBeGreaterThan(ordinary.length);
  });

  it("hard-caps a caller-supplied MiniCPM5 model at 32K", () => {
    const bounded = normalizeMiniCPM5Model({
      provider: "minicpm5-local",
      id: "default_model",
      contextWindow: 65_536,
      maxTokens: 4_096,
    });
    expect(bounded.contextWindow).toBe(32_768);
    expect(normalizeMiniCPM5Model({ provider: "openai", contextWindow: 65_536 }).contextWindow).toBe(65_536);
  });

  it("counts CJK prose conservatively so a long Chinese chapter cannot overflow the model window", () => {
    const oldChapter = "这是旧章节内容。".repeat(4_000);
    const projected = projectMiniCPM5ContextMessages([
      user(oldChapter, 1),
      user("请继续", 2),
    ], { contextWindow: 4_096, outputReserve: 512, defaultBudget: 3_584 });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ role: "user", content: "请继续" });
  });

  it("does not undercount repeated short ASCII tokens used by long code probes", () => {
    const projected = projectMiniCPM5ContextMessages([
      user("x ".repeat(20_000), 1),
      user("请继续", 2),
    ], { contextWindow: 4_096, outputReserve: 512, defaultBudget: 3_584 });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ role: "user", content: "请继续" });
  });

  it("drops an orphan tool result and truncates oversized tool output", () => {
    const projected = projectMiniCPM5ContextMessages([
      user("read file", 1),
      { role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "x" }] },
      toolCall("read", "read-1", { path: "a.md" }),
      { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "x".repeat(20_000) }] },
    ], { defaultBudget: 20_000, toolResultChars: 100 });

    expect(projected.some((message) => message.toolCallId === "missing")).toBe(false);
    expect(JSON.stringify(projected)).toContain("context projection truncated");
  });

  it("blocks identical calls but permits different write content", () => {
    const guard = createMiniCPM5LoopGuard({ maxToolResults: 6 });
    const context: any = { messages: [user("写入两个不同版本", 1)] };
    const first = { assistantMessage: null, toolCall: { name: "write", id: "w1" }, args: { path: "a.md", content: "one" }, context };
    const second = { assistantMessage: null, toolCall: { name: "write", id: "w2" }, args: { path: "a.md", content: "two" }, context };
    const duplicate = { assistantMessage: null, toolCall: { name: "write", id: "w3" }, args: { path: "a.md", content: "two" }, context };

    expect(guard.beforeToolCall(first)).toBeUndefined();
    expect(guard.beforeToolCall(second)).toBeUndefined();
    expect(guard.beforeToolCall(duplicate)).toMatchObject({ block: true });
  });

  it("stops after two failures and does not call the wrapped after hook twice", async () => {
    const previous = vi.fn(async () => undefined);
    const guard = createMiniCPM5LoopGuard({ previousAfterToolCall: previous, maxToolResults: 6 });
    const context: any = { messages: [user("执行工具", 1)] };
    const call = (id: string) => ({
      assistantMessage: null,
      toolCall: { name: "read", id },
      args: { path: `${id}.md` },
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true,
      context,
    });

    await guard.afterToolCall(call("r1"));
    const second = await guard.afterToolCall(call("r2"));
    expect(second).toMatchObject({ terminate: true });
    expect(previous).toHaveBeenCalledTimes(2);
    expect(guard.shouldStopAfterTurn({ context })).toBe(true);
  });

  it("does not stop before the sixth successful result", async () => {
    const guard = createMiniCPM5LoopGuard({ maxToolResults: 6 });
    const context: any = { messages: [user("执行工具", 1)] };
    for (let index = 0; index < 5; index += 1) {
      await guard.afterToolCall({
        toolCall: { name: "read", id: `r${index}` },
        args: { path: `${index}.md` },
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
        context,
      });
    }
    expect(guard.shouldStopAfterTurn({ context })).toBe(false);
  });
});
