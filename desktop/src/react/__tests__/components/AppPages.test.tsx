// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { AppPages } from '../../components/app/AppPages';

vi.mock('../../MainContent', () => ({
  MainContent: ({ children }: { children: React.ReactNode }) => (
    <main data-testid="main-content">{children}</main>
  ),
}));

vi.mock('../../components/right-workspace/RightWorkspacePanel', () => ({
  RightWorkspacePanel: () => <section data-testid="right-workspace-panel" />,
}));

vi.mock('../../components/plugin/PluginPageView', () => ({
  PluginPageView: ({ pluginId }: { pluginId: string }) => (
    <section data-testid="plugin-page">{pluginId}</section>
  ),
}));

vi.mock('../../components/chat/ChatArea', () => ({
  ChatArea: () => <section data-testid="chat-area" />,
}));

vi.mock('../../components/InputArea', () => ({
  InputArea: () => <section data-testid="input-area" />,
}));

vi.mock('../../components/WelcomeScreen', () => ({
  WelcomeScreen: () => <section data-testid="welcome-screen" />,
}));



vi.mock('../../components/ActivityPanel', () => ({
  ActivityPanel: () => <section data-testid="activity-panel" />,
}));

vi.mock('../../components/AutomationPanel', () => ({
  AutomationPanel: () => <section data-testid="automation-panel" />,
}));

vi.mock('../../components/SkillsPanel', () => ({
  SkillsPanel: () => <section data-testid="skills-panel" />,
}));

vi.mock('../../components/BridgePanel', () => ({
  BridgePanel: () => <section data-testid="bridge-panel" />,
}));

describe('AppPages page ownership', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      currentTab: 'chat',
      welcomeVisible: false,
      currentSessionPath: '/sessions/main.jsonl',
      currentChannel: null,
      channelIsDM: false,
      channelMembers: [],
      channelInfoName: '',
      jianOpen: true,
      previewOpen: true,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the file preview only on the chat page', () => {
    render(<AppPages />);

    expect(screen.getByTestId('chat-area')).toBeInTheDocument();
    expect(document.querySelector('#previewPanel')).toBeInTheDocument();
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument();
  });

  it('keeps the workspace companion on plugin pages without carrying the file preview', () => {
    useStore.setState({ currentTab: 'plugin:hanako-hyperframes' } as never);

    render(<AppPages />);

    expect(screen.getByTestId('plugin-page')).toHaveTextContent('hanako-hyperframes');
    expect(document.querySelector('#previewPanel')).not.toBeInTheDocument();
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument();
  });

  it('falls back to chat for a legacy channel tab without channel UI', () => {
    useStore.setState({ currentTab: 'channels' } as never);
    render(<AppPages />);
    expect(screen.getByTestId('chat-area')).toBeInTheDocument();
    expect(document.querySelector('.channel-page')).toBeNull();
    expect(document.querySelector('#channelInspector')).toBeNull();
    expect(document.querySelector('#previewPanel')).toBeInTheDocument();
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument();
  });
});
