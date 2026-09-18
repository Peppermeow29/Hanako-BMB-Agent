import { describe, expect, it } from 'vitest';
import { collectUiContext } from '../../utils/ui-context';

describe('collectUiContext', () => {
  it('reports the workspace CWD as the viewed desk path and ignores legacy current subdirs', () => {
    const context = collectUiContext({
      deskBasePath: '/workspace',
      deskCurrentPath: 'legacy/subdir',
      previewItems: [],
      activeTabId: null,
      pinnedViewers: [],
    } as any);

    expect(context).toEqual({
      currentViewed: '/workspace',
      activeFile: null,
      activePreview: null,
      pinnedFiles: [],
    });
  });

  it('returns null when there is no desk root, preview, or pinned viewer', () => {
    const context = collectUiContext({
      deskBasePath: '',
      deskCurrentPath: 'legacy/subdir',
      previewItems: [],
      activeTabId: null,
      pinnedViewers: [],
    } as any);

    expect(context).toBeNull();
  });
});
