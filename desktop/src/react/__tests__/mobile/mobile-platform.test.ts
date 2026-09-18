// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installMobilePlatform } from '../../mobile/mobile-platform';

describe('mobile platform capability contract', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-platform');
    Reflect.deleteProperty(window, 'platform');
  });

  it('does not expose desktop-only file system capabilities as callable no-ops', () => {
    installMobilePlatform();

    expect(document.documentElement.getAttribute('data-platform')).toBe('web');
    expect(window.platform?.selectFolder).toBeUndefined();
    expect(window.platform?.selectFiles).toBeUndefined();
    expect(window.platform?.writeFileIfUnchanged).toBeUndefined();
    expect(window.platform?.openFolder).toBeUndefined();
    expect(window.platform?.showInFinder).toBeUndefined();
    expect(window.platform?.trashItem).toBeUndefined();
    expect(window.platform?.getFilePath).toBeUndefined();
  });

  it('routes platform settings requests through an explicit mobile event contract', () => {
    installMobilePlatform();
    const listener = vi.fn();
    const unsubscribe = window.platform?.onOpenSettingsModal?.(listener);

    window.platform?.openSettings?.('providers');

    expect(listener).toHaveBeenCalledWith('providers');
    unsubscribe?.();
    window.platform?.openSettings?.('work');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('replaces stale partial platform globals with the mobile event contract', () => {
    window.platform = {
      openSettings: vi.fn(),
      selectFolder: vi.fn(),
    } as unknown as typeof window.platform;

    installMobilePlatform();
    const listener = vi.fn();
    window.platform?.onOpenSettingsModal?.(listener);

    window.platform?.openSettings?.('providers');

    expect(listener).toHaveBeenCalledWith('providers');
    expect(window.platform?.selectFolder).toBeUndefined();
  });
});
