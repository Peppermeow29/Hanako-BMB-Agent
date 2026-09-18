import { afterEach, describe, expect, it } from 'vitest';
import { clearAppFileDragPayload, writeAppFileDragPayload } from '../../utils/app-file-drag';
import { getMarkdownCoverDropImagePath } from '../../utils/markdown-cover-drop';

function dataTransferStub() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) || '',
  } as unknown as DataTransfer;
}

describe('markdown-cover-drop', () => {
  afterEach(() => {
    clearAppFileDragPayload();
  });

  it('extracts an image path from an app file drag payload', () => {
    const dataTransfer = dataTransferStub();
    writeAppFileDragPayload(dataTransfer, {
      source: 'workspace',
      files: [{
        id: 'image-1',
        name: 'desk-cover.png',
        path: '/tmp/workspace/desk-cover.png',
        mimeType: 'image/png',
      }],
    });

    expect(getMarkdownCoverDropImagePath(dataTransfer)).toBe('/tmp/workspace/desk-cover.png');
  });

  it('ignores directories and non-image files', () => {
    const dataTransfer = dataTransferStub();
    writeAppFileDragPayload(dataTransfer, {
      source: 'workspace',
      files: [
        {
          id: 'dir-1',
          name: 'images',
          path: '/tmp/workspace/images',
          isDirectory: true,
        },
        {
          id: 'doc-1',
          name: 'notes.md',
          path: '/tmp/workspace/notes.md',
          mimeType: 'text/markdown',
        },
      ],
    });

    expect(getMarkdownCoverDropImagePath(dataTransfer)).toBeNull();
  });

  it('falls back to the source path extension when the displayed name has no extension', () => {
    const dataTransfer = dataTransferStub();
    writeAppFileDragPayload(dataTransfer, {
      source: 'workspace',
      files: [{
        id: 'image-2',
        name: 'cover',
        path: '/tmp/workspace/cover.webp',
      }],
    });

    expect(getMarkdownCoverDropImagePath(dataTransfer)).toBe('/tmp/workspace/cover.webp');
  });
});
