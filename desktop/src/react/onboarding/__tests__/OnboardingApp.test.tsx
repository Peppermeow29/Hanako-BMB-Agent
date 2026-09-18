/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingApp } from '../OnboardingApp';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TRANSLATIONS: Record<string, Record<string, string>> = {
  zh: {
    'onboarding.welcome.title': '欢迎',
    'onboarding.welcome.subtitle': '开始设置',
    'onboarding.welcome.next': '下一步',
    'onboarding.remote.link': '已有服务器？使用局域网连接',
    'onboarding.remote.url': '服务器地址',
    'onboarding.remote.key': '访问密钥',
    'onboarding.remote.connect': '连接',
    'onboarding.remote.connecting': '连接中...',
    'onboarding.remote.failed': '连接局域网服务器失败',
    'common.cancel': '取消',
  },
  en: {
    'onboarding.welcome.title': 'Welcome',
    'onboarding.welcome.subtitle': 'Start setup',
    'onboarding.welcome.next': 'Next',
    'onboarding.remote.link': 'Already have a server? Connect over LAN',
    'onboarding.remote.url': 'Server URL',
    'onboarding.remote.key': 'Access key',
    'onboarding.remote.connect': 'Connect',
    'onboarding.remote.connecting': 'Connecting...',
    'onboarding.remote.failed': 'Failed to connect to LAN server',
    'common.cancel': 'Cancel',
  },
};

function resolveLocaleKey(locale: string): string {
  if (locale.startsWith('en')) return 'en';
  return 'zh';
}

describe('OnboardingApp locale switching', () => {
  let enLoad: Deferred<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    enLoad = createDeferred<void>();
    let loadedLocale = 'zh';

    const i18nMock = {
      locale: 'zh',
      defaultName: 'Hanako',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async (locale: string) => {
        const key = resolveLocaleKey(locale);
        i18nMock.locale = key;
        if (key === 'en') {
          await enLoad.promise;
        }
        loadedLocale = key;
      }),
      setAgentOverrides: vi.fn(),
      t: vi.fn((key: string, _vars?: Record<string, string | number>) => TRANSLATIONS[loadedLocale]?.[key] ?? key),
    };

    vi.stubGlobal('i18n', i18nMock);
    vi.stubGlobal('t', (key: string, vars?: Record<string, string | number>) => i18nMock.t(key, vars));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('hana', {
      getServerPort: vi.fn(async () => '62950'),
      getServerToken: vi.fn(async () => 'token'),
      getSplashInfo: vi.fn(async () => ({ locale: 'zh-CN', agentName: 'Hanako' })),
      getAvatarPath: vi.fn(async () => null),
      onboardingComplete: vi.fn(async () => {}),
    });
    vi.stubGlobal('platform', {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:62950/api/agents?fresh=1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ agents: [{ id: 'hana-primary', isPrimary: true, isCurrent: true }] }),
        } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the newly selected locale only after that locale has loaded', async () => {
    render(<OnboardingApp preview skipToTutorial={false} />);

    expect(await screen.findByRole('heading', { name: '欢迎' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    await act(async () => {
      enLoad.resolve();
      await enLoad.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    });
  });

  it('lets first-run users connect to an existing LAN server from the welcome page', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:62950/api/agents?fresh=1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ agents: [{ id: 'hana-primary', isPrimary: true, isCurrent: true }] }),
        } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/web-auth/login') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/server/identity') {
        return {
          ok: true,
          json: async () => ({
            connectionKind: 'lan',
            serverId: 'server_lan',
            serverNodeId: 'node_lan',
            userId: 'user_lan',
            studioId: 'studio_lan',
            label: 'LAN Server',
            trustState: 'lan',
            authState: 'paired',
            credentialKind: 'device_credential',
            capabilities: ['chat', 'resources', 'files'],
          }),
        } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnboardingApp preview={false} skipToTutorial={false} />);

    fireEvent.click(await screen.findByRole('button', { name: '已有服务器？使用局域网连接' }));
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'http://192.168.31.75:14500' },
    });
    fireEvent.change(screen.getByLabelText('访问密钥'), {
      target: { value: 'fixture-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(window.hana.onboardingComplete).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.31.75:14500/api/web-auth/login', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('shows an ambiguous agent error without hiding the LAN connection escape hatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ agents: [{ id: 'agent-a' }, { id: 'agent-b' }] }),
    } as Response)));

    render(<OnboardingApp preview={false} skipToTutorial={false} />);

    expect(await screen.findByRole('heading', { name: '欢迎' })).toBeInTheDocument();
    expect(screen.getByText('Onboarding target agent is ambiguous')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已有服务器？使用局域网连接' })).toBeInTheDocument();
  });

  it('uses a six-step flow and moves directly from model selection to workspace selection', async () => {
    const { container } = render(<OnboardingApp preview skipToTutorial={false} />);

    expect(await screen.findByRole('heading', { name: '欢迎' })).toBeInTheDocument();
    expect(container.querySelectorAll('.onboarding-dot')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.name.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.name.next' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.provider.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.model.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.workspace.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'onboarding.theme.title' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('.onboarding-dot')[4]).toHaveClass('active');

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.workspace.back' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.model.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.workspace.next' }));
    expect(await screen.findByRole('heading', { name: 'onboarding.tutorial.title' })).toBeInTheDocument();
    expect(container.querySelectorAll('.onboarding-dot')[5]).toHaveClass('active');
  });

  it('opens the tutorial as the sixth step when tutorial preview is requested', async () => {
    const { container } = render(<OnboardingApp preview skipToTutorial />);

    expect(await screen.findByRole('heading', { name: 'onboarding.tutorial.title' })).toBeInTheDocument();
    expect(container.querySelectorAll('.onboarding-dot')).toHaveLength(6);
    expect(container.querySelectorAll('.onboarding-dot')[5]).toHaveClass('active');
    expect(screen.queryByRole('heading', { name: 'onboarding.theme.title' })).not.toBeInTheDocument();
  });
});
