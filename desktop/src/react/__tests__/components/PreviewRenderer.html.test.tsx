/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewRenderer } from '../../components/preview/PreviewRenderer';
import { useStore } from '../../stores';
import { clearAppFileDragPayload, writeAppFileDragPayload } from '../../utils/app-file-drag';
import type { PreviewItem } from '../../types';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
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

describe('PreviewRenderer HTML isolation', () => {
  const htmlContent = '<script src="https://cdn.tailwindcss.com"></script><div class="text-red-500">Hello</div>';
  const previewItem: PreviewItem = {
    id: 'html-demo',
    type: 'html',
    title: 'demo.html',
    content: htmlContent,
    filePath: '/tmp/demo.html',
    ext: 'html',
  };
  let legacyNativePreviewApi: {
    showHtmlPreview: ReturnType<typeof vi.fn>;
    updateHtmlPreviewBounds: ReturnType<typeof vi.fn>;
    closeHtmlPreview: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      settingsModal: { open: false, activeTab: 'agent' },
    } as never);
    legacyNativePreviewApi = {
      showHtmlPreview: vi.fn(async () => true),
      updateHtmlPreviewBounds: vi.fn(async () => true),
      closeHtmlPreview: vi.fn(async () => true),
    };
    window.platform = legacyNativePreviewApi as unknown as typeof window.platform;
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({
      previewUrl: 'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAppFileDragPayload();
    cleanup();
  });

  it('registers HTML and renders the local preview document in a sandboxed iframe', async () => {
    const { container } = render(<PreviewRenderer previewItem={previewItem} />);

    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'demo.html',
        content: htmlContent,
        sourceFilePath: '/tmp/demo.html',
      }),
    });

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });

  it('passes the HTML preview asset root to the server registration route', () => {
    const rootedItem = {
      ...previewItem,
      sourceRootPath: '/tmp/workspace',
    } as PreviewItem & { sourceRootPath: string };

    render(<PreviewRenderer previewItem={rootedItem} />);

    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/preview/html', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        title: 'demo.html',
        content: htmlContent,
        sourceFilePath: '/tmp/demo.html',
        sourceRootPath: '/tmp/workspace',
      }),
    }));
  });

  it('keeps the iframe preview visible while the in-window settings modal is open', async () => {
    useStore.setState({
      settingsModal: { open: true, activeTab: 'skills' },
    } as never);

    const { container } = render(<PreviewRenderer previewItem={previewItem} />);

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();
    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });

  it('does not close the iframe preview when the in-window settings modal toggles', async () => {
    const { container, rerender } = render(<PreviewRenderer previewItem={previewItem} />);

    const iframe = container.querySelector<HTMLIFrameElement>('[data-html-preview-frame]');
    expect(iframe).toBeTruthy();

    await waitFor(() => {
      expect(iframe).toHaveAttribute(
        'src',
        'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
      );
    });

    useStore.setState({
      settingsModal: { open: true, activeTab: 'skills' },
    } as never);
    rerender(<PreviewRenderer previewItem={previewItem} />);

    expect(container.querySelector('[data-html-preview-frame]')).toBeTruthy();
    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();

    useStore.setState({
      settingsModal: { open: false, activeTab: 'skills' },
    } as never);
    rerender(<PreviewRenderer previewItem={previewItem} />);

    expect(container.querySelector('[data-html-preview-frame]')).toBeTruthy();
    expect(legacyNativePreviewApi.showHtmlPreview).not.toHaveBeenCalled();
    expect(legacyNativePreviewApi.closeHtmlPreview).not.toHaveBeenCalled();
  });

  it('renders PDF previews from a source URL without requiring base64 content', () => {
    const pdfItem = {
      id: 'pdf-demo',
      type: 'pdf',
      title: 'Report.PDF',
      content: '',
      filePath: '/tmp/Report.PDF',
      ext: 'pdf',
      sourceUrl: 'file:///tmp/Report.PDF',
    } as PreviewItem & { sourceUrl: string };

    const { container } = render(<PreviewRenderer previewItem={pdfItem} />);
    const iframe = container.querySelector<HTMLIFrameElement>('.preview-pdf');

    expect(iframe).toBeTruthy();
    expect(iframe).toHaveAttribute('src', 'file:///tmp/Report.PDF#toolbar=0&navpanes=0');
  });

  it('applies a workspace image dropped on the markdown cover', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
    } as unknown as typeof window.platform;
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: [
        '---',
        'cover:',
        '  image: cover.png',
        '---',
        '# Demo',
      ].join('\n'),
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    };
    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const cover = container.querySelector('.markdown-cover');
    expect(cover).toBeTruthy();

    fireEvent.dragOver(cover!, { dataTransfer });
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
  });

  it('applies a workspace image dropped on the no-cover preview top rail without a pointer overlay', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
    } as unknown as typeof window.platform;
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: '# Demo',
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    };
    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const host = container.querySelector('.markdown-cover-drop-host');
    const rail = container.querySelector('.markdown-cover-drop-rail');
    expect(host).toBeTruthy();
    expect(rail).toBeTruthy();
    expect(rail).not.toHaveAttribute('ondrop');

    fireEvent.dragOver(host!, { dataTransfer, clientY: 12 });
    expect(rail).toHaveClass('markdown-cover-drop-rail-active');
    fireEvent.drop(host!, { dataTransfer, clientY: 12 });

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
  });

  it('marks markdown body rendered after a cover for cover-aware title layout', () => {
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: [
        '---',
        'cover:',
        '  image: cover.png',
        '---',
        '# Demo',
      ].join('\n'),
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    };

    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const body = container.querySelector('.preview-markdown');

    expect(body).toHaveClass('markdown-has-cover');
    expect(body?.querySelector('h1')?.textContent).toBe('Demo');
  });

  it('removes the preview cover from the markdown file context menu', async () => {
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      writeFileIfUnchanged: vi.fn(async (_filePath: string, _content: string, _version: unknown) => ({
        ok: true,
        version: { mtimeMs: 2, size: 32, sha256: 'v2' },
      })),
    } as unknown as typeof window.platform;

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: [
        '---',
        'title: Demo',
        'cover:',
        '  image: cover.png',
        '---',
        '# Demo',
      ].join('\n'),
      filePath: '/tmp/workspace/demo.md',
      fileVersion: { mtimeMs: 1, size: 48, sha256: 'v1' },
      ext: 'md',
    };

    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const cover = container.querySelector('.markdown-cover') as HTMLElement | null;
    expect(cover).toBeTruthy();

    fireEvent.contextMenu(cover!, { clientX: 44, clientY: 72 });
    fireEvent.click(screen.getByRole('button', { name: 'preview.cover.deleteCover' }));

    await waitFor(() => {
      expect(window.platform?.writeFileIfUnchanged).toHaveBeenCalledWith(
        '/tmp/workspace/demo.md',
        [
          '---',
          'title: Demo',
          '---',
          '# Demo',
        ].join('\n'),
        { mtimeMs: 1, size: 48, sha256: 'v1' },
      );
    });
  });
});
