import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../lib/memory/fact-store.ts";
import { createMemorySearchTool } from "../lib/memory/memory-search.ts";
import { applyConversationScopedMemorySearch } from "../lib/conversations/agent-phone-session.ts";

describe("search_memory 频道作用域（#1670 群聊记忆混淆）", () => {
  let tmpDir;
  let factStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-scope-"));
    factStore = new FactStore(path.join(tmpDir, "facts.db"));
    factStore.add({
      fact: "用户喜欢吃披萨配菠萝",
      tags: ["食物偏好"],
      time: "2026-06-01T12:00",
      session_id: null,
    });
    factStore.add({
      fact: "[#alpha] 频道决定每周五吃披萨聚餐",
      tags: ["频道", "alpha"],
      time: "2026-06-02T12:00",
      session_id: "channel-alpha",
    });
    factStore.add({
      fact: "[#beta] 频道里有人说讨厌披萨",
      tags: ["频道", "beta"],
      time: "2026-06-03T12:00",
      session_id: "channel-beta",
    });
  });

  afterEach(() => {
    factStore?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runSearch(tool, params) {
    const result = await tool.execute("tool-call-1", params);
    return result.content?.[0]?.text || "";
  }

  it("未注入作用域的实例行为不变：能看到所有频道的事实，schema 不暴露 cross_channel", async () => {
    const tool = createMemorySearchTool(factStore);

    const text = await runSearch(tool, { query: "披萨" });

    expect(text).toContain("菠萝");
    expect(text).toContain("[#alpha]");
    expect(text).toContain("[#beta]");
    expect(JSON.stringify(tool.parameters)).not.toContain("cross_channel");
  });

  it("频道作用域实例默认排除其它频道的事实，保留通用事实和当前频道事实", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "披萨" });

    expect(text).toContain("菠萝");
    expect(text).toContain("[#alpha]");
    expect(text).not.toContain("[#beta]");
  });

  it("显式 cross_channel: true 时允许跨频道检索", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "披萨", cross_channel: true });

    expect(text).toContain("[#alpha]");
    expect(text).toContain("[#beta]");
    expect(JSON.stringify(tool.parameters)).toContain("cross_channel");
  });

  it("标签检索同样受作用域约束", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "", tags: ["频道"] });

    expect(text).toContain("[#alpha]");
    expect(text).not.toContain("[#beta]");
  });

  it("applyConversationScopedMemorySearch 只做同名替换，不凭空注入", () => {
    const scoped = { name: "search_memory", scoped: true };
    const other = { name: "channel_reply" };
    const withMemory = [{ name: "search_memory" }, other];
    const withoutMemory = [other];

    expect(applyConversationScopedMemorySearch(withMemory, scoped)).toEqual([scoped, other]);
    expect(applyConversationScopedMemorySearch(withoutMemory, scoped)).toEqual([other]);
    expect(applyConversationScopedMemorySearch(withMemory, null)).toEqual(withMemory);
  });
});
