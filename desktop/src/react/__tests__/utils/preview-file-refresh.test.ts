/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApi, PreviewItem } from '../../types';

const mockState: { previewItems: PreviewItem[]; openTabs: string[] } = { previewItems: [], openTabs: [] };
const mockUpsertPreviewItem = vi.fn();

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
  },
}));

vi.mock('../../stores/preview-actions', () => ({
  upsertPreviewItem: mockUpsertPreviewItem,
}));

describe('refreshPreviewItemsFromFile', () => {
  beforeEach(() => {
    mockState.previewItems = [];
    mockState.openTabs = [];
    mockUpsertPreviewItem.mockReset();
    window.platform = {
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        content: `text:${filePath}`,
        version: { mtimeMs: 10, size: 20, sha256: 'text-hash' },
      })),
      readFile: vi.fn(async (filePath: string) => `legacy:${filePath}`),
      readDocxHtml: vi.fn(async (filePath: string) => `<p>docx:${filePath}</p>`),
      readXlsxHtml: vi.fn(async (filePath: string) => `<table><tr><td>${filePath}</td></tr></table>`),
      readFileBase64: vi.fn(async (filePath: string) => `pdf:${filePath}`),
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as PlatformApi;
  });

  it('reloads matching preview items through their own preview type reader', async () => {
    mockState.previewItems = [
      {
        id: 'doc',
        type: 'docx',
        title: 'report.docx',
        content: '<p>old</p>',
        filePath: '/tmp/report.docx',
        ext: 'docx',
      },
      {
        id: 'other',
        type: 'markdown',
        title: 'other.md',
        content: '# Old',
        filePath: '/tmp/other.md',
        ext: 'md',
      },
    ];

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();
    await refreshPreviewItemsFromFile('/tmp/report.docx');

    expect(window.platform?.readDocxHtml).toHaveBeenCalledWith('/tmp/report.docx');
    expect(window.platform?.readFileSnapshot).not.toHaveBeenCalled();
    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      content: '<p>docx:/tmp/report.docx</p>',
      fileVersion: undefined,
      status: 'available',
      missingAt: null,
    });
  });

  it('refreshes PDF previews through their source URL instead of reading the file into base64', async () => {
    mockState.previewItems = [{
      id: 'pdf',
      type: 'pdf',
      title: 'report.pdf',
      content: 'old-base64',
      filePath: '/tmp/report.pdf',
      ext: 'pdf',
      sourceUrl: 'file:///old/report.pdf',
    }];

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();
    await refreshPreviewItemsFromFile('/tmp/report.pdf');

    expect(window.platform?.getFileUrl).toHaveBeenCalledWith('/tmp/report.pdf');
    expect(window.platform?.readFileBase64).not.toHaveBeenCalled();
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      content: '',
      sourceUrl: 'file:///tmp/report.pdf',
      fileVersion: undefined,
      status: 'available',
      missingAt: null,
    });
  });

  it('drops stale refresh results when a newer refresh finishes first', async () => {
    const oldVersion = { mtimeMs: 10, size: 20, sha256: 'old' };
    const newVersion = { mtimeMs: 11, size: 21, sha256: 'new' };
    mockState.previewItems = [{
      id: 'note',
      type: 'markdown',
      title: 'note.md',
      content: 'old content',
      filePath: '/tmp/note.md',
      ext: 'md',
    }];

    let resolveOld!: (value: { content: string; version: typeof oldVersion }) => void;
    const oldRead = new Promise<{ content: string; version: typeof oldVersion }>((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(window.platform!.readFileSnapshot!)
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce({
        content: 'new content',
        version: newVersion,
      });

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();

    const firstRefresh = refreshPreviewItemsFromFile('/tmp/note.md');
    const secondRefresh = refreshPreviewItemsFromFile('/tmp/note.md');

    await secondRefresh;
    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenLastCalledWith({
      ...mockState.previewItems[0],
      content: 'new content',
      fileVersion: newVersion,
      status: 'available',
      missingAt: null,
    });

    resolveOld({
      content: 'older content',
      version: oldVersion,
    });
    await firstRefresh;

    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
  });

  it('retries unchanged reads when the caller expects a file change', async () => {
    const oldVersion = { mtimeMs: 10, size: 20, sha256: 'old' };
    const newVersion = { mtimeMs: 11, size: 30, sha256: 'new' };
    mockState.previewItems = [{
      id: 'note',
      type: 'markdown',
      title: 'note.md',
      content: 'old content',
      filePath: '/tmp/note.md',
      ext: 'md',
      fileVersion: oldVersion,
    }];

    vi.mocked(window.platform!.readFileSnapshot!)
      .mockResolvedValueOnce({
        content: 'old content',
        version: oldVersion,
      })
      .mockResolvedValueOnce({
        content: 'new content',
        version: newVersion,
      });

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();

    await (refreshPreviewItemsFromFile as (
      filePath: string,
      options: { retryUnchanged: boolean; retryDelaysMs: number[] },
    ) => Promise<void>)('/tmp/note.md', {
      retryUnchanged: true,
      retryDelaysMs: [0],
    });

    expect(window.platform?.readFileSnapshot).toHaveBeenCalledTimes(2);
    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      content: 'new content',
      fileVersion: newVersion,
      status: 'available',
      missingAt: null,
    });
  });

  it('delays missing status when a transient read miss recovers during retry', async () => {
    const newVersion = { mtimeMs: 12, size: 18, sha256: 'fresh' };
    mockState.previewItems = [{
      id: 'missing',
      type: 'markdown',
      title: 'missing.md',
      content: 'stale',
      filePath: '/tmp/missing.md',
      ext: 'md',
    }];
    vi.mocked(window.platform!.readFileSnapshot!)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        content: 'fresh',
        version: newVersion,
      });
    vi.mocked(window.platform!.readFile!).mockResolvedValueOnce(null);
    const noticeSpy = vi.fn();
    window.addEventListener('hana-inline-notice', noticeSpy);

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();

    await (refreshPreviewItemsFromFile as (
      filePath: string,
      options: { retryMissing: boolean; retryDelaysMs: number[] },
    ) => Promise<void>)('/tmp/missing.md', {
      retryMissing: true,
      retryDelaysMs: [0],
    });
    window.removeEventListener('hana-inline-notice', noticeSpy);

    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      content: 'fresh',
      fileVersion: newVersion,
      status: 'available',
      missingAt: null,
    });
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it('marks matching preview items missing without dispatching an inline notice', async () => {
    mockState.previewItems = [{
      id: 'missing',
      type: 'markdown',
      title: 'missing.md',
      content: 'stale',
      filePath: '/tmp/missing.md',
      ext: 'md',
    }];
    vi.mocked(window.platform!.readFileSnapshot!).mockResolvedValueOnce(null);
    vi.mocked(window.platform!.readFile!).mockResolvedValueOnce(null);
    window.t = ((key: string) => key) as typeof window.t;
    const noticeSpy = vi.fn();
    window.addEventListener('hana-inline-notice', noticeSpy);

    const { __resetPreviewFileRefreshStateForTests, refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    __resetPreviewFileRefreshStateForTests();

    await refreshPreviewItemsFromFile('/tmp/missing.md');
    window.removeEventListener('hana-inline-notice', noticeSpy);

    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      status: 'missing',
      missingAt: expect.any(Number),
    });
    expect(noticeSpy).not.toHaveBeenCalled();
  });

});
