export type BridgePlatform = 'feishu' | 'wechat';

export interface BridgePlatformDescriptor {
  id: BridgePlatform;
  labelKey?: string;
  fallbackLabel: string;
  panelOrder: number;
  settingsOrder?: number;
  settingsEnabled: boolean;
  statusAffectsSidebarDot?: boolean;
}

export const BRIDGE_PLATFORM_DESCRIPTORS: readonly BridgePlatformDescriptor[] = [
  { id: 'feishu', labelKey: 'settings.bridge.feishu', fallbackLabel: 'Feishu', panelOrder: 10, settingsOrder: 30, settingsEnabled: true },
  { id: 'wechat', labelKey: 'settings.bridge.wechat', fallbackLabel: 'WeChat', panelOrder: 20, settingsOrder: 20, settingsEnabled: true },
];

export const BRIDGE_PANEL_PLATFORMS = [...BRIDGE_PLATFORM_DESCRIPTORS]
  .sort((a, b) => a.panelOrder - b.panelOrder);

export const BRIDGE_SETTINGS_PLATFORMS = BRIDGE_PANEL_PLATFORMS
  .filter((platform) => platform.settingsEnabled)
  .sort((a, b) => (a.settingsOrder ?? a.panelOrder) - (b.settingsOrder ?? b.panelOrder));

export function isBridgePlatform(value: unknown): value is BridgePlatform {
  return typeof value === 'string' && BRIDGE_PLATFORM_DESCRIPTORS.some((platform) => platform.id === value);
}

export function bridgePlatformLabel(
  platform: BridgePlatform | BridgePlatformDescriptor,
  translate?: (key: string) => string,
): string {
  const descriptor = typeof platform === 'string'
    ? BRIDGE_PLATFORM_DESCRIPTORS.find((item) => item.id === platform)
    : platform;
  if (!descriptor) return String(platform || '');
  if (descriptor.labelKey && translate) return translate(descriptor.labelKey);
  return descriptor.fallbackLabel;
}
