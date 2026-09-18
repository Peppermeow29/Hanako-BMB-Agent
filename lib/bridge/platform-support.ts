// Runtime support is separate from historical session/config platform names.
export const SUPPORTED_BRIDGE_PLATFORMS = Object.freeze(["wechat", "feishu"]);

export function isBridgePlatformSupported(platform: unknown): boolean {
  return typeof platform === "string" && SUPPORTED_BRIDGE_PLATFORMS.includes(platform);
}

export function bridgePlatformUnavailableMessage(platform: unknown): string {
  return `Bridge platform ${String(platform)} is not included in this edition. Use WeChat or Feishu.`;
}

export function assertBridgePlatformSupported(platform: unknown): void {
  if (!isBridgePlatformSupported(platform)) throw new Error(bridgePlatformUnavailableMessage(platform));
}
