import { describe, expect, it, vi } from "vitest";

const { submitDesktopSessionMessageMock } = vi.hoisted(() => ({
  submitDesktopSessionMessageMock: vi.fn(async () => ({ text: null, toolMedia: [] })),
}));

vi.mock("../core/desktop-session-submit.js", () => ({
  submitDesktopSessionMessage: submitDesktopSessionMessageMock,
}));

import { Hub } from "../hub/index.ts";

function createEngine(overrides = {}) {
  return {
    agentsDir: "/agents",
    channelsDir: null,
    hanakoHome: "/tmp/hana",
    providerRegistry: {
      getCredentials: vi.fn(() => ({})),
      getModelsByType: vi.fn(() => []),
      getAllModelsByType: vi.fn(() => []),
    },
    setHubCallbacks: vi.fn(),
    setEventBus: vi.fn(),
    getAgent: vi.fn(() => null),
    updateConfig: vi.fn(async () => {}),
    listAgents: vi.fn(() => []),
    listSessions: vi.fn(async () => []),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    executeExternalMessage: vi.fn(async () => {}),
    executeIsolated: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Hub media routing", () => {
  it("preserves clientMessageId when routing desktop session messages", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    await hub.send("hello", {
      sessionId: "sess_chat",
      sessionPath: "/agents/hanako/sessions/chat.jsonl",
      clientMessageId: "client-user-1",
      displayMessage: { text: "hello" },
    });

    expect(submitDesktopSessionMessageMock).toHaveBeenCalledWith(
      engine,
      expect.objectContaining({
        sessionPath: "/agents/hanako/sessions/chat.jsonl",
        sessionId: "sess_chat",
        clientMessageId: "client-user-1",
      }),
    );
  });

  it("preserves native audio fields when routing desktop session messages", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });
    const audios = [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }];

    await hub.send("listen", {
      sessionPath: "/agents/hanako/sessions/audio.jsonl",
      audios,
      audioAttachmentPaths: ["/tmp/hana/voice.wav"],
      displayMessage: {
        text: "listen",
        attachments: [{ path: "/tmp/hana/voice.wav", name: "voice.wav", mimeType: "audio/wav" }],
      },
    });

    expect(submitDesktopSessionMessageMock).toHaveBeenCalledWith(
      engine,
      expect.objectContaining({
        sessionPath: "/agents/hanako/sessions/audio.jsonl",
        audios,
        audioAttachmentPaths: ["/tmp/hana/voice.wav"],
      }),
    );
  });

  it("preserves native audio fields when routing focus desktop prompts", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });
    const audios = [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }];

    await hub.send("listen", {
      audios,
    });

    expect(engine.prompt).toHaveBeenCalledWith(
      "listen",
      expect.objectContaining({ audios }),
    );
  });

  it("routes ephemeral activity through non-interactive auto permission", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    await hub.send("background tick", {
      ephemeral: true,
      cwd: "/work",
      persist: "/agents/hanako/activity",
    });

    expect(engine.executeIsolated).toHaveBeenCalledWith(
      "background tick",
      expect.objectContaining({
        cwd: "/work",
        persist: "/agents/hanako/activity",
        permissionMode: "auto",
        approvalPolicy: "deny_on_prompt",
        allowHumanApproval: false,
      }),
    );
  });

  it("preserves explicit ephemeral permission mode without enabling human approval", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    await hub.send("background operate", {
      ephemeral: true,
      permissionMode: "operate",
    });

    expect(engine.executeIsolated).toHaveBeenCalledWith(
      "background operate",
      expect.objectContaining({
        permissionMode: "operate",
        approvalPolicy: "deny_on_prompt",
        allowHumanApproval: false,
      }),
    );
  });

  it("preserves native audio fields when routing bridge owner messages", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });
    const audios = [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }];

    await hub.send("listen", {
      sessionKey: "telegram_dm_1",
      audios,
      audioAttachmentPaths: ["/tmp/hana/voice.wav"],
    });

    expect(engine.executeExternalMessage).toHaveBeenCalledWith(
      "listen",
      "telegram_dm_1",
      undefined,
      expect.objectContaining({
        audios,
        audioAttachmentPaths: ["/tmp/hana/voice.wav"],
      }),
    );
  });

  it("preserves native audio fields when routing bridge guest messages", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });
    const audios = [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }];

    await hub.send("listen", {
      sessionKey: "telegram_guest_1",
      role: "guest",
      meta: { name: "Guest" },
      audios,
      audioAttachmentPaths: ["/tmp/hana/voice.wav"],
    });

    expect(engine.executeExternalMessage).toHaveBeenCalledWith(
      expect.stringContaining("listen"),
      "telegram_guest_1",
      { name: "Guest" },
      expect.objectContaining({
        guest: true,
        audios,
        audioAttachmentPaths: ["/tmp/hana/voice.wav"],
      }),
    );
  });
});
