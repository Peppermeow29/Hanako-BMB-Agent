/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const hanaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ ok: true }),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/actions', () => ({
  loadSettingsConfig: vi.fn(async () => {}),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

import { MeTab } from '../../settings/tabs/MeTab';

describe('MeTab', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    useSettingsStore.setState({
      settingsAgentId: 'mio',
      currentAgentId: 'hana',
      userAvatarUrl: null,
      settingsConfig: { user: { name: 'Old Name' }, _userProfile: 'profile text' },
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('saves the user name globally, not against whichever agent settings is showing', async () => {
    render(<MeTab />);

    const nameInput = screen.getByDisplayValue('Old Name');
    fireEvent.change(nameInput, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('settings.save'));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());

    const configCalls = hanaFetchMock.mock.calls.filter(([url]) => url.includes('/config'));
    expect(configCalls).toHaveLength(1);
    expect(configCalls[0][0]).toBe('/api/config');
    expect(JSON.parse(String(configCalls[0][1]?.body))).toEqual({ user: { name: 'New Name' } });
    expect(hanaFetchMock.mock.calls.some(([url]) => url.startsWith('/api/agents/'))).toBe(false);
  });

  it('still saves the user profile through the user-level route', async () => {
    render(<MeTab />);

    const profileInput = screen.getByDisplayValue('profile text');
    fireEvent.change(profileInput, { target: { value: 'new profile' } });
    fireEvent.click(screen.getByText('settings.save'));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());

    const profileCall = hanaFetchMock.mock.calls.find(([url]) => url === '/api/user-profile');
    expect(profileCall).toBeDefined();
    expect(JSON.parse(String(profileCall?.[1]?.body))).toEqual({ content: 'new profile' });
  });
});
