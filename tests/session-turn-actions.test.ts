import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import {
  collectStructuredBackgroundTaskIds,
  normalizeSessionNodeTarget,
  replayLatestUserTurn,
  resolveSessionNodeTarget,
  retrySessionTurn,
} from "../core/session-turn-actions.ts";
import {
  AGENT_REVIEW_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  MESSAGE_PRESENTATION_RECORD_TYPE,
} from "../core/desktop-session-submit.ts";

function makeNavigableSession(manager) {
  return {
    sessionManager: manager,
    navigateTree: vi.fn(async (entryId) => {
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    }),
  };
}

describe("replayLatestUserTurn", () => {
  it("branches before the latest user message and replays the original prompt", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "try again" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      clientMessageId: "client-user",
      displayMessage: { text: "try again" },
    }, { submit });

    expect(session.navigateTree).not.toHaveBeenCalled();
    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(manager.getBranch().at(-1)).toMatchObject({ customType: "hana-session-branch-reset" });
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "session_branch_reset",
      messageId: latestUserId,
      projectionMessageId: latestUserId,
      clientMessageId: "client-user",
      todos: [],
      sessionFiles: [],
      discardedTaskIds: [],
    }, "/tmp/main.jsonl");
    expect(engine.setSessionBranchHead).toHaveBeenCalledWith("/tmp/main.jsonl", {
      leafId: priorAssistantId,
      reason: "replay_rewind",
    });
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      sessionPath: "/tmp/main.jsonl",
      text: "try again",
      displayMessage: expect.objectContaining({ text: "try again" }),
    }));
  });

  it("replaces only the visible text when editing and preserves attachment markers", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new text",
      displayMessage: { text: "new text" },
    }, { submit, readFile });

    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nnew text",
      images: [{ type: "image", data: Buffer.from("png-by-filename").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
      displayMessage: expect.objectContaining({ text: "new text" }),
    }));
  });

  it("preserves a leading reference listing when editing the visible text", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const envelope = [
      "[hana_reference]",
      "yuque (4 tools)",
      "[/hana_reference]",
      "",
      "[hana_reminder]",
      "- New memory facts recorded: the user prefers dark mode",
      "[/hana_reminder]",
      "",
      "[attached_image: /tmp/a.png]",
    ].join("\n");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `${envelope}\nold text` }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new text",
      displayMessage: { text: "new text" },
    }, { submit, readFile });

    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: `${envelope}\nnew text`,
    }));
  });

  it("branches before the latest user when editing a leaf user message", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "context" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "context answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old leaf text" }] } as any);
    const session = makeNavigableSession(manager);
    session.navigateTree = vi.fn(async (entryId) => {
      if (entryId === manager.getLeafId?.()) return { cancelled: false };
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    });
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new leaf text",
      displayMessage: { text: "new leaf text" },
    }, { submit });

    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "new leaf text",
      displayMessage: expect.objectContaining({ text: "new leaf text" }),
    }));
  });

  it("rehydrates pruned attached image markers when replaying a turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).toHaveBeenCalledWith("/tmp/a.png");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: [{ type: "image", data: Buffer.from("png-by-filename").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("keeps existing inline image payloads on replay without rereading the path", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "[attached_image: /tmp/a.png]\nold text" },
        { type: "image", data: "BASE64_A", mimeType: "image/png" },
      ],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: [{ type: "image", data: "BASE64_A", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("rejects a stale source entry instead of replaying the wrong turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const staleUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }] } as any);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "latest" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: staleUserId,
    }, { submit })).rejects.toThrow("latest user message");

    expect(submit).not.toHaveBeenCalled();
  });

  it("rolls the in-memory branch back and aborts replay when head persistence fails", async () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: "context" } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: "retry" } as any);
    const oldLeafId = manager.appendMessage({ role: "assistant", content: "bad answer" } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(() => {
        throw new Error("manifest disk full");
      }),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
    }, { submit })).rejects.toThrow("manifest disk full");

    expect(manager.getLeafId()).toBe(oldLeafId);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      beforeInputSideEffects: expect.any(Function),
    }));
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });
});

describe("session node target resolution", () => {
  it("normalizes persisted node identities and rejects ambiguous targets", () => {
    expect(normalizeSessionNodeTarget({ role: "user", entryId: " user-1 " })).toEqual({
      role: "user",
      entryId: "user-1",
    });
    expect(normalizeSessionNodeTarget({ role: "assistant_turn", precedingUserEntryId: " user-1 " })).toEqual({
      role: "assistant_turn",
      turnInputEntryId: "user-1",
    });
    expect(normalizeSessionNodeTarget({ role: "assistant_turn", turnInputEntryId: " custom-1 " })).toEqual({
      role: "assistant_turn",
      turnInputEntryId: "custom-1",
    });
    expect(() => normalizeSessionNodeTarget({ role: "assistant" })).toThrow("entryId");
    expect(() => normalizeSessionNodeTarget({ role: "tool", entryId: "tool-1" })).toThrow("role");
  });

  it("maps an assistant node to its user turn and uses the complete turn end as the fork boundary", () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "first" } as any);
    const toolCallAssistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
    } as any);
    manager.appendMessage({ role: "toolResult", toolCallId: "tc-1", content: [] } as any);
    const finalAssistantId = manager.appendMessage({ role: "assistant", content: "done" } as any);
    const nextEnvelopeId = manager.appendCustomEntry(MESSAGE_PRESENTATION_RECORD_TYPE, { displayText: "second" });
    manager.appendMessage({ role: "user", content: "second" } as any);
    manager.appendMessage({ role: "assistant", content: "second answer" } as any);

    const resolved = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant", entryId: toolCallAssistantId },
      { mode: "fork" },
    );

    expect(resolved.selectedUser).toBeNull();
    expect(resolved.precedingUser?.id).toBe(userId);
    expect(resolved.userEntry.id).toBe(userId);
    expect(resolved.selectedEntry.id).toBe(toolCallAssistantId);
    expect(resolved.turnEndEntry.id).toBe(finalAssistantId);
    expect(resolved.boundaryEntry.id).toBe(finalAssistantId);
    expect(resolved.boundaryEntry.id).not.toBe(nextEnvelopeId);
  });

  it("uses the selected user itself as the user-node fork boundary", () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "first" } as any);
    manager.appendMessage({ role: "assistant", content: "answer" } as any);

    const resolved = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "user", entryId: userId },
      { mode: "fork" },
    );

    expect(resolved.selectedUser?.id).toBe(userId);
    expect(resolved.precedingUser).toBeNull();
    expect(resolved.boundaryEntry.id).toBe(userId);
  });

  it("resolves assistant_turn through its persisted preceding user and rejects abandoned entries", () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "first" } as any);
    const abandonedAssistantId = manager.appendMessage({ role: "assistant", content: "abandoned" } as any);
    manager.branch(userId);
    const activeAssistantId = manager.appendMessage({ role: "assistant", content: "active" } as any);

    const resolved = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant_turn", turnInputEntryId: userId },
      { mode: "fork" },
    );
    expect(resolved.selectedEntry.id).toBe(activeAssistantId);
    expect(resolved.boundaryEntry.id).toBe(activeAssistantId);

    expect(() => resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant", entryId: abandonedAssistantId },
      { mode: "retry" },
    )).toThrow("active branch");
  });

  it("treats persisted custom messages as independent turn boundaries", () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: "visible question" } as any);
    const visibleAssistantId = manager.appendMessage({ role: "assistant", content: "visible answer" } as any);
    const firstCustomId = manager.appendCustomMessageEntry(
      "hana-background-result",
      '<hana-background-result task-id="task-1" status="success" type="subagent">one</hana-background-result>',
      false,
      { deliveryId: "delivery-1" },
    );
    const firstCustomAssistantId = manager.appendMessage({ role: "assistant", content: "handled one" } as any);
    manager.appendCustomMessageEntry(
      "hana-background-result",
      '<hana-background-result task-id="task-2" status="success" type="subagent">two</hana-background-result>',
      false,
      { deliveryId: "delivery-2" },
    );
    manager.appendMessage({ role: "assistant", content: "handled two" } as any);

    const visibleTurn = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant", entryId: visibleAssistantId },
      { mode: "fork" },
    );
    expect(visibleTurn.boundaryEntry.id).toBe(visibleAssistantId);

    const customTurn = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant_turn", turnInputEntryId: firstCustomId },
      { mode: "fork" },
    );
    expect(customTurn.userEntry).toBeNull();
    expect(customTurn.turnInputEntry.id).toBe(firstCustomId);
    expect(customTurn.selectedEntry.id).toBe(firstCustomAssistantId);
    expect(customTurn.boundaryEntry.id).toBe(firstCustomAssistantId);
  });

  it("keeps extension custom context inside its surrounding user turn", () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    manager.appendCustomMessageEntry(
      "extension-context",
      "extra context for the same prompt",
      false,
      { source: "before_agent_start" },
    );
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);

    const resolved = resolveSessionNodeTarget(
      manager.getBranch(),
      { role: "assistant", entryId: assistantId },
      { mode: "fork" },
    );

    expect(resolved.turnInputEntry.id).toBe(userId);
    expect(resolved.userEntry.id).toBe(userId);
    expect(resolved.boundaryEntry.id).toBe(assistantId);
  });
});

describe("retrySessionTurn", () => {
  function makeStableEngine(session, sessionPath = "/tmp/main.jsonl", sessionId = "sess-main") {
    return {
      getSessionManifest: vi.fn((requestedId) => requestedId === sessionId
        ? { sessionId, currentLocator: { path: sessionPath } }
        : null),
      getSessionIdForPath: vi.fn((requestedPath) => requestedPath === sessionPath ? sessionId : null),
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setSessionBranchHead: vi.fn(),
    };
  }

  it("retries an arbitrary active user node from before its Hana metadata envelope", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: "context" } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: "context answer" } as any);
    manager.appendCustomEntry(MESSAGE_PRESENTATION_RECORD_TYPE, {
      displayText: "hello @Critic",
      agentMentions: [{ agentId: "critic", label: "Critic" }],
    });
    manager.appendCustomEntry(MESSAGE_ORIGIN_RECORD_TYPE, {
      source: "bridge_rc",
      bridgeSessionKey: "telegram:1",
      origin: { kind: "agent", agentId: "critic" },
    });
    manager.appendCustomEntry(AGENT_REVIEW_RECORD_TYPE, {
      requestId: "review-1",
      status: "completed",
      reviewedSessionId: "sess-parent",
      reviewerSessionId: "sess-review",
      reviewerAgentId: "critic",
      reviewerAgentName: "Critic",
      text: "findings",
      completedAt: "2026-07-19T00:00:00.000Z",
    });
    const targetUserId = manager.appendMessage({
      role: "user",
      content: [{
        type: "text",
        text: `[SessionFile] {"fileId":"sf-1","sessionId":"sess-main","sessionPath":"/tmp/main.jsonl","label":"note","kind":"attachment"}\nhello`,
      }],
    } as any);
    manager.appendMessage({ role: "assistant", content: "first answer" } as any);
    manager.appendMessage({ role: "user", content: "later" } as any);
    manager.appendMessage({ role: "assistant", content: "later answer" } as any);
    const session = makeNavigableSession(manager);
    const engine = makeStableEngine(session);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const invalidateDerivedState = vi.fn();

    await retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: targetUserId },
      clientMessageId: "client-retry",
    }, { submit, invalidateDerivedState });

    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(invalidateDerivedState).toHaveBeenCalledWith(engine, {
      sessionId: "sess-main",
      sessionPath: "/tmp/main.jsonl",
      retainedMessageCount: 2,
    });
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      sessionId: "sess-main",
      sessionPath: "/tmp/main.jsonl",
      preservePromptEnvelope: true,
      text: expect.stringContaining('[SessionFile] {"fileId":"sf-1"'),
      displayMessage: expect.objectContaining({
        text: "hello @Critic",
        source: "bridge_rc",
        bridgeSessionKey: "telegram:1",
        agentMentions: [{ agentId: "critic", label: "Critic" }],
        agentReview: expect.objectContaining({
          requestId: "review-1",
          reviewerAgentId: "critic",
          text: "findings",
        }),
      }),
    }));
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_branch_reset",
      sessionId: "sess-main",
      messageId: targetUserId,
    }), "/tmp/main.jsonl");
  });

  it("maps assistant and assistant_turn targets back to the preceding user", async () => {
    for (const targetKind of ["assistant", "assistant_turn"] as const) {
      const manager = SessionManager.inMemory("/workspace");
      const priorAssistantId = manager.appendMessage({ role: "assistant", content: "preamble" } as any);
      const userId = manager.appendMessage({ role: "user", content: "question" } as any);
      const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
      manager.appendMessage({ role: "user", content: "later" } as any);
      const session = makeNavigableSession(manager);
      const engine = makeStableEngine(session);
      const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));

      await retrySessionTurn(engine, {
        sessionId: "sess-main",
        target: targetKind === "assistant"
          ? { role: "assistant", entryId: assistantId }
          : { role: "assistant_turn", turnInputEntryId: userId },
      }, { submit, invalidateDerivedState: vi.fn() });

      expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id)).toEqual([priorAssistantId]);
      expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({ text: "question" }));
    }
  });

  it("retries a persisted custom background turn without projecting a user node", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const visibleUserId = manager.appendMessage({ role: "user", content: "visible question" } as any);
    const visibleAssistantId = manager.appendMessage({ role: "assistant", content: "visible answer" } as any);
    const hiddenInputContent = '<hana-background-result task-id="task-1" status="success" type="subagent">[attached_image: /missing/stale.png]\ndone</hana-background-result>';
    const hiddenInputId = manager.appendCustomMessageEntry(
      "hana-background-result",
      hiddenInputContent,
      false,
      { deliveryId: "delivery-1" },
    );
    const hiddenAssistantId = manager.appendMessage({ role: "assistant", content: "background answer" } as any);
    const session = makeNavigableSession(manager);
    const engine = makeStableEngine(session) as any;
    engine.listSessionFiles = vi.fn((_sessionPath, options) => (
      JSON.stringify(options?.references || []).includes("/missing/stale.png")
        ? [{ id: "stale-custom-file", filePath: "/missing/stale.png" }]
        : []
    ));
    engine.serializeSessionFile = vi.fn((file) => file);
    const submit = vi.fn();
    const readFile = vi.fn(async () => {
      throw new Error("custom retry must not read attachment-like text");
    });
    const deliverCustomMessage = vi.fn(async (_sessionPath, _message, options) => {
      options.beforeInputSideEffects();
      return { ok: true, mode: "triggerTurn" };
    });

    await retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "assistant", entryId: hiddenAssistantId },
    }, { submit, deliverCustomMessage, readFile, invalidateDerivedState: vi.fn() });

    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id)).toEqual([
      visibleUserId,
      visibleAssistantId,
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(engine.listSessionFiles).toHaveBeenCalledWith("/tmp/main.jsonl", {
      references: expect.not.arrayContaining([expect.stringContaining("/missing/stale.png")]),
    });
    expect(deliverCustomMessage).toHaveBeenCalledWith(
      "/tmp/main.jsonl",
      {
        customType: "hana-background-result",
        content: hiddenInputContent,
        display: false,
        details: { deliveryId: "delivery-1" },
      },
      expect.objectContaining({ triggerTurn: true, beforeInputSideEffects: expect.any(Function) }),
    );
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_branch_reset",
      messageId: hiddenInputId,
      projectionMessageId: hiddenAssistantId,
      sessionFiles: [],
    }), "/tmp/main.jsonl");
  });

  it("suppresses only pending tasks introduced by the discarded branch", async () => {
    const sessionPath = "/tmp/main.jsonl";
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: "first" } as any);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-prefix", name: "subagent", arguments: {} }],
    } as any);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-prefix",
      toolName: "subagent",
      content: [],
      details: { taskId: "task-prefix", runId: "task-prefix" },
    } as any);
    manager.appendMessage({ role: "assistant", content: "first answer" } as any);
    const retryUserId = manager.appendMessage({ role: "user", content: "second" } as any);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-tail", name: "subagent", arguments: {} }],
    } as any);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-tail",
      toolName: "subagent",
      content: [],
      details: { taskId: "task-tail", runId: "task-tail" },
    } as any);
    manager.appendMessage({ role: "assistant", content: "second answer" } as any);

    const store = new DeferredResultStore(null, null, {
      getSessionIdForPath: (path) => path === sessionPath ? "sess-main" : null,
    }) as any;
    store.defer("task-prefix", { sessionId: "sess-main", sessionPath }, { type: "subagent" });
    store.defer("task-tail", { sessionId: "sess-main", sessionPath }, { type: "subagent" });
    const deliverCustomMessage = vi.fn(async () => ({ ok: true }));
    const coordinator = new DeferredResultCoordinator({
      store,
      sessionCoordinator: {
        isRunnableSessionPath: vi.fn(() => true),
        deliverCustomMessage,
      },
      retryIntervalMs: 0,
    });
    coordinator.start();

    try {
      const session = makeNavigableSession(manager);
      const engine = makeStableEngine(session) as any;
      engine.deferredResults = store;
      engine.taskRegistry = {
        query: vi.fn((taskId) => ({ taskId, parentSessionId: "sess-main", status: "running" })),
        abort: vi.fn(() => "aborted"),
      };
      engine.subagentRuns = {
        query: vi.fn((taskId) => ({ taskId, parentSessionId: "sess-main", status: "pending" })),
        abort: vi.fn(),
      };
      const submit = vi.fn(async (_engine, input) => {
        input.beforeInputSideEffects();
        return { text: "new answer", toolMedia: [] };
      });

      await retrySessionTurn(engine, {
        sessionId: "sess-main",
        target: { role: "user", entryId: retryUserId },
      }, { submit, invalidateDerivedState: vi.fn() });

      expect(store.query("task-prefix")).toMatchObject({ status: "pending", delivered: false });
      expect(store.query("task-tail")).toMatchObject({
        status: "aborted",
        delivered: true,
        deliverySuppressed: true,
      });
      expect(engine.taskRegistry.abort).toHaveBeenCalledTimes(1);
      expect(engine.taskRegistry.abort).toHaveBeenCalledWith("task-tail", "discarded by session retry");
      expect(engine.subagentRuns.abort).toHaveBeenCalledTimes(1);
      expect(engine.subagentRuns.abort).toHaveBeenCalledWith("task-tail", "discarded by session retry");

      store.resolve("task-tail", "stale result");
      store.resolve("task-prefix", "retained result");
      await vi.waitFor(() => expect(deliverCustomMessage).toHaveBeenCalledTimes(1));
      expect(JSON.stringify(deliverCustomMessage.mock.calls[0])).toContain("task-prefix");
      expect(JSON.stringify(deliverCustomMessage.mock.calls[0])).not.toContain("task-tail");
      expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "session_branch_reset",
        discardedTaskIds: ["task-tail"],
      }), sessionPath);
    } finally {
      coordinator.dispose();
      store.dispose();
    }
  });

  it("collects task identities only from structured entry fields", () => {
    expect(collectStructuredBackgroundTaskIds([{
      message: {
        content: "taskId: textual-id",
        details: {
          taskId: "task-a",
          nested: [{ runId: "run-b" }, { replacesTaskId: "task-c" }],
        },
      },
    }])).toEqual(["task-a", "run-b", "task-c"]);
  });

  it("rehydrates forked media from the active child cache after the parent bytes are cleaned", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-retry-fork-media-"));
    try {
      const parentMediaPath = path.join(tempRoot, "parent-cache", "image.png");
      const childMediaPath = path.join(tempRoot, "child-cache", "image.png");
      fs.mkdirSync(path.dirname(parentMediaPath), { recursive: true });
      fs.mkdirSync(path.dirname(childMediaPath), { recursive: true });
      fs.writeFileSync(parentMediaPath, "parent-bytes");
      fs.copyFileSync(parentMediaPath, childMediaPath);
      fs.rmSync(parentMediaPath);

      const manager = SessionManager.inMemory("/workspace");
      const userId = manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `[attached_image: ${parentMediaPath}]\nquestion` }],
      } as any);
      manager.appendMessage({ role: "assistant", content: "answer" } as any);
      const childSessionPath = path.join(tempRoot, "child.jsonl");
      const session = makeNavigableSession(manager);
      const engine = makeStableEngine(session, childSessionPath, "sess-child") as any;
      const childFile = {
        id: "sf-child",
        sessionId: "sess-child",
        sessionPath: childSessionPath,
        filePath: childMediaPath,
        realPath: childMediaPath,
        legacyFileIds: ["sf-parent"],
        legacyFilePaths: [parentMediaPath],
        mime: "image/png",
        status: "available",
      };
      engine.resolveActiveSessionFile = vi.fn(({ fileId, filePath }) => (
        fileId === "sf-parent" || filePath === parentMediaPath ? childFile : null
      ));
      const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));

      await retrySessionTurn(engine, {
        sessionId: "sess-child",
        target: { role: "user", entryId: userId },
        displayMessage: {
          text: "question",
          attachments: [{
            fileId: "sf-parent",
            path: parentMediaPath,
            name: "image.png",
            isDir: false,
            mimeType: "image/png",
          }],
        },
      }, { submit, invalidateDerivedState: vi.fn() });

      expect(fs.existsSync(parentMediaPath)).toBe(false);
      expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
        text: `[attached_image: ${parentMediaPath}]\nquestion`,
        imageAttachmentPaths: [parentMediaPath],
        images: [{
          type: "image",
          data: Buffer.from("parent-bytes").toString("base64"),
          mimeType: "image/png",
        }],
        displayMessage: expect.objectContaining({
          attachments: [expect.objectContaining({
            fileId: "sf-child",
            path: childMediaPath,
            sessionId: "sess-child",
            sessionPath: childSessionPath,
          })],
        }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a target that exists in the file but is no longer on the active branch", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const abandonedAssistantId = manager.appendMessage({ role: "assistant", content: "abandoned" } as any);
    manager.branch(userId);
    manager.appendMessage({ role: "assistant", content: "active" } as any);
    const session = makeNavigableSession(manager);
    const engine = makeStableEngine(session);
    const submit = vi.fn();

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "assistant", entryId: abandonedAssistantId },
    }, { submit, invalidateDerivedState: vi.fn() })).rejects.toThrow("active branch");

    expect(submit).not.toHaveBeenCalled();
  });

  it("invalidates the owning agent's session-derived memory before moving the branch", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const session = makeNavigableSession(manager);
    const engine = makeStableEngine(session) as any;
    const invalidateSessionDerivedState = vi.fn(() => ({ aggregateHistoryPreserved: true }));
    engine.resolveSessionOwnership = vi.fn(() => ({ agentId: "agent-main" }));
    engine.getAgent = vi.fn(() => ({
      memoryTicker: { invalidateSessionDerivedState },
    }));

    await retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, { submit: vi.fn(async () => ({ text: "new answer", toolMedia: [] })) });

    expect(invalidateSessionDerivedState).toHaveBeenCalledWith({
      sessionId: "sess-main",
      sessionPath: "/tmp/main.jsonl",
      retainedMessageCount: 0,
    });
  });

  it("keeps branch, memory, and UI untouched when submit preflight fails before the commit hook", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const session = makeNavigableSession(manager);
    const engine = makeStableEngine(session);
    const invalidateDerivedState = vi.fn();

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, {
      submit: vi.fn(async () => { throw new Error("Cache prefix contract violated: tools"); }),
      invalidateDerivedState,
    })).rejects.toThrow("Cache prefix contract violated");

    expect(manager.getBranch().map(entry => entry.id)).toEqual([userId, assistantId]);
    expect(invalidateDerivedState).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("serializes retry operations for the same stable session id", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const engine = makeStableEngine(makeNavigableSession(manager));
    let releaseSubmit: ((value: any) => void) | null = null;
    const submit = vi.fn(() => new Promise((resolve) => { releaseSubmit = resolve; }));

    const first = retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, { submit, invalidateDerivedState: vi.fn() });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, { submit, invalidateDerivedState: vi.fn() })).rejects.toThrow("session_busy");

    releaseSubmit?.({ text: "new answer", toolMedia: [] });
    await first;
  });

  it("durably restores the original leaf when memory invalidation rejects the branch commit", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
    manager.appendCustomEntry("test-background-task", { taskId: "task-tail" });
    const engine = makeStableEngine(makeNavigableSession(manager)) as any;
    const store = new DeferredResultStore(null, null, {
      getSessionIdForPath: () => "sess-main",
    }) as any;
    store.defer("task-tail", {
      sessionId: "sess-main",
      sessionPath: "/tmp/main.jsonl",
    }, { type: "subagent" });
    engine.deferredResults = store;
    engine.taskRegistry = {
      query: vi.fn(() => ({ taskId: "task-tail", parentSessionId: "sess-main", status: "running" })),
      abort: vi.fn(),
    };
    const submit = vi.fn(async (_engine, input) => {
      input.beforeInputSideEffects();
      return { text: "unreachable", toolMedia: [] };
    });

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, {
      submit,
      invalidateDerivedState: vi.fn(() => { throw new Error("memory store unavailable"); }),
    })).rejects.toThrow("memory store unavailable");

    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id))
      .toEqual([userId, assistantId]);
    expect(manager.getBranch().at(-1)).toMatchObject({
      customType: "hana-session-branch-reset",
      data: { rolledBack: true, reason: "memory_invalidation_failed" },
    });
    expect(store.query("task-tail")).toMatchObject({ status: "pending", delivered: false });
    expect(store.query("task-tail")).not.toHaveProperty("deliverySuppressed");
    expect(engine.taskRegistry.abort).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
    store.dispose();
  });

  it("atomically restores the summary when fallback fact invalidation fails without a ticker", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const engine = makeStableEngine(makeNavigableSession(manager)) as any;
    const originalSummary = {
      session_id: "sess-main",
      summary: "original active-branch memory",
      messageCount: 2,
      snapshot: "original snapshot",
    };
    let currentSummary: any = structuredClone(originalSummary);
    const summaryManager = {
      getSummary: vi.fn(() => currentSummary),
      invalidateSession: vi.fn(() => {
        currentSummary = null;
        return true;
      }),
      saveSummary: vi.fn((_sessionId, snapshot) => {
        currentSummary = structuredClone(snapshot);
      }),
    };
    engine.resolveSessionOwnership = vi.fn(() => ({ agentId: "agent-main" }));
    engine.getAgent = vi.fn(() => ({
      memoryTicker: null,
      summaryManager,
      factStore: {
        deleteBySession: vi.fn(() => { throw new Error("facts database locked"); }),
      },
    }));

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, {
      submit: vi.fn(async () => ({ text: "unreachable", toolMedia: [] })),
    })).rejects.toThrow("facts database locked");

    expect(currentSummary).toEqual(originalSummary);
    expect(summaryManager.saveSummary).toHaveBeenCalledWith("sess-main", originalSummary);
    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id))
      .toEqual([userId, assistantId]);
    expect(manager.getBranch().at(-1)).toMatchObject({
      customType: "hana-session-branch-reset",
      data: { rolledBack: true, reason: "memory_invalidation_failed" },
    });
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("keeps derived memory intact when the final runtime projection fails", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const originalMessages = manager.buildSessionContext().messages;
    const session = makeNavigableSession(manager) as any;
    const replaceMessages = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("runtime projection unavailable"); });
    session.agent = { replaceMessages };
    const engine = makeStableEngine(session);
    const invalidateDerivedState = vi.fn();
    const submit = vi.fn(async (_engine, input) => {
      input.beforeInputSideEffects();
      return { text: "unreachable", toolMedia: [] };
    });

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, {
      submit,
      invalidateDerivedState,
    })).rejects.toThrow("runtime projection unavailable");

    expect(invalidateDerivedState).not.toHaveBeenCalled();
    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id))
      .toEqual([userId, assistantId]);
    expect(manager.getBranch().at(-1)).toMatchObject({
      customType: "hana-session-branch-reset",
      data: { rolledBack: true, reason: "runtime_projection_failed" },
    });
    expect(replaceMessages).toHaveBeenLastCalledWith(originalMessages);
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("restores live agent messages even when both the branch and rollback markers fail to persist", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const assistantId = manager.appendMessage({ role: "assistant", content: "answer" } as any);
    const originalMessages = manager.buildSessionContext().messages;
    const session = makeNavigableSession(manager) as any;
    session.agent = { state: { messages: originalMessages } };
    const engine = makeStableEngine(session);
    const appendSpy = vi.spyOn(manager, "appendCustomEntry")
      .mockImplementation(() => { throw new Error("session storage is unwritable"); });
    const submit = vi.fn(async (_engine, input) => {
      input.beforeInputSideEffects();
      return { text: "unreachable", toolMedia: [] };
    });

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      target: { role: "user", entryId: userId },
    }, {
      submit,
      invalidateDerivedState: vi.fn(),
    })).rejects.toThrow("session storage is unwritable");

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(manager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id))
      .toEqual([userId, assistantId]);
    expect(session.agent.state.messages).toEqual(originalMessages);
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("requires a stable session identity and rejects a stale locator", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const userId = manager.appendMessage({ role: "user", content: "question" } as any);
    const engine = makeStableEngine(makeNavigableSession(manager));

    await expect(retrySessionTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      target: { role: "user", entryId: userId },
    }, { submit: vi.fn() })).rejects.toThrow("sessionId is required");

    await expect(retrySessionTurn(engine, {
      sessionId: "sess-main",
      sessionPath: "/tmp/stale.jsonl",
      target: { role: "user", entryId: userId },
    }, { submit: vi.fn() })).rejects.toThrow("session identity mismatch");
  });
});
