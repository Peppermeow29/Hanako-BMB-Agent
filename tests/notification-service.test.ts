import { describe, expect, it, vi } from "vitest";
import { NotificationService, formatNotificationText } from "../lib/notifications/notification-service.ts";

describe("NotificationService", () => {
  it("keeps legacy notify calls on the desktop channel", async () => {
    const desktopEvents = [];
    const service = new NotificationService({
      emitDesktop: (event) => desktopEvents.push(event),
      getBridgeManager: () => null,
    });

    const result = await service.notify({ title: "提醒", body: "该喝水了" }, { agentId: "hana" });

    expect(desktopEvents).toEqual([
      { title: "提醒", body: "该喝水了", agentId: "hana", desktopFocusPolicy: "always" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
  });

  it("passes desktop focus policy to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "完成",
        body: "这一轮已经结束",
        desktopFocusPolicy: "when_unfocused",
      },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "完成",
      body: "这一轮已经结束",
      agentId: "hana",
      desktopFocusPolicy: "when_unfocused",
    });
  });

  it("passes the notification sessionPath to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "完成",
        body: "这一轮已经结束",
        sessionPath: "/tmp/finished.jsonl",
      },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "完成",
      body: "这一轮已经结束",
      agentId: "hana",
      desktopFocusPolicy: "always",
      sessionPath: "/tmp/finished.jsonl",
    });
  });

  it("skips repeated notifications with the same explicit idempotency key", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const first = await service.notify(
      { title: "提醒", body: "喝水", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "hana" },
    );
    const second = await service.notify(
      { title: "提醒", body: "喝水", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
    expect(second).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      skipped: true,
      deliveries: [{
        channel: "notification",
        status: "skipped",
        reason: "duplicate notification",
      }],
    });
  });

  it("delivers explicit bridge owner notifications through BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hana",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      {
        title: "AI 日报",
        body: "今天有三条新闻。",
        channels: ["bridge_owner"],
      },
      { agentId: "hana" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "AI 日报\n\n今天有三条新闻。",
      "hana",
      { contextPolicy: "record_when_delivered" },
    );
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{
        channel: "bridge_owner",
        status: "sent",
        platform: "wechat",
        sessionKey: "wx_dm_wx-user@hana",
      }],
    });
  });

  it("routes notifications with a persisted bridge delivery target to BridgeManager by default", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "wechat",
        chatId: "wx-owner",
        sessionKey: "wx_dm_wx-owner@hana",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      {
        title: "自动任务",
        body: "正文",
      },
      {
        agentId: "hana",
        notificationContext: {
          bridgeDeliveryTarget: {
            kind: "bridge",
            platform: "wechat",
            chatId: "wx-owner",
            sessionKey: "wx_dm_wx-owner@hana",
            agentId: "hana",
          },
        },
      },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "自动任务\n\n正文",
      "hana",
      {
        contextPolicy: "record_when_delivered",
        deliveryTarget: {
          kind: "bridge",
          platform: "wechat",
          chatType: "dm",
          chatId: "wx-owner",
          sessionKey: "wx_dm_wx-owner@hana",
          agentId: "hana",
        },
      },
    );
    expect(result.deliveries[0]).toMatchObject({
      channel: "bridge_owner",
      status: "sent",
      platform: "wechat",
    });
  });

  it("passes preferred bridge platforms to BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "feishu",
        chatId: "oc_owner",
        sessionKey: "fs_dm_owner@hana",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    await service.notify(
      {
        title: "提醒",
        body: "正文",
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
      },
      { agentId: "hana" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "提醒\n\n正文",
      "hana",
      {
        contextPolicy: "record_when_delivered",
        bridgePlatforms: ["feishu"],
      },
    );
  });

  it("surfaces Bridge fan-out delivery details from BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@hana",
        recorded: true,
        deliveries: [
          {
            status: "sent",
            platform: "wechat",
            chatId: "wx-user",
            sessionKey: "wx_dm_wx-user@hana",
            recorded: true,
          },
          {
            status: "sent",
            platform: "qq",
            chatId: "qq-user",
            sessionKey: "qq_dm_qq-user@hana",
            recorded: true,
          },
        ],
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      {
        title: "提醒",
        body: "正文",
        channels: ["bridge_owner"],
        bridgePlatforms: ["wechat", "qq"],
      },
      { agentId: "hana" },
    );

    expect(result.deliveries[0]).toMatchObject({
      channel: "bridge_owner",
      status: "sent",
      platform: "wechat",
      recorded: true,
      bridgeDeliveries: [
        { status: "sent", platform: "wechat", chatId: "wx-user" },
        { status: "sent", platform: "qq", chatId: "qq-user" },
      ],
    });
  });

  it("reports explicit bridge owner delivery failure when the channel is unavailable", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI 日报", body: "正文", channels: ["bridge_owner"] },
      { agentId: "hana" },
    );

    expect(result.ok).toBe(false);
    expect(emitDesktop).not.toHaveBeenCalled();
    expect(result.deliveries).toEqual([{
      channel: "bridge_owner",
      status: "failed",
      error: "bridge manager unavailable",
    }]);
  });

  it("surfaces reply_context_unavailable from BridgeManager instead of a coarse missing-target error", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        ok: false,
        error: "reply_context_unavailable",
        deliveries: [{
          status: "failed",
          platform: "wechat",
          chatId: "wx-user",
          error: "reply_context_unavailable",
        }],
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      { title: "提醒", body: "正文", channels: ["bridge_owner"] },
      {
        agentId: "hana",
        bridgeDeliveryTarget: {
          kind: "bridge",
          platform: "wechat",
          chatId: "wx-user",
          sessionKey: "wx_dm_wx-user@hana",
          agentId: "hana",
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.deliveries[0]).toMatchObject({
      channel: "bridge_owner",
      status: "failed",
      error: "reply_context_unavailable",
      bridgeDeliveries: [{
        status: "failed",
        platform: "wechat",
        chatId: "wx-user",
        error: "reply_context_unavailable",
      }],
    });
    expect(result.deliveries[0].error).not.toBe("no bridge owner delivery target available");
  });

  it("surfaces send_failed from BridgeManager with adapter message on bridge_owner", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        ok: false,
        error: "send_failed",
        message: "upstream 503",
        deliveries: [{
          status: "failed",
          platform: "wechat",
          chatId: "wx-user",
          error: "upstream 503",
        }],
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      { title: "提醒", body: "正文", channels: ["bridge_owner"] },
      { agentId: "hana" },
    );

    expect(result.ok).toBe(false);
    expect(result.deliveries[0]).toMatchObject({
      channel: "bridge_owner",
      status: "failed",
      error: "send_failed",
      message: "upstream 503",
      bridgeDeliveries: [{
        status: "failed",
        platform: "wechat",
        chatId: "wx-user",
        error: "upstream 503",
      }],
    });
  });

  it("surfaces target_missing from BridgeManager when no owner target exists", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        ok: false,
        error: "target_missing",
        deliveries: [],
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      { title: "提醒", body: "正文", channels: ["bridge_owner"] },
      { agentId: "hana" },
    );

    expect(result.ok).toBe(false);
    expect(result.deliveries[0]).toMatchObject({
      channel: "bridge_owner",
      status: "failed",
      error: "target_missing",
    });
  });

  it("treats explicit desktop and bridge channels as fan-out rather than ordered fallback", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI 日报", body: "正文", channels: ["bridge_owner", "desktop"] },
      { agentId: "hana" },
    );

    expect(emitDesktop).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([
      {
        channel: "bridge_owner",
        status: "failed",
        error: "bridge manager unavailable",
      },
      { channel: "desktop", status: "sent" },
    ]);
  });

  it("fails unsupported explicit channels instead of falling back to desktop", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI 日报", body: "正文", channels: ["sms"] },
      { agentId: "hana" },
    );

    expect(emitDesktop).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([{
      channel: "sms",
      status: "failed",
      error: "unsupported notification channel: sms",
    }]);
  });
});

describe("formatNotificationText", () => {
  it("uses the exact user-visible text for bridge delivery", () => {
    expect(formatNotificationText("标题", "正文")).toBe("标题\n\n正文");
    expect(formatNotificationText("", "正文")).toBe("正文");
    expect(formatNotificationText("标题", "")).toBe("标题");
  });
});
