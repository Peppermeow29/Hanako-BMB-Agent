import { describe, expect, it } from "vitest";
import {
  assertSessionSnapshotRequest,
  buildSessionCacheSnapshot,
  buildSessionSnapshotRequestContract,
} from "../core/session-cache-snapshot.ts";

function tool(name, description = "desc") {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute: () => {},
  };
}

const model = {
  id: "glm-4.5",
  provider: "zhipu",
  api: "openai-completions",
  baseUrl: "https://open.bigmodel.cn",
};

describe("session cache snapshot", () => {
  it("captures model, cache params, system, active tools, and media-capable message prefix", () => {
    const runtimeModel = {
      ...model,
      quirks: ["enable_thinking"],
      cost: { input: 1, output: 2 },
    };
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model: runtimeModel,
      cacheKeyParams: { thinkingLevel: "high", toolChoice: "auto" },
      systemPrompt: "stable system",
      tools: [tool("read"), tool("exec_command")],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "input_audio", audio_url: "file://voice.wav" },
          ],
          timestamp: 1,
        },
      ],
      reason: "compaction",
    });

    expect(snapshot).toMatchObject({
      version: 1,
      strategy: "session_snapshot",
      sessionPath: "/sessions/a.jsonl",
      reason: "compaction",
      model,
      cacheKeyParams: { thinkingLevel: "high", toolChoice: "auto" },
      toolNames: ["read", "exec_command"],
      strict: true,
    });
    expect(snapshot.requestModel).toEqual(runtimeModel);
    expect(snapshot.model).not.toHaveProperty("quirks");
    expect(snapshot.model).not.toHaveProperty("cost");
    expect(snapshot.cachePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.messagePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.messages[0].content[1]).toEqual({ type: "input_audio", audio_url: "file://voice.wav" });
  });

  it("canonicalizes legacy auto thinking params before hashing snapshots", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "auto", reasoning: "auto", toolChoice: "auto" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "compaction",
    });

    expect(snapshot.cacheKeyParams).toEqual({
      reasoning: "medium",
      thinkingLevel: "medium",
      toolChoice: "auto",
    });

    const requestContract = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "auto", reasoning: "auto", toolChoice: "auto" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      prefixMessageCount: 1,
    });

    expect(requestContract.cacheKeyParams).toEqual(snapshot.cacheKeyParams);
    expect(assertSessionSnapshotRequest(snapshot, requestContract)).toMatchObject({
      ok: true,
      strict: true,
      diffs: [],
    });
  });

  it("keeps Session identity separate while reusing an identical provider-visible prefix", () => {
    const common = {
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [
        { role: "user", content: "shared question" },
        { role: "assistant", content: "shared answer" },
      ],
      reason: "session_fork",
      createdAt: "2026-07-19T00:00:00.000Z",
    };
    const source = buildSessionCacheSnapshot({
      ...common,
      sessionPath: "/sessions/source.jsonl",
    });
    const child = buildSessionCacheSnapshot({
      ...common,
      sessionPath: "/sessions/child.jsonl",
    });

    expect(child.sessionPath).not.toBe(source.sessionPath);
    expect(child.cachePrefixHash).toBe(source.cachePrefixHash);
    expect(child.messagePrefixHash).toBe(source.messagePrefixHash);
  });

  it("tracks reasoning replay mode as part of the cache contract", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "clear" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "compaction",
    });

    expect(snapshot.cacheKeyParams).toEqual({
      thinkingLevel: "high",
      reasoningReplay: "clear",
    });

    const changedReplay = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "high", reasoningReplay: "preserve" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }, { role: "user", content: "suffix" }],
      prefixMessageCount: 1,
    });

    expect(assertSessionSnapshotRequest(snapshot, changedReplay).diffs.map((d) => d.field)).toContain("cacheKeyParamsHash");
  });

  it("accepts a side request that appends only an internal suffix", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "memory_reflection",
    });
    const requestContract = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: [{ type: "text", text: "internal task" }] },
      ],
      prefixMessageCount: 1,
    });

    expect(assertSessionSnapshotRequest(snapshot, requestContract)).toMatchObject({
      ok: true,
      strict: true,
      diffs: [],
    });
  });

  it("allows end-of-turn media canonicalization by snapshotting the current provider-visible prefix", () => {
    const nativeMediaSnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "input_audio", audio_url: "data:audio/wav;base64,AAAA" },
        ],
      }],
      reason: "chat.turn",
    });
    const canonicalHistorySnapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "text", text: "[attached_audio: sf_audio_1]" },
        ],
      }],
      reason: "memory.reflection",
    });

    expect(canonicalHistorySnapshot.cachePrefixHash).not.toBe(nativeMediaSnapshot.cachePrefixHash);

    const requestContract = buildSessionSnapshotRequestContract({
      snapshot: canonicalHistorySnapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [
        ...canonicalHistorySnapshot.messages,
        { role: "user", content: "internal suffix" },
      ],
      prefixMessageCount: canonicalHistorySnapshot.messageCount,
    });
    expect(assertSessionSnapshotRequest(canonicalHistorySnapshot, requestContract)).toMatchObject({
      ok: true,
      strict: true,
      diffs: [],
    });
  });

  it("rejects missing tools, changed effort, and changed prefix messages", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "compaction",
    });

    const missingTool = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [],
      messages: [{ role: "user", content: "first" }, { role: "user", content: "suffix" }],
      prefixMessageCount: 1,
    });
    expect(assertSessionSnapshotRequest(snapshot, missingTool).diffs.map((d) => d.field)).toContain("toolSchemaHash");

    const changedEffort = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }, { role: "user", content: "suffix" }],
      prefixMessageCount: 1,
    });
    expect(assertSessionSnapshotRequest(snapshot, changedEffort).diffs.map((d) => d.field)).toContain("cacheKeyParamsHash");

    const changedPrefix = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system",
      tools: [tool("read")],
      messages: [{ role: "user", content: "changed" }, { role: "user", content: "suffix" }],
      prefixMessageCount: 1,
    });
    expect(assertSessionSnapshotRequest(snapshot, changedPrefix).diffs.map((d) => d.field)).toContain("messagePrefixHash");
  });
});
