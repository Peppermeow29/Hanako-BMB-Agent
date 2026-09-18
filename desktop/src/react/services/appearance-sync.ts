import registry from '../../shared/theme-registry';
import { isPaperTextureEnabled } from '../../shared/appearance-preferences';
import { hanaFetch } from '../hooks/use-hana-fetch';

export interface SyncedAppearancePreferences {
  theme?: string;
  serif?: boolean;
  paperTexture?: boolean;
  leavesOverlay?: boolean;
}

export function readBrowserAppearancePreferences(): Required<SyncedAppearancePreferences> {
  return {
    theme: registry.migrateSavedTheme(window.localStorage.getItem(registry.STORAGE_KEY)),
    serif: window.localStorage.getItem('hana-font-serif') !== '0',
    paperTexture: isPaperTextureEnabled(window.localStorage),
    leavesOverlay: window.localStorage.getItem('hana-leaves-overlay') === '1',
  };
}

export function applySyncedAppearancePreferences(preferences?: SyncedAppearancePreferences | null): void {
  if (!preferences || typeof preferences !== 'object') return;
  if (preferences.theme) window.setTheme?.(preferences.theme);
  if (typeof preferences.serif === 'boolean') window.setSerifFont?.(preferences.serif);
  if (typeof preferences.paperTexture === 'boolean') window.setPaperTexture?.(preferences.paperTexture);
  if (typeof preferences.leavesOverlay === 'boolean') {
    window.localStorage.setItem('hana-leaves-overlay', preferences.leavesOverlay ? '1' : '0');
    window.dispatchEvent(new CustomEvent('hana-settings', {
      detail: { type: 'leaves-overlay-changed', enabled: preferences.leavesOverlay },
    }));
  }
}

export async function persistAppearancePreferences(
  preferences: SyncedAppearancePreferences = readBrowserAppearancePreferences(),
): Promise<void> {
  await hanaFetch('/api/preferences/appearance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
}
