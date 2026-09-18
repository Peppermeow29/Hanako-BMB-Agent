import { describe, it, expect, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { callText } from "../core/llm-client.ts";
import { readCurrentSessionBranch } from "../lib/session-jsonl.ts";

describe("SessionSummaryManager._buildConversationText", () => {
  function createManager() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-"));
    return {
      manager: new SessionSummaryManager(tmpDir),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("assistant 普通文本全文保留，不再按 300 字截断", () => {
    const { manager, cleanup } = createManager();
    try {
      const longText = "甲".repeat(360);
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [{ type: "text", text: longText }],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain(`【助手】${longText}`);
      expect(text).not.toContain("长回复已截断");
    } finally {
      cleanup();
    }
  });

  it("assistant 的工具调用只保留简短标题", () => {
    const { manager, cleanup } = createManager();
    try {
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先看看实现。" },
            { type: "tool_use", name: "read", input: { file_path: "/tmp/demo.js" } },
            { type: "tool_use", name: "web_search", input: { query: "notifyTurn" } },
          ],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain("【助手】我先看看实现。");
      expect(text).toContain("【助手】读取了 /tmp/demo.js");
      expect(text).toContain("【助手】搜索了 notifyTurn");
      expect(text).not.toContain("tool_use");
    } finally {
      cleanup();
    }
  });

  it("uses full local dates in timeline text so cross-day sessions keep ownership", () => {
    const { manager, cleanup } = createManager();
    try {
      const text = manager._buildConversationText([
        {
          role: "user",
          content: "今晚先看记忆。",
          timestamp: "2026-05-16T15:50:00.000Z",
        },
        {
          role: "assistant",
          content: "继续处理。",
          timestamp: "2026-05-16T16:10:00.000Z",
        },
      ], { timeZone: "Asia/Shanghai" });

      expect(text).toContain("[2026-05-16 23:50] 【用户】今晚先看记忆。");
      expect(text).toContain("[2026-05-17 00:10] 【助手】继续处理。");
    } finally {
      cleanup();
    }
  });
});

describe("SessionSummaryManager invalidation", () => {
  it("removes one session's persisted summary and cache entry without touching others", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-invalidate-"));
    const manager = new SessionSummaryManager(tmpDir);
    try {
      manager.saveSummary("sess-a", { session_id: "sess-a", summary: "old branch" });
      manager.saveSummary("sess-b", { session_id: "sess-b", summary: "keep" });

      expect(manager.invalidateSession("sess-a")).toBe(true);
      expect(manager.getSummary("sess-a")).toBeNull();
      expect(manager.getSummary("sess-b")?.summary).toBe("keep");
      expect(manager.invalidateSession("sess-a")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps fork provenance but resets the child's independent summary cursor", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-fork-reset-"));
    const manager = new SessionSummaryManager(tmpDir);
    try {
      manager.initializeForkBaseline("sess-child", {
        sourceSessionId: "sess-source",
        throughEntryId: "entry-5",
        messageCount: 5,
        forkedAt: "2026-07-19T00:00:00.000Z",
      });
      manager.saveSummary("sess-child", {
        ...manager.getSummary("sess-child"),
        summary: "child-only memory",
        messageCount: 9,
        snapshot: "child-only memory",
      });

      expect(manager.invalidateSession("sess-child", { retainedMessageCount: 7 })).toBe(true);
      expect(manager.getSummary("sess-child")).toMatchObject({
        summary: "",
        snapshot: "",
        messageCount: 0,
        fork_baseline: {
          sourceSessionId: "sess-source",
          throughEntryId: "entry-5",
          retainedMessageCount: 5,
        },
      });
      expect(manager.invalidateSession("sess-child", { retainedMessageCount: 3 })).toBe(true);
      expect(manager.getSummary("sess-child")?.messageCount).toBe(0);
      expect(manager.getSummary("sess-child")?.fork_baseline.retainedMessageCount).toBe(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SessionSummaryManager fork baseline", () => {
  it("builds an independent child summary once, then only sends divergent messages", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-fork-"));
    const manager = new SessionSummaryManager(tmpDir);
    const inherited = [
      { role: "user", content: "inherited question", timestamp: "2026-07-18T23:00:00.000Z" },
      { role: "assistant", content: "inherited answer", timestamp: "2026-07-18T23:01:00.000Z" },
    ];
    try {
      (callText as any).mockClear();
      (callText as any).mockResolvedValueOnce(
        "### 重要事实\n- 子会话继承了问题。\n\n### 事情经过\n- [2026-07-19 07:00] 用户提出继承问题。",
      );
      manager.initializeForkBaseline("sess-child", {
        sourceSessionId: "sess-source",
        throughEntryId: "entry-a1",
        messageCount: inherited.length,
        forkedAt: "2026-07-19T00:00:00.000Z",
      });

      await manager.rollingSummary(
        "sess-child",
        inherited,
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );
      expect(callText).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((callText as any).mock.calls[0][0].messages)).toContain("inherited question");

      (callText as any).mockResolvedValueOnce("### 重要事实\n- 无\n\n### 事情经过\n- [2026-07-19 08:02] 用户开始了新分支。");
      await manager.rollingSummary(
        "sess-child",
        [...inherited, { role: "user", content: "new branch", timestamp: "2026-07-19T00:02:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );

      expect(callText).toHaveBeenCalledTimes(2);
      const promptText = JSON.stringify((callText as any).mock.calls[1][0].messages);
      expect(promptText).toContain("new branch");
      expect(promptText).not.toContain("inherited question");
      expect(manager.getSummary("sess-child")?.fork_baseline).toMatchObject({
        sourceSessionId: "sess-source",
        retainedMessageCount: inherited.length,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not skip post-reset messages when the retained source count is larger", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-fork-reset-domain-"));
    const manager = new SessionSummaryManager(tmpDir);
    try {
      (callText as any).mockClear();
      (callText as any).mockResolvedValueOnce(
        "### 重要事实\n- 子会话有独立记忆。\n\n### 事情经过\n- [2026-07-19 08:02] 用户继续了新分支。",
      );
      manager.initializeForkBaseline("sess-child", {
        sourceSessionId: "sess-source",
        throughEntryId: "entry-100",
        messageCount: 100,
        forkedAt: "2026-07-19T00:00:00.000Z",
      });

      await manager.rollingSummary(
        "sess-child",
        [{ role: "user", content: "post-reset child message", timestamp: "2026-07-19T00:02:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );

      expect(callText).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((callText as any).mock.calls[0][0].messages)).toContain("post-reset child message");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the child's independently derived summary when the source is later invalidated", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-fork-lineage-"));
    const manager = new SessionSummaryManager(tmpDir);
    try {
      manager.saveSummary("sess-source", {
        session_id: "sess-source",
        summary: "source summary",
        messageCount: 2,
        created_at: "2026-07-18T23:00:00.000Z",
        updated_at: "2026-07-18T23:01:00.000Z",
      });
      manager.initializeForkBaseline("sess-child", {
        sourceSessionId: "sess-source",
        throughEntryId: "entry-a1",
        messageCount: 2,
        forkedAt: "2026-07-19T00:00:00.000Z",
      });
      (callText as any).mockClear();
      (callText as any).mockResolvedValueOnce(
        "### 重要事实\n- 子会话保留了独立上下文。\n\n### 事情经过\n- [2026-07-19 08:01] 子会话继续工作。",
      );
      await manager.rollingSummary(
        "sess-child",
        [
          { role: "user", content: "inherited", timestamp: "2026-07-18T23:00:00.000Z" },
          { role: "assistant", content: "child context", timestamp: "2026-07-18T23:01:00.000Z" },
        ],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );
      const childBefore = structuredClone(manager.getSummary("sess-child"));

      expect(manager.invalidateSession("sess-source")).toBe(true);

      expect(manager.getSummary("sess-source")).toBeNull();
      expect(manager.getSummary("sess-child")).toEqual(childBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SessionSummaryManager.rollingSummary prompt contract", () => {
  function createManager() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-"));
    return {
      manager: new SessionSummaryManager(tmpDir),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("asks the model to emit summary fields as third-level headings", async () => {
    (callText as any).mockResolvedValueOnce("### 重要事实\n无\n\n### 事情经过\n[10:00] 用户在讨论记忆系统。");
    const { manager, cleanup } = createManager();
    try {
      await manager.rollingSummary(
        "s1",
        [{ role: "user", content: "我们看一下记忆 rolling。", timestamp: "2026-04-15T10:00:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
      );

      const prompt = (callText as any).mock.calls[0][0].systemPrompt;
      expect(prompt).toContain("### 重要事实");
      expect(prompt).toContain("### 事情经过");
      expect(prompt).toContain("第一行必须是 `### 重要事实`");
      expect(prompt).toContain("两个标题下的正文都必须使用无序列表");
      expect(prompt).toContain("列表项必须以 `- ` 开头");
      expect(prompt).not.toContain("第一行必须是 `## 重要事实`");
      // “以 facts 标题开头、不要前言后记”只允许在共享格式块出现一次，
      // 规则列表不得再硬编码标题字面量复述（#1628 审查 issue 1）
      expect(prompt).not.toContain("直接以 ### 重要事实 开头输出");
      const formatSection = prompt.slice(
        prompt.indexOf("## 输出格式"),
        prompt.indexOf("## 内容要求"),
      );
      expect(formatSection).not.toContain("只记录用户画像类信息");
      expect(formatSection).not.toContain("按时间顺序记录本 session 发生了什么");
    } finally {
      cleanup();
    }
  });

  it("frames rolling summary as the agent reviewing its own existing memory snapshot", async () => {
    (callText as any).mockResolvedValueOnce("### 重要事实\n- 无\n\n### 事情经过\n- [2026-04-15 10:00] 用户在讨论记忆系统。");
    const { manager, cleanup } = createManager();
    try {
      await manager.rollingSummary(
        "s1",
        [{ role: "user", content: "我们看一下记忆 rolling。", timestamp: "2026-04-15T10:00:00.000Z" }],
        { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" },
        {
          memoryReflectionSnapshot: {
            version: 1,
            locale: "zh-CN",
            agentName: "Hana",
            userName: "测试用户",
            identityAndPersonality: "我是 Hana，偏文学但工程严谨。",
            userProfile: "用户叫测试用户。",
            existingMemory: "用户长期关注 Project Hana 的记忆系统。",
            roster: "同处于这个系统里的别的 Agent：Butter、Ming。",
          },
        },
      );

      const request = (callText as any).mock.calls.at(-1)[0];
      expect(request.systemPrompt).toContain("你是 Hana");
      expect(request.systemPrompt).toContain("你正在整理自己刚刚经历的一段对话");
      expect(request.systemPrompt).toContain("## 你的身份与人格");
      expect(request.systemPrompt).toContain("我是 Hana，偏文学但工程严谨。");
      expect(request.systemPrompt).toContain("## 主人设定");
      expect(request.systemPrompt).toContain("用户叫测试用户。");
      expect(request.systemPrompt).toContain("## 你已有的长期记忆");
      expect(request.systemPrompt).toContain("这是你在本次对话开始前已经拥有的记忆");
      expect(request.systemPrompt).toContain("不要因为它出现在这里就重复写入");
      expect(request.systemPrompt).toContain("## 花名册");
      expect(request.systemPrompt).toContain("同处于这个系统里的别的 Agent");
      expect(request.messages[0].content).toContain("## 新增对话");
      expect(request.messages[0].content).toContain("## 本次摘要预算");
    } finally {
      cleanup();
    }
  });
});

describe("SessionSummaryManager branch cursor", () => {
  const MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };
  const VALID_SUMMARY = "### 重要事实\n- 无\n\n### 事情经过\n- [2026-07-16 16:00] 用户讨论记忆系统。";

  function createHarness(entries: any[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-summary-branch-"));
    const sessionPath = path.join(root, "tree.jsonl");
    const header = { type: "session", version: 3, id: "tree", timestamp: "2026-07-16T08:00:00.000Z", cwd: root };
    fs.writeFileSync(sessionPath, [header, ...entries].map((item) => JSON.stringify(item)).join("\n") + "\n");
    return {
      root,
      sessionPath,
      manager: new SessionSummaryManager(path.join(root, "summaries")),
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  function msg(id: string, parentId: string | null, role: "user" | "assistant", content: string, second: number) {
    return {
      type: "message",
      id,
      parentId,
      timestamp: `2026-07-16T08:00:${String(second).padStart(2, "0")}.000Z`,
      message: { role, content },
    };
  }

  it("rebuilds a legacy messageCount summary once without feeding it back as previous summary", async () => {
    const harness = createHarness([
      msg("u1", null, "user", "完整新分支问题", 1),
      msg("a1", "u1", "assistant", "完整新分支回答", 2),
    ]);
    try {
      harness.manager.saveSummary("s1", {
        session_id: "s1",
        created_at: "2026-07-16T07:00:00.000Z",
        updated_at: "2026-07-16T07:00:00.000Z",
        summary: "旧版摘要不得进入 replacement prompt",
        messageCount: 2,
        snapshot: "旧版摘要不得进入 replacement prompt",
      });
      const projection = readCurrentSessionBranch(harness.sessionPath);
      (callText as any).mockResolvedValueOnce(VALID_SUMMARY);

      const draft = await harness.manager.createRollingSummaryDraft("s1", projection.messages, MODEL, { projection });
      const requestText = (callText as any).mock.calls.at(-1)[0].messages[0].content;

      expect(draft.mode).toBe("replace");
      expect(draft.data.factReplacementRequired).toBe(true);
      expect(requestText).toContain("完整新分支问题");
      expect(requestText).toContain("完整新分支回答");
      expect(requestText).not.toContain("旧版摘要不得进入 replacement prompt");
      expect(draft.data.cursor).toEqual({
        coveredLeafId: projection.selectedLeafId,
        lineageHash: projection.lineageHash,
      });
    } finally {
      harness.cleanup();
    }
  });

  it("uses only the delta for a verified ancestor append", async () => {
    const harness = createHarness([
      msg("u1", null, "user", "already summarized user", 1),
      msg("a1", "u1", "assistant", "already summarized assistant", 2),
      msg("u2", "a1", "user", "new delta user", 3),
      msg("a2", "u2", "assistant", "new delta assistant", 4),
    ]);
    try {
      const prefix = readCurrentSessionBranch(harness.sessionPath, {
        branchHead: {
          sessionId: "s1",
          leafId: "a1",
          observedTailLeafId: "a2",
          revision: 1,
          reason: "explicit_test",
        },
      });
      const current = readCurrentSessionBranch(harness.sessionPath);
      harness.manager.saveSummary("s1", {
        session_id: "s1",
        created_at: "2026-07-16T07:00:00.000Z",
        updated_at: "2026-07-16T07:00:00.000Z",
        summary: "verified previous summary",
        messageCount: 2,
        cursor: { coveredLeafId: prefix.selectedLeafId, lineageHash: prefix.lineageHash },
        snapshot: "verified previous summary",
      });
      (callText as any).mockResolvedValueOnce(VALID_SUMMARY);

      const draft = await harness.manager.createRollingSummaryDraft("s1", current.messages, MODEL, { projection: current });
      const requestText = (callText as any).mock.calls.at(-1)[0].messages[0].content;

      expect(draft.mode).toBe("append");
      expect(requestText).toContain("verified previous summary");
      expect(requestText).toContain("new delta user");
      expect(requestText).toContain("new delta assistant");
      expect(requestText).not.toContain("already summarized user");
      expect(draft.data.factReplacementRequired).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("treats an explicit root cursor as the ancestor of the first append", async () => {
    const harness = createHarness([msg("u1", null, "user", "first message", 1)]);
    try {
      const root = readCurrentSessionBranch(harness.sessionPath, {
        branchHead: { sessionId: "s1", leafId: null, observedTailLeafId: "u1", revision: 1, reason: "root" },
      });
      const current = readCurrentSessionBranch(harness.sessionPath);
      harness.manager.saveSummary("s1", {
        session_id: "s1",
        created_at: "2026-07-16T07:00:00.000Z",
        updated_at: "2026-07-16T07:00:00.000Z",
        summary: "",
        cursor: { coveredLeafId: null, lineageHash: root.lineageHash },
        snapshot: "",
      });
      (callText as any).mockResolvedValueOnce(VALID_SUMMARY);

      const draft = await harness.manager.createRollingSummaryDraft("s1", current.messages, MODEL, { projection: current });

      expect(draft.mode).toBe("append");
      expect(draft.data.factReplacementRequired).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("fully rebuilds a same-message-count sibling branch", async () => {
    const harness = createHarness([
      msg("u1", null, "user", "root", 1),
      msg("a-old", "u1", "assistant", "discarded sibling", 2),
      msg("a-new", "u1", "assistant", "current sibling", 3),
    ]);
    try {
      const oldBranch = readCurrentSessionBranch(harness.sessionPath, {
        branchHead: { sessionId: "s1", leafId: "a-old", observedTailLeafId: "a-new", revision: 1, reason: "test" },
      });
      const newBranch = readCurrentSessionBranch(harness.sessionPath);
      harness.manager.saveSummary("s1", {
        session_id: "s1",
        created_at: "2026-07-16T07:00:00.000Z",
        updated_at: "2026-07-16T07:00:00.000Z",
        summary: "discarded summary must not be merged",
        messageCount: oldBranch.messages.length,
        cursor: { coveredLeafId: oldBranch.selectedLeafId, lineageHash: oldBranch.lineageHash },
        snapshot: "discarded summary must not be merged",
      });
      expect(newBranch.messages).toHaveLength(oldBranch.messages.length);
      (callText as any).mockResolvedValueOnce(VALID_SUMMARY);

      const draft = await harness.manager.createRollingSummaryDraft("s1", newBranch.messages, MODEL, { projection: newBranch });
      const requestText = (callText as any).mock.calls.at(-1)[0].messages[0].content;

      expect(draft.mode).toBe("replace");
      expect(requestText).toContain("current sibling");
      expect(requestText).not.toContain("discarded sibling");
      expect(requestText).not.toContain("discarded summary must not be merged");
    } finally {
      harness.cleanup();
    }
  });

  it("discards an LLM draft when revalidation observes a sibling switch", async () => {
    const harness = createHarness([
      msg("u1", null, "user", "root", 1),
      msg("a-old", "u1", "assistant", "old", 2),
      msg("a-new", "u1", "assistant", "new", 3),
    ]);
    try {
      const oldBranch = readCurrentSessionBranch(harness.sessionPath, {
        branchHead: { sessionId: "s1", leafId: "a-old", observedTailLeafId: "a-new", revision: 1, reason: "test" },
      });
      const newBranch = readCurrentSessionBranch(harness.sessionPath);
      (callText as any).mockResolvedValueOnce(VALID_SUMMARY);

      const draft = await harness.manager.createRollingSummaryDraft("s1", oldBranch.messages, MODEL, {
        projection: oldBranch,
        revalidateProjection: () => newBranch,
      });

      expect(draft).toMatchObject({ changed: false, data: null, reason: "branch_changed" });
    } finally {
      harness.cleanup();
    }
  });

  it("persists an empty replacement tombstone so old facts can be cleared", async () => {
    const harness = createHarness([msg("u-old", null, "user", "discarded", 1)]);
    try {
      const oldBranch = readCurrentSessionBranch(harness.sessionPath);
      harness.manager.saveSummary("s1", {
        session_id: "s1",
        created_at: "2026-07-16T07:00:00.000Z",
        updated_at: "2026-07-16T07:00:00.000Z",
        summary: "old summary",
        cursor: { coveredLeafId: oldBranch.selectedLeafId, lineageHash: oldBranch.lineageHash },
        snapshot: "old summary",
      });
      const root = readCurrentSessionBranch(harness.sessionPath, {
        branchHead: { sessionId: "s1", leafId: null, observedTailLeafId: "u-old", revision: 2, reason: "reset" },
      });
      const callsBefore = (callText as any).mock.calls.length;

      const draft = await harness.manager.createRollingSummaryDraft("s1", root.messages, MODEL, { projection: root });

      expect(draft.mode).toBe("replace");
      expect(draft.data).toMatchObject({
        session_id: "s1",
        summary: "",
        factReplacementRequired: true,
        cursor: { coveredLeafId: null, lineageHash: root.lineageHash },
      });
      expect((callText as any).mock.calls).toHaveLength(callsBefore);
    } finally {
      harness.cleanup();
    }
  });
});
