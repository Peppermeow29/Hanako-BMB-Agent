import { describe, expect, it } from 'vitest';
import {
  buildSettingsSearchEntries,
  searchSettings,
  type SettingsSearchNavItem,
} from '../settings-search-index';

const navItems: SettingsSearchNavItem[] = [
  { id: 'agent', label: '助手' },
  { id: 'providers', label: '模型' },
  { id: 'interface', label: '界面' },
  { id: 'plugins', label: '插件' },
  { id: 'plugin-native', label: 'Native Plugin' },
];

const translate = (key: string) => {
  const labels: Record<string, string> = {
    'settings.tabs.providers': '模型',
    'settings.tabs.interface': '界面',
    'settings.api.apiKey': 'API Key',
    'settings.api.searchProvider': '搜索服务',
    'settings.appearance.theme': '主题',
  };
  return labels[key] || key;
};

describe('settings search index', () => {
  it('matches explicit aliases and returns the owning settings tab path', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('api key', entries, translate);

    expect(results[0]).toMatchObject({
      id: 'providers-api-key',
      tabId: 'providers',
      title: 'API Key',
      path: '模型',
    });
  });

  it('adds native plugin settings tabs as searchable tab-level results', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('native', entries, translate);

    expect(results[0]).toMatchObject({
      id: 'plugin-native',
      tabId: 'plugin-native',
      title: 'Native Plugin',
      path: 'Native Plugin',
    });
  });

  it('sorts direct title matches ahead of broader aliases', () => {
    const entries = buildSettingsSearchEntries(navItems);
    const results = searchSettings('主题', entries, translate);

    expect(results[0]?.id).toBe('interface-theme');
  });
});
