import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "../lib/pi-sdk/index.ts";
import { adaptMiniCPM5XmlToolCallStream, sanitizeMiniCPM5Context } from "../lib/pi-sdk/minicpm5-stream-adapter.ts";

const model = { provider: "minicpm5-local", id: "default_model", api: "openai-completions" };

function message(content) {
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions",
    provider: "minicpm5-local",
    model: "default_model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

describe("MiniCPM5 XML stream adapter", () => {
  it("turns MLX text XML into standard tool-call events before the agent loop", async () => {
    const inner = createAssistantMessageEventStream();
    const final = message([{ type: "text", text: '<think>inspect</think><function name="read"><param name="path">README.md</param></function>' }]);
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: final });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map(event => event.type)).toContain("toolcall_end");
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "thinking", thinking: "inspect" },
      expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "README.md" } }),
    ]);
    expect(JSON.stringify(result.content)).not.toContain("<function");
  });

  it("streams ordinary text while buffering a split XML protocol", async () => {
    const inner = createAssistantMessageEventStream();
    const finalText = '先看一下\n<function name="read"><param name="path">README.md</param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: "先看一下\n<fun", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: 'ction name="read"><param name="path">README.md</param></function>', partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: finalText }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const textDeltas = events.filter(event => event.type === "text_delta").map(event => event.delta);
    expect(textDeltas).toEqual(["先看一下\n"]);
    expect(textDeltas.join("")).not.toContain("<fun");
    expect(events.some(event => event.type === "toolcall_end")).toBe(true);
  });

  it("does not stream a closing XML residue after a tool result", async () => {
    const inner = createAssistantMessageEventStream();
    const text = "已将诗句写入 poem.md 文件。]]></param></function>";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, { tools: [] });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const streamedText = events.filter(event => event.type === "text_delta").map(event => event.delta).join("");

    expect(streamedText).toBe("已将诗句写入 poem.md 文件。");
    expect(streamedText).not.toContain("</param>");
    expect((await stream.result()).content).toEqual([{ type: "text", text: "已将诗句写入 poem.md 文件。" }]);
  });

  it("does not append the normalized terminal tail after divergent streamed prose", async () => {
    const inner = createAssistantMessageEventStream();
    const streamed = "Paragraph 1: First paragraph.\n\nParagraph 2: Second paragraph finished.";
    const finalText = "Paragraph 1: First paragraph.\n\nParagraph 2: Second paragraph finished.\n";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: streamed, partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: finalText }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, { tools: [] });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const streamedText = events.filter(event => event.type === "text_delta").map(event => event.delta).join("");

    expect(streamedText).toBe(streamed);
    expect(streamedText.match(/Paragraph 2:/g)).toHaveLength(1);
  });

  it("recovers a call when only the terminal function tag was truncated", async () => {
    const inner = createAssistantMessageEventStream();
    const final = message([{ type: "text", text: '<function name="read"><param name="path">README.md</param>' }]);
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "length", message: final });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "README.md" } }),
    ]);
  });

  it("still rejects a function truncated inside a parameter", async () => {
    const inner = createAssistantMessageEventStream();
    const final = { ...message([{ type: "text", text: '<function name="read"><param name="path">README' }]), stopReason: "length" as const };
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "length", message: final });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("length");
    expect(JSON.stringify(result.content)).toContain("malformed_xml");
    expect(JSON.stringify(result.content)).not.toContain('type":"toolCall"');
  });

  it("hides hallucinated protocol wrappers and trailing XML residue", async () => {
    const inner = createAssistantMessageEventStream();
    const final = message([{
      type: "text",
      text: '<pokong-enode\n"not an instruction"</pokong-enode>\n\n已完成。]]></param></function>',
    }]);
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: final });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, { tools: [] });
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "已完成。" }]);
  });

  it("preserves ordinary less-than text while extracting split thinking and CDATA tool XML", async () => {
    const inner = createAssistantMessageEventStream();
    const finalText = '条件 x < 3\n<think>先读取草稿</think><function name="write"><param name="path"><![CDATA[draft.md]]></param><param name="content"><![CDATA[<draft>保留原样</draft>]]></param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: "条件 x < 3\n<th", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: 'ink>先读取草稿</think><function name="write"><param name="path"><![CDATA[draft.md]]></param><param name="content"><![CDATA[<draft>保留原样</draft>]]></param></function>', partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: finalText }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: "条件 x < 3\n" },
      { type: "thinking", thinking: "先读取草稿" },
      expect.objectContaining({
        type: "toolCall",
        name: "write",
        arguments: { path: "draft.md", content: "<draft>保留原样</draft>" },
      }),
    ]);
    expect(events.some(event => event.type === "thinking_end")).toBe(true);
    expect(events.some(event => event.type === "toolcall_end")).toBe(true);
  });

  it("keeps an unclosed think channel out of visible text", async () => {
    const inner = createAssistantMessageEventStream();
    const text = "<think>内部推理尚未闭合";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "length", message: { ...message([{ type: "text", text }]), stopReason: "length" } });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, { tools: [] });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "thinking", thinking: "内部推理尚未闭合" }]);
    expect(events.some(event => event.type === "thinking_end")).toBe(true);
    expect(events.some(event => event.type === "text_delta" && /内部推理/.test(event.delta))).toBe(false);
  });

  it("recovers the write phase after MiniCPM5 stops after generated prose", async () => {
    const inner = createAssistantMessageEventStream();
    const prose = "月光落在旧日记上，我决定把这段回忆留给明天。";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "text_delta", contentIndex: 0, delta: prose, partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: prose }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{
        role: "user",
        content: "请先写出正文，正文完成后，再调用一次 write 将完全相同的正文写入 CodeLife/novel.md。",
      }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: prose },
      expect.objectContaining({
        type: "toolCall",
        name: "write",
        arguments: { path: "novel.md", content: prose },
      }),
    ]);
    expect(events.map((event) => event.type)).toContain("toolcall_end");
  });

  it("recovers the write phase when display precedes write without a leading stage marker", async () => {
    const inner = createAssistantMessageEventStream();
    const prose = "晚霞铺满天际，星辰初现。";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: prose }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{ role: "user", content: "写一段优美的诗句，展现给我，然后写入poem4.md文件" }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: prose },
      expect.objectContaining({
        type: "toolCall",
        name: "write",
        arguments: { path: "poem4.md", content: prose },
      }),
    ]);
  });

  it("does not synthesize a second write after the same user turn already wrote", async () => {
    const inner = createAssistantMessageEventStream();
    const prose = "同一段正文不应被重复写入。";
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: prose }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [
        { role: "user", content: "请先写出正文，正文完成后，再调用一次 write 将正文写入 CodeLife/novel.md。" },
        { role: "assistant", content: [{ type: "text", text: prose }, { type: "toolCall", name: "write", id: "call-1", arguments: { path: "novel.md", content: prose } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: prose }]);
  });

  it("re-displays successful write content when it was not shown earlier", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial: message([]) });
    inner.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: "我已经处理好了，请问还需要什么？" }]),
    });
    inner.end();

    const prose = "这是应当在最终回答中再次展示的正文。";
    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [
        { role: "user", content: "请先写出正文，正文完成后展现给我，再调用一次 write 写入 CodeLife/novel.md。" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "novel.md", content: prose } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "我已经处理好了，请问还需要什么？" },
      { type: "text", text: `\n\n正文：\n${prose}` },
    ]);
    expect(result.content.some((block) => block?.type === "toolCall")).toBe(false);
  });

  it("does not re-display write content already shown earlier in the user turn", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial: message([]) });
    inner.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: "文件已写入。" }]),
    });
    inner.end();

    const prose = "这段正文已经展示过，工具完成后不应重复出现。";
    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [
        { role: "user", content: "请先写出正文并展现给我，再调用 write 写入 CodeLife/novel.md。" },
        { role: "assistant", content: [{ type: "text", text: prose }, { type: "toolCall", id: "call-1", name: "write", arguments: { path: "novel.md", content: prose } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "文件已写入。" }]);
  });

  it("removes write content repeated by a post-tool continuation", async () => {
    const inner = createAssistantMessageEventStream();
    const prose = "这段正文已经展示过，模型续写不应原样重复。";
    inner.push({ type: "start", partial: message([]) });
    inner.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: `已写入 poem.md。正文：\n${prose}` }]),
    });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [
        { role: "user", content: "请先写出正文并展现给我，再调用 write 写入 CodeLife/novel.md。" },
        { role: "assistant", content: [{ type: "text", text: prose }, { type: "toolCall", id: "call-1", name: "write", arguments: { path: "novel.md", content: prose } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "已写入 poem.md。" }]);
  });

  it("still allows several explicit XML writes in one resumed user turn", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = '<function name="write"><param name="path">chapter-2.md</param><param name="content">第二章</param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      messages: [
        { role: "user", content: "请连续写入 chapter-1.md 和 chapter-2.md 两个章节文件。" },
        { role: "assistant", content: [{ type: "toolCall", name: "write", id: "call-1", arguments: { path: "chapter-1.md", content: "第一章" } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "write", arguments: { path: "chapter-2.md", content: "第二章" } }),
    ]);
  });

  it("allows non-Markdown relative paths explicitly mentioned in a multi-step tool request", async () => {
    const xml = [
      '<function name="read"><param name="path">tools-input/a.txt</param></function>',
      '<function name="read"><param name="path">tools-input/b.txt</param></function>',
    ].join("");
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{
        role: "user",
        content: "1. read tools-input/a.txt\n2. read tools-input/b.txt\n3. write SUM=8 to tools-input/target.md\n4. read tools-input/target.md",
      }],
      tools: [
        { name: "read", parameters: Type.Object({ path: Type.String() }) },
        { name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
      ],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.filter(block => block?.type === "toolCall")).toHaveLength(2);
    expect(result.content).not.toContain("was not mentioned");
  });

  it("rejects a write path carried over from an older user turn", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = '<function name="write"><param name="path">CodeLife/old.md</param><param name="content">旧正文</param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{
        role: "user",
        content: "请先写出正文，正文完成后，展现给我，然后再调用一次 write，将完全相同的正文写入 CodeLife/current.md。",
      }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining("write path \"CodeLife/old.md\" was not mentioned"),
    }]);
  });

  it("rejects a read of an unmentioned file while allowing the current target", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="read"><param name="path">CodeLife/old.md</param></function>',
      '<function name="read"><param name="path">CodeLife/current.md</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{ role: "user", content: "请读取并处理 CodeLife/current.md。" }],
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "current.md" } }),
      { type: "text", text: expect.stringContaining('read path "CodeLife/old.md" was not mentioned') },
    ]));
    expect(JSON.stringify(result.content)).not.toContain('"path":"old.md"');
  });

  it("rejects every path tool when the current user turn names no file", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="read"><param name="path">novel.md</param></function>',
      '<function name="find"><param name="path">.</param></function>',
      '<function name="ls"><param name="path">.</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{ role: "user", content: "AUTO_START_OK" }],
      tools: [
        { name: "read", parameters: Type.Object({ path: Type.String() }) },
        { name: "find", parameters: Type.Object({ path: Type.String() }) },
        { name: "ls", parameters: Type.Object({ path: Type.String() }) },
      ],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content.filter((block) => block?.type === "toolCall")).toHaveLength(0);
    const text = result.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
    expect(text).toContain('read path "novel.md" was not mentioned');
    expect(text).toContain('find path "." was not mentioned');
    expect(text).toContain('ls path "." was not mentioned');
  });

  it("blocks shell and file-tool filesystem inspection without an explicit path", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="exec_command"><param name="cmd"><![CDATA[find . -maxdepth 2 -type f]]></param></function>',
      '<function name="file"><param name="action">stat</param><param name="path">novel.md</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      messages: [{ role: "user", content: "只回答这一句，不要访问文件。" }],
      tools: [
        { name: "exec_command", parameters: Type.Object({ cmd: Type.String() }) },
        { name: "file", parameters: Type.Object({ action: Type.Literal("stat"), path: Type.String() }) },
      ],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content.filter((block) => block?.type === "toolCall")).toHaveLength(0);
    const text = result.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
    expect(text).toContain("exec_command filesystem inspection was rejected");
    expect(text).toContain("file path");
  });

  it("allows a shell read only for a file explicitly named by the user", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = '<function name="exec_command"><param name="cmd"><![CDATA[cat CodeLife/current.md]]></param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{ role: "user", content: "请查看 CodeLife/current.md。" }],
      tools: [{ name: "exec_command", parameters: Type.Object({ cmd: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "exec_command", arguments: { cmd: "cat CodeLife/current.md" } }),
    ]);
  });

  it("shows write content when the user explicitly asks to see it and normalizes CodeLife paths", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = '<function name="write"><param name="path">CodeLife/current.md</param><param name="content">这是应当展示给用户的正文。</param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{
        role: "user",
        content: "请先写出正文，正文完成后，展现给我，然后再调用一次 write，将完全相同的正文写入 CodeLife/current.md。",
      }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: "这是应当展示给用户的正文。" },
      expect.objectContaining({ type: "toolCall", name: "write", arguments: { path: "current.md", content: "这是应当展示给用户的正文。" } }),
    ]);
  });

  it("shows the current write content even when an older path is rejected", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="write"><param name="path">CodeLife/old.md</param><param name="content">旧正文</param></function>',
      '<function name="write"><param name="path">CodeLife/current.md</param><param name="content">当前回合应展示的正文。</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{
        role: "user",
        content: "请先写出正文，正文完成后，展现给我，然后再调用一次 write，将完全相同的正文写入 CodeLife/current.md。",
      }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(expect.arrayContaining([
      { type: "text", text: "当前回合应展示的正文。" },
      expect.objectContaining({ type: "toolCall", name: "write", arguments: { path: "current.md", content: "当前回合应展示的正文。" } }),
    ]));
    expect(JSON.stringify(result.content)).toContain('CodeLife/old.md');
    expect(JSON.stringify(result.content)).not.toContain('"path":"old.md"');
  });

  it("guards an already parsed standard write tool call", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial: message([]) });
    inner.push({
      type: "done",
      reason: "stop",
      message: message([{
        type: "toolCall",
        id: "stale-write",
        name: "write",
        arguments: { path: "CodeLife/old.md", content: "旧正文" },
      }]),
    });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      systemPrompt: "## 工作区范围\n主工作台：/tmp/hanako-workspace",
      messages: [{ role: "user", content: "请写入 CodeLife/current.md。" }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining('write path "CodeLife/old.md" was not mentioned'),
    }]);
  });

  it("rejects explicitly forbidden tools on a resumed MiniCPM5 turn", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = '<function name="read"><param name="path">current.md</param></function>';
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      messages: [{ role: "user", content: "请写入 CodeLife/current.md，不要调用 read、ls、find。" }],
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining('tool "read" was explicitly forbidden'),
    }]);
  });

  it("rejects only an identical repeated write while allowing changed content", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="write"><param name="path">current.md</param><param name="content">第一版</param></function>',
      '<function name="write"><param name="path">current.md</param><param name="content">第二版</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      messages: [
        { role: "user", content: "请继续写入 CodeLife/current.md。" },
        { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "current.md", content: "第一版" } }] },
        { role: "toolResult", toolName: "write", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
      ],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "toolCall", name: "write", arguments: { path: "current.md", content: "第二版" } }),
      { type: "text", text: expect.stringContaining("repeated the same") },
    ]));
    expect(JSON.stringify(result.content)).not.toContain('"content":"第一版"');
  });

  it("rejects an identical write repeated inside one XML response", async () => {
    const inner = createAssistantMessageEventStream();
    const xml = [
      '<function name="write"><param name="path">current.md</param><param name="content">同一版</param></function>',
      '<function name="write"><param name="path">current.md</param><param name="content">同一版</param></function>',
    ].join("");
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: xml }]) });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      messages: [{ role: "user", content: "请写入 CodeLife/current.md。" }],
      tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.filter((block) => block?.type === "toolCall")).toHaveLength(1);
    expect(JSON.stringify(result.content)).toContain("repeated the same");
  });

  it("does not infer a write call for an ordinary response or a negated request", async () => {
    const makeStream = (userText: string) => {
      const inner = createAssistantMessageEventStream();
      inner.push({ type: "start", partial: message([]) });
      inner.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "普通回复" }]) });
      inner.end();
      return adaptMiniCPM5XmlToolCallStream(inner, model, {
        messages: [{ role: "user", content: userText }],
        tools: [{ name: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
      });
    };

    const ordinaryStream = makeStream("请解释一下这个文件的用途：CodeLife/novel.md");
    const negatedStream = makeStream("请先写出正文，但不要写入 CodeLife/novel.md。");
    const ordinary = await ordinaryStream.result();
    const negated = await negatedStream.result();
    expect(ordinary.stopReason).toBe("stop");
    expect(negated.stopReason).toBe("stop");
    expect(ordinary.content).toEqual([{ type: "text", text: "普通回复" }]);
    expect(negated.content).toEqual([{ type: "text", text: "普通回复" }]);
  });

  it("propagates an aborted terminal event without attempting a tool call", async () => {
    const inner = createAssistantMessageEventStream();
    const aborted = { ...message([{ type: "text", text: '<function name="read"><param name="path">README.md</param></function>' }]), stopReason: "aborted" as const, errorMessage: "aborted by user" };
    inner.push({ type: "start", partial: message([]) });
    inner.push({ type: "error", reason: "aborted", error: aborted });
    inner.end();

    const stream = adaptMiniCPM5XmlToolCallStream(inner, model, {
      tools: [{ name: "read", parameters: Type.Object({ path: Type.String() }) }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("aborted by user");
    expect(result.content).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(events.some(event => event.type === "toolcall_end")).toBe(false);
  });

  it("sanitizes protocol residue from persisted assistant context", () => {
    const context = sanitizeMiniCPM5Context({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "已完成。]]></param></function>" }] },
        { role: "user", content: "保留用户原文 <pokong-enode>" },
      ],
    });

    expect(context.messages[0].content[0].text).toBe("已完成。");
    expect(context.messages[1].content).toContain("<pokong-enode>");
  });
});
