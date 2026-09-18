/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewEditor, type PreviewEditorHandle } from '../../components/PreviewEditor';
import { clearAppFileDragPayload, writeAppFileDragPayload } from '../../utils/app-file-drag';
import type { PlatformApi } from '../../types';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  refreshPreviewDocumentTarget: vi.fn(async () => undefined),
  changeOptions: { retryMissing: true, retryUnchanged: true },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

vi.mock('../../utils/preview-document-refresh', () => ({
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS: mocks.changeOptions,
  refreshPreviewDocumentTarget: mocks.refreshPreviewDocumentTarget,
}));

vi.mock('../../utils/checkpoints', () => ({
  requestUserEditCheckpoint: vi.fn(async () => undefined),
}));

function dataTransferStub() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) || '',
  } as unknown as DataTransfer;
}

function editorDragEvent(type: 'dragover' | 'drop', dataTransfer: DataTransfer, clientY: number): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  return event as DragEvent;
}

function putWorkspaceImageOnDrag(dataTransfer: DataTransfer) {
  writeAppFileDragPayload(dataTransfer, {
    source: 'workspace',
    files: [{
      id: 'cover-source',
      name: 'cover-source.png',
      path: '/tmp/workspace/cover-source.png',
      mimeType: 'image/png',
    }],
  });
}

function elementRect(width = 960, height = 640): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('PreviewEditor markdown cover drop', () => {
  let elementRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    elementRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => elementRect());
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
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      readFile: vi.fn(async () => '# Demo'),
      copyFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn(),
    } as unknown as PlatformApi;
    mocks.hanaFetch.mockReset();
    mocks.refreshPreviewDocumentTarget.mockClear();
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => {
    clearAppFileDragPayload();
    cleanup();
    elementRectSpy.mockRestore();
  });

  it('replaces an existing editor cover when a workspace image is dropped on it', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const content = [
      '---',
      'cover:',
      '  image: old-cover.png',
      '---',
      '# Demo',
    ].join('\n');
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content={content}
        filePath="/tmp/workspace/demo.md"
        mode="markdown"
      />,
    );
    let cover: Element | null = null;
    await waitFor(() => {
      cover = container.querySelector('.cm-markdown-cover');
      expect(cover).toBeTruthy();
    });

    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);

    fireEvent.dragOver(cover!, { dataTransfer });
    expect(cover).toHaveClass('cm-markdown-cover-drop-active');
    fireEvent.drop(cover!, { dataTransfer });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
    await waitFor(() => {
      expect(mocks.refreshPreviewDocumentTarget).toHaveBeenCalledWith({
        kind: 'local-file',
        filePath: '/tmp/workspace/demo.md',
      });
    });
    expect(ref.current?.getView()?.state.doc.toString()).toBe(content);
  });

  it('keeps CodeMirror root on the detached editor document without forcing setRoot', () => {
    const setRoot = vi.spyOn(EditorView.prototype, 'setRoot');
    const ref = createRef<PreviewEditorHandle>();
    const childDocument = document.implementation.createHTMLDocument('detached-editor');
    const childWindow = Object.create(window) as Window;
    Object.defineProperty(childWindow, 'document', {
      configurable: true,
      value: childDocument,
    });
    Object.defineProperty(childDocument, 'defaultView', {
      configurable: true,
      value: childWindow,
    });

    render(
      <PreviewEditor
        ref={ref}
        content="# Detached editor"
        filePath="/tmp/workspace/detached.md"
        mode="markdown"
        saveDocument={async () => ({ ok: true, conflict: false, version: null })}
      />,
      { container: childDocument.body, baseElement: childDocument.body },
    );

    expect(ref.current?.getView()?.root).toBe(childDocument);
    expect(setRoot).not.toHaveBeenCalled();
    setRoot.mockRestore();
  });

  it('keeps regular body image drops on the markdown attachment path', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content="# Demo"
        filePath="/tmp/workspace/demo.md"
        mode="markdown"
      />,
    );
    let contentDom: Element | null = null;
    await waitFor(() => {
      contentDom = container.querySelector('.cm-content');
      expect(ref.current?.getView()?.dom).toBeTruthy();
      expect(contentDom).toBeTruthy();
    });

    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(drop, 'clientY', { value: 120 });

    await act(async () => {
      contentDom!.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.platform?.copyFile).toHaveBeenCalled();
    });
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
    expect(ref.current?.getView()?.state.doc.toString()).toContain('![cover-source](<文本附件/cover-source-');
  });

  it('uses the editor top rail as a cover drop target when the note has no cover yet', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const content = '# Demo';
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content={content}
        filePath="/tmp/workspace/demo.md"
        mode="markdown"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.cm-scroller')).toBeTruthy();
    });

    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);

    const editorDom = ref.current?.getView()?.dom;
    expect(editorDom).toBeTruthy();
    editorDom!.dispatchEvent(editorDragEvent('dragover', dataTransfer, 12));
    expect(ref.current?.getView()?.dom).toHaveClass('cm-markdown-cover-rail-active');
    editorDom!.dispatchEvent(editorDragEvent('drop', dataTransfer, 12));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
    await waitFor(() => {
      expect(mocks.refreshPreviewDocumentTarget).toHaveBeenCalledWith({
        kind: 'local-file',
        filePath: '/tmp/workspace/demo.md',
      });
    });
    expect(ref.current?.getView()?.state.doc.toString()).toBe(content);
  });
});
