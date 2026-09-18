// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsNav } from '../SettingsNav';
import { useSettingsStore } from '../store';

const translations: Record<string, string> = {
  'settings.settingsSearch.placeholder': '搜索设置',
  'settings.settingsSearch.clear': '清空搜索',
  'settings.settingsSearch.results': '搜索结果',
  'settings.settingsSearch.noResults': '没有找到相关设置',
  'settings.tabs.agent': '助手',
  'settings.tabs.me': '我',
  'settings.tabs.interface': '界面',
  'settings.tabs.general': '通用',
  'settings.tabs.browser': '浏览器',
  'settings.tabs.work': '工作台',
  'settings.tabs.skills': '技能',
  'settings.tabs.bridge': '桥接',
  'settings.tabs.providers': '模型',
  'settings.tabs.media': '媒体',
  'settings.tabs.sharing': '分享',
  'settings.tabs.access': '访问',
  'settings.tabs.plugins': '插件',
  'settings.tabs.experiments': '实验',
  'settings.tabs.security': '安全',
  'settings.tabs.about': '关于',
  'settings.api.apiKey': 'API Key',
  'settings.api.searchProvider': '搜索服务',
  'settings.appearance.theme': '主题',
};

describe('SettingsNav search', () => {
  beforeEach(() => {
    window.t = ((key: string) => translations[key] || key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => translations[key] || key) as typeof window.t,
    };
    useSettingsStore.setState({
      activeTab: 'agent',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('switches from the tab list to iOS-style search results and opens the result tab', () => {
    const onTabChange = vi.fn();
    render(React.createElement(SettingsNav, { onTabChange }));

    const input = screen.getByPlaceholderText('搜索设置');
    fireEvent.change(input, { target: { value: 'api key' } });

    expect(screen.getByText('搜索结果')).toBeTruthy();
    expect(screen.getByRole('button', { name: /API Key/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '助手' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /API Key/ }));

    expect(useSettingsStore.getState().activeTab).toBe('providers');
    expect(onTabChange).toHaveBeenCalledWith('providers');
  });

  it('clears back to the normal tab list', () => {
    render(React.createElement(SettingsNav));

    fireEvent.change(screen.getByPlaceholderText('搜索设置'), { target: { value: 'theme' } });
    expect(screen.getByText('搜索结果')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('清空搜索'));

    expect((screen.getByPlaceholderText('搜索设置') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '助手' })).toBeTruthy();
  });
});
