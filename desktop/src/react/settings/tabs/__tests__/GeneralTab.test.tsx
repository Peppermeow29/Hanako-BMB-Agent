/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const getAutoLaunchStatus = vi.fn();
const setAutoLaunchEnabled = vi.fn();
const setKeepAwakeEnabled = vi.fn();
const quickChatReloadShortcut = vi.fn();
const settingsChanged = vi.fn();
const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();
const updateSettingsSnapshot = vi.fn();
const hanaFetch = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
  updateSettingsSnapshot: (...args: unknown[]) => updateSettingsSnapshot(...args),
}));

vi.mock('@/ui', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
    disabled,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={disabled || on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
  SelectWidget: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="turn-completion-notification"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { GeneralTab } from '../GeneralTab';
import { useSettingsStore } from '../../store';

function jsonResponse(data: unknown) {
  return {
    json: vi.fn(async () => data),
  };
}

function installHana(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAutoLaunchStatus,
      setAutoLaunchEnabled,
      setKeepAwakeEnabled,
      quickChatReloadShortcut,
      settingsChanged,
      ...overrides,
    },
  }));
}

beforeEach(() => {
  getAutoLaunchStatus.mockResolvedValue({
    supported: true,
    openAtLogin: false,
    openedAtLogin: false,
    status: null,
  });
  hanaFetch.mockResolvedValue(jsonResponse({
    notifications: { chatCompletion: 'never' },
  }));
  quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });
  useSettingsStore.setState({
    settingsConfig: { keep_awake: false },
    settingsSnapshot: {
      key: null,
      status: 'idle',
      data: null,
      error: null,
      requestId: 0,
      updatedAt: null,
    },
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

afterEach(() => {
  cleanup();
  getAutoLaunchStatus.mockReset();
  setAutoLaunchEnabled.mockReset();
  setKeepAwakeEnabled.mockReset();
  quickChatReloadShortcut.mockReset();
  settingsChanged.mockReset();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  updateSettingsSnapshot.mockReset();
  hanaFetch.mockReset();
  useSettingsStore.setState({
    settingsConfig: null,
    settingsSnapshot: {
      key: null,
      status: 'idle',
      data: null,
      error: null,
      requestId: 0,
      updatedAt: null,
    },
  });
  vi.unstubAllGlobals();
});

describe('GeneralTab', () => {
  it('renders startup and background controls in one section', async () => {
    installHana();

    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.startup.title')).toBeTruthy();
    const launchRow = await screen.findByText('settings.general.launchAtLogin');
    const keepAwakeRow = screen.getByText('settings.general.keepAwake');
    const quickChatSection = screen.getByText('settings.general.quickChat.title');
    const notificationSection = screen.getByText('settings.general.notifications.title');

    expect(launchRow.compareDocumentPosition(keepAwakeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keepAwakeRow.compareDocumentPosition(quickChatSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quickChatSection.compareDocumentPosition(notificationSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('settings.general.launchAtLogin-off')).toBeTruthy();
    expect(screen.getByTestId('settings.general.keepAwake-off')).toBeTruthy();
  });

  it('keeps the keep-awake switch in loading state until settings config is ready', async () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<GeneralTab />);

    const keepAwakeSwitch = await screen.findByTestId('settings.general.keepAwake-loading');
    expect(keepAwakeSwitch.getAttribute('aria-checked')).toBe('mixed');
    expect((keepAwakeSwitch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(keepAwakeSwitch);
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(setKeepAwakeEnabled).not.toHaveBeenCalled();
  });

  it('updates the launch-at-login row from the main-process result', async () => {
    installHana();
    setAutoLaunchEnabled.mockResolvedValue({
      supported: true,
      openAtLogin: true,
      openedAtLogin: false,
      status: null,
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.launchAtLogin-off'));

    await waitFor(() => expect(setAutoLaunchEnabled).toHaveBeenCalledWith(true));
    await screen.findByTestId('settings.general.launchAtLogin-on');
  });

  it('persists keep-awake preference before applying it in the main process', async () => {
    installHana();
    autoSaveConfig.mockResolvedValue(undefined);
    loadSettingsConfig.mockResolvedValue(undefined);
    setKeepAwakeEnabled.mockResolvedValue({
      enabled: true,
      active: true,
      blockerId: 42,
      type: 'prevent-app-suspension',
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.keepAwake-off'));

    await waitFor(() => expect(autoSaveConfig).toHaveBeenCalledWith({ keep_awake: true }, { silent: true }));
    await waitFor(() => expect(setKeepAwakeEnabled).toHaveBeenCalledWith(true));
    expect(autoSaveConfig.mock.invocationCallOrder[0]).toBeLessThan(setKeepAwakeEnabled.mock.invocationCallOrder[0]);
  });

  it('renders three completion categories and saves the chat preference through the notification route', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space' } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        notifications: {
          chatCompletion: 'when_session_unfocused',
          scheduledTaskCompletion: 'never',
          patrolCompletion: 'never',
        },
      }));

    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.notifications.chatCompletion')).toBeTruthy();
    expect(screen.getByText('settings.general.notifications.scheduledTaskCompletion')).toBeTruthy();
    expect(screen.getByText('settings.general.notifications.patrolCompletion')).toBeTruthy();
    const row = screen.getByTestId('chat-completion-notification-row');
    const select = within(row).getByRole('combobox');
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    expect(within(row).getByText('settings.general.notifications.whenSessionUnfocused')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'when_session_unfocused' } });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { chatCompletion: 'when_session_unfocused' } }),
    }));
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('when_session_unfocused'));
  });

  it('records and registers the quick chat shortcut', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'CommandOrControl+Shift+K' });

    render(<GeneralTab />);

    const shortcutButton = await screen.findByLabelText('settings.general.quickChat.shortcut');
    await waitFor(() => expect((shortcutButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(shortcutButton);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
    await waitFor(() => expect(settingsChanged).toHaveBeenCalledWith('quick-chat-shortcut-changed', {
      quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 },
    }));
  });

  it('saves the quick chat reuse timeout without re-registering the shortcut', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }));

    render(<GeneralTab />);

    const input = await screen.findByLabelText('settings.general.quickChat.reuseTimeout');
    fireEvent.change(input, { target: { value: '5' } });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).not.toHaveBeenCalled();
  });

  it('records macOS Option+Space as Alt+Space instead of an invisible character', async () => {
    installHana();
    hanaFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { chatCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByLabelText('settings.general.quickChat.shortcut'));
    fireEvent.keyDown(window, { key: '\u00A0', code: 'Space', altKey: true });

    await waitFor(() => expect(hanaFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
  });
});
