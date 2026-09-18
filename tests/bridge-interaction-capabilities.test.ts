import { describe, expect, it } from "vitest";
import {
  BRIDGE_INTERACTION_CAPABILITIES,
  createInteractionCapabilities,
  interactionCapabilitiesForPlatform,
} from "../lib/bridge/interaction-capabilities.ts";
import { BRIDGE_NOTIFY_PLATFORMS } from "../lib/bridge/bridge-context.ts";
import { bridgeCommands } from "../core/slash-commands/bridge-commands.ts";

describe("bridge interaction capabilities", () => {
  it("validates the declaration shape", () => {
    expect(() => createInteractionCapabilities({ confirmationMode: "text_command" } as any)).toThrow(
      /requires platform/,
    );
    expect(() => createInteractionCapabilities({ platform: "wechat", confirmationMode: "tap_card" } as any)).toThrow(
      /unsupported confirmation mode/,
    );
  });

  it("freezes declarations", () => {
    const capability = createInteractionCapabilities({
      platform: "wechat",
      confirmationMode: "text_command",
      source: "test",
    });
    expect(Object.isFrozen(capability)).toBe(true);
  });

  it("declares text-command confirmation for every bridge platform", () => {
    for (const platform of BRIDGE_NOTIFY_PLATFORMS) {
      const capability = interactionCapabilitiesForPlatform(platform);
      expect(capability.platform).toBe(platform);
      expect(capability.confirmationMode).toBe("text_command");
    }
    // 声明表与平台列表一一对应：不允许声明列表外的幽灵平台
    expect(Object.keys(BRIDGE_INTERACTION_CAPABILITIES).sort()).toEqual(
      [...BRIDGE_NOTIFY_PLATFORMS].sort(),
    );
  });

  it("throws for platforms without a declaration", () => {
    expect(() => interactionCapabilitiesForPlatform("desktop")).toThrow(
      /no interaction capabilities declared/,
    );
  });

  it("keeps the /apply text protocol in sync with the registered slash command", () => {
    // 确认文案里引导用户回复的 /apply 必须是真实注册的 bridge 命令，防止文案与协议漂移
    const apply = bridgeCommands.find((command) => command.name === "apply");
    expect(apply).toBeTruthy();
    expect(apply?.permission).toBe("owner");
  });
});
