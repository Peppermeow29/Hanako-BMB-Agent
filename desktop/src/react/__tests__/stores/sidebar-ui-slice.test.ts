/**
 * @vitest-environment jsdom
 *
 * sidebar UI 偏好 slice：侧边栏行高与折叠状态的唯一归属。
 * 组件实例只读这里，重挂载不再各自 fetch，也就不会先渲染默认双行再跳回单行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const hanaFetchMock = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
  hanaUrl: (path: string) => path,
}));

import {
  SIDEBAR_UI_PREFS_CACHE_KEY,
  createSidebarUiSlice,
  loadSidebarUiPrefs,
  readCachedSidebarUiPrefs,
  type SidebarUiSlice,
} from '../../stores/sidebar-ui-slice';
import { useStore } from '../../stores';

function createSidebarUiStore() {
  return create<SidebarUiSlice>()((set, get) => createSidebarUiSlice(set, get));
}

function singleLinePrefsPayload() {
  return {
    sidebarUi: {
      projectView: {
        collapsedProjectIds: ['project-a'],
        collapsedFolderIds: ['folder-a'],
        showAllProjectIds: ['project-b'],
      },
      sessionList: { rowMode: 'single-line' },
    },
  };
}

describe('sidebar-ui-slice', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hanaFetchMock.mockReset();
    hanaFetchMock.mockResolvedValue({ json: async () => ({}) });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('seeds the first frame from the localStorage cache', () => {
    window.localStorage.setItem(SIDEBAR_UI_PREFS_CACHE_KEY, JSON.stringify({
      projectView: { collapsedProjectIds: ['project-a'], collapsedFolderIds: [], showAllProjectIds: [] },
      sessionList: { rowMode: 'single-line' },
    }));

    const store = createSidebarUiStore();

    expect(store.getState().sidebarUiPrefs.sessionList.rowMode).toBe('single-line');
    expect(store.getState().sidebarUiPrefs.projectView.collapsedProjectIds).toEqual(['project-a']);
    expect(store.getState().sidebarUiPrefsLoaded).toBe(false);
  });

  it('falls back to defaults when the cached value is corrupt', () => {
    window.localStorage.setItem(SIDEBAR_UI_PREFS_CACHE_KEY, '{not-json');

    expect(() => readCachedSidebarUiPrefs()).not.toThrow();

    const store = createSidebarUiStore();
    expect(store.getState().sidebarUiPrefs.sessionList.rowMode).toBe('two-line');
    expect(store.getState().sidebarUiPrefs.projectView.collapsedProjectIds).toEqual([]);
  });

  it('applySidebarUiPrefs updates the store and the cache together', () => {
    const store = createSidebarUiStore();

    store.getState().applySidebarUiPrefs(singleLinePrefsPayload());

    const state = store.getState();
    expect(state.sidebarUiPrefs.sessionList.rowMode).toBe('single-line');
    expect(state.sidebarUiPrefs.projectView.collapsedFolderIds).toEqual(['folder-a']);
    expect(state.sidebarUiPrefsLoaded).toBe(true);

    const cached = JSON.parse(window.localStorage.getItem(SIDEBAR_UI_PREFS_CACHE_KEY) || 'null');
    expect(cached).toEqual({
      projectView: {
        collapsedProjectIds: ['project-a'],
        collapsedFolderIds: ['folder-a'],
        showAllProjectIds: ['project-b'],
      },
      sessionList: { rowMode: 'single-line' },
    });
  });

  it('setSidebarProjectViewPrefs updates optimistically and persists only the project view', async () => {
    const store = createSidebarUiStore();
    store.getState().applySidebarUiPrefs(singleLinePrefsPayload());
    hanaFetchMock.mockClear();

    store.getState().setSidebarProjectViewPrefs({ collapsedProjectIds: ['project-a', 'project-c'] });

    const state = store.getState();
    expect(state.sidebarUiPrefs.projectView.collapsedProjectIds).toEqual(['project-a', 'project-c']);
    expect(state.sidebarUiPrefs.projectView.collapsedFolderIds).toEqual(['folder-a']);
    expect(state.sidebarUiPrefs.sessionList.rowMode).toBe('single-line');

    expect(hanaFetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = hanaFetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/preferences/sidebar-ui');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      projectView: {
        collapsedProjectIds: ['project-a', 'project-c'],
        collapsedFolderIds: ['folder-a'],
        showAllProjectIds: ['project-b'],
      },
    });

    const cached = JSON.parse(window.localStorage.getItem(SIDEBAR_UI_PREFS_CACHE_KEY) || 'null');
    expect(cached.projectView.collapsedProjectIds).toEqual(['project-a', 'project-c']);
  });

  it('loadSidebarUiPrefs retries with bounded backoff and applies the result to the store', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    hanaFetchMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('server is still starting');
      return { json: async () => singleLinePrefsPayload() };
    });

    const done = loadSidebarUiPrefs();
    await vi.advanceTimersByTimeAsync(299);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(599);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(attempts).toBe(3);
    expect(useStore.getState().sidebarUiPrefs.sessionList.rowMode).toBe('single-line');
    expect(useStore.getState().sidebarUiPrefsLoaded).toBe(true);
  });

  it('loadSidebarUiPrefs de-dupes concurrent calls into a single request', async () => {
    hanaFetchMock.mockImplementation(async () => ({ json: async () => singleLinePrefsPayload() }));

    await Promise.all([loadSidebarUiPrefs(), loadSidebarUiPrefs(), loadSidebarUiPrefs()]);

    expect(hanaFetchMock).toHaveBeenCalledTimes(1);
    expect(hanaFetchMock).toHaveBeenCalledWith('/api/preferences/sidebar-ui');
  });
});
