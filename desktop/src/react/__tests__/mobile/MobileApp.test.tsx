// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { MobileApp } from '../../mobile/MobileApp';
import { installMobilePlatform } from '../../mobile/mobile-platform';
import registry from '../../../shared/theme-registry';
// 预热 LazyWorkspaceCompanionRail 的模块树：它在用例中途才被动态 import，全量并行
// 时 transform 队列冷且拥堵，加载耗时会吃穿 findBy 的 1s 预算（desktop-input-area
// 用例偶发超时的主因）。静态引入把加载成本移到文件收集期，React.lazy 届时从模块
// 缓存瞬时解析。
import '../../components/app/WorkspaceCompanionRail';

vi.mock('../../components/InputArea', async () => {
  const ReactModule = await import('react');
  return {
    InputArea: ({ surface }: { surface?: string }) => ReactModule.createElement('div', {
      'data-testid': 'desktop-input-area',
      'data-surface': surface || 'desktop',
      contentEditable: true,
      role: 'textbox',
      tabIndex: 0,
    }),
  };
});

vi.mock('../../components/SettingsModalShell', async () => {
  const ReactModule = await import('react');
  const { useStore } = await import('../../stores');
  return {
    SettingsModalShell: () => {
      const settingsModal = useStore(s => s.settingsModal);
      return settingsModal.open
        ? ReactModule.createElement('div', { 'data-testid': 'mobile-settings-modal' }, settingsModal.activeTab)
        : null;
    },
  };
});

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

// 用例会用 defineProperty 覆盖这些 window 属性（窄视口 / 键盘视口测试），
// 在任何用例运行前捕获原始描述符，供 afterEach 恢复，防止跨用例泄漏。
const ORIGINAL_WINDOW_VIEWPORT_DESCRIPTORS: ReadonlyArray<[string, PropertyDescriptor | undefined]> = [
  ['innerWidth', Object.getOwnPropertyDescriptor(window, 'innerWidth')],
  ['innerHeight', Object.getOwnPropertyDescriptor(window, 'innerHeight')],
  ['visualViewport', Object.getOwnPropertyDescriptor(window, 'visualViewport')],
];

describe('MobileApp', () => {
  const fetchMock = vi.fn();
  const mobileLoginTranslations: Record<string, string> = {
    'mobile.auth.title': '手机访问 Hana',
    'mobile.auth.deviceHelp': '输入桌面端为这台设备生成的访问密钥。',
    'mobile.auth.passwordHelp': '使用桌面端设置的本地账号登录。',
    'mobile.auth.tabLabel': '登录方式',
    'mobile.auth.deviceField': '访问密钥',
    'mobile.auth.deviceTab': '访问密钥',
    'mobile.auth.passwordTab': '用户名密码',
    'mobile.auth.usernameField': '用户名',
    'mobile.auth.passwordField': '密码',
    'mobile.auth.plaintextWarning': '远程明文链路不接收账号密码。',
    'mobile.auth.submit': '登录',
    'mobile.auth.scopeError': '当前登录缺少工作台权限，请重新输入访问密钥。',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    MockWebSocket.instances = [];
    document.documentElement.removeAttribute('data-platform');
    delete window.__hanaMobileUpdateAvailable;
    resetStoreForMobileTest();
    window.i18n = {
      locale: 'zh',
      defaultName: 'Hanako',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async function load(this: typeof window.i18n, locale: string) {
        this.locale = locale.startsWith('zh') ? 'zh' : locale;
        this._data = mobileLoginTranslations;
      }),
      setAgentOverrides: vi.fn(),
      t: (key: string) => {
        const value = window.i18n?._data?.[key];
        return typeof value === 'string' ? value : key;
      },
    };
    window.t = ((key: string, vars?: Record<string, string | number>) => window.i18n.t(key, vars)) as typeof window.t;
    window.setTheme = vi.fn();
    window.setSerifFont = vi.fn();
    window.setPaperTexture = vi.fn();
  });

  afterEach(() => {
    // MockWebSocket 的 onopen 挂在真实 setTimeout 上；用例结束时若还未开火，
    // 会漂进下一个用例的时间线（向已重置的 store 写 wsState、发起 fetch）。
    // 置空全部回调，保证任何提前收尾的用例都不向后泄漏。
    for (const ws of MockWebSocket.instances) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
    }
    cleanup();
    // 恢复被用例覆盖的 window 视口属性与 mobile platform 桩，防跨用例泄漏。
    // 放在 cleanup() 之后：组件卸载期间仍看到用例内的环境，卸载完再还原。
    for (const [prop, descriptor] of ORIGINAL_WINDOW_VIEWPORT_DESCRIPTORS) {
      if (descriptor) Object.defineProperty(window, prop, descriptor);
      else Reflect.deleteProperty(window, prop);
    }
    Reflect.deleteProperty(window, 'platform');
    delete window.__hanaMobileUpdateAvailable;
    vi.restoreAllMocks();
  });

  it('loads locale before showing the access-key login when no browser session exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: false, principal: null }));

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(window.i18n.load).toHaveBeenCalledWith('zh-CN');
    expect(screen.getByLabelText('访问密钥')).toBeInTheDocument();
    expect(screen.queryByText('mobile.auth.title')).not.toBeInTheDocument();
  });

  it('can submit a username and password login without sending a device credential', async () => {
    let sessionCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        sessionCalls += 1;
        return Promise.resolve(jsonResponse(sessionCalls === 1
          ? { authenticated: false, principal: null }
          : { authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write'], 'password') }));
      }
      if (url.includes('/api/web-auth/login')) return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    fireEvent.click(await screen.findByRole('tab', { name: '用户名密码' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'hana-owner' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      const loginCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/web-auth/login'));
      expect(loginCall).toBeTruthy();
      const body = JSON.parse(String(loginCall?.[1]?.body));
      expect(body).toEqual({ username: 'hana-owner', password: 'secret-password' });
      expect(body).not.toHaveProperty('credential');
    });

    // 等登录后的整条 bootstrap 链在本用例内跑完：login() → bootstrap() →
    // initializeMobileRuntime() → connectWebSocket() 无人 await，不等到 shell
    // 就绪就结束用例，会把 setState / fetch / WS onopen 泄漏给后续用例。
    await waitForMobileChatReady();
  });

  it('returns stale browser sessions without file scopes to login', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat']) }));
      }
      if (url.includes('/api/web-auth/logout')) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url)));
    });

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByText('当前登录缺少工作台权限，请重新输入访问密钥。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/web-auth/logout', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('returns stale browser sessions without resource scope to login', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'files.read', 'files.write']) }));
      }
      if (url.includes('/api/web-auth/logout')) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url)));
    });

    render(<MobileApp />);

    expect(await screen.findByText('手机访问 Hana')).toBeInTheDocument();
    expect(screen.getByText('当前登录缺少工作台权限，请重新输入访问密钥。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/web-auth/logout', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('loads chat sessions, desktop input surface, and workbench files for an authenticated phone', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    expect(await waitForMobileChatReady()).toHaveTextContent('sidebar.newChat');
    expect(screen.getByTestId('desktop-input-area')).toHaveAttribute('data-surface', 'mobile');
    expect(document.querySelector('.titlebar')).toBeInTheDocument();
    expect(titlebarNewSessionButton()).toHaveAttribute('data-mobile-titlebar-action', 'new-session');
    expect(screen.getByLabelText('titlebar.currentChatTitle')).toHaveTextContent('sidebar.newChat');
    expect(document.querySelector('.sidebar')).toBeInTheDocument();
    expect(document.querySelector('.jian-sidebar')).toBeInTheDocument();
    expect(useStore.getState().homeFolder).toBe('/workspace');
    expect(useStore.getState().selectedFolder).toBe('/workspace');
    expect(useStore.getState().agents[0]).toMatchObject({
      id: 'hana',
      homeFolder: '/workspace',
      chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
    });
    expect(useStore.getState().sessions.some(session => session.path === '/hana/sessions/one.jsonl')).toBe(true);
    expect(useStore.getState().sessionLocatorsById.sess_mobile_one).toEqual({ path: '/hana/sessions/one.jsonl' });
    fireEvent.click(screen.getByTitle('sidebar.jian'));
    expect(await screen.findByText('note.md')).toBeInTheDocument();
  });

  it('hydrates persisted mobile runtime configuration from bootstrap', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options, {
        bootstrap: {
          homeFolder: '/persisted-workspace',
          cwdHistory: ['/persisted-workspace', '/older-workspace'],
          memoryMasterEnabled: false,
          memoryEnabled: false,
          thinkingLevel: 'high',
          editor: {
            markdown: {
              fontPreset: 'sans',
              bodyFontSize: 18,
              heading1FontSize: 28,
              heading2FontSize: 24,
              heading3FontSize: 21,
              heading4FontSize: 19,
              heading5FontSize: 18,
              heading6FontSize: 17,
              lineHeight: 1.75,
              contentPadding: 30,
            },
          },
        },
      })));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();

    expect(useStore.getState()).toMatchObject({
      homeFolder: '/persisted-workspace',
      selectedFolder: '/persisted-workspace',
      cwdHistory: ['/persisted-workspace', '/older-workspace'],
      memoryMasterEnabled: false,
      memoryEnabled: false,
      thinkingLevel: 'high',
    });
    expect(document.documentElement.style.getPropertyValue('--editor-markdown-font-size')).toBe('18px');
    expect(document.documentElement.style.getPropertyValue('--editor-markdown-line-height')).toBe('1.75');
  });

  it('opens the settings modal from the mobile platform settings event', async () => {
    installMobilePlatform();
    const onOpenSettingsModal = vi.fn(window.platform?.onOpenSettingsModal?.bind(window.platform));
    window.platform!.onOpenSettingsModal = onOpenSettingsModal;
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(onOpenSettingsModal).toHaveBeenCalled());

    act(() => {
      window.platform?.openSettings?.('providers');
    });

    expect(await screen.findByTestId('mobile-settings-modal')).toHaveTextContent('providers');
  });

  it('shows a controlled reload action when the PWA has an update ready', async () => {
    const applyUpdate = vi.fn();
    window.addEventListener('hana-mobile-apply-update', applyUpdate);
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    try {
      render(<MobileApp />);
      await waitForMobileChatReady();

      act(() => {
        window.dispatchEvent(new Event('hana-mobile-update-available'));
      });

      expect(await screen.findByText('mobile.update.available')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'mobile.update.reload' }));

      expect(applyUpdate).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('hana-mobile-apply-update', applyUpdate);
    }
  });

  it('keeps a PWA update notice that arrives before the mobile shell is ready', async () => {
    const applyUpdate = vi.fn();
    window.addEventListener('hana-mobile-apply-update', applyUpdate);
    window.__hanaMobileUpdateAvailable = true;
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    try {
      render(<MobileApp />);
      await waitForMobileChatReady();

      expect(await screen.findByText('mobile.update.available')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'mobile.update.reload' }));

      expect(applyUpdate).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('hana-mobile-apply-update', applyUpdate);
    }
  });

  it('starts authenticated phones on the welcome draft instead of auto-opening the first session', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    expect(await waitForMobileChatReady()).toHaveTextContent('sidebar.newChat');
    expect(useStore.getState().sessions.some(session => session.path === '/hana/sessions/one.jsonl')).toBe(true);
    expect(useStore.getState()).toMatchObject({
      currentSessionPath: null,
      pendingNewSession: true,
      welcomeVisible: true,
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/sessions/messages'))).toBe(false);
  });

  it('normalizes desktop drawer state before rendering the mobile shell', async () => {
    stubNarrowViewport(true);
    useStore.setState({
      sidebarOpen: true,
      jianOpen: true,
      previewOpen: true,
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();

    expect(useStore.getState()).toMatchObject({
      sidebarOpen: false,
      jianOpen: false,
      previewOpen: false,
    });
    expect(document.querySelector('.mobile-drawer-scrim')).not.toBeInTheDocument();
    expect(document.querySelector('#previewPanel')).not.toBeInTheDocument();
  });

  it('refreshes mobile sessions when the phone returns to the foreground', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    const countSessionListCalls = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes('/api/sessions') && !url.includes('/api/sessions/')).length;
    const before = countSessionListCalls();

    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(countSessionListCalls()).toBeGreaterThan(before));
  });

  it('re-pulls the open session on foreground when its revision drifted while backgrounded (#1610)', async () => {
    const sessionPath = '/hana/sessions/rc.jsonl';
    let diskRevision = 'rev-1';
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      if (url.includes('/api/sessions/messages')) {
        return Promise.resolve(jsonResponse({
          messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [], revision: diskRevision,
        }));
      }
      if (url.includes('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse([
          { path: sessionPath, title: 'RC 会话', firstMessage: '', modified: '2026-06-10T00:00:00.000Z', messageCount: 2, agentId: 'hana', agentName: 'Hana', cwd: '/workspace', revision: diskRevision },
        ]));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await openMobileSession('RC 会话');

    const countMessagesCalls = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes('/api/sessions/messages')).length;
    await waitFor(() => expect(countMessagesCalls()).toBeGreaterThan(0));
    const baseline = countMessagesCalls();

    // 后台期间 Bridge /rc 写入了新消息 → 磁盘修订点前进
    diskRevision = 'rev-2';
    fireEvent(window, new Event('focus'));

    await waitFor(() => expect(countMessagesCalls()).toBeGreaterThan(baseline));
  });

  it('does not re-pull the open session on foreground when its revision is unchanged', async () => {
    const sessionPath = '/hana/sessions/idle.jsonl';
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      if (url.includes('/api/sessions/messages')) {
        return Promise.resolve(jsonResponse({
          messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [], revision: 'rev-stable',
        }));
      }
      if (url.includes('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse([
          { path: sessionPath, title: '安静会话', firstMessage: '', modified: '2026-06-10T00:00:00.000Z', messageCount: 2, agentId: 'hana', agentName: 'Hana', cwd: '/workspace', revision: 'rev-stable' },
        ]));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await openMobileSession('安静会话');

    const countMessagesCalls = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes('/api/sessions/messages')).length;
    await waitFor(() => expect(countMessagesCalls()).toBeGreaterThan(0));
    const baseline = countMessagesCalls();
    const countSessionListCalls = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes('/api/sessions') && !url.includes('/api/sessions/')).length;
    const listBaseline = countSessionListCalls();

    fireEvent(window, new Event('focus'));

    // 列表刷新已发生（说明 foreground 流程跑完），但消息不应被重拉
    await waitFor(() => expect(countSessionListCalls()).toBeGreaterThan(listBaseline));
    // 排掉 loadMobileSessions().then(reconcile) 的微任务链后再断言「没有补拉」
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(countMessagesCalls()).toBe(baseline);
  });

  it('syncs the selected session permission mode from the mobile session list', async () => {
    const planModeEvents: unknown[] = [];
    const listener = (event: Event) => {
      planModeEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener('hana-plan-mode', listener);
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      if (url.includes('/api/sessions/switch')) {
        return Promise.resolve(jsonResponse({
          cwd: '/workspace',
          workspaceFolders: [],
          memoryEnabled: true,
          permissionMode: 'read_only',
        }));
      }
      if (url.includes('/api/sessions/messages')) {
        return Promise.resolve(jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [] }));
      }
      if (url.includes('/api/sessions')) {
        return Promise.resolve(jsonResponse([
          { path: '/hana/sessions/one.jsonl', title: '日常记录', firstMessage: '', modified: '2026-05-16T00:00:00.000Z', messageCount: 2, agentId: 'hana', agentName: 'Hana', cwd: '/workspace', permissionMode: 'read_only' },
        ]));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    try {
      render(<MobileApp />);
      await waitForMobileChatReady();
      await openMobileSession('日常记录');

      await waitFor(() => {
        expect(planModeEvents).toContainEqual({ enabled: true, mode: 'read_only' });
      });
    } finally {
      window.removeEventListener('hana-plan-mode', listener);
    }
  });

  it('opens workbench files through the neutral workbench content route using the desktop preview panel', async () => {
    document.documentElement.setAttribute('data-platform', 'web');
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    fireEvent.click(screen.getByTitle('sidebar.jian'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /note\.md/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => {
        const url = String(input);
        return url.includes('/api/workbench/content')
          && url.includes('name=note.md')
          && url.includes('mountId=default');
      })).toBe(true);
      expect(useStore.getState().previewOpen).toBe(true);
      expect(useStore.getState().previewItems.some(item => item.content.includes('来自手机工作台预览'))).toBe(true);
    });
  });

  it('uses the desktop new-session draft flow on mobile instead of creating an empty session immediately', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    fireEvent.click(titlebarNewSessionButton());

    expect(useStore.getState().pendingNewSession).toBe(true);
    expect(useStore.getState().welcomeVisible).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/sessions/new'))).toBe(false);
    expect(screen.getByLabelText('titlebar.currentChatTitle')).toHaveTextContent('sidebar.newChat');
  });

  it('resets mobile global new chat to the primary agent effective default workspace', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options, {
        bootstrap: {
          currentAgentId: 'mio',
          agentName: 'Mio',
          homeFolder: '/workspace/mio',
          agents: [
            {
              id: 'hana',
              name: 'Hana',
              yuan: 'hanako',
              isPrimary: true,
              homeFolder: null,
              effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
            },
            {
              id: 'mio',
              name: 'Mio',
              yuan: 'hanako',
              isPrimary: false,
              homeFolder: '/workspace/mio',
              effectiveHomeFolder: '/workspace/mio',
            },
          ],
        },
      })));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    fireEvent.click(titlebarNewSessionButton());

    expect(useStore.getState().selectedAgentId).toBe('hana');
    expect(useStore.getState().selectedFolder).toBe('/home/test/Desktop/OH-WorkSpace');
  });

  it('leaves mobile keyboard viewport handling to the browser', async () => {
    stubNarrowViewport(true);
    const viewport = installVisualViewportStub({ height: 700, offsetTop: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    const shell = mobileShell();
    expect(shell).not.toHaveAttribute('data-mobile-keyboard-open');
    expect(shell.style.getPropertyValue('--mobile-layout-height')).toBe('');
    expect(shell.style.getPropertyValue('--mobile-keyboard-offset')).toBe('');

    fireEvent.focusIn(screen.getByTestId('desktop-input-area'));
    viewport.height = 420;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(shell).not.toHaveAttribute('data-mobile-keyboard-open');
    expect(shell.style.getPropertyValue('--mobile-layout-height')).toBe('');
    expect(shell.style.getPropertyValue('--mobile-keyboard-offset')).toBe('');
  });

  it('renders server-broadcast user messages through the desktop websocket handler', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    await openMobileSession('日常记录');
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'session_user_message',
          sessionPath: '/hana/sessions/one.jsonl',
          message: { id: 'u-mobile-1', text: '手机端发来的消息' },
        }),
      } as MessageEvent);
    });

    expect(await screen.findAllByText('手机端发来的消息')).not.toHaveLength(0);
  });

  it('shows server-created sessions from another LAN client without waiting for a refetch payload', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);

    await waitForMobileChatReady();
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'session_created',
          sessionPath: '/hana/sessions/from-desktop.jsonl',
          session: {
            path: '/hana/sessions/from-desktop.jsonl',
            title: '电脑新会话',
            firstMessage: 'desktop created',
            modified: '2026-05-16T12:00:00.000Z',
            messageCount: 1,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/workspace',
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(useStore.getState().sessions.some(session => session.path === '/hana/sessions/from-desktop.jsonl')).toBe(true);
      expect(screen.getByText('电脑新会话')).toBeInTheDocument();
    });
  });

  it('opens the session drawer from a left-edge swipe on narrow mobile', async () => {
    stubNarrowViewport(true);
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().sidebarOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 8, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 78, clientY: 228 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 82, clientY: 230 }],
    });

    expect(useStore.getState().sidebarOpen).toBe(true);
    expect(useStore.getState().jianOpen).toBe(false);
  });

  it('opens the workbench drawer from a right-edge swipe on narrow mobile', async () => {
    stubNarrowViewport(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().jianOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 382, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 305, clientY: 226 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 300, clientY: 228 }],
    });

    expect(useStore.getState().jianOpen).toBe(true);
    expect(useStore.getState().sidebarOpen).toBe(false);
  });

  it('does not open mobile drawers from non-edge swipes', async () => {
    stubNarrowViewport(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    fetchMock.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/web-auth/session')) {
        return Promise.resolve(jsonResponse({ authenticated: true, principal: principal(['chat', 'resources.read', 'files.read', 'files.write']) }));
      }
      return Promise.resolve(jsonResponse(jsonResponseForMobile(url, options)));
    });

    render(<MobileApp />);
    await waitForMobileChatReady();
    await waitFor(() => expect(useStore.getState().sidebarOpen).toBe(false));

    fireEvent.touchStart(mobileShell(), {
      touches: [{ clientX: 120, clientY: 220 }],
    });
    fireEvent.touchMove(mobileShell(), {
      touches: [{ clientX: 200, clientY: 225 }],
    });
    fireEvent.touchEnd(mobileShell(), {
      changedTouches: [{ clientX: 205, clientY: 225 }],
    });

    expect(useStore.getState().sidebarOpen).toBe(false);
    expect(useStore.getState().jianOpen).toBe(false);
  });
});

function principal(scopes: string[], credentialKind = 'device_credential') {
  return {
    kind: credentialKind === 'password' ? 'account_user' : 'device',
    credentialKind,
    connectionKind: 'lan',
    trustState: 'lan',
    serverId: 'server_1',
    userId: 'user_1',
    studioId: 'studio_1',
    scopes,
  };
}

function jsonResponseForMobile(
  url: string,
  _options?: RequestInit,
  overrides: { bootstrap?: Record<string, unknown> } = {},
): unknown {
  if (url.includes('/api/server/identity')) {
    return {
      serverId: 'server_1',
      userId: 'user_1',
      studioId: 'studio_1',
      label: 'Hana Studio',
      studioLabel: 'Hana Studio',
      userLabel: 'Owner',
      connectionKind: 'local',
      trustState: 'local',
      credentialKind: 'loopback_token',
      capabilities: ['chat', 'resources', 'files'],
    };
  }
  if (url.includes('/api/mobile/bootstrap')) {
    return {
      locale: 'zh-CN',
      agentName: 'Hana',
      userName: 'Owner',
      currentAgentId: 'hana',
      agentYuan: 'hanako',
      homeFolder: '/workspace',
      cwdHistory: ['/workspace'],
      avatars: { agent: false, user: false },
      agents: [{
        id: 'hana',
        name: 'Hana',
        yuan: 'hanako',
        isPrimary: true,
        hasAvatar: false,
        homeFolder: '/workspace',
        chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
      }],
      appearance: { theme: registry.DEFAULT_THEME, serif: true, paperTexture: false },
      ...overrides.bootstrap,
    };
  }
  if (url.includes('/api/models')) {
    return { models: [{ id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', isCurrent: true }], activeModel: null };
  }
  if (url.includes('/api/desk/files')) {
    return {
      basePath: '/workspace',
      subdir: '',
      files: [{ name: 'note.md', isDir: false, size: 12, mtime: '2026-05-16T00:00:00.000Z' }],
    };
  }
  if (url.includes('/api/workbench/content')) {
    return '# Mobile Note\n\n来自手机工作台预览';
  }
  if (url.includes('/api/desk/jian')) {
    return { content: null };
  }
  if (url.includes('/api/sessions/messages')) {
    return { messages: [], blocks: [], todos: [], hasMore: false, sessionFiles: [] };
  }
  if (url.includes('/api/sessions')) {
    return [
      { path: '/hana/sessions/one.jsonl', sessionId: 'sess_mobile_one', title: '日常记录', firstMessage: '', modified: '2026-05-16T00:00:00.000Z', messageCount: 2, agentId: 'hana', agentName: 'Hana', cwd: '/workspace' },
    ];
  }
  return {};
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
    headers: new Headers(),
  } as Response;
}

function stubNarrowViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function installVisualViewportStub({
  height,
  offsetTop,
}: {
  height: number;
  offsetTop: number;
}): EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number } {
  const viewport = new EventTarget() as EventTarget & {
    height: number;
    width: number;
    offsetTop: number;
    offsetLeft: number;
    scale: number;
  };
  viewport.height = height;
  viewport.width = 390;
  viewport.offsetTop = offsetTop;
  viewport.offsetLeft = 0;
  viewport.scale = 1;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

function mobileShell(): HTMLElement {
  const shell = document.querySelector<HTMLElement>('.mobile-desktop-root');
  if (!shell) throw new Error('mobile shell not found');
  return shell;
}

function titlebarNewSessionButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('[data-mobile-titlebar-action="new-session"]');
  if (!button) throw new Error('mobile titlebar new-session button not found');
  return button;
}

function titlebarSidebarButton(): HTMLElement {
  const button = document.getElementById('tbToggleLeft');
  if (!button) throw new Error('mobile titlebar sidebar button not found');
  return button;
}

async function openMobileSession(title: string): Promise<void> {
  if (!useStore.getState().sidebarOpen) {
    fireEvent.click(titlebarSidebarButton());
  }
  fireEvent.click(await screen.findByText(title));
}

async function waitForMobileChatReady(): Promise<HTMLElement> {
  return await screen.findByLabelText('titlebar.currentChatTitle');
}

function resetStoreForMobileTest(): void {
  useStore.setState({
    serverPort: null,
    serverToken: null,
    serverConnections: {},
    activeServerConnectionId: null,
    activeServerConnection: null,
    connected: false,
    wsState: 'disconnected',
    sessions: [],
    currentSessionPath: null,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    chatSessions: {},
    sessionRegistryFilesByPath: {},
    sessionModelsByPath: {},
    _loadMessagesVersion: {},
    streamingSessions: [],
    previewItems: [],
    openTabs: [],
    activeTabId: null,
    previewOpen: false,
    agents: [],
    currentAgentId: null,
    agentName: 'Hanako',
    userName: 'User',
    agentAvatarUrl: null,
    userAvatarUrl: null,
    models: [],
    currentModel: null,
    locale: 'zh',
    currentTab: 'chat',
    sidebarOpen: true,
    jianOpen: false,
    jianAutoCollapsed: false,
    sidebarAutoCollapsed: false,
    deskBasePath: '',
    deskCurrentPath: '',
    deskFiles: [],
    deskTreeFilesByPath: {},
    deskExpandedPaths: [],
    deskDirtyTreePaths: [],
    deskSelectedPath: '',
    deskJianContent: null,
    cwdSkills: [],
    cwdSkillsOpen: false,
    jianDrawerOpen: false,
    rightWorkspaceTab: 'workspace',
    jianView: 'desk',
    activePanel: null,
    settingsModal: { open: false, activeTab: 'agent' },
  });
}
