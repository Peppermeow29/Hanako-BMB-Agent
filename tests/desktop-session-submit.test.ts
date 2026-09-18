import { describe, it, expect, vi } from "vitest";

import {
  AGENT_REVIEW_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  MESSAGE_PRESENTATION_RECORD_TYPE,
  submitDesktopSessionInterjection,
  submitDesktopSessionMessage,
  submitDesktopSessionMessageWithReceipt,
} from "../core/desktop-session-submit.ts";
import fs from "fs";
import os from "os";
import path from "path";

function makeFakeSession({ replyText = "desktop reply", toolMedia = [], toolMediaDetails = null, settingsUpdate = null }: any = {}) {
  const subs = [];
  return {
    subscribe: (fn) => {
      subs.push(fn);
      return () => {
        const idx = subs.indexOf(fn);
        if (idx >= 0) subs.splice(idx, 1);
      };
    },
    prompt: vi.fn<(...args: any[]) => Promise<any>>(async () => {
      for (const fn of subs) {
        fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: replyText } });
        if (toolMediaDetails) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: { details: { media: toolMediaDetails } },
          });
        }
        for (const url of toolMedia) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: { details: { media: { mediaUrls: [url] } } },
          });
        }
        if (settingsUpdate) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: { details: { settingsUpdate } },
          });
        }
      }
    }),
    model: null,
  };
}

function sessionFileMarker({ fileId, sessionPath, sessionId = undefined, label, kind = "attachment" }) {
  return `[SessionFile] ${JSON.stringify({
    fileId,
    sessionPath,
    ...(sessionId ? { sessionId } : {}),
    label,
    kind,
  })}`;
}

describe("submitDesktopSessionMessage", () => {
  it("rejects a sessionId/sessionPath mismatch before loading or emitting (#2078)", async () => {
    const engine = {
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/canonical.jsonl" } })),
      ensureSessionLoaded: vi.fn(),
      promptSession: vi.fn(),
    };

    await expect(submitDesktopSessionMessage(engine, {
      sessionId: "sess_target",
      sessionPath: "/tmp/other.jsonl",
      text: "hello",
    })).rejects.toThrow("session identity mismatch");
    expect(engine.ensureSessionLoaded).not.toHaveBeenCalled();
    expect(engine.promptSession).not.toHaveBeenCalled();
  });
  it("rejects concurrent submissions for the same session before streaming status is emitted", async () => {
    const session = makeFakeSession();
    const ready = (Promise as any).withResolvers();
    const engine = {
      ensureSessionLoaded: vi.fn(() => ready.promise),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      isSessionStreaming: vi.fn(() => false),
    };

    const first = submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "first",
      displayMessage: { text: "first" },
    });
    await Promise.resolve();

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "second",
      displayMessage: { text: "second" },
    })).rejects.toThrow("session_busy");

    ready.resolve(session);
    await expect(first).resolves.toMatchObject({ text: "desktop reply" });
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
  });

  it("rejects concurrent submissions for moved paths with the same session id", async () => {
    const session = makeFakeSession();
    const ready = (Promise as any).withResolvers();
    const originalPath = "/tmp/original-desk.jsonl";
    const movedPath = "/tmp/archived/renamed-desk.jsonl";
    const sessionId = "sess_desktop_submit";
    const engine = {
      getSessionIdForPath: vi.fn((sessionPath) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      )),
      ensureSessionLoaded: vi.fn((sessionPath) => (
        sessionPath === originalPath ? ready.promise : Promise.resolve(session)
      )),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      isSessionStreaming: vi.fn(() => false),
    };

    const first = submitDesktopSessionMessage(engine, {
      sessionPath: originalPath,
      text: "first",
      displayMessage: { text: "first" },
    });
    await Promise.resolve();

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: movedPath,
      text: "second",
      displayMessage: { text: "second" },
    })).rejects.toThrow("session_busy");

    ready.resolve(session);
    await expect(first).resolves.toMatchObject({ text: "desktop reply" });
  });

  it("emits a session-scoped user message, toggles streaming status, and returns captured assistant output", async () => {
    const session = makeFakeSession({
      replyText: "desktop reply",
      toolMedia: ["https://example.com/a.png"],
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };
    const onDelta = vi.fn();

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello from bridge",
      displayMessage: { text: "hello from bridge" },
      uiContext: null,
      onDelta,
    });

    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/tmp/desk.jsonl");
    expect(engine.setUiContext).toHaveBeenCalledWith("/tmp/desk.jsonl", null);
    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "hello from bridge" }),
      }),
      "/tmp/desk.jsonl",
    );
    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/desk.jsonl", "hello from bridge", undefined);
    expect(onDelta).toHaveBeenCalledWith("desktop reply", "desktop reply");
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false }),
      "/tmp/desk.jsonl",
    );
    expect(result).toEqual({
      text: "desktop reply",
      toolMedia: [{ type: "remote_url", url: "https://example.com/a.png" }],
    });
  });

  it("can replay a hidden model input without emitting a visible user projection", async () => {
    const session = makeFakeSession({ replyText: "background reply" });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };
    const hiddenInput = '<hana-background-result task-id="task-1">done</hana-background-result>';

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: hiddenInput,
      projectUserMessage: false,
    });

    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/desk.jsonl", hiddenInput, undefined);
    expect(engine.emitEvent.mock.calls.some(([event]) => event?.type === "session_user_message")).toBe(false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
  });

  it("deduplicates SessionFile refs by stable sessionId when it is available", async () => {
    const session = makeFakeSession();
    const engine = {
      getSessionIdForPath: vi.fn(() => "sess_submit_stable"),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "open it",
      displayMessage: { text: "open it" },
      sessionFileRefs: [
        {
          fileId: "sf_note",
          sessionId: "sess_submit_stable",
          sessionPath: "/tmp/old-location.jsonl",
          label: "old note",
          kind: "attachment",
        },
        {
          fileId: "sf_note",
          sessionId: "sess_submit_stable",
          sessionPath: "/tmp/new-location.jsonl",
          label: "new note",
          kind: "attachment",
        },
      ],
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      `${sessionFileMarker({
        fileId: "sf_note",
        sessionId: "sess_submit_stable",
        sessionPath: "/tmp/old-location.jsonl",
        label: "old note",
      })}\nopen it`,
      undefined,
    );
  });

  it("preserves an existing prompt envelope without duplicating media, SessionFile, or reminder markers", async () => {
    const session = makeFakeSession();
    (session as any).sessionManager = { appendCustomEntry: vi.fn() };
    const registerSessionFile = vi.fn();
    const engine = {
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/desk.jsonl" } })),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      registerSessionFile,
      renderSessionReminderBlock: vi.fn(() => ({
        block: "[hana_reminder]\nnew reminder\n[/hana_reminder]",
        receipt: { throughSeq: 1 },
      })),
    };
    const originalPrompt = [
      '[SessionFile] {"fileId":"sf-1","sessionId":"sess-1","sessionPath":"/tmp/desk.jsonl","label":"note","kind":"attachment"}',
      "[attached_image: /tmp/image.png]",
      "review this",
    ].join("\n");

    await submitDesktopSessionMessage(engine, {
      sessionId: "sess-1",
      sessionPath: "/tmp/desk.jsonl",
      text: originalPrompt,
      images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/image.png"],
      sessionFileRefs: [{
        fileId: "sf-1",
        sessionId: "sess-1",
        sessionPath: "/tmp/desk.jsonl",
        label: "note",
        kind: "attachment",
      }],
      displayMessage: {
        text: "review this",
        attachments: [{ fileId: "sf-1", path: "/tmp/image.png", name: "image.png" }],
      },
      preservePromptEnvelope: true,
    } as any);

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      originalPrompt,
      {
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/image.png"],
      },
    );
    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(engine.renderSessionReminderBlock).not.toHaveBeenCalled();
  });

  it("threads clientMessageId into the session user message event", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      clientMessageId: "client-user-1",
      displayMessage: { text: "hello" },
    } as any);

    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        clientMessageId: "client-user-1",
        message: expect.objectContaining({ text: "hello" }),
      }),
      "/tmp/desk.jsonl",
    );
  });

  it("forwards turn context to promptSession without exposing it in the visible user message", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
      context: {
        beforeUser: "world lore",
        metadata: { pluginId: "tavern" },
      },
    } as any);

    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "hello" }),
      }),
      "/tmp/desk.jsonl",
    );
    expect(engine.emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: expect.stringContaining("world lore") }),
      }),
      expect.anything(),
    );
    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      "hello",
      { context: { beforeUser: "world lore", metadata: { pluginId: "tavern" } } },
    );
  });

  it("prefers structured tool media items over legacy mediaUrls", async () => {
    const item = { type: "session_file", fileId: "sf_1", filePath: "/tmp/a.png" };
    const session = makeFakeSession({
      replyText: "desktop reply",
      toolMediaDetails: { items: [item], mediaUrls: ["/tmp/a.png"] },
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });

    expect(result.toolMedia).toEqual([item]);
  });

  it("appends settings update summaries into captured bridge text", async () => {
    const session = makeFakeSession({
      replyText: "",
      settingsUpdate: {
        status: "applied",
        action: "core.apply",
        key: "locale",
        title: "Locale updated",
        summary: "Locale changed.",
        changes: [{ key: "locale", label: "Locale", before: "zh-CN", after: "en" }],
      },
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "change locale",
      displayMessage: { text: "change locale" },
    });

    expect(result.text).toContain("Locale updated");
    expect(result.text).toContain("Locale: zh-CN -> en");
  });

  // ── #1610: /rc 来源元信息持久化 ──

  it("persists a message-origin custom entry before prompting for bridge_rc submissions", async () => {
    const session = makeFakeSession();
    const appendOrder: string[] = [];
    (session as any).sessionManager = {
      appendCustomEntry: vi.fn(() => {
        appendOrder.push("origin-entry");
      }),
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => {
        appendOrder.push("prompt");
        return session.prompt(text, opts);
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello from telegram",
      displayMessage: {
        text: "hello from telegram",
        source: "bridge_rc",
        bridgeSessionKey: "telegram:12345",
      },
    });

    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      MESSAGE_ORIGIN_RECORD_TYPE,
      expect.objectContaining({
        source: "bridge_rc",
        bridgeSessionKey: "telegram:12345",
      }),
    );
    // 来源记录必须先于 prompt 写入，让条目紧邻它注释的 user message
    expect(appendOrder).toEqual(["origin-entry", "prompt"]);
  });

  it("does not write a message-origin entry for plain desktop submissions", async () => {
    const session = makeFakeSession();
    (session as any).sessionManager = { appendCustomEntry: vi.fn() };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });

    expect((session as any).sessionManager.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("persists review presentation and result as message-level custom entries", async () => {
    const session = makeFakeSession();
    const appendCustomEntry = vi.fn();
    (session as any).sessionManager = { appendCustomEntry };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (_sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "user request\n\n[另一位 Agent 的审阅结果]\nfindings",
      displayMessage: {
        text: "user request @Critic",
        agentMentions: [{ agentId: "critic", label: "Critic" }],
        agentReview: {
          requestId: "review-1",
          status: "completed",
          reviewedSessionId: "sess_parent",
          reviewerSessionId: "sess_review",
          reviewerAgentId: "critic",
          reviewerAgentName: "Critic",
          text: "findings",
        },
      },
    });

    expect(appendCustomEntry).toHaveBeenNthCalledWith(1, MESSAGE_PRESENTATION_RECORD_TYPE, expect.objectContaining({
      displayText: "user request @Critic",
      agentMentions: [{ agentId: "critic", label: "Critic" }],
    }));
    expect(appendCustomEntry).toHaveBeenNthCalledWith(2, AGENT_REVIEW_RECORD_TYPE, expect.objectContaining({
      reviewedSessionId: "sess_parent",
      reviewerSessionId: "sess_review",
      text: "findings",
    }));
  });

  it("still submits the message when the origin entry write fails", async () => {
    const session = makeFakeSession();
    (session as any).sessionManager = {
      appendCustomEntry: vi.fn(() => {
        throw new Error("disk hiccup");
      }),
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello from qq",
      displayMessage: { text: "hello from qq", source: "bridge_rc", bridgeSessionKey: "qq:678" },
    });

    expect(result.text).toBe("desktop reply");
  });

  it("still emits session_status=false when promptSession throws", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => {
        throw new Error("boom");
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    })).rejects.toThrow("boom");

    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false }),
      "/tmp/desk.jsonl",
    );
  });

  it("forwards image attachment paths to promptSession", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "see image",
      images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/upload.png"],
      displayMessage: { text: "see image" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      "[attached_image: /tmp/upload.png]\nsee image",
      {
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/upload.png"],
      },
    );
  });

  it("forwards videos to promptSession and records attached video markers", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "see video",
      videos: [{ type: "video", data: "BASE64", mimeType: "video/mp4" }],
      videoAttachmentPaths: ["/tmp/upload.mp4"],
      displayMessage: { text: "see video" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      "[attached_video: /tmp/upload.mp4]\nsee video",
      {
        videos: [{ type: "video", data: "BASE64", mimeType: "video/mp4" }],
        videoAttachmentPaths: ["/tmp/upload.mp4"],
      },
    );
  });

  it("forwards audios to promptSession and records attached audio markers", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hear audio",
      audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
      audioAttachmentPaths: ["/tmp/upload.wav"],
      displayMessage: { text: "hear audio" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      "[attached_audio: /tmp/upload.wav]\nhear audio",
      {
        audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
        audioAttachmentPaths: ["/tmp/upload.wav"],
      },
    );
  });

  it("adds SessionFile references for display-only audio attachments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-display-audio-"));
    try {
      const filePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_audio_attachment",
        fileId: "sf_audio_attachment",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "wav",
        mime: "audio/wav",
        size: 4,
        kind: "audio",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const queueVoiceTranscription = vi.fn();
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        speechRecognition: { queueVoiceTranscription },
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: `[附件] ${filePath}`,
        displayMessage: {
          text: "",
          attachments: [{
            path: filePath,
            name: "voice.wav",
            isDir: false,
            mimeType: "audio/wav",
          }],
        },
      });

      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_audio_attachment",
          sessionPath,
          label: "voice.wav",
        })}\n[附件] ${filePath}`,
        undefined,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers display audio attachments and forwards native audio paths when audio bytes are present", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-display-native-audio-"));
    try {
      const filePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_audio_attachment",
        fileId: "sf_audio_attachment",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "wav",
        mime: "audio/wav",
        size: 4,
        kind: "audio",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const queueVoiceTranscription = vi.fn();
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        speechRecognition: { queueVoiceTranscription },
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "hear this",
        audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
        displayMessage: {
          text: "hear this",
          attachments: [{
            path: filePath,
            name: "voice.wav",
            isDir: false,
            mimeType: "audio/wav",
          }],
        },
      });

      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath,
        label: "voice.wav",
        origin: "user_attachment",
        storageKind: "external",
        presentation: "attachment",
        listed: true,
      });
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_audio_attachment",
          sessionPath,
          label: "voice.wav",
        })}\n[attached_audio: ${filePath}]\nhear this`,
        {
          audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
          audioAttachmentPaths: [filePath],
        },
      );
      expect(queueVoiceTranscription).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queues transcription only for voice-input audio attachments with registered file ids", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-display-voice-input-"));
    try {
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(voicePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind, presentation, listed }) => ({
        id: "sf_voice_input",
        fileId: "sf_voice_input",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "wav",
        mime: "audio/wav",
        size: 4,
        kind: "audio",
        origin,
        storageKind,
        presentation,
        listed,
        createdAt: 1,
      }));
      const queueVoiceTranscription = vi.fn();
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        speechRecognition: { queueVoiceTranscription },
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "",
        audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
        displayMessage: {
          text: "",
          attachments: [{
            path: voicePath,
            name: "录音 1.wav",
            isDir: false,
            mimeType: "audio/wav",
            presentation: "voice-input",
          }],
        },
      });

      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath: voicePath,
        label: "录音 1.wav",
        origin: "voice_input",
        storageKind: "external",
        presentation: "voice-input",
        listed: false,
      });
      expect(queueVoiceTranscription).toHaveBeenCalledTimes(1);
      expect(queueVoiceTranscription).toHaveBeenCalledWith({
        sessionPath,
        fileId: "sf_voice_input",
      });
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_voice_input",
          sessionPath,
          label: "录音 1.wav",
        })}\n[attached_audio: ${voicePath}]`,
        {
          audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
          audioAttachmentPaths: [voicePath],
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers desktop display attachments into the session file ledger", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-display-attachment-"));
    try {
      const filePath = path.join(tmpDir, "desk.png");
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_desktop_attachment",
        fileId: "sf_desktop_attachment",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "png",
        mime: "image/png",
        size: 4,
        kind: "image",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "local file",
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        displayMessage: {
          text: "local file",
          attachments: [{
            path: filePath,
            name: "desk.png",
            isDir: false,
            base64Data: "BASE64",
            mimeType: "image/png",
          }],
        },
      });

      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath,
        label: "desk.png",
        origin: "user_attachment",
        storageKind: "external",
        presentation: "attachment",
        listed: true,
      });
      expect(engine.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_user_message",
          message: expect.objectContaining({
            attachments: [expect.objectContaining({
              fileId: "sf_desktop_attachment",
              path: filePath,
            })],
          }),
        }),
        sessionPath,
      );
      const emittedAttachment = engine.emitEvent.mock.calls
        .find(([event]) => event.type === "session_user_message")?.[0].message.attachments[0];
      expect(emittedAttachment).not.toHaveProperty("base64Data");
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_desktop_attachment",
          sessionPath,
          label: "desk.png",
        })}\n[attached_image: ${filePath}]\nlocal file`,
        expect.objectContaining({
          imageAttachmentPaths: [filePath],
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers bridge inbound files for desktop /rc target sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desktop-inbound-"));
    try {
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_rc_inbound",
        fileId: "sf_rc_inbound",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "png",
        mime: "image/png",
        size: 4,
        kind: "image",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "see bridge image",
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        inboundFiles: [{
          type: "image",
          filename: "bridge.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        }],
        displayMessage: { text: "see bridge image" },
      });

      const savedPath = registerSessionFile.mock.calls[0][0].filePath;
      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath: expect.stringContaining(path.join(tmpDir, "session-files")),
        label: "bridge.png",
        origin: "bridge_inbound",
        storageKind: "managed_cache",
      });
      expect(engine.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_user_message",
          message: expect.objectContaining({
            attachments: [expect.objectContaining({ fileId: "sf_rc_inbound", path: savedPath })],
          }),
        }),
        sessionPath,
      );
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_rc_inbound",
          sessionPath,
          label: "bridge.png",
        })}\n[attached_image: ${savedPath}]\nsee bridge image`,
        expect.objectContaining({
          imageAttachmentPaths: [savedPath],
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("interjects into a streaming session after registering the same visible attachment envelope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desktop-interject-"));
    try {
      const filePath = path.join(tmpDir, "note.txt");
      fs.writeFileSync(filePath, "note");
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_note",
        fileId: "sf_note",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "txt",
        mime: "text/plain",
        size: 4,
        kind: "attachment",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        ensureSessionLoaded: vi.fn(async () => makeFakeSession()),
        isSessionStreaming: vi.fn(() => true),
        promptSession: vi.fn(),
        steerSession: vi.fn(() => true),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      const result = await submitDesktopSessionInterjection(engine, {
        sessionPath,
        text: "[附件] note.txt",
        displayMessage: {
          text: "",
          attachments: [{
            path: filePath,
            name: "note.txt",
            isDir: false,
          }],
        },
        sessionFileRefs: [{
          fileId: "sf_note",
          sessionPath,
          label: "note.txt",
          kind: "attachment",
        }],
        uiContext: { currentTab: "chat" },
      });

      expect(result).toEqual({ text: null, toolMedia: [], steered: true });
      expect(engine.ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
      expect(engine.setUiContext).toHaveBeenCalledWith(sessionPath, { currentTab: "chat" });
      expect(engine.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_user_message",
          message: expect.objectContaining({
            text: "",
            attachments: [expect.objectContaining({
              fileId: "sf_note",
              path: filePath,
              name: "note.txt",
            })],
          }),
        }),
        sessionPath,
      );
      expect(engine.steerSession).toHaveBeenCalledWith(
        sessionPath,
        `${sessionFileMarker({
          fileId: "sf_note",
          sessionPath,
          label: "note.txt",
        })}\n[附件] note.txt`,
      );
      expect(engine.promptSession).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to a normal prompt when an interject arrives after streaming already ended", async () => {
    const session = makeFakeSession({ replyText: "finished reply" });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      steerSession: vi.fn(() => true),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const result = await submitDesktopSessionInterjection(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "late interject",
      displayMessage: { text: "late interject" },
    });

    expect(result).toMatchObject({ text: "finished reply" });
    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/desk.jsonl", "late interject", undefined);
    expect(engine.steerSession).not.toHaveBeenCalled();
  });

  // #1610 孤儿写入修复：steer 被拒绝时不写 origin 条目
  it("does not write a message-origin entry when steerSession returns false (session_busy race)", async () => {
    const session = makeFakeSession();
    const appendCustomEntry = vi.fn();
    (session as any).sessionManager = { appendCustomEntry };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => true),
      steerSession: vi.fn(() => false),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await expect(submitDesktopSessionInterjection(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "interject",
      displayMessage: {
        text: "interject",
        source: "bridge_rc",
        bridgeSessionKey: "telegram:99",
      },
    })).rejects.toThrow("session_busy");

    // origin 条目必须在 steer 成功后才写，被拒绝时不能产生孤儿
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });
});

describe("session reminder block injection", () => {
  const reminderBlock = "[hana_reminder]\n- 当前时间：2026-07-05 14:05\n[/hana_reminder]";
  const receipt = Object.freeze({
    observedAt: 1783231500000,
    throughSeq: 7,
    compactionRevision: 3,
  });

  it("prepends reminders before attachment markers and consumes the exact receipt after prompt acceptance", async () => {
    const session = makeFakeSession();
    (session as any).sessionManager = { appendCustomEntry: vi.fn() };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      imageAttachmentPaths: ["/tmp/image.png"],
      displayMessage: { text: "hello" },
      context: { beforeUser: "world lore" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      `${reminderBlock}\n\n[attached_image: /tmp/image.png]\nhello`,
      { imageAttachmentPaths: ["/tmp/image.png"], context: { beforeUser: "world lore" } },
    );
    expect(engine.consumeRenderedSessionReminderBlock).toHaveBeenCalledWith("/tmp/desk.jsonl", receipt);
    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      MESSAGE_PRESENTATION_RECORD_TYPE,
      expect.objectContaining({ displayText: "hello" }),
    );
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "hello" }),
      }),
      "/tmp/desk.jsonl",
    );
  });

  it("does not consume a rendered receipt when promptSession rejects", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => { throw new Error("model preflight failed"); }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    })).rejects.toThrow("model preflight failed");

    expect(engine.consumeRenderedSessionReminderBlock).not.toHaveBeenCalled();
  });

  it("does not rerender through the legacy API when the render API reports no reminder", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => null),
      consumeSessionReminderBlock: vi.fn(() => reminderBlock),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/desk.jsonl", "hello", undefined);
    expect(engine.consumeSessionReminderBlock).not.toHaveBeenCalled();
  });

  it("ignores destructive consume-only reminders while preserving numeric rendered receipts", async () => {
    const legacySession = makeFakeSession();
    const consumeOnlyEngine = {
      ensureSessionLoaded: vi.fn(async () => legacySession),
      promptSession: vi.fn(async (sessionPath, text, opts) => legacySession.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      consumeSessionReminderBlock: vi.fn(() => reminderBlock),
    };
    await submitDesktopSessionMessage(consumeOnlyEngine, {
      sessionPath: "/tmp/legacy.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });
    expect(consumeOnlyEngine.promptSession).toHaveBeenCalledWith("/tmp/legacy.jsonl", "hello", undefined);
    expect(consumeOnlyEngine.consumeSessionReminderBlock).not.toHaveBeenCalled();

    const numericSession = makeFakeSession();
    const numericEngine = {
      ensureSessionLoaded: vi.fn(async () => numericSession),
      promptSession: vi.fn(async (sessionPath, text, opts) => numericSession.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, now: 1783231500000 })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };
    await submitDesktopSessionMessage(numericEngine, {
      sessionPath: "/tmp/numeric.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });
    expect(numericEngine.consumeRenderedSessionReminderBlock)
      .toHaveBeenCalledWith("/tmp/numeric.jsonl", 1783231500000);
  });

  it("puts reminder, beforeUser context, attachment marker, and body in stable interjection order", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => true),
      steerSession: vi.fn(() => true),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await submitDesktopSessionInterjection(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "interject now",
      imageAttachmentPaths: ["/tmp/image.png"],
      displayMessage: { text: "interject now" },
      context: { beforeUser: "world lore" },
    });

    expect(engine.steerSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      `${reminderBlock}\n\nworld lore\n\n[attached_image: /tmp/image.png]\ninterject now`,
    );
    expect(engine.consumeRenderedSessionReminderBlock).toHaveBeenCalledWith("/tmp/desk.jsonl", receipt);
  });

  it("keeps a rendered receipt pending when steerSession rejects", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => true),
      steerSession: vi.fn(() => false),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await expect(submitDesktopSessionInterjection(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "interject now",
      displayMessage: { text: "interject now" },
    })).rejects.toThrow("session_busy");

    expect(engine.consumeRenderedSessionReminderBlock).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_user_message" }),
      expect.anything(),
    );
  });

  it("publishes prompt side effects only inside the synchronous post-preflight hook", async () => {
    const session = makeFakeSession();
    (session as any).sessionManager = { appendCustomEntry: vi.fn() };
    const order: string[] = [];
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (_sessionPath, text, opts, submitOptions) => {
        order.push("cache-preflight");
        expect((session as any).sessionManager.appendCustomEntry).not.toHaveBeenCalled();
        expect(engine.emitEvent).not.toHaveBeenCalled();
        const hookResult = submitOptions.afterCachePreflight();
        expect(hookResult).toBeUndefined();
        order.push("pi-prompt");
        await session.prompt(text, opts);
      }),
      emitEvent: vi.fn((event) => order.push(event.type)),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "visible", source: "bridge_rc" },
      beforeInputSideEffects: () => { order.push("retry-branch-commit"); },
    });

    expect(order.slice(0, 5)).toEqual([
      "cache-preflight",
      "retry-branch-commit",
      "session_status",
      "session_user_message",
      "pi-prompt",
    ]);
    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalled();
  });

  it("leaves no prompt events, custom entries, or consumed receipt when preflight rejects", async () => {
    const session = makeFakeSession();
    const appendCustomEntry = vi.fn();
    (session as any).sessionManager = { appendCustomEntry };
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => { throw new Error("Cache prefix contract violated: tools"); }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };
    const beforeInputSideEffects = vi.fn();

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello", source: "bridge_rc" },
      beforeInputSideEffects,
    })).rejects.toThrow("Cache prefix contract violated");

    expect(engine.emitEvent).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
    expect(engine.consumeRenderedSessionReminderBlock).not.toHaveBeenCalled();
    expect(beforeInputSideEffects).not.toHaveBeenCalled();
  });

  it("acceptance receipt rejects for an immediate preflight failure", async () => {
    const session = makeFakeSession();
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => { throw new Error("prompt preflight rejected"); }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const submission = submitDesktopSessionMessageWithReceipt(engine, {
      sessionPath: "/tmp/receipt-fast-reject.jsonl",
      text: "hello",
    });
    await expect(submission.accepted).rejects.toThrow("prompt preflight rejected");
    await expect(submission.completion).rejects.toThrow("prompt preflight rejected");
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("acceptance receipt stays pending through delayed preflight and rejects when it finally fails", async () => {
    const session = makeFakeSession();
    let finishPreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { finishPreflight = resolve; });
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => {
        await preflightGate;
        throw new Error("delayed prompt preflight rejected");
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const submission = submitDesktopSessionMessageWithReceipt(engine, {
      sessionPath: "/tmp/receipt-delayed-reject.jsonl",
      text: "hello",
    });
    let acceptedSettled = false;
    void submission.accepted.finally(() => { acceptedSettled = true; }).catch(() => {});
    await Promise.resolve();
    expect(acceptedSettled).toBe(false);
    finishPreflight();
    await expect(submission.accepted).rejects.toThrow("delayed prompt preflight rejected");
    await expect(submission.completion).rejects.toThrow("delayed prompt preflight rejected");
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("receipt resolves after accepted side effects without waiting for the model turn", async () => {
    const session = makeFakeSession();
    let finishTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (_sessionPath, _text, _opts, submitOptions) => {
        submitOptions.afterCachePreflight();
        submitOptions.afterInputAccepted();
        await turnGate;
        throw new Error("provider failed after acceptance");
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const submission = submitDesktopSessionMessageWithReceipt(engine, {
      sessionPath: "/tmp/receipt-accepted.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });
    await expect(submission.accepted).resolves.toMatchObject({
      accepted: true,
      sessionPath: "/tmp/receipt-accepted.jsonl",
    });
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_user_message" }),
      "/tmp/receipt-accepted.jsonl",
    );
    finishTurn();
    await expect(submission.completion).rejects.toThrow("provider failed after acceptance");
  });

  it("closes streaming status but retains the receipt when Pi prompt fails after the hook", async () => {
    const session = makeFakeSession();
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (_sessionPath, _text, _opts, submitOptions) => {
        submitOptions.afterCachePreflight();
        throw new Error("provider rejected prompt");
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    })).rejects.toThrow("provider rejected prompt");

    expect(engine.emitEvent.mock.calls
      .filter(([event]) => event.type === "session_status")
      .map(([event]) => event.isStreaming)).toEqual([true, false]);
    expect(engine.consumeRenderedSessionReminderBlock).not.toHaveBeenCalled();
  });

  it("consumes a silent recovery receipt without changing prompt or presentation", async () => {
    const session = makeFakeSession();
    const appendCustomEntry = vi.fn();
    (session as any).sessionManager = { appendCustomEntry };
    const recoveryReceipt = { ...receipt, unavailableToolNames: [] };
    const engine = {
      preflightSessionInput: vi.fn(),
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (_sessionPath, text, opts, submitOptions) => {
        submitOptions.afterCachePreflight();
        await session.prompt(text, opts);
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: "", receipt: recoveryReceipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });

    expect(engine.promptSession.mock.calls[0][1]).toBe("hello");
    expect(appendCustomEntry).not.toHaveBeenCalledWith(
      MESSAGE_PRESENTATION_RECORD_TYPE,
      expect.anything(),
    );
    expect(engine.consumeRenderedSessionReminderBlock)
      .toHaveBeenCalledWith("/tmp/desk.jsonl", recoveryReceipt);
  });

  it("keeps steer failures completely side-effect free when cache preflight throws", async () => {
    const session = makeFakeSession();
    const appendCustomEntry = vi.fn();
    (session as any).sessionManager = { appendCustomEntry };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => true),
      steerSession: vi.fn(() => { throw new Error("Cache prefix contract violated: tools"); }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
      renderSessionReminderBlock: vi.fn(() => ({ block: reminderBlock, receipt })),
      consumeRenderedSessionReminderBlock: vi.fn(),
    };

    await expect(submitDesktopSessionInterjection(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "interject",
      displayMessage: { text: "interject", source: "bridge_rc" },
    })).rejects.toThrow("Cache prefix contract violated");

    expect(engine.emitEvent).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
    expect(engine.consumeRenderedSessionReminderBlock).not.toHaveBeenCalled();
  });
});
