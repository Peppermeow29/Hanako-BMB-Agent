// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { ChatSidebarContent } from '../../components/app/ChatSidebar';

vi.mock('../../components/channels/ChannelList', () => ({
  ChannelListSidebar: () => <section data-testid="channel-list-sidebar" />,
}));

vi.mock('../../components/RegionalErrorBoundary', () => ({
  RegionalErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/SessionList', () => ({
  SessionList: () => <section data-testid="session-list" />,
}));

vi.mock('../../components/notices/SidebarNoticeSlot', () => ({
  SidebarNoticeSlot: () => null,
}));

vi.mock('../../stores/browser-slice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/browser-slice')>();
  return {
    ...actual,
    useAnyBrowserRunning: () => false,
  };
});

describe('ChatSidebarContent', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'sidebar.title': '对话',
      'sidebar.newChat': '新对话',
      'sidebar.collapse': '收起',
      'sidebar.bridgeShort': '桥接',
      'sidebar.activity': '助手活动',
      'automation.title': '任务计划',
      'skills.panel.title': 'Skills',
      'browser.background': '浏览器',
      'browser.backgroundHint': '浏览器',
      'settings.title': '设置',
    }[key] || key)) as typeof window.t;
    useStore.setState({
      automationCount: 0,
      bridgeDotConnected: false,
      currentAgentId: 'agent-a',
      currentTab: 'chat',
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the skills panel from the activity bar below automation', () => {
    const onTogglePanel = vi.fn();

    render(
      <ChatSidebarContent
        showSettingsButton={false}
        onNewSession={vi.fn()}
        onCollapse={vi.fn()}
        onTogglePanel={onTogglePanel}
      />,
    );

    const skillsButton = screen.getByRole('button', { name: 'Skills' });
    expect(skillsButton.previousElementSibling).toHaveTextContent('任务计划');

    fireEvent.click(skillsButton);

    expect(onTogglePanel).toHaveBeenCalledWith('skills');
  });
});
