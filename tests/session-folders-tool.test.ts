import path from "path";
import { describe, expect, it, vi } from "vitest";
import { createSessionFoldersTool } from "../lib/tools/session-folders-tool.ts";

function textPayload(result) {
  return JSON.parse(result.content[0].text);
}

function makeCtx(sessionPath = "/tmp/agents/hana/sessions/s1.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

describe("session_folders tool", () => {
  it("lists the current session folder scope", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const engine = {
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      })),
    };
    const tool = createSessionFoldersTool({ getEngine: () => engine });

    const result = await tool.execute("call-1", { action: "list" }, null, null, makeCtx(sessionPath));

    expect(textPayload(result)).toEqual({
      session_folders: {
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      },
    });
  });

  it("ask mode requires confirmation before adding an authorized folder", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const folder = path.resolve("/external/assets");
    const engine = {
      getSessionPermissionMode: vi.fn(() => "ask"),
      addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: [],
        authorizedFolders: [folder],
        sandboxFolders: ["/workspace/project", folder],
      })),
      getSessionFolderScope: vi.fn(),
    };
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-folder-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const emitEvent = vi.fn();
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      emitEvent,
    });

    const result = await tool.execute("call-1", { action: "add", folder }, null, null, makeCtx(sessionPath));

    expect(confirmStore.create).toHaveBeenCalledWith("session_folders", { action: "add", folder }, sessionPath);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_confirmation",
      request: expect.objectContaining({
        confirmId: "confirm-folder-1",
        kind: "session_folders",
      }),
    }), sessionPath);
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, folder);
    expect(result.details).toMatchObject({ action: "add", confirmed: true, sessionPath, folder });
    expect(textPayload(result).session_folders.authorizedFolders).toEqual([folder]);
  });

  it("operate mode updates session folders without reviewer or human confirmation", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const folder = path.resolve("/external/assets");
    const engine = {
      getSessionPermissionMode: vi.fn(() => "operate"),
      addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: [],
        authorizedFolders: [folder],
        sandboxFolders: ["/workspace/project", folder],
      })),
      getSessionFolderScope: vi.fn(),
    };
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "deny_and_continue",
        reviewer: "large_tool_model",
        reason: "should not run",
        risk: "high",
      })),
    };
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await tool.execute("call-1", { action: "add", folder }, null, null, makeCtx(sessionPath));

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, folder);
    expect(result.details).toMatchObject({ action: "add", confirmed: true, sessionPath, folder });
  });

  it("auto mode adds an authorized folder after approval gateway approval without human confirmation", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const folder = path.resolve("/external/assets");
      const engine = {
        getSessionIdForPath: vi.fn((candidate) => candidate === sessionPath ? "sess_session_folders" : null),
        getSessionPermissionMode: vi.fn(() => "auto"),
        addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: [],
        authorizedFolders: [folder],
          sandboxFolders: ["/workspace/project", folder],
        })),
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/shared"],
        authorizedFolders: ["/external/existing"],
        sandboxFolders: ["/workspace/project", "/workspace/shared", "/external/existing"],
      })),
    };
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "large_tool_model",
        reason: "folder access matches the user request",
        risk: "high",
      })),
    };
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await tool.execute("call-1", { action: "add", folder }, null, null, makeCtx(sessionPath));

      expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^sess_session_folders:session_folders:/),
        kind: "session_folders",
        sessionPath,
        toolName: "session_folders",
        target: expect.objectContaining({ type: "directory", path: folder }),
      }),
      expect.objectContaining({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/shared"],
        authorizedFolders: ["/external/existing"],
        userIntentSummary: "Authorize this folder for the current session.",
      }),
    );
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, folder);
    expect(result.details).toMatchObject({ action: "add", confirmed: true, sessionPath, folder });
  });

  it("auto mode does not fall back to the existing folder confirmation when the gateway asks the user", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const folder = path.resolve("/external/assets");
    const engine = {
      getSessionPermissionMode: vi.fn(() => "auto"),
      addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: [],
        authorizedFolders: [folder],
        sandboxFolders: ["/workspace/project", folder],
      })),
      getSessionFolderScope: vi.fn(),
    };
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-folder-auto-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "large_tool_model",
        reason: "broad folder access needs confirmation",
        risk: "high",
      })),
    };
    const emitEvent = vi.fn();
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent,
    });

    const result = await tool.execute("call-1", { action: "add", folder }, null, null, makeCtx(sessionPath));

    expect(approvalGateway.review).toHaveBeenCalledOnce();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(engine.addSessionAuthorizedFolder).not.toHaveBeenCalled();
    expect((result as any).details.confirmation).toMatchObject({
      kind: "session_folders",
      status: "needs_user_approval_but_unavailable",
      reviewStatus: "ask_user",
      reason: "broad folder access needs confirmation",
      reviewer: "large_tool_model",
      risk: "high",
    });
  });

  it("auto mode returns unavailable instead of confirming when the execution context cannot ask", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const folder = path.resolve("/external/assets");
    const engine = {
      getSessionPermissionMode: vi.fn(() => "auto"),
      addSessionAuthorizedFolder: vi.fn(),
      getSessionFolderScope: vi.fn(),
    };
    const confirmStore = { create: vi.fn() };
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "ask_user",
        reviewer: "large_tool_model",
        reason: "broad folder access needs confirmation",
        risk: "high",
      })),
    };
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      getApprovalGateway: () => approvalGateway,
      emitEvent: vi.fn(),
    });

    const result = await tool.execute(
      "call-1",
      { action: "add", folder },
      null,
      null,
      { ...makeCtx(sessionPath), allowHumanApproval: false },
    );

    expect(approvalGateway.review).toHaveBeenCalledOnce();
    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(engine.addSessionAuthorizedFolder).not.toHaveBeenCalled();
    expect((result as any).details.confirmation).toMatchObject({
      kind: "session_folders",
      status: "needs_user_approval_but_unavailable",
      reviewStatus: "ask_user",
      reason: "broad folder access needs confirmation",
    });
  });
});
