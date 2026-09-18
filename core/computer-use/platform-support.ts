import { normalizeComputerUseSettings } from "./settings.ts";

// This edition preserves settings compatibility but ships no native GUI providers.

export function isComputerUsePlatformSupported(_platform = process.platform) {
  return false;
}

export function effectiveComputerUseSettings(settings = {}, { platform = process.platform } = {}) {
  const normalized = normalizeComputerUseSettings(settings || {});
  if (isComputerUsePlatformSupported(platform)) return normalized;
  return {
    ...normalized,
    enabled: false,
  };
}

export function selectedComputerProviderId(settings = {}, { platform = process.platform } = {}) {
  if (!isComputerUsePlatformSupported(platform)) return null;
  const normalized = normalizeComputerUseSettings(settings || {});
  return normalized.provider_by_platform?.[platform] || null;
}
