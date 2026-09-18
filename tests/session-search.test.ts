import { describe, expect, it } from "vitest";

import { searchSessions } from "../lib/search/session-search.ts";

const baseSession = {
  firstMessage: "",
  modified: new Date("2026-05-22T12:00:00.000Z"),
  messageCount: 3,
  cwd: "/tmp/project-hana",
  agentId: "hana",
  agentName: "Hana",
};

describe("session search", () => {
  it("searches titles independently from content so title matches can be shown first", () => {
    const sessions = [
      {
        ...baseSession,
        path: "/tmp/agents/hana/sessions/title.jsonl",
        title: "聊天记录搜索方案",
        allMessagesText: "只在正文里提到别的事情。",
      },
      {
        ...baseSession,
        path: "/tmp/agents/hana/sessions/body.jsonl",
        title: "无关主题",
        allMessagesText: "这里讨论了聊天记录搜索。",
      },
    ];

    expect(searchSessions(sessions, "聊天记录", { phase: "title" }).map(r => r.path))
      .toEqual(["/tmp/agents/hana/sessions/title.jsonl"]);
    expect(searchSessions(sessions, "聊天记录", { phase: "content" }).map(r => r.path))
      .toEqual(["/tmp/agents/hana/sessions/body.jsonl"]);
  });

  it("finds Chinese content through jieba tokens when the raw query is longer than the stored phrase", () => {
    const sessions = [
      {
        ...baseSession,
        path: "/tmp/agents/hana/sessions/a2a.jsonl",
        title: "Round 4",
        allMessagesText: "昨天搞了一天的A2A通信，后来又排查 Friday endpoint。",
      },
    ];

    const results = searchSessions(sessions, "A2A通信记录", { phase: "content" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: "/tmp/agents/hana/sessions/a2a.jsonl",
      matchKind: "content",
    });
    expect(results[0].snippet).toContain("A2A通信");
    expect(results[0]).not.toHaveProperty("allMessagesText");
  });

  it("does not match long multi-token Chinese queries on a single generic token", () => {
    const sessions = [
      {
        ...baseSession,
        path: "/tmp/agents/hana/sessions/generic-record.jsonl",
        title: "会议记录",
        allMessagesText: "这里是普通会议记录，没有讨论通信协议。",
      },
      {
        ...baseSession,
        path: "/tmp/agents/hana/sessions/a2a.jsonl",
        title: "Round 4",
        allMessagesText: "昨天搞了一天的A2A通信。",
      },
    ];

    expect(searchSessions(sessions, "A2A通信记录", { phase: "content" }).map(r => r.path))
      .toEqual(["/tmp/agents/hana/sessions/a2a.jsonl"]);
  });
});
