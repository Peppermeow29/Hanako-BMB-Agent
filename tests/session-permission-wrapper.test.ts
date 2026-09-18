import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApprovalGateway } from "../lib/approval-gateway.ts";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.ts";

const SESSION_PATH = path.resolve("/tmp/session.jsonl");
const DIRECT_SESSION_PATH = path.resolve("/tmp/direct-session.jsonl");

const ctx = {
  sessionManager: { getSessionFile: () => SESSION_PATH },
};

function makeTool(name = "write", extras: any = {}) {
  return {
    name,
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "executed" }],
      details: { executed: true },
    })),
    ...extras,
  };
}

function makeChannelDescriptorTool() {
  return makeTool("channel", {
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (params.action === "list" || params.action === "read") {
          return {
            action: params.action,
            kind: "read",
            capability: `channel.${params.action}`,
          };
        }
        if (params.action !== "post" || typeof params.channelId !== "string" || !params.channelId.trim()) {
          return null;
        }
        return {
          action: "post",
          kind: "review",
          capability: "channel.post",
          target: { type: "channel", id: params.channelId.trim(), label: params.channelLabel || params.channelId.trim() },
          sideEffect: {
            kind: "external_message",
            summary: "Post a message to the selected channel.",
          },
        };
      },
    },
  });
}

function makeTerminalDescriptorTool() {
  return makeTool("terminal", {
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        const action = params.action;
        if (!["list", "read", "start", "write", "close"].includes(action)) return null;
        return {
          action,
          kind: action === "list" || action === "read"
            ? "read"
            : action === "close" ? "routine" : "review",
          capability: `terminal.${action}`,
          ...(["read", "write", "close"].includes(action) ? {
            target: { type: "terminal_process", id: params.terminal_id, label: params.terminal_id },
          } : {}),
        };
      },
    },
  });
}

function makeWriteStdinDescriptorTool() {
  return makeTool("write_stdin", {
    sessionPermission: {
      resolveInvocation: (params: any = {}) => ({
        action: "write",
        kind: "review",
        capability: "write_stdin.write",
        target: { type: "terminal_process", id: params.process_id, label: params.process_id },
      }),
    },
  });
}

const automationPermissionContext = { surface: "automation" };

function makeAutomationStore() {
  return {
    addJob: vi.fn((jobData) => ({ ...jobData, id: "studio_job_1", enabled: true })),
    updateJob: vi.fn(),
    getJob: vi.fn(() => null),
    listJobs: vi.fn(() => []),
  };
}

describe("session permission wrapper", () => {
  it("blocks side-effect tools in read-only mode", async () => {
    const tool = makeTool("write");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("allows file stat in read-only mode", async () => {
    const tool = makeTool("file");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { action: "stat", fileId: "sf_1" }, null, null, ctx);

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("allows plugin tools declared read-only in read-only mode", async () => {
    const tool = makeTool("office_list-capabilities", {
      _pluginId: "office",
      sessionPermission: { readOnly: true },
    });
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "allow", reviewer: "small_tool_model", risk: "low" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-1", {}, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("blocks file copy in read-only mode", async () => {
    const tool = makeTool("file");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { action: "copy", fileId: "sf_1" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("asks before running the transitional file tool in ask mode", async () => {
    const tool = makeTool("file");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "copy", fileId: "sf_1" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "file" }),
      SESSION_PATH,
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("asks before running side-effect tools in ask mode", async () => {
    const tool = makeTool("write");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "write" }),
      SESSION_PATH,
    );
    expect(emitted[0]).toMatchObject({
      sessionPath: SESSION_PATH,
      event: {
        type: "session_confirmation",
        request: {
          type: "session_confirmation",
          kind: "tool_action_approval",
          status: "pending",
        },
      },
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("does not run side-effect tools when ask mode is rejected", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmed).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("operate mode bypasses approval gateway and human confirmations", async () => {
    const tool = makeTool("write");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "should not run",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("operate mode lets ordinary git push behave like regular bash", async () => {
    const tool = makeTool("bash");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "should not review operate bash",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { command: "git push origin main" }, null, null, ctx);

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(result.details.executed).toBe(true);
  });

  it("operate mode runs dangerous git push variants through the same flow as an ordinary push", async () => {
    const tool = makeTool("bash");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "allow", reviewer: "small_tool_model", risk: "low" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { command: "git push --force-with-lease origin main" }, null, null, ctx);

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode runs sandbox-bound workspace actions without approval gateway or human confirmation", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "workspace write is in scope",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      getSessionIdForPath: (sessionPath) => sessionPath === SESSION_PATH ? "sess_tool_permission" : null,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode lets plugin-output tools run when the plugin declares bounded session output", async () => {
    const tool = makeTool("office_html-to-pdf", {
      _pluginId: "office",
      sessionPermission: { kind: "plugin_output" },
    });
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({ action: "deny_and_continue", reviewer: "small_tool_model", risk: "high" })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { html: "<h1>Hi</h1>" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode sends plugin tools with external side effects to the approval reviewer", async () => {
    const tool = makeTool("media_generate-image", {
      _pluginId: "media",
      sessionPermission: {
        kind: "external_side_effect",
        describeSideEffect: (params) => ({
          kind: "external_generation",
          summary: `Generate image through provider ${params.provider || "default"}.`,
          risk: "medium",
          ruleId: "plugin-media-generation",
        }),
      },
    });
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "generation matches user intent",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { prompt: "cover", provider: "openai" }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "media_generate-image",
        sideEffect: expect.objectContaining({
          kind: "external_generation",
          summary: "Generate image through provider openai.",
          ruleId: "plugin-media-generation",
        }),
      }),
      expect.any(Object),
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("uses the tool-owned descriptor to allow concrete read actions", async () => {
    const tool = makeChannelDescriptorTool();
    const approvalGateway = { review: vi.fn() };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-channel-list", { action: "list" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("resolves a synchronously allowed invocation only once", async () => {
    const resolveInvocation = vi.fn(() => ({
      action: "list",
      kind: "read",
      capability: "channel.list",
    }));
    const tool = makeTool("channel", {
      sessionPermission: { resolveInvocation },
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
    });

    const result = await wrapped.execute("call-channel-list-once", { action: "list" }, null, null, ctx);

    expect(resolveInvocation).toHaveBeenCalledOnce();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("fails closed when a declared invocation resolver throws or rejects the action", async () => {
    const cases = [
      makeTool("channel", {
        sessionPermission: {
          resolveInvocation: () => { throw new Error("secret resolver detail"); },
        },
      }),
      makeTool("channel", {
        sessionPermission: { resolveInvocation: () => null },
      }),
    ];

    for (const tool of cases) {
      const approvalGateway = { review: vi.fn() };
      const [wrapped] = wrapWithSessionPermission([tool], {
        getPermissionMode: () => "auto",
        getApprovalGateway: () => approvalGateway,
      });
      const result = await wrapped.execute("call-invalid", { action: "post" }, null, null, ctx);

      expect(tool.execute).not.toHaveBeenCalled();
      expect(approvalGateway.review).not.toHaveBeenCalled();
      expect(result.details.errorCode).toBe("TOOL_INVOCATION_RESOLVER_FAILED");
      expect(JSON.stringify(result)).not.toContain("secret resolver detail");
    }
  });

  it("passes descriptor action, target, and side effect to the approval gateway", async () => {
    const tool = makeChannelDescriptorTool();
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "matches intent",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    await wrapped.execute("call-channel-post", {
      action: "post",
      channelId: "ch_team",
      channelLabel: "Team",
      content: "hello",
    }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "channel",
        actionName: "post",
        target: { type: "channel", id: "ch_team", label: "Team" },
        blastRadius: "external",
        sideEffect: {
          kind: "external_message",
          summary: "Post a message to the selected channel.",
        },
      }),
      expect.any(Object),
    );
  });

  it("treats reviewed browser-tab interactions as external blast radius", async () => {
    const tool = makeTool("browser", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "click",
          kind: "review",
          capability: "browser.click",
          target: { type: "browser_tab", id: "tab-checkout", label: "Checkout" },
        }),
      },
    });
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "matches the requested interaction",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    await wrapped.execute("call-browser-click", {
      action: "click",
      tabId: "tab-checkout",
      ref: 7,
    }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "browser_tab", id: "tab-checkout", label: "Checkout" },
        blastRadius: "external",
      }),
      expect.any(Object),
    );
  });

  it("fails closed when a reviewer-approved target changes before execution", async () => {
    let resolvedAgentId = "agent-a";
    const tool = makeTool("dm", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "send",
          kind: "review",
          capability: "dm.send",
          target: { type: "agent", id: resolvedAgentId, label: resolvedAgentId },
        }),
      },
    });
    const approvalGateway = {
      review: vi.fn(async () => {
        resolvedAgentId = "agent-b";
        return {
          action: "allow",
          reviewer: "small_tool_model",
          reason: "approved agent-a",
          risk: "low",
        };
      }),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-drifting-dm", { to: "Team Agent", message: "hello" }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: "agent", id: "agent-a", label: "agent-a" } }),
      expect.any(Object),
    );
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("TOOL_INVOCATION_CHANGED_BEFORE_EXECUTION");
  });

  it("keeps Hana and runtime-native session identities in separate namespaces", async () => {
    const hanaSessionId = "sess-desktop";
    const runtimeNativeSessionId = "019f7dca-9ff4-7031-ba7f-cdcd5f7b3198";
    const sessionPath = path.resolve("/tmp/desktop-session.jsonl");
    let receivedCtx: any = null;
    const tool = makeChannelDescriptorTool();
    tool.execute = vi.fn(async (...toolArgs: any[]) => {
      receivedCtx = toolArgs[4];
      return {
        content: [{ type: "text", text: "executed" }],
        details: { executed: true },
      };
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionIdForPath: (candidatePath) => (
        candidatePath === sessionPath ? hanaSessionId : null
      ),
    });

    const result = await wrapped.execute(
      "call-distinct-session-identities",
      { action: "list" },
      null,
      null,
      {
        sessionId: hanaSessionId,
        sessionRef: { sessionId: hanaSessionId, sessionPath },
        sessionManager: {
          getSessionId: () => runtimeNativeSessionId,
          getSessionFile: () => sessionPath,
        },
      },
    );

    expect(result.details.executed).toBe(true);
    expect(receivedCtx).toMatchObject({
      sessionId: hanaSessionId,
      sessionRef: { sessionId: hanaSessionId, sessionPath },
    });
    expect(receivedCtx.sessionManager.getSessionId()).toBe(runtimeNativeSessionId);
  });

  it("fails closed when explicit Hana session identities conflict", async () => {
    const sessionPath = path.resolve("/tmp/conflicting-hana-session.jsonl");
    const tool = makeChannelDescriptorTool();
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionIdForPath: () => "sess-from-manifest",
    });

    const result = await wrapped.execute(
      "call-conflicting-hana-session",
      { action: "list" },
      null,
      null,
      {
        sessionId: "sess-explicit",
        sessionRef: { sessionId: "sess-explicit", sessionPath },
        sessionManager: {
          getSessionId: () => "019f7dca-9ff4-7031-ba7f-cdcd5f7b3198",
          getSessionFile: () => sessionPath,
        },
      },
    );

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      errorCode: "TOOL_SESSION_CONTEXT_INVALID",
      sessionContextReason: "conflicting-session-identities",
    });
  });

  it("fails closed when the runtime-native session identity changes during review", async () => {
    const hanaSessionId = "sess-stable";
    const sessionPath = path.resolve("/tmp/runtime-native-drift.jsonl");
    let runtimeNativeSessionId = "019f7dca-9ff4-7031-ba7f-cdcd5f7b3198";
    const tool = makeChannelDescriptorTool();
    const approvalGateway = {
      review: vi.fn(async () => {
        runtimeNativeSessionId = "019f7dca-b75c-7ffd-8071-44a8be0632c4";
        return {
          action: "allow",
          reviewer: "small_tool_model",
          reason: "approved stable Hana session",
          risk: "low",
        };
      }),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionIdForPath: () => hanaSessionId,
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute(
      "call-runtime-native-drift",
      { action: "post", channelId: "ch_team", content: "hello" },
      null,
      null,
      {
        sessionId: hanaSessionId,
        sessionRef: { sessionId: hanaSessionId, sessionPath },
        sessionManager: {
          getSessionId: () => runtimeNativeSessionId,
          getSessionFile: () => sessionPath,
        },
      },
    );

    expect(approvalGateway.review).toHaveBeenCalledOnce();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION");
  });

  it("fails closed when the Pi session context changes while approval review is pending", async () => {
    const sessions = {
      a: { sessionId: "sess-a", sessionPath: path.resolve("/tmp/session-a.jsonl") },
      b: { sessionId: "sess-b", sessionPath: path.resolve("/tmp/session-b.jsonl") },
    };
    let activeSession = sessions.a;
    const mutableCtx = {
      sessionId: sessions.a.sessionId,
      sessionManager: { getSessionFile: () => activeSession.sessionPath },
    };
    const tool = makeChannelDescriptorTool();
    const approvalGateway = {
      review: vi.fn(async () => {
        activeSession = sessions.b;
        mutableCtx.sessionId = sessions.b.sessionId;
        return {
          action: "allow",
          reviewer: "small_tool_model",
          reason: "approved session A",
          risk: "low",
        };
      }),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionIdForPath: (sessionPath) => (
        sessionPath === sessions.a.sessionPath
          ? sessions.a.sessionId
          : sessionPath === sessions.b.sessionPath
            ? sessions.b.sessionId
            : null
      ),
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute(
      "call-session-drift",
      { action: "post", channelId: "ch_team", content: "hello" },
      null,
      null,
      mutableCtx,
    );

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringContaining("sess-a:channel:"),
        sessionPath: sessions.a.sessionPath,
      }),
      expect.objectContaining({ sessionPath: sessions.a.sessionPath }),
    );
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION");
  });

  it("fails closed when a Bridge delivery authority changes while review is pending", async () => {
    const mutableCtx = {
      ...ctx,
      bridgeContext: {
        isBridgeSession: true,
        platform: "wechat",
        chatId: "owner-a",
        sessionKey: "wechat_dm_owner-a@agent-a",
      },
    };
    const tool = makeTool("notify", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "send",
          kind: "review",
          capability: "notify.send",
          target: { type: "notification_route", id: "context-default" },
        }),
      },
    });
    const approvalGateway = {
      review: vi.fn(async () => {
        mutableCtx.bridgeContext.chatId = "owner-b";
        mutableCtx.bridgeContext.sessionKey = "wechat_dm_owner-b@agent-a";
        return {
          action: "allow",
          reviewer: "small_tool_model",
          reason: "approved owner A",
          risk: "low",
        };
      }),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute(
      "call-bridge-drift",
      { title: "Reminder", body: "Check the report" },
      null,
      null,
      mutableCtx,
    );

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION");
  });

  it("keeps the execution context bound to session A after the tool starts", async () => {
    const sessions = {
      a: {
        sessionId: "sess-a",
        runtimeNativeSessionId: "pi-session-a",
        sessionPath: path.resolve("/tmp/session-a.jsonl"),
        cwd: path.resolve("/tmp/workspace-a"),
      },
      b: {
        sessionId: "sess-b",
        runtimeNativeSessionId: "pi-session-b",
        sessionPath: path.resolve("/tmp/session-b.jsonl"),
        cwd: path.resolve("/tmp/workspace-b"),
      },
    };
    let activeSession = sessions.a;
    const appendCustomEntry = vi.fn(() => "forwarded");
    const mutableCtx = {
      sessionId: sessions.a.sessionId,
      bridgeContext: {
        isBridgeSession: true,
        platform: "wechat",
        chatId: "owner-a",
        sessionKey: "wechat_dm_owner-a@agent-a",
      },
      notificationContext: {
        bridgeDeliveryTarget: { platform: "wechat", chatId: "owner-a" },
      },
      sessionManager: {
        getSessionId: () => activeSession.runtimeNativeSessionId,
        getSessionFile: () => activeSession.sessionPath,
        getCwd: () => activeSession.cwd,
        appendCustomEntry,
      },
    };
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let receivedCtx: any = null;
    const tool = makeChannelDescriptorTool();
    tool.execute = vi.fn(async (...toolArgs: any[]) => {
      receivedCtx = toolArgs[4];
      markExecutionStarted();
      await executionGate;
      const forwarded = receivedCtx.sessionManager.appendCustomEntry("entry");
      return {
        content: [{ type: "text", text: "executed" }],
        details: {
          executed: true,
          sessionId: receivedCtx.sessionId,
          sessionPath: receivedCtx.sessionPath,
          sessionRef: receivedCtx.sessionRef,
          managerSessionId: receivedCtx.sessionManager.getSessionId(),
          managerSessionPath: receivedCtx.sessionManager.getSessionFile(),
          managerCwd: receivedCtx.sessionManager.getCwd(),
          bridgeChatId: receivedCtx.bridgeContext.chatId,
          bridgeSessionKey: receivedCtx.bridgeContext.sessionKey,
          notificationChatId: receivedCtx.notificationContext.bridgeDeliveryTarget.chatId,
          forwarded,
        },
      };
    });
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "approved session A",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionIdForPath: (sessionPath) => (
        sessionPath === sessions.a.sessionPath
          ? sessions.a.sessionId
          : sessionPath === sessions.b.sessionPath
            ? sessions.b.sessionId
            : null
      ),
      getApprovalGateway: () => approvalGateway,
    });

    const pendingResult = wrapped.execute(
      "call-bound-session",
      { action: "post", channelId: "ch_team", content: "hello" },
      null,
      null,
      mutableCtx,
    );
    await executionStarted;
    activeSession = sessions.b;
    mutableCtx.sessionId = sessions.b.sessionId;
    mutableCtx.bridgeContext.chatId = "owner-b";
    mutableCtx.bridgeContext.sessionKey = "wechat_dm_owner-b@agent-a";
    mutableCtx.notificationContext.bridgeDeliveryTarget.chatId = "owner-b";
    releaseExecution();
    const result = await pendingResult;

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(receivedCtx).not.toBe(mutableCtx);
    expect(receivedCtx.sessionManager).not.toBe(mutableCtx.sessionManager);
    expect(result.details).toMatchObject({
      executed: true,
      sessionId: sessions.a.sessionId,
      sessionPath: sessions.a.sessionPath,
      sessionRef: {
        sessionId: sessions.a.sessionId,
        sessionPath: sessions.a.sessionPath,
      },
      managerSessionId: sessions.a.runtimeNativeSessionId,
      managerSessionPath: sessions.a.sessionPath,
      managerCwd: sessions.a.cwd,
      bridgeChatId: "owner-a",
      bridgeSessionKey: "wechat_dm_owner-a@agent-a",
      notificationChatId: "owner-a",
      forwarded: "forwarded",
    });
    expect(appendCustomEntry).toHaveBeenCalledWith("entry");
  });

  it("runs hard safety before a tool-owned resolver", async () => {
    const resolver = vi.fn(() => { throw new Error("resolver should not run"); });
    const tool = makeTool("stage_files", {
      sessionPermission: { resolveInvocation: resolver },
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
    });

    const result = await wrapped.execute("call-stage-hostile", {
      filepaths: ["/outside/secret.txt"],
    }, null, null, ctx);

    expect(resolver).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY");
  });

  it("rejects accessor parameters without evaluating them", async () => {
    const getter = vi.fn(() => "post");
    const params = {} as Record<string, unknown>;
    Object.defineProperty(params, "action", { enumerable: true, get: getter });
    const tool = makeChannelDescriptorTool();
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
    });

    const result = await wrapped.execute("call-accessor", params, null, null, ctx);

    expect(getter).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("TOOL_INVOCATION_INPUT_INVALID");
  });

  it("executes the reviewed parameter snapshot even if caller and reviewer mutate their copies", async () => {
    const tool = makeChannelDescriptorTool();
    const params = {
      action: "post",
      channelId: "ch_team",
      content: "approved content",
    };
    const approvalGateway = {
      review: vi.fn(async (request) => {
        request.params.content = "reviewer mutation";
        params.content = "caller mutation";
        return { action: "allow", reviewer: "policy", risk: "low" };
      }),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-snapshot", params, null, null, ctx);

    expect(result.details.executed).toBe(true);
    expect(tool.execute).toHaveBeenCalledWith(
      "call-snapshot",
      expect.objectContaining({ content: "approved content" }),
      null,
      null,
      expect.objectContaining({
        sessionPath: SESSION_PATH,
        sessionManager: expect.any(Object),
      }),
    );
    expect((tool.execute.mock.calls[0] as any)[4]).not.toBe(ctx);
  });

  it("keeps the direct third-argument Pi-compatible call shape with a bound context", async () => {
    const tool = makeChannelDescriptorTool();
    const directCtx = {};
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getSessionPath: () => DIRECT_SESSION_PATH,
      getSessionIdForPath: () => "sess-direct",
    });

    const result = await wrapped.execute("call-direct", { action: "list" }, directCtx);

    expect(result.details.executed).toBe(true);
    expect(tool.execute).toHaveBeenCalledWith(
      "call-direct",
      { action: "list" },
      expect.objectContaining({
        sessionId: "sess-direct",
        sessionPath: DIRECT_SESSION_PATH,
        sessionRef: {
          sessionId: "sess-direct",
          sessionPath: DIRECT_SESSION_PATH,
        },
      }),
    );
    expect((tool.execute.mock.calls[0] as any)[2]).not.toBe(directCtx);
  });

  it("rechecks the workspace delivery boundary immediately before execution", async () => {
    const tool = makeTool("stage_files", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "stage",
          kind: "routine",
          capability: "stage_files.stage",
          target: { type: "session_files", id: "workspace-file" },
        }),
      },
    });
    const checkStagePath = vi.fn()
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: false, reason: "path left authorized workspace" });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionBoundary: { checkStagePath },
    });

    const result = await wrapped.execute("call-stage", { filepaths: ["/workspace/report.txt"] }, null, null, ctx);

    expect(checkStagePath).toHaveBeenCalledTimes(2);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY");
  });

  it("executes stage_files with the canonical path approved by the workspace boundary", async () => {
    const tool = makeTool("stage_files", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "stage",
          kind: "routine",
          capability: "stage_files.stage",
          target: { type: "session_files", id: "workspace-file" },
        }),
      },
    });
    const linkPath = "/workspace/latest.txt";
    const canonicalPath = "/workspace/reports/report.txt";
    const checkStagePath = vi.fn(() => ({ allowed: true, canonicalPath }));
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionBoundary: { checkStagePath },
    });

    const result = await wrapped.execute("call-stage-canonical", {
      filePath: linkPath,
      label: "report.txt",
    }, null, null, ctx);

    expect(result.details.executed).toBe(true);
    expect(checkStagePath).toHaveBeenCalledTimes(3);
    expect(tool.execute).toHaveBeenCalledWith(
      "call-stage-canonical",
      expect.objectContaining({
        filepaths: [canonicalPath],
        label: "report.txt",
      }),
      null,
      null,
      expect.any(Object),
    );
    expect((tool.execute.mock.calls[0] as any)[1].filePath).toBeUndefined();
  });

  it("fails closed when stage_files receives a path without a workspace boundary", async () => {
    const tool = makeTool("stage_files", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "stage",
          kind: "routine",
          capability: "stage_files.stage",
          target: { type: "session_files", id: "workspace-file" },
        }),
      },
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
    });

    const result = await wrapped.execute("call-stage-unbound", {
      filepaths: ["/workspace/report.txt"],
    }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY");
  });

  it("does not accept class-instance permission metadata as a legacy read-only declaration", async () => {
    class UnsafePermission {
      readOnly = true;
      resolveInvocation() {
        return { action: "write", kind: "review", capability: "unsafe.write" };
      }
    }
    const tool = makeTool("unsafe", { sessionPermission: new UnsafePermission() });
    const approvalGateway = { review: vi.fn() };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
    });

    const result = await wrapped.execute("call-unsafe", {}, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(result.details.errorCode).toMatch(/^TOOL_INVOCATION_/);
  });

  it("runs unattended automation reads and routine actions without grants, reviewer, or confirmation", async () => {
    const channel = makeChannelDescriptorTool();
    const terminal = makeTerminalDescriptorTool();
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "reviewer unavailable",
        reasonCode: "approval_reviewer_unavailable",
        risk: "medium",
      })),
    };
    const [wrappedChannel, wrappedTerminal] = wrapWithSessionPermission(
      [channel, terminal],
      {
        getPermissionMode: () => "auto",
        permissionContext: automationPermissionContext,
        getConfirmStore: () => confirmStore,
        getApprovalGateway: () => approvalGateway,
        allowHumanApproval: false,
      },
    );

    const channelList = await wrappedChannel.execute("call-channel-list", { action: "list" }, null, null, ctx);
    const channelRead = await wrappedChannel.execute("call-channel-read", { action: "read" }, null, null, ctx);
    const terminalClose = await wrappedTerminal.execute(
      "call-terminal-close",
      { action: "close", terminal_id: "term_1" },
      null,
      null,
      ctx,
    );
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(channelList.details.executed).toBe(true);
    expect(channelRead.details.executed).toBe(true);
    expect(terminalClose.details.executed).toBe(true);
  });

  it("keeps host PTY start, input, and write_stdin reviewer-bound in unattended Auto", async () => {
    const terminal = makeTerminalDescriptorTool();
    const writeStdin = makeWriteStdinDescriptorTool();
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "reviewer unavailable",
        reasonCode: "approval_reviewer_unavailable",
        risk: "medium",
      })),
    };
    const [wrappedTerminal, wrappedStdin] = wrapWithSessionPermission(
      [terminal, writeStdin],
      {
        getPermissionMode: () => "auto",
        permissionContext: automationPermissionContext,
        getApprovalGateway: () => approvalGateway,
        allowHumanApproval: false,
      },
    );

    const results = [
      await wrappedTerminal.execute("call-start", { action: "start" }, null, null, ctx),
      await wrappedTerminal.execute("call-write", { action: "write", terminal_id: "term_1", chars: "q" }, null, null, ctx),
      await wrappedStdin.execute("call-stdin", { process_id: "term_1", chars: "q" }, null, null, ctx),
    ];

    expect(approvalGateway.review).toHaveBeenCalledTimes(3);
    expect(terminal.execute).not.toHaveBeenCalled();
    expect(writeStdin.execute).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.details.confirmation).toMatchObject({
        status: "needs_user_approval_but_unavailable",
        reviewStatus: "ask_user",
      });
    }
  });

  it("sends unattended automation boundary actions through the auto reviewer without durable grants", async () => {
    const tool = makeChannelDescriptorTool();
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "the channel post matches the scheduled task",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionContext: automationPermissionContext,
      getApprovalGateway: () => approvalGateway,
      allowHumanApproval: false,
    });

    const result = await wrapped.execute("call-automation-post", {
      action: "post",
      channelId: "ch_team",
      content: "daily update",
    }, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledOnce();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("lets operate mode run unattended automation routine and review actions without grants", async () => {
    const channel = makeChannelDescriptorTool();
    const terminal = makeTerminalDescriptorTool();
    const approvalGateway = { review: vi.fn() };
    const [wrappedChannel, wrappedTerminal] = wrapWithSessionPermission([channel, terminal], {
      getPermissionMode: () => "operate",
      permissionContext: automationPermissionContext,
      getApprovalGateway: () => approvalGateway,
    });

    const post = await wrappedChannel.execute("call-operate-post", {
      action: "post",
      channelId: "ch_team",
    }, null, null, ctx);
    const start = await wrappedTerminal.execute("call-operate-start", { action: "start" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(post.details.executed).toBe(true);
    expect(start.details.executed).toBe(true);
  });

  it("does not trust precomputed descriptor or authorization flags from permissionContext", async () => {
    const tool = makeTool("unknown_plugin_write");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "policy",
        reason: "legacy unknown tool remains reviewer-bound",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionContext: {
        toolInvocation: { action: "write", kind: "read", capability: "unknown_plugin_write.write" },
      },
      getApprovalGateway: () => approvalGateway,
    });

    await wrapped.execute("call-forged-context", {}, null, null, ctx);

    expect(approvalGateway.review).toHaveBeenCalledOnce();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("runs hard safety checks before unattended automation action classification", async () => {
    const tool = makeTool("stage_files", {
      sessionPermission: {
        resolveInvocation: () => ({
          action: "stage",
          kind: "routine",
          capability: "stage_files.stage",
          target: { type: "session_files", id: "workspace-file" },
        }),
      },
    });
    const approvalGateway = { review: vi.fn() };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionContext: automationPermissionContext,
      getApprovalGateway: () => approvalGateway,
      allowHumanApproval: false,
    });

    const result = await wrapped.execute("call-automation-danger", {
      filepaths: ["/outside/secret.txt"],
    }, null, null, ctx);

    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY");
    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("auto mode lets automation draft generation run without a tool-action confirmation", async () => {
    const store = makeAutomationStore();
    const confirmStore = { create: vi.fn() };
    const automationSuggestionStore = {
      create: vi.fn((entry) => ({
        ...entry,
        suggestionId: "automation_suggestion_1",
        shortCode: "3827",
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      automationSuggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => createApprovalGateway(),
      emitEvent: vi.fn(),
    });

    const automationCtx = {
      ...ctx,
      sessionRef: {
        sessionId: "sess_automation_draft",
        sessionPath: SESSION_PATH,
      },
    };
    const result = await wrapped.execute(
      "call-automation-draft",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      null,
      null,
      automationCtx,
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(automationSuggestionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_automation_draft",
      sessionPath: SESSION_PATH,
      operation: "create",
      apply: expect.any(Function),
    }));
    expect(result.details).toMatchObject({
      action: "pending_add",
      suggestionId: "automation_suggestion_1",
      suggestionShortCode: "3827",
    });
    expect(result.details.confirmId).toBeUndefined();
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("defaults missing permission mode to auto and runs sandbox-bound workspace actions directly", async () => {
    const tool = makeTool("write");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "default auto reviewer approved",
        risk: "low",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode does not run a denied reviewer-bound action and returns the reviewer reason to the agent", async () => {
    const tool = makeTool("browser");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "small_tool_model",
        reason: "use a safer local command",
        saferAlternative: "inspect files without shelling out",
        risk: "high",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#pay" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      confirmed: false,
      confirmation: {
        kind: "tool_action_approval",
        status: "denied",
        toolName: "browser",
        // 拒绝文案署名（灰测修复 A3）：原因必须标明来源是审查网关，模型不会把
        // 拒绝脑补成沙箱限制。
        reason: "session permission auto-review: use a safer local command",
        reviewer: "small_tool_model",
      },
    });
  });

  it("unattended auto review does not fall back to human confirmation when the reviewer is unavailable", async () => {
    const tool = makeTool("browser");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-auto-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "reviewer unavailable",
        risk: "medium",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      permissionContext: automationPermissionContext,
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation).toMatchObject({
      kind: "tool_action_approval",
      status: "needs_user_approval_but_unavailable",
      toolName: "browser",
      reviewStatus: "ask_user",
      reason: "reviewer unavailable",
      reviewer: "policy",
      risk: "medium",
    });
  });

  it("preserves structured reviewer failures while unattended auto mode fails closed", async () => {
    const tool = makeTool("browser");
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "Automatic approval review could not produce a valid decision.",
        reasonCode: "approval_review_failed",
        reviewerFailures: [
          {
            reviewer: "small_tool_model",
            reasonCode: "reviewer_invalid_json",
            attempts: 2,
          },
          {
            reviewer: "large_tool_model",
            reasonCode: "reviewer_timeout",
            errorCode: "LLM_TIMEOUT",
            attempts: 1,
          },
        ],
        risk: "medium",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation).toMatchObject({
      status: "needs_user_approval_but_unavailable",
      approvalPolicy: "deny_on_prompt",
      reviewStatus: "ask_user",
      reasonCode: "approval_review_failed",
      reviewerFailures: [
        {
          reviewer: "small_tool_model",
          reasonCode: "reviewer_invalid_json",
          attempts: 2,
        },
        {
          reviewer: "large_tool_model",
          reasonCode: "reviewer_timeout",
          errorCode: "LLM_TIMEOUT",
          attempts: 1,
        },
      ],
    });
  });

  it("passes trust context to the auto reviewer for reviewer-bound tool actions", async () => {
    const tool = makeTool("browser");
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "trusted workspace target",
        risk: "low",
      })),
    };
    const runtimeCtx = {
      sessionManager: { getSessionFile: () => SESSION_PATH },
      agentId: "hana",
      userIntentSummary: "Click the send button in the local preview",
      explicitUserAuthorization: "User asked to submit the local preview form.",
      recentApprovalHistory: [{ toolName: "browser", action: "navigate", status: "approved" }],
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getApprovalGateway: () => approvalGateway,
      cwd: "/workspace/project",
      workspaceFolders: ["/workspace/project", "/workspace/shared"],
      authorizedFolders: ["/external/assets-static"],
      getAuthorizedFolders: () => ["/external/assets-live"],
      knownRemotes: ["origin git@example.com:hana/project.git"],
      knownDomains: ["localhost"],
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, runtimeCtx);

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser",
        sessionPath: SESSION_PATH,
        agentId: "hana",
      }),
      expect.objectContaining({
        sessionPath: SESSION_PATH,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/project", "/workspace/shared"],
        authorizedFolders: ["/external/assets-live"],
        knownRemotes: ["origin git@example.com:hana/project.git"],
        knownDomains: ["localhost"],
        userIntentSummary: "Click the send button in the local preview",
        explicitUserAuthorization: "User asked to submit the local preview form.",
        recentApprovalHistory: [{ toolName: "browser", action: "navigate", status: "approved" }],
      }),
    );
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("auto mode returns needs_user_approval_but_unavailable when reviewer asks in a non-interactive context", async () => {
    const tool = makeTool("browser");
    const confirmStore = {
      create: vi.fn(),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "policy",
        reason: "bridge cannot ask the user",
        risk: "medium",
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "auto",
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      allowHumanApproval: false,
    });

    const result = await wrapped.execute("call-1", { action: "click", selector: "#send" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation.status).toBe("needs_user_approval_but_unavailable");
    expect(result.details.confirmation.reviewStatus).toBe("ask_user");
    expect(result.details.confirmation.reason).toBe("bridge cannot ask the user");
  });

  it("ask mode returns needs_user_approval_but_unavailable when approval policy cannot ask", async () => {
    const tool = makeTool("write");
    const confirmStore = { create: vi.fn() };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      approvalPolicy: "deny_on_prompt",
    });

    const result = await wrapped.execute("call-1", { path: "notes.md" }, null, null, ctx);

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmation).toMatchObject({
      kind: "tool_action_approval",
      status: "needs_user_approval_but_unavailable",
      approvalPolicy: "deny_on_prompt",
      toolName: "write",
    });
  });

  // ---- 甲（Codex 式）端到端：permissionContext 透传到 classify ----

  it("subagent 上下文拦 subagent 工具（防自递归），即便 operate 全放行也拦，真实工具不执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate", // 即便最宽松的 operate
      permissionContext: { isSubagent: true },
    });
    const result = await wrapped.execute("call-1", { task: "递归" }, null, null, ctx);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_IN_SUBAGENT");
  });

  it("subagent 上下文 + read-only：write 被拦、read 放行（探索者只读档的执行层证明）", async () => {
    const write = makeTool("write");
    const read = makeTool("read");
    const [wWrite, wRead] = wrapWithSessionPermission([write, read], {
      getPermissionMode: () => "read_only",
      permissionContext: { isSubagent: true },
    });
    const wr = await wWrite.execute("c1", { path: "x" }, null, null, ctx);
    const rd = await wRead.execute("c2", { path: "x" }, null, null, ctx);
    expect(write.execute).not.toHaveBeenCalled();
    expect(wr.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
    expect(read.execute).toHaveBeenCalledOnce();
    expect(rd.details.executed).toBe(true);
  });

  it("对照：无 permissionContext 时 subagent 工具在 operate 下正常执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
    });
    const result = await wrapped.execute("call-1", { task: "x" }, null, null, ctx);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("does not trust a public wrapped marker and reapplies stricter dependencies", async () => {
    const tool = makeTool("write", { _sessionPermissionWrapped: true });
    const [operateWrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
    });
    const [readOnlyWrapped] = wrapWithSessionPermission([operateWrapped], {
      getPermissionMode: () => "read_only",
    });

    const result = await readOnlyWrapped.execute("call-rewrapped", { path: "notes.md" }, null, null, ctx);

    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
