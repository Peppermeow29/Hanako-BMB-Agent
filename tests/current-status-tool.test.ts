import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySessionPermission } from "../core/session-permission-mode.ts";
import {
  readAgentAvatarResource,
  writeAgentAppearanceProfileResource,
} from "../lib/agent-appearance-summary.ts";
import { createCurrentStatusTool } from "../lib/tools/current-status-tool.ts";
import { loadLocale } from "../lib/i18n.ts";

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

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-current-status-"));
  tempDirs.push(dir);
  return dir;
}

function writeAvatar(baseDir, role, content = `${role}-avatar`) {
  const dir = path.join(baseDir, "avatars");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${role}.png`);
  fs.writeFileSync(filePath, Buffer.from(content));
  return filePath;
}

describe("current_status tool", () => {
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("describes time and logical_date as distinct lookup contracts", () => {
    loadLocale("en");
    const tool = createCurrentStatusTool();

    expect(tool.description).toContain('key="time"');
    expect(tool.description).toContain("Session started at");
    expect(tool.description).toContain("frozen snapshot");
  });

  it("falls back to English toolDef for all locales", () => {
    for (const locale of ["zh", "en"]) {
      loadLocale(locale);
      const tool = createCurrentStatusTool();
      expect(tool.description).toContain("status");
      expect(tool.description).toContain("time");
    }
  });

  it("lists available status keys without returning live status values", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await (tool.execute as any)("call_1", { action: "list" }));

    expect(payload.available.map((item) => item.key)).toEqual([
      "time",
      "logical_date",
      "agent",
      "appearance",
      "model",
      "ui_context",
      "session_files",
      "session_folders",
      "bridge_context",
      "subagents",
    ]);
    expect(payload.usage).toContain("list");
    expect(payload.usage).toContain("get");
    expect(JSON.stringify(payload)).not.toContain("Hana");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
    expect(JSON.stringify(payload)).not.toContain("2026-05-03T19:30:00.000Z");
  });

  it("returns the current session folder scope without relying on prompt injection", async () => {
    const sessionPath = "/tmp/agents/hana/sessions/s1.jsonl";
    const tool = createCurrentStatusTool({
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      })),
    });

    const payload = textPayload(await tool.execute(
      "call_1",
      { action: "get", key: "session_folders" },
      null,
      null,
      makeCtx(sessionPath),
    ));

    expect(payload).toEqual({
      session_folders: {
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      },
    });
  });

  it("returns only time fields for get time", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "time" }, null, null, makeCtx()));

    expect(payload).toEqual({
      time: {
        iso: "2026-05-03T19:30:00.000Z",
        timezone: "Asia/Shanghai",
        localDateTime: "2026-05-04 03:30:00",
        utcOffset: "+08:00",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Hana");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
  });

  it("computes logical date in the configured timezone with the 4am boundary", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
    });

    const payload = textPayload(await (tool.execute as any)("call_1", { action: "get", key: "logical_date" }));

    expect(payload).toEqual({
      logical_date: {
        date: "2026-05-03",
        timezone: "Asia/Shanghai",
        dayBoundaryHour: 4,
      },
    });
  });

  it("returns only agent fields for get agent", async () => {
    const tool = createCurrentStatusTool({
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      now: () => new Date("2026-05-03T19:30:00.000Z"),
    });

    const payload = textPayload(await (tool.execute as any)("call_1", { action: "get", key: "agent" }));

    expect(payload).toEqual({
      agent: {
        id: "hana",
        name: "Hana",
      },
    });
  });

  it("returns no appearance image when only the Yuan default avatar exists", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "hana");
    fs.mkdirSync(path.join(root, "desktop", "src", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "desktop", "src", "assets", "Hanako.png"), Buffer.from("yuan-default"));

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "hana",
        agentName: "Hana",
        userName: "User",
        userDir,
        agentDir,
        productDir: root,
        config: { agent: { name: "Hana", yuan: "hanako" } },
      }),
      getCurrentModel: () => ({ id: "gpt-4o", provider: "openai", input: ["text", "image"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("unavailable");
    expect(payload.appearance.agent.avatar.available).toBe(false);
    expect(payload.appearance.agent.summary).toBeNull();
    expect(payload.appearance.agent.directImage.included).toBe(false);
  });

  it("returns direct user avatar image blocks but keeps agent appearance behind the profile resource", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "hana");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "hana",
        agentName: "Hana",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getCurrentModel: () => ({ id: "gpt-4o", provider: "openai", input: ["text", "image"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);
    const serializedJson = result.content[0].text;

    expect(payload.appearance.mode).toBe("direct_image");
    expect(payload.appearance.user.directImage).toMatchObject({ included: true, contentIndex: 1 });
    expect(payload.appearance.agent.directImage).toMatchObject({ included: false, contentIndex: null });
    expect(payload.appearance.agent.vision.status).toBe("profile_resource_missing");
    expect(result.content.slice(1)).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from("user image bytes").toString("base64") },
    ]);
    expect(serializedJson).not.toContain(userDir);
    expect(serializedJson).not.toContain(agentDir);
    expect(serializedJson).not.toContain(Buffer.from("user image bytes").toString("base64"));
  });

  it("returns explicit unavailable appearance when avatars exist but neither auxiliary vision nor direct image input is available", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "hana");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "hana",
        agentName: "Hana",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getCurrentModel: () => ({ id: "deepseek-chat", provider: "deepseek", input: ["text"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("unavailable");
    expect(payload.appearance.user.avatar.available).toBe(true);
    expect(payload.appearance.user.summary).toBeNull();
    expect(payload.appearance.user.vision.status).toBe("not_configured");
    expect(payload.appearance.user.directImage.included).toBe(false);
    expect(payload.appearance.agent.avatar.available).toBe(true);
    expect(payload.appearance.agent.summary).toBeNull();
    expect(payload.appearance.agent.vision.status).toBe("profile_resource_missing");
    expect(payload.appearance.agent.directImage.included).toBe(false);
  });

  it("reads agent appearance from the profile resource and only summarizes user avatars through the auxiliary bridge", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "hana");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");
    const agentAvatar = readAgentAvatarResource(agentDir);
    expect(agentAvatar).not.toBeNull();
    writeAgentAppearanceProfileResource(agentDir, {
      avatarHash: agentAvatar!.hash,
      summary: "你的形象是银白色短发，神情安静。",
      model: "vision-profile",
    });
    const summarizeResources = vi.fn(async ({ resources }) => ({
      notes: resources.map((resource) => ({
        key: resource.key,
        label: resource.label,
        note: `${resource.label}: calm portrait summary`,
        reused: false,
      })),
    }));

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "hana",
        agentName: "Hana",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getVisionBridge: () => ({ summarizeResources }),
      getCurrentModel: () => ({ id: "deepseek-chat", provider: "deepseek", input: ["text"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(summarizeResources).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/agents/hana/sessions/s1.jsonl",
      userRequest: expect.stringContaining("appearance"),
      resources: [
        expect.objectContaining({ label: "user custom avatar" }),
      ],
    }));
    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("vision_summary");
    expect(payload.appearance.user.summary).toContain("user custom avatar: calm portrait summary");
    expect(payload.appearance.agent.summary).toBe("你的形象是银白色短发，神情安静。");
    expect(payload.appearance.agent.vision.status).toBe("profile_resource");
    expect(payload.appearance.agent.vision.reused).toBe(true);
    expect(payload.appearance.user.directImage.included).toBe(false);
  });

  it("does not generate an agent appearance summary inside current_status when the profile resource is missing", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agents", "hana");
    writeAvatar(agentDir, "agent", "agent image bytes");
    const summarizeResources = vi.fn(async ({ resources }) => ({
      notes: resources.map((resource) => ({
        key: resource.key,
        label: resource.label,
        note: `${resource.label}: should not be used for agent`,
        reused: false,
      })),
    }));

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "hana",
        agentName: "Hana",
        userName: "Sample User",
        agentDir,
      }),
      getVisionBridge: () => ({ summarizeResources }),
      getCurrentModel: () => ({ id: "deepseek-chat", provider: "deepseek", input: ["text"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(summarizeResources).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("unavailable");
    expect(payload.appearance.agent.avatar.available).toBe(true);
    expect(payload.appearance.agent.summary).toBeNull();
    expect(payload.appearance.agent.vision.status).toBe("profile_resource_missing");
    expect(payload.appearance.agent.directImage.included).toBe(false);
  });

  it("returns the current session model for get model", async () => {
    const tool = createCurrentStatusTool({
      getSessionModel: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }
        : null,
      getCurrentModel: () => ({ id: "fallback", provider: "openai", name: "Fallback" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "model" }, null, null, makeCtx()));

    expect(payload).toEqual({
      model: {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        name: "Claude Sonnet 4.5",
      },
    });
  });

  it("returns passive UI context metadata for get ui_context", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? {
            currentViewed: "/workspace/notes",
            activeFile: "/workspace/notes/diary.md",
            activePreview: null,
            pinnedFiles: ["/workspace/spec.md"],
          }
        : null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: "/workspace/notes",
        activeFile: "/workspace/notes/diary.md",
        activePreview: null,
        pinnedFiles: ["/workspace/spec.md"],
      },
    });
  });

  it("returns an empty UI context shape when no visible UI context is stored", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: () => null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: null,
        activeFile: null,
        activePreview: null,
        pinnedFiles: [],
      },
    });
  });

  it("returns normalized current session files for get session_files", async () => {
    const tool = createCurrentStatusTool({
      listSessionFiles: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? [
            {
              id: "sf_browser",
              fileId: "sf_browser",
              sessionPath,
              filePath: "/tmp/session-files/browser-screenshot.jpg",
              realPath: "/private/tmp/session-files/browser-screenshot.jpg",
              label: "browser-screenshot.jpg",
              displayName: "Browser Screenshot",
              filename: "browser-screenshot.jpg",
              ext: "jpg",
              mime: "image/jpeg",
              kind: "image",
              size: 12345,
              origin: "browser_screenshot",
              operations: ["captured"],
              storageKind: "managed_cache",
              status: "available",
              missingAt: null,
              createdAt: 1778432852184,
              isDirectory: false,
              internalOnly: "must not leak",
            },
            {
              id: "sf_expired",
              sessionPath,
              filePath: "/tmp/session-files/old.png",
              label: "old.png",
              mime: "image/png",
              kind: "image",
              origin: "browser_screenshot",
              operations: ["captured"],
              storageKind: "managed_cache",
              status: "expired",
              missingAt: 1778432859999,
            },
            {
              id: "sf_agent_report",
              fileId: "sf_agent_report",
              sessionPath,
              filePath: "/workspace/report.md",
              label: "report.md",
              mime: "text/markdown",
              kind: "text",
              origin: "agent_write",
              operations: ["created"],
              storageKind: "external",
              status: "available",
              createdAt: 1778432860000,
            },
          ]
        : [],
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "session_files" }, null, null, makeCtx()));

    expect(payload).toEqual({
      session_files: {
        sessionPath: "/tmp/agents/hana/sessions/s1.jsonl",
        registryAvailable: true,
        files: [
          {
            fileId: "sf_browser",
            sessionFileRef: { kind: "session-file", fileId: "sf_browser" },
            writableLocalRef: null,
            label: "browser-screenshot.jpg",
            displayName: "Browser Screenshot",
            filename: "browser-screenshot.jpg",
            ext: "jpg",
            kind: "image",
            mime: "image/jpeg",
            size: 12345,
            origin: "browser_screenshot",
            operations: ["captured"],
            storageKind: "managed_cache",
            status: "available",
            missingAt: null,
            createdAt: 1778432852184,
            isDirectory: false,
          },
          {
            fileId: "sf_expired",
            sessionFileRef: { kind: "session-file", fileId: "sf_expired" },
            writableLocalRef: null,
            label: "old.png",
            displayName: null,
            filename: null,
            ext: null,
            kind: "image",
            mime: "image/png",
            size: null,
            origin: "browser_screenshot",
            operations: ["captured"],
            storageKind: "managed_cache",
            status: "expired",
            missingAt: 1778432859999,
            createdAt: null,
            isDirectory: false,
          },
          {
            fileId: "sf_agent_report",
            sessionFileRef: { kind: "session-file", fileId: "sf_agent_report" },
            writableLocalRef: { kind: "local-file", path: "/workspace/report.md" },
            label: "report.md",
            displayName: null,
            filename: null,
            ext: null,
            kind: "text",
            mime: "text/markdown",
            size: null,
            origin: "agent_write",
            operations: ["created"],
            storageKind: "external",
            status: "available",
            missingAt: null,
            createdAt: 1778432860000,
            isDirectory: false,
          },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("internalOnly");
  });

  it("returns bridge context for the current session when available", async () => {
    const tool = createCurrentStatusTool({
      getBridgeContext: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? {
            isBridgeSession: true,
            platform: "wechat",
            platformLabel: "微信",
            chatType: "dm",
            role: "owner",
            sessionKey: "wx_dm_owner@hana",
            notificationHint: {
              channels: ["bridge_owner"],
              bridgePlatforms: ["wechat"],
              contextPolicy: "record_when_delivered",
            },
          }
        : null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "bridge_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      bridge_context: {
        isBridgeSession: true,
        platform: "wechat",
        platformLabel: "微信",
        chatType: "dm",
        role: "owner",
        sessionKey: "wx_dm_owner@hana",
        agentId: null,
        userId: null,
        chatId: null,
        notificationHint: {
          channels: ["bridge_owner"],
          bridgePlatforms: ["wechat"],
          contextPolicy: "record_when_delivered",
        },
      },
    });
  });

  it("returns an explicit non-bridge shape outside Bridge sessions", async () => {
    const tool = createCurrentStatusTool({
      getBridgeContext: () => null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "bridge_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      bridge_context: {
        isBridgeSession: false,
      },
    });
  });

  it("returns open direct subagent instances for the current session", async () => {
    const tool = createCurrentStatusTool({
      listOpenSubagentThreads: (sessionPath) => sessionPath === "/session/s1.jsonl"
        ? [{
            threadId: "thread-a",
            agentId: "other-agent",
            agentName: "毛毛",
            label: "探索一",
            access: "read",
            status: "open",
            lastRunStatus: "resolved",
            childSessionPath: "/child/a.jsonl",
            summary: "读完生命周期代码",
            runCount: 2,
            lastRunAt: "2026-06-02T10:00:00.000Z",
            updatedAt: "2026-06-02T10:01:00.000Z",
          }]
        : [],
    });

    const payload = textPayload(await tool.execute(
      "call_1",
      { action: "get", key: "subagents" },
      null,
      null,
      makeCtx("/session/s1.jsonl"),
    ));

    expect(payload).toEqual({
      subagents: {
        sessionPath: "/session/s1.jsonl",
        open: [{
          threadId: "thread-a",
          agentId: "other-agent",
          agentName: "毛毛",
          label: "探索一",
          access: "read",
          status: "open",
          lastRunStatus: "resolved",
          childSessionPath: "/child/a.jsonl",
          summary: "读完生命周期代码",
          runCount: 2,
          lastRunAt: "2026-06-02T10:00:00.000Z",
          updatedAt: "2026-06-02T10:01:00.000Z",
        }],
      },
    });
  });

  it("returns a clear error for unknown keys", async () => {
    const tool = createCurrentStatusTool();

    const result = await (tool.execute as any)("call_1", { action: "get", key: "session_path" });

    expect(result.content[0].text).toContain("Unknown status key");
    expect(result.details.errorCode).toBe("UNKNOWN_STATUS_KEY");
  });

  it("is allowed in read-only permission mode", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "current_status" }))
      .toEqual({ action: "allow" });
  });
});
