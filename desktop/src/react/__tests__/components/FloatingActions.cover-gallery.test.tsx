/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_GALLERY_PRESETS } from '../../../../../shared/cover-gallery-presets.ts';
import { COVER_GALLERY_ITEMS } from '../../components/preview/cover-gallery-assets';
import { FloatingActions } from '../../components/preview/FloatingActions';
import { useStore, type StoreState } from '../../stores';
import type { PlatformApi } from '../../types';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

describe('FloatingActions cover gallery', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      selectFiles: vi.fn(async () => ['/tmp/local-cover.png']),
      readFile: vi.fn(async () => null),
      readFileSnapshot: vi.fn(async () => ({
        content: '---\ncover:\n  image: 文本附件/demo-cover.jpg\n---\n# Demo\n',
        version: 'v-cover',
      })),
    } as unknown as PlatformApi;
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, cover: { image: '文本附件/demo-cover.jpg' } }), { status: 200 });
    });
    useStore.setState({
      currentAgentId: 'agent-1',
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '# Demo\n',
        filePath: '/tmp/note.md',
      }],
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      currentAgentId: null,
      previewItems: [],
      locale: '',
    } as Partial<StoreState>);
  });

  it('keeps every shared preset mapped to a renderer asset', () => {
    expect(COVER_GALLERY_ITEMS).toHaveLength(COVER_GALLERY_PRESETS.length);
    expect(COVER_GALLERY_ITEMS.every(item => item.src && item.id)).toBe(true);
  });

  it('does not expose the removed pink daisy fireworks preset', () => {
    expect(COVER_GALLERY_PRESETS.some(item => item.id === 'pink-daisy-fireworks')).toBe(false);
    expect(COVER_GALLERY_ITEMS.some(item => item.title === '粉菊烟火')).toBe(false);
  });

  it('removes a gallery preset when its thumbnail fails to load', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));
    fireEvent.click(screen.getByText('cover.gallery.title'));

    const firstItem = COVER_GALLERY_ITEMS[0];
    const itemButton = screen.getByRole('button', { name: firstItem.title });
    const image = itemButton.querySelector('img');
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(screen.queryByRole('button', { name: firstItem.title })).not.toBeInTheDocument();
  });

  it('opens the built-in gallery card and applies the selected preset', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));
    fireEvent.click(screen.getByText('cover.gallery.title'));

    expect(screen.getByRole('dialog', { name: 'cover.gallery.title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: COVER_GALLERY_PRESETS[0].title }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/preset/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/tmp/note.md',
            presetId: COVER_GALLERY_PRESETS[0].id,
          }),
        }),
      );
    });

    await waitFor(() => {
      const item = useStore.getState().previewItems[0];
      expect(item.content).toContain('cover:');
      expect(item.fileVersion).toBe('v-cover');
    });
  });

  it('hides upload cover when the runtime has no file picker capability', async () => {
    window.platform = {} as unknown as PlatformApi;
    const originalFileReader = window.FileReader;
    Object.defineProperty(window, 'FileReader', { configurable: true, value: undefined });

    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));

    expect(screen.queryByRole('button', { name: 'cover.gallery.upload' })).not.toBeInTheDocument();
    Object.defineProperty(window, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('refreshes markdown preview toggle i18n after locale sync', async () => {
    window.t = ((key: string) => key) as typeof window.t;

    render(
      <FloatingActions
        content="# Demo\n"
        contentType="text"
        showMarkdownPreviewToggle
        onToggleMarkdownPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'preview.markdownPreview' })).toBeInTheDocument();

    window.t = ((key: string) => (
      key === 'preview.markdownPreview' ? '预览' : key
    )) as typeof window.t;
    useStore.setState({ locale: 'zh' } as Partial<StoreState>);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument();
    });
  });

  it('applies an uploaded cover without sending agent scope', async () => {
    render(<FloatingActions content="# Demo\n" filePath="/tmp/note.md" contentType="markdown" />);

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));
    fireEvent.click(screen.getByText('cover.gallery.upload'));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filePath: '/tmp/note.md',
            imageFilePath: '/tmp/local-cover.png',
          }),
        }),
      );
    });
  });

  it('shows cover actions for remote workbench markdown and applies presets by target', async () => {
    const remoteContentRef = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: { mtimeMs: 10, size: 7 },
    } as any;

    render(
      <FloatingActions
        content="# Remote\n"
        contentType="markdown"
        remoteContentRef={remoteContentRef}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));
    fireEvent.click(screen.getByText('cover.gallery.title'));
    fireEvent.click(screen.getByRole('button', { name: COVER_GALLERY_PRESETS[0].title }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/preset/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            target: {
              kind: 'workbench-file',
              mountId: 'mount_docs',
              subdir: 'notes',
              name: 'remote.md',
            },
            presetId: COVER_GALLERY_PRESETS[0].id,
          }),
        }),
      );
    });
  });

  it('uploads selected client cover bytes for remote workbench markdown', async () => {
    window.platform = {
      selectFiles: vi.fn(async () => ['/client/cover.png']),
      readFileBase64: vi.fn(async () => 'PNG_BASE64'),
    } as unknown as PlatformApi;
    const remoteContentRef = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: '',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=&name=remote.md',
      version: { mtimeMs: 10, size: 7 },
    } as any;

    render(
      <FloatingActions
        content="# Remote\n"
        contentType="markdown"
        remoteContentRef={remoteContentRef}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('cover.make')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('cover.make'));
    fireEvent.click(screen.getByText('cover.gallery.upload'));

    await waitFor(() => {
      expect(window.platform?.readFileBase64).toHaveBeenCalledWith('/client/cover.png');
      expect(mocks.hanaFetch).toHaveBeenCalledWith(
        '/api/desk/beautify/cover/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            target: {
              kind: 'workbench-file',
              mountId: 'mount_docs',
              subdir: '',
              name: 'remote.md',
            },
            image: {
              filename: 'cover.png',
              contentBase64: 'PNG_BASE64',
            },
          }),
        }),
      );
    });
  });
});
