/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installWindowTestT } from '../helpers/i18n-test-strings';
import { PreviewPanel } from '../../components/PreviewPanel';
import { useStore, type StoreState } from '../../stores';
import { refreshOpenPreviewDocumentsForResourceChange } from '../../utils/preview-document-refresh';
import type { PlatformApi } from '../../types';

const resourceEventMocks = vi.hoisted(() => ({
  retainLocalFileResourceWatch: vi.fn(() => vi.fn()),
  retainResourceWatch: vi.fn(() => vi.fn()),
  resourceWatchKey: (ref: any) => ref.kind === 'mount'
    ? `mount:${ref.mountId}:${String(ref.path || '').replace(/^\/+|\/+$/g, '')}`
    : `local-file:${ref.path}`,
}));

vi.mock('../../services/resource-events', () => ({
  retainLocalFileResourceWatch: resourceEventMocks.retainLocalFileResourceWatch,
  retainResourceWatch: resourceEventMocks.retainResourceWatch,
  resourceWatchKey: resourceEventMocks.resourceWatchKey,
}));

describe('PreviewPanel markdown editor status', () => {
  beforeEach(() => {
    resourceEventMocks.retainLocalFileResourceWatch.mockClear();
    resourceEventMocks.retainResourceWatch.mockClear();
    installWindowTestT();
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }));
    window.platform = {
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn(),
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        content: filePath.endsWith('inactive.ts') ? 'export const value = 2;\n' : '外部更新',
        version: { mtimeMs: 20, size: 23, sha256: 'fresh' },
      })),
      writeFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
    } as unknown as PlatformApi;
    useStore.setState({
      previewOpen: true,
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '你好ab',
        filePath: '/tmp/hana-note.md',
      }],
      openTabs: ['note'],
      activeTabId: 'note',
      markdownPreviewIds: [],
      quoteCandidate: null,
      quotedSelections: [],
      quotedSelection: null,
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      previewOpen: false,
      previewItems: [],
      openTabs: [],
      activeTabId: null,
      markdownPreviewIds: [],
      quoteCandidate: null,
      quotedSelections: [],
      quotedSelection: null,
    } as Partial<StoreState>);
  });

  it('shows selected and total character counts for editable markdown', () => {
    render(<PreviewPanel />);

    expect(screen.getByTestId('markdown-editor-status')).toHaveTextContent('选中 0 字 · 共 4 字');
  });

  it('uses the shared panel spacing and card chrome for the preview editor card', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/Preview.module.css'),
      'utf8',
    );
    const shellBlock = css.match(/\.previewBodyShell\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const bodyBlock = css.match(/\.previewPanelBody\s*\{[\s\S]*?\}/)?.[0] ?? '';

    render(<PreviewPanel />);

    expect(document.getElementById('previewBody')).toHaveClass('universal-card');
    expect(shellBlock).toMatch(/margin:\s*var\(--panel-edge-gap\);/);
    expect(bodyBlock).toMatch(/background:\s*var\(--panel-card-bg\);/);
    expect(bodyBlock).toMatch(/border-radius:\s*var\(--panel-card-radius\);/);
    expect(bodyBlock).toMatch(/border:\s*var\(--panel-card-border\);/);
    expect(bodyBlock).toMatch(/box-shadow:\s*var\(--panel-card-shadow\);/);
  });

  it('treats remote workbench markdown files as editable', () => {
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: '远程ab',
        ext: 'md',
        storageKind: 'remote-content',
        remoteContentRef: {
          kind: 'mobile-workbench',
          rootId: 'default',
          subdir: '',
          name: 'remote.md',
          contentPath: '/api/mobile/workbench/content?rootId=default&subdir=&name=remote.md',
          version: { mtimeMs: 10, size: 8 },
        },
      }],
      openTabs: ['remote-note'],
      activeTabId: 'remote-note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    expect(screen.getByTestId('markdown-editor-status')).toHaveTextContent('选中 0 字 · 共 4 字');
  });

  it('renders a moved-or-deleted page for missing preview targets instead of the editor', () => {
    useStore.setState({
      previewItems: [{
        id: 'missing-note',
        type: 'markdown',
        title: 'missing.md',
        content: 'stale content',
        filePath: '/tmp/missing.md',
        status: 'missing',
        missingAt: 1234,
      }],
      openTabs: ['missing-note'],
      activeTabId: 'missing-note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    expect(screen.getByText('原稿件已移动或者删除')).toBeInTheDocument();
    expect(within(screen.getByTestId('preview-missing-target')).getByText('missing.md')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-editor-status')).not.toBeInTheDocument();
  });

  it('refreshes an inactive open preview tab when its backing file changes', async () => {
    useStore.setState({
      previewOpen: true,
      previewItems: [
        {
          id: 'note',
          type: 'markdown',
          title: 'note.md',
          content: '你好ab',
          filePath: '/tmp/hana-note.md',
        },
        {
          id: 'inactive',
          type: 'code',
          title: 'inactive.ts',
          content: 'export const value = 1;\n',
          filePath: '/tmp/inactive.ts',
          ext: 'ts',
          language: 'ts',
        },
      ],
      openTabs: ['note', 'inactive'],
      activeTabId: 'note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    await refreshOpenPreviewDocumentsForResourceChange({
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/tmp/inactive.ts',
      },
    });

    await waitFor(() => {
      const inactive = useStore.getState().previewItems.find(item => item.id === 'inactive');
      expect(inactive?.content).toBe('export const value = 2;\n');
      expect(inactive?.fileVersion).toEqual({ mtimeMs: 20, size: 23, sha256: 'fresh' });
    });
  });

  it('refreshes open local preview files when the panel mounts', async () => {
    useStore.setState({
      previewOpen: true,
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: 'stale snapshot',
        filePath: '/tmp/hana-note.md',
        fileVersion: { mtimeMs: 1, size: 14, sha256: 'stale' },
      }],
      openTabs: ['note'],
      activeTabId: 'note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    await waitFor(() => {
      const note = useStore.getState().previewItems.find(item => item.id === 'note');
      expect(note?.content).toBe('外部更新');
      expect(note?.fileVersion).toEqual({ mtimeMs: 20, size: 23, sha256: 'fresh' });
    });
  });

  it('watches open remote workbench preview files by resolved file path across file types', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useStore.setState({
      previewOpen: false,
      deskBasePath: '/workspace',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
      previewItems: [{
        id: 'remote-code',
        type: 'code',
        title: 'app.ts',
        content: 'export const value = 1;\n',
        ext: 'ts',
        language: 'ts',
        storageKind: 'remote-content',
        remoteContentRef: {
          kind: 'workbench-file',
          mountId: 'default',
          subdir: 'src',
          name: 'app.ts',
          contentPath: '/api/workbench/content?mountId=default&subdir=src&name=app.ts',
        },
      }],
      openTabs: ['remote-code'],
      activeTabId: 'remote-code',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(resourceEventMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: '/workspace/src/app.ts' });
    });
    await Promise.resolve();
    warnSpy.mockRestore();
  });

  it('keeps retained file watches alive when the open tab set changes', async () => {
    useStore.setState({
      previewOpen: true,
      previewItems: [
        {
          id: 'note',
          type: 'markdown',
          title: 'note.md',
          content: '你好ab',
          filePath: '/tmp/hana-note.md',
        },
        {
          id: 'inactive',
          type: 'code',
          title: 'inactive.ts',
          content: 'export const value = 1;\n',
          filePath: '/tmp/inactive.ts',
          ext: 'ts',
          language: 'ts',
        },
        {
          id: 'extra',
          type: 'markdown',
          title: 'extra.md',
          content: 'extra',
          filePath: '/tmp/extra.md',
        },
      ],
      openTabs: ['note', 'inactive'],
      activeTabId: 'note',
      markdownPreviewIds: [],
    } as Partial<StoreState>);

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(resourceEventMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: '/tmp/hana-note.md' });
      expect(resourceEventMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: '/tmp/inactive.ts' });
    });

    useStore.setState({ openTabs: ['note', 'inactive', 'extra'] } as Partial<StoreState>);

    await waitFor(() => {
      expect(resourceEventMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: '/tmp/extra.md' });
    });
    const releaseNote = resourceEventMocks.retainResourceWatch.mock.results[0]?.value;
    const releaseInactive = resourceEventMocks.retainResourceWatch.mock.results[1]?.value;
    const releaseExtra = resourceEventMocks.retainResourceWatch.mock.results[2]?.value;
    expect(releaseNote).not.toHaveBeenCalled();
    expect(releaseInactive).not.toHaveBeenCalled();

    useStore.setState({ openTabs: ['note', 'extra'] } as Partial<StoreState>);

    await waitFor(() => {
      expect(releaseInactive).toHaveBeenCalledTimes(1);
    });
    expect(releaseNote).not.toHaveBeenCalled();
    expect(releaseExtra).not.toHaveBeenCalled();
  });
});
