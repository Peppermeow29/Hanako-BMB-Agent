import { describe, expect, it } from "vitest";
import {
  buildBridgeContext,
  buildBridgePromptLine,
} from "../lib/bridge/bridge-context.ts";

describe("bridge context", () => {
  it("formats a Chinese platform line with text-command confirmation guidance", () => {
    const context = buildBridgeContext({
      sessionKey: "wx_dm_owner@hana",
      role: "owner",
    }, "zh");

    expect(buildBridgePromptLine(context, "zh")).toBe(
      "当前用户正通过微信与你对话，仅在需要理解当前平台或“这里”等指代时参考。"
      + "微信对话是纯文本渠道，没有可点击的卡片、按钮或确认弹窗；"
      + "需要用户确认的操作（如自动任务建议）由用户回复文字指令完成：回复 /apply 创建最新的自动任务建议，回复 /apply <建议ID> 指定其中一项。"
      + "需要确认时引导用户回复指令，不要让用户点击任何界面元素。",
    );
  });

  it("formats an English platform line with text-command confirmation guidance", () => {
    const context = buildBridgeContext({
      sessionKey: "fs_dm_owner@hana",
      role: "owner",
    }, "en");

    expect(buildBridgePromptLine(context, "en")).toBe(
      "The user is currently talking with you through Feishu; use this only when interpreting the current platform or references like \"here.\" "
      + "This Feishu conversation is a text-only channel without clickable cards, buttons, or confirmation dialogs; "
      + "actions that need the user's confirmation (such as automation suggestions) are completed by text commands: replying /apply creates the latest automation suggestion, and /apply <id> targets a specific one. "
      + "When confirmation is needed, guide the user to reply with the command instead of clicking any UI element.",
    );
  });

  it("attaches the platform-declared interaction capabilities to the context", () => {
    const context = buildBridgeContext({
      sessionKey: "wx_dm_owner@hana",
      role: "owner",
    }, "zh");

    expect(context.interactionCapabilities).toMatchObject({
      platform: "wechat",
      confirmationMode: "text_command",
    });
    expect(Object.isFrozen(context.interactionCapabilities)).toBe(true);
  });

  it("never tells the user to click in the confirmation guidance", () => {
    for (const sessionKey of ["wx_dm_owner@hana", "fs_dm_owner@hana", "dt_dm_owner@hana", "tg_dm_owner@hana", "qq_dm_owner@hana"]) {
      for (const locale of ["zh", "en"]) {
        const line = buildBridgePromptLine(buildBridgeContext({ sessionKey, role: "owner" }, locale), locale);
        expect(line).toContain("/apply");
        // 文案只允许以否定形式提及点击（"不要让用户点击"/"instead of clicking"）
        expect(line).not.toMatch(/请点击|点击确认|点击按钮|点击卡片/);
        expect(line.toLowerCase()).not.toMatch(/click (the|a|on)\b/);
      }
    }
  });

  it("builds detailed bridge state without turning guest chats into owner notification targets", () => {
    const ownerContext = buildBridgeContext({
      sessionKey: "fs_dm_open-id@hana",
      role: "owner",
      userId: "owner-user",
      chatId: "oc_chat",
      agentId: "hana",
    }, "zh");

    expect(ownerContext).toMatchObject({
      isBridgeSession: true,
      platform: "feishu",
      platformLabel: "飞书",
      chatType: "dm",
      role: "owner",
      sessionKey: "fs_dm_open-id@hana",
      agentId: "hana",
      userId: "owner-user",
      chatId: "oc_chat",
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
        contextPolicy: "record_when_delivered",
      },
    });

    const guestContext = buildBridgeContext({
      sessionKey: "tg_group_g1@hana",
      role: "guest",
      userId: "guest-user",
      chatId: "g1",
      agentId: "hana",
    }, "zh");

    expect(guestContext).toMatchObject({
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });
});
