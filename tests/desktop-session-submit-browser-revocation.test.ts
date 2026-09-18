import { describe, it, expect, vi, beforeEach } from "vitest";

// 用户急停浏览器后，BrowserManager 会记下"该 session 的浏览器授权被撤销"。
// 该 session 收到下一条用户消息时必须解除这个拒绝标记——本文件锁定这个契约。
const browserMock = vi.hoisted(() => ({ clearRevocation: vi.fn() }));

vi.mock("../lib/browser/browser-manager.ts", () => ({
  BrowserManager: {
    instance: () => ({ clearBrowserAuthorizationRevocation: browserMock.clearRevocation }),
  },
}));

import {
  submitDesktopSessionInterjection,
  submitDesktopSessionMessage,
} from "../core/desktop-session-submit.ts";

const SESSION_PATH = "/tmp/desk-revocation.jsonl";

function makeFakeSession() {
  const subs: Array<(event: any) => void> = [];
  return {
    subscribe: (fn: (event: any) => void) => {
      subs.push(fn);
      return () => {
        const idx = subs.indexOf(fn);
        if (idx >= 0) subs.splice(idx, 1);
      };
    },
    prompt: vi.fn<(...args: any[]) => Promise<any>>(async () => {
      for (const fn of subs) {
        fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
      }
    }),
    model: null,
  };
}

function makeEngine(overrides: any = {}) {
  const session = makeFakeSession();
  return {
    ensureSessionLoaded: vi.fn(async () => session),
    promptSession: vi.fn(async (_sessionPath: string, text: string, opts: any) => session.prompt(text, opts)),
    steerSession: vi.fn(() => true),
    isSessionStreaming: vi.fn(() => false),
    emitEvent: vi.fn(),
    setUiContext: vi.fn(),
    ...overrides,
  };
}

describe("desktop session submit lifts the browser authorization revocation", () => {
  beforeEach(() => {
    browserMock.clearRevocation.mockClear();
  });

  it("clears the revocation once when a user message is submitted", async () => {
    const engine = makeEngine();

    await submitDesktopSessionMessage(engine, {
      sessionPath: SESSION_PATH,
      text: "接着刚才的活儿",
      displayMessage: { text: "接着刚才的活儿" },
    });

    expect(browserMock.clearRevocation).toHaveBeenCalledTimes(1);
    expect(browserMock.clearRevocation).toHaveBeenCalledWith(SESSION_PATH);
    expect(engine.promptSession).toHaveBeenCalled();
  });

  it("clears the revocation once when an interjection steers a streaming session", async () => {
    const engine = makeEngine({ isSessionStreaming: vi.fn(() => true) });

    await submitDesktopSessionInterjection(engine, {
      sessionPath: SESSION_PATH,
      text: "等一下",
      displayMessage: { text: "等一下" },
    });

    expect(engine.steerSession).toHaveBeenCalled();
    expect(browserMock.clearRevocation).toHaveBeenCalledTimes(1);
    expect(browserMock.clearRevocation).toHaveBeenCalledWith(SESSION_PATH);
  });

  it("clears the revocation exactly once when an interjection falls back to a normal prompt", async () => {
    // 未在流式中时 submitDesktopSessionInterjection 会转交 submitDesktopSessionMessage；
    // 解除只应发生一次，说明解除点位于转交分支之后。
    const engine = makeEngine({ isSessionStreaming: vi.fn(() => false) });

    await submitDesktopSessionInterjection(engine, {
      sessionPath: SESSION_PATH,
      text: "晚到的插话",
      displayMessage: { text: "晚到的插话" },
    });

    expect(engine.steerSession).not.toHaveBeenCalled();
    expect(browserMock.clearRevocation).toHaveBeenCalledTimes(1);
    expect(browserMock.clearRevocation).toHaveBeenCalledWith(SESSION_PATH);
  });

  it("clears the revocation for the canonical path when the caller passes a session id", async () => {
    const engine = makeEngine({
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: SESSION_PATH } })),
    });

    await submitDesktopSessionMessage(engine, {
      sessionId: "sess-revocation",
      text: "换个入口提交",
      displayMessage: { text: "换个入口提交" },
    });

    expect(browserMock.clearRevocation).toHaveBeenCalledTimes(1);
    expect(browserMock.clearRevocation).toHaveBeenCalledWith(SESSION_PATH);
  });

  it("does not lift the revocation when the submission is rejected before delivery", async () => {
    const engine = makeEngine({ isSessionStreaming: vi.fn(() => true) });

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: SESSION_PATH,
      text: "会被 session_busy 拒掉",
      displayMessage: { text: "会被 session_busy 拒掉" },
    })).rejects.toThrow("session_busy");

    expect(browserMock.clearRevocation).not.toHaveBeenCalled();
  });
});
