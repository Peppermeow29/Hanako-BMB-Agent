import { describe, expect, it } from "vitest";
import {
  createWsClientRecord,
  subscribeWsClientToSession,
  wsClientCanReceiveEvent,
  wsClientCanSendMessage,
} from "../server/ws-scope.ts";

describe("websocket scope filtering", () => {
  it("allows local owner to receive legacy global events", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "local_user",
        credentialKind: "loopback_token",
        connectionKind: "local",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
      },
    });
    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(true);
    expect(wsClientCanSendMessage(client, { type: "prompt", sessionPath: "/s/a.jsonl" })).toBe(true);
  });

  it("denies remote session events outside subscribed session", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/b.jsonl",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
    })).toBe(true);
  });

  it("allows same-Studio remote clients through a studio subscription", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "session_user_message",
      studioId: "studio_1",
      sessionPath: "/s/new.jsonl",
    })).toBe(true);
    expect(wsClientCanSendMessage(client, {
      type: "prompt",
      sessionPath: "/s/new.jsonl",
    })).toBe(true);
    expect(wsClientCanSendMessage(client, {
      type: "interject",
      sessionPath: "/s/new.jsonl",
    })).toBe(true);
  });

  it("allows same-Studio LAN clients to receive session-aware notifications", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });

    expect(wsClientCanReceiveEvent(client, {
      type: "notification",
      studioId: "studio_1",
      sessionPath: "/s/finished.jsonl",
      desktopFocusPolicy: "when_session_unfocused",
    })).toBe(true);
    expect(wsClientCanReceiveEvent(client, {
      type: "notification",
      studioId: "studio_2",
      sessionPath: "/s/finished.jsonl",
      desktopFocusPolicy: "when_session_unfocused",
    })).toBe(false);
  });

  it("blocks remote base64 media events and unknown global events", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "browser_status",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
      thumbnail: "data:image/png;base64,xxx",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(false);
  });

  it("denies session events that lack explicit studioId for non-local-owner clients", () => {
    // 收紧 wsClientCanReceiveEvent：session 事件必须显式 set studioId，
    // 否则非 local owner 一律拒收（fail-closed），避免 publisher 漏 set
    // 时 fallback 到 receiver 自己的 studioId 让校验形同虚设。
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      sessionPath: "/s/a.jsonl",
      // studioId intentionally omitted
    })).toBe(false);
    // local owner 仍然能收（不受新契约约束）
    const owner = createWsClientRecord({
      principal: {
        kind: "local_user",
        credentialKind: "loopback_token",
        connectionKind: "local",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
      },
    });
    expect(wsClientCanReceiveEvent(owner, {
      type: "message",
      sessionPath: "/s/a.jsonl",
    })).toBe(true);
  });

  it("adds session subscriptions without losing prior principal", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
    });
    const next = subscribeWsClientToSession(client, {
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
    });
    expect(next.principal.principalId).toBe(client.principal.principalId);
    expect(next.subscriptions).toEqual([
      { kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" },
    ]);
  });

  it("keeps receiving session events by sessionId after the session's path changes on archive (remote subscriber)", () => {
    // A-2 判决：归档改 path 后，裸 sessionPath 相等匹配会让远程/Mobile 端静默断流。
    // 订阅时若已知 sessionId，事件里带同一个 sessionId 就该继续放行，即使 path 已经变了。
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
    });
    const subscribed = subscribeWsClientToSession(client, {
      studioId: "studio_1",
      sessionPath: "/s/active/a.jsonl",
      sessionId: "sess_abc",
    });

    expect(wsClientCanReceiveEvent(subscribed, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/archived/a.jsonl",
      sessionId: "sess_abc",
    })).toBe(true);
  });

  it("resolves sessionId once per broadcast via resolvedSessionId instead of requiring it on every event", () => {
    // 广播侧在扇出前解析一次 sessionId 时，通过第三参数传入即可命中，
    // 不需要每条 event 都显式带 sessionId 字段。
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
    });
    const subscribed = subscribeWsClientToSession(client, {
      studioId: "studio_1",
      sessionPath: "/s/active/a.jsonl",
      sessionId: "sess_xyz",
    });

    expect(wsClientCanReceiveEvent(subscribed, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/archived/a.jsonl",
    }, { resolvedSessionId: "sess_xyz" })).toBe(true);
  });

  it("still matches by path when the session has no manifest sessionId on either side", () => {
    // 兼容路径：无 manifest 的老会话双侧都没有 sessionId 时，继续按 path 相等工作，不回归。
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
    });
    const subscribed = subscribeWsClientToSession(client, {
      studioId: "studio_1",
      sessionPath: "/s/legacy/a.jsonl",
    });

    expect(wsClientCanReceiveEvent(subscribed, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/legacy/a.jsonl",
    })).toBe(true);
    expect(wsClientCanReceiveEvent(subscribed, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/legacy/b.jsonl",
    })).toBe(false);
  });
});
