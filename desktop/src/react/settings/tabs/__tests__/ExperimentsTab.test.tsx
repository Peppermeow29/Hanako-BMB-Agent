// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentsTab } from '../ExperimentsTab';
import { useSettingsStore } from '../../store';

const hanaFetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/preferences/computer-use') {
    return new Response(JSON.stringify({
      selectedProviderId: 'macos:cua',
      settings: { enabled: false, app_approvals: [] },
      status: {
        providers: [{ providerId: 'macos:cua', status: { available: false, permissions: [] } }],
        activeLease: null,
      },
    }));
  }
  if (url === '/api/experiments/session.compaction_mode' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({ ok: true, value: body.value }));
  }
  if (url === '/api/experiments/session.instant_simple_compaction' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({ ok: true, value: body.value }));
  }
  if (url === '/api/experiments/provider.deepseek_roleplay_reasoning_patch' && init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({ ok: true, value: body.value }));
  }
  if (url === '/api/experiments') {
    return new Response(JSON.stringify({
      experiments: [
        {
          id: 'session.compaction_mode',
          titleKey: 'settings.experiments.compaction.title',
          descriptionKey: 'settings.experiments.compaction.description',
          owner: 'session',
          value: 'auto',
          status: 'beta',
          risk: 'low',
          restartPolicy: 'immediate',
          valueSchema: {
            type: 'enum',
            presentation: { type: 'select' },
            options: [
              { value: 'auto', labelKey: 'settings.experiments.compaction.auto' },
              { value: 'cache_preserving', labelKey: 'settings.experiments.compaction.cachePreserving' },
              { value: 'pi_compatible', labelKey: 'settings.experiments.compaction.piCompatible' },
            ],
          },
        },
        {
          id: 'session.instant_simple_compaction',
          titleKey: 'settings.experiments.instantSimpleCompaction.title',
          descriptionKey: 'settings.experiments.instantSimpleCompaction.description',
          owner: 'session',
          value: false,
          status: 'alpha',
          risk: 'medium',
          restartPolicy: 'immediate',
          valueSchema: {
            type: 'boolean',
            presentation: { type: 'toggle' },
          },
        },
        {
          id: 'provider.deepseek_roleplay_reasoning_patch',
          titleKey: 'settings.experiments.deepseekRoleplay.title',
          descriptionKey: 'settings.experiments.deepseekRoleplay.description',
          owner: 'provider',
          value: false,
          status: 'alpha',
          risk: 'medium',
          restartPolicy: 'new_session',
          valueSchema: {
            type: 'boolean',
            presentation: { type: 'toggle' },
          },
        },
        // memory.editable_facts 已毕业转正（不再是实验），registry 目前没有
        // 存活的 owner: "memory" 实验；memory.cache_snapshot_reflection 也已退休，
        // 不会出现在 /api/experiments 里。
      ],
    }));
  }
  return new Response(JSON.stringify({ experiments: [] }));
});

vi.mock('../../api', () => ({
  hanaFetch: (...args: [string, RequestInit?]) => hanaFetchMock(...args),
}));

describe('ExperimentsTab', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useSettingsStore.setState({ platformName: 'darwin', showToast: vi.fn() } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetchMock.mockClear();
    vi.clearAllMocks();
  });

  it('shows the memory section empty state now that editable facts has graduated and cache snapshot is retired', async () => {
    render(React.createElement(ExperimentsTab));

    expect(screen.getByText('settings.experiments.memoryTitle')).toBeTruthy();
    expect(await screen.findByText('settings.experiments.empty')).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.title')).toBeNull();
    expect(screen.queryByText('settings.experiments.description')).toBeNull();

    expect(screen.queryByText('settings.experiments.editableMemory.title')).toBeNull();
    expect(screen.queryByText('settings.experiments.cacheSnapshot.title')).toBeNull();
    expect(screen.queryByText('settings.experiments.cacheSnapshot.observeOnly')).toBeNull();
  });

  it('keeps the compaction selector to three persistent modes', async () => {
    render(React.createElement(ExperimentsTab));

    await waitFor(() => {
      expect(screen.getByText('settings.experiments.compactionTitle')).toBeTruthy();
    });

    expect(screen.getByText('settings.experiments.compaction.title')).toBeTruthy();
    expect(screen.getByText('settings.experiments.compaction.description')).toBeTruthy();
    expect(screen.getByTitle('settings.experiments.compaction.auto')).toBeTruthy();

    fireEvent.click(screen.getByTitle('settings.experiments.compaction.auto'));
    expect(screen.queryByRole('option', { name: 'settings.experiments.compaction.lossyLocal' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'settings.experiments.compaction.piCompatible' }));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/session.compaction_mode',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'pi_compatible' }),
        }),
      );
    });
  });

  it('renders instant simple compaction as an independent capability toggle', async () => {
    render(React.createElement(ExperimentsTab));

    const toggle = await screen.findByRole('switch', {
      name: 'settings.experiments.instantSimpleCompaction.title',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/session.instant_simple_compaction',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });

  it('renders and saves the DeepSeek roleplay reasoning patch toggle', async () => {
    render(React.createElement(ExperimentsTab));

    const toggle = await screen.findByRole('switch', {
      name: 'settings.experiments.deepseekRoleplay.title',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/provider.deepseek_roleplay_reasoning_patch',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });

  it('hides Computer Use on Linux preview', () => {
    useSettingsStore.setState({ platformName: 'linux', showToast: vi.fn() } as never);

    render(React.createElement(ExperimentsTab));

    expect(screen.queryByText('settings.computerUse.title')).toBeNull();
  });
});
