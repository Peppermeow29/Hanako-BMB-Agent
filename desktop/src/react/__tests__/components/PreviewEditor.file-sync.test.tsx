/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewEditor, type PreviewEditorHandle } from '../../components/PreviewEditor';
import type { PlatformApi, VersionedWriteResult } from '../../types';

vi.mock('../../utils/checkpoints', () => ({
  requestUserEditCheckpoint: vi.fn(async () => undefined),
}));

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

describe('PreviewEditor file sync', () => {
  let platform: Pick<
    PlatformApi,
    'readFile' | 'writeFile' | 'writeFileIfUnchanged' | 'writeFileBinary' | 'copyFile' | 'watchFile' | 'unwatchFile' | 'onFileChanged' | 'getFilePath'
  >;
  let elementRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T01:02:03Z'));
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
    platform = {
      readFile: vi.fn(async () => 'external update'),
      writeFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
      writeFileBinary: vi.fn(async () => true),
      copyFile: vi.fn(async () => true),
      getFilePath: vi.fn(() => null),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn(),
    };
    window.platform = platform as PlatformApi;
  });

  afterEach(() => {
    cleanup();
    elementRectSpy.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not autosave content that arrived from a parent file refresh', async () => {
    const ref = createRef<PreviewEditorHandle>();

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="external update"
          filePath="/tmp/hana-note.md"
          fileVersion={{ mtimeMs: 2, size: 15, sha256: 'external' }}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('external update');

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('uses native selection in markdown while keeping CodeMirror selection drawing for code', () => {
    const markdownRef = createRef<PreviewEditorHandle>();
    const { container: markdownContainer, unmount: unmountMarkdown } = render(
      <PreviewEditor
        ref={markdownRef}
        content="alpha\nbeta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    expect(markdownRef.current?.getView()).toBeTruthy();
    expect(markdownContainer.querySelector('.cm-selectionLayer')).toBeNull();

    unmountMarkdown();

    const codeRef = createRef<PreviewEditorHandle>();
    const { container: codeContainer } = render(
      <PreviewEditor
        ref={codeRef}
        content="const value = 1;"
        filePath="/tmp/demo.ts"
        mode="code"
        language="typescript"
      />,
    );

    expect(codeRef.current?.getView()).toBeTruthy();
    expect(codeContainer.querySelector('.cm-selectionLayer')).toBeTruthy();
  });

  it('keeps spellcheck disabled on the editable CodeMirror content surface', () => {
    const ref = createRef<PreviewEditorHandle>();
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content="中文正文"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    expect(ref.current?.getView()).toBeTruthy();
    expect(container.querySelector('.cm-content')?.getAttribute('spellcheck')).toBe('false');
  });

  it('toggles the shared block menu closed on a second handle click and keeps inline actions', () => {
    const coordsSpy = vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
      left: 200,
      right: 260,
      top: 32,
      bottom: 56,
    });
    const lineBlockSpy = vi.spyOn(EditorView.prototype, 'lineBlockAt').mockReturnValue({
      top: 32,
      bottom: 56,
      height: 24,
    } as ReturnType<EditorView['lineBlockAt']>);
    const boundarySpy = vi.spyOn(EditorView.prototype, 'moveToLineBoundary').mockImplementation(start => start);
    const ref = createRef<PreviewEditorHandle>();
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content={'Alpha\n\nBeta'}
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );
    act(() => vi.runOnlyPendingTimers());
    const handle = container.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    fireEvent.click(handle!);
    expect(document.body.querySelector('.context-menu')).toBeTruthy();
    expect(document.body.querySelector('[title="粗体"]')).toBeTruthy();
    expect(document.body.querySelector('[title="删除线"]')).toBeTruthy();
    act(() => vi.runOnlyPendingTimers());

    fireEvent.click(handle!);
    expect(document.body.querySelector('.context-menu')).toBeNull();
    coordsSpy.mockRestore();
    lineBlockSpy.mockRestore();
    boundarySpy.mockRestore();
  });

  it('offers quote-to-chat first in the right-click menu for an explicit editor selection', () => {
    const ref = createRef<PreviewEditorHandle>();
    const onQuoteRange = vi.fn();
    const { container } = render(
      <PreviewEditor
        ref={ref}
        content="Alpha Beta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
        onQuoteRange={onQuoteRange}
      />,
    );
    const view = ref.current?.getView();
    expect(view).toBeTruthy();
    act(() => view!.dispatch({ selection: { anchor: 0, head: 5 } }));

    fireEvent.contextMenu(container.querySelector('.cm-line')!, { clientX: 24, clientY: 32 });
    const items = document.body.querySelectorAll<HTMLElement>('.context-menu-item');
    expect(items[0]?.textContent).toContain('引用到对话');

    fireEvent.click(items[0]);
    expect(onQuoteRange).toHaveBeenCalledWith(view, { from: 0, to: 5 });
  });

  it('can scroll to a match without stealing focus from the find box', () => {
    const ref = createRef<PreviewEditorHandle>();
    render(
      <PreviewEditor
        ref={ref}
        content="alpha beta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    const view = ref.current?.getView();
    expect(view).toBeTruthy();
    const focusSpy = vi.spyOn(view!, 'focus');

    act(() => {
      ref.current?.scrollToOffset(0, 5, { focus: false });
    });
    expect(focusSpy).not.toHaveBeenCalled();

    act(() => {
      ref.current?.scrollToOffset(6, 10);
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('emits selection commit only after a user commit event', () => {
    const ref = createRef<PreviewEditorHandle>();
    const onSelectionChange = vi.fn();
    const onSelectionCommit = vi.fn();

    render(
      <PreviewEditor
        ref={ref}
        content="alpha\nbeta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
        onSelectionChange={onSelectionChange}
        onSelectionCommit={onSelectionCommit}
      />,
    );

    const view = ref.current?.getView();
    expect(view).toBeTruthy();

    act(() => {
      view?.dispatch({ selection: { anchor: 0, head: 5 } });
    });

    expect(onSelectionChange).toHaveBeenCalledWith(view);
    expect(onSelectionCommit).not.toHaveBeenCalled();

    fireEvent.mouseUp(view!.dom);

    expect(onSelectionCommit).toHaveBeenCalledWith(view);
  });

  it('emits selection commit when mouseup lands outside the editor on the surface window', () => {
    const ref = createRef<PreviewEditorHandle>();
    const onSelectionCommit = vi.fn();

    render(
      <PreviewEditor
        ref={ref}
        content="alpha\nbeta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
        onSelectionCommit={onSelectionCommit}
      />,
    );

    const view = ref.current?.getView();
    expect(view).toBeTruthy();

    act(() => {
      view?.dispatch({ selection: { anchor: 0, head: 5 } });
      view?.focus();
    });

    fireEvent.mouseUp(window);

    expect(onSelectionCommit).toHaveBeenCalledWith(view);
  });

  it('does not reset the CodeMirror root when the editor already lives in the main document', () => {
    const setRoot = vi.spyOn(EditorView.prototype, 'setRoot');
    const ref = createRef<PreviewEditorHandle>();

    render(
      <PreviewEditor
        ref={ref}
        content="alpha\nbeta"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    expect(ref.current?.getView()?.root).toBe(document);
    expect(setRoot).not.toHaveBeenCalled();
    setRoot.mockRestore();
  });

  it('waits for a hidden document to become visible before creating CodeMirror', async () => {
    const ref = createRef<PreviewEditorHandle>();
    let visibilityState: Document['visibilityState'] = 'hidden';
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);

    try {
      render(
        <PreviewEditor
          ref={ref}
          content={'alpha\nbeta'}
          filePath="/tmp/hana-note.md"
          mode="markdown"
        />,
      );

      await act(async () => {
        vi.advanceTimersByTime(32);
        await Promise.resolve();
      });

      expect(ref.current?.getView()).toBeNull();

      visibilityState = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(32);
        await Promise.resolve();
      });

      expect(ref.current?.getView()?.state.doc.toString()).toBe('alpha\nbeta');
    } finally {
      visibilitySpy.mockRestore();
    }
  });

  it('retries editor creation until the host has a measurable box', async () => {
    const ref = createRef<PreviewEditorHandle>();
    let measurable = false;
    elementRectSpy.mockImplementation(() => (measurable ? elementRect() : elementRect(0, 0)));

    render(
      <PreviewEditor
        ref={ref}
        content={'alpha\nbeta'}
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(32);
      await Promise.resolve();
    });

    expect(ref.current?.getView()).toBeNull();

    measurable = true;
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('alpha\nbeta');
  });

  it('saves user edits with the file version that was last loaded from disk', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const fileVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const nextVersion = { mtimeMs: 2, size: 10, sha256: 'next' };
    const onContentChange = vi.fn();
    vi.mocked(platform.writeFileIfUnchanged!).mockResolvedValueOnce({
      ok: true,
      conflict: false,
      version: nextVersion,
    });

    render(
      <PreviewEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={fileVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'user edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledWith(
      '/tmp/hana-note.md',
      'user edit',
      fileVersion,
    );
    expect(onContentChange).toHaveBeenLastCalledWith('user edit', nextVersion);
    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('saves remote editable documents through the injected save handler', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 10, size: 8, sha256: 'loaded' };
    const nextVersion = { mtimeMs: 20, size: 11, sha256: 'next' };
    const saveDocument = vi.fn(async () => ({
      ok: true,
      conflict: false,
      version: nextVersion,
    }));
    const onContentChange = vi.fn();

    render(
      <PreviewEditor
        ref={ref}
        content="original"
        fileVersion={loadedVersion}
        mode="markdown"
        saveDocument={saveDocument}
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'remote edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveDocument).toHaveBeenCalledWith('remote edit', loadedVersion);
    expect(platform.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(platform.writeFile).not.toHaveBeenCalled();
    expect(onContentChange).toHaveBeenLastCalledWith('remote edit', nextVersion);
  });

  it('preserves the cursor when parent content is refreshed', async () => {
    const ref = createRef<PreviewEditorHandle>();

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content="abcdef"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 3 } });
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="abcXYZdef"
          filePath="/tmp/hana-note.md"
          mode="markdown"
        />,
      );
    });

    const view = ref.current?.getView();
    expect(view?.state.doc.toString()).toBe('abcXYZdef');
    expect(view?.state.selection.main.head).toBe(3);
  });

  it('preserves scroll position when parent content is refreshed', async () => {
    const ref = createRef<PreviewEditorHandle>();

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content="line 1\nline 2\nline 3"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    const view = ref.current?.getView();
    expect(view).toBeTruthy();
    if (!view) return;

    const originalDispatch = view.dispatch.bind(view);
    vi.spyOn(view, 'dispatch').mockImplementation((...specs) => {
      originalDispatch(...specs);
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
    });
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.scrollLeft = 16;

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="line 1\ninserted\nline 2\nline 3"
          filePath="/tmp/hana-note.md"
          mode="markdown"
        />,
      );
    });

    expect(view.scrollDOM.scrollTop).toBe(240);
    expect(view.scrollDOM.scrollLeft).toBe(16);
  });

  it('merges cover-only refresh into unsaved markdown edits instead of replacing them', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 20, sha256: 'loaded' };
    const coverVersion = { mtimeMs: 2, size: 80, sha256: 'cover' };
    const saved = '# Demo\n\nBody';
    const coverUpdated = [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body',
    ].join('\n');
    const onContentChange = vi.fn();

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content={saved}
        filePath="/tmp/hana-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: saved.length, insert: '# Demo\n\nBody with local draft' },
        annotations: Transaction.userEvent.of('input.type'),
      });
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content={coverUpdated}
          filePath="/tmp/hana-note.md"
          fileVersion={coverVersion}
          mode="markdown"
          onContentChange={onContentChange}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const merged = [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body with local draft',
    ].join('\n');

    expect(ref.current?.getView()?.state.doc.toString()).toBe(merged);
    expect(onContentChange).toHaveBeenCalledWith(merged);
    expect(platform.writeFileIfUnchanged).toHaveBeenCalledWith(
      '/tmp/hana-note.md',
      merged,
      coverVersion,
    );
  });

  it('reports total and selected character counts', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const onStatsChange = vi.fn();

    render(
      <PreviewEditor
        ref={ref}
        content="你好ab"
        filePath="/tmp/hana-note.md"
        mode="markdown"
        onStatsChange={onStatsChange}
      />,
    );

    expect(onStatsChange).toHaveBeenLastCalledWith({ selectedChars: 0, totalChars: 4 });

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 0, head: 2 } });
    });

    expect(onStatsChange).toHaveBeenLastCalledWith({ selectedChars: 2, totalChars: 4 });
  });

  it('queues saves and does not publish stale save results over newer edits', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const firstVersion = { mtimeMs: 2, size: 10, sha256: 'first' };
    const secondVersion = { mtimeMs: 3, size: 11, sha256: 'second' };
    const onContentChange = vi.fn();

    let resolveFirst!: (value: VersionedWriteResult) => void;
    const firstWrite = new Promise<VersionedWriteResult>((resolve) => {
      resolveFirst = resolve;
    });

    vi.mocked(platform.writeFileIfUnchanged!)
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce({
        ok: true,
        conflict: false,
        version: secondVersion,
      });

    render(
      <PreviewEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'first edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'first edit'.length, insert: 'second edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        ok: true,
        conflict: false,
        version: firstVersion,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(2);
    expect(platform.writeFileIfUnchanged).toHaveBeenLastCalledWith(
      '/tmp/hana-note.md',
      'second edit',
      firstVersion,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onContentChange).not.toHaveBeenCalledWith('first edit', firstVersion);
    expect(onContentChange).toHaveBeenLastCalledWith('second edit', secondVersion);
  });

  it('does not report a self-write refresh as an external conflict while newer edits are pending', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const firstVersion = { mtimeMs: 2, size: 10, sha256: 'first' };
    const notices: Array<{ text?: string; type?: string }> = [];
    const onNotice = vi.fn((event: Event) => {
      notices.push((event as CustomEvent).detail ?? {});
    });

    let resolveFirst!: (value: VersionedWriteResult) => void;
    const firstWrite = new Promise<VersionedWriteResult>((resolve) => {
      resolveFirst = resolve;
    });

    vi.mocked(platform.writeFileIfUnchanged!).mockReturnValueOnce(firstWrite);
    window.addEventListener('hana-inline-notice', onNotice);

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'first edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'first edit'.length, insert: 'second edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirst({
        ok: true,
        conflict: false,
        version: firstVersion,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="first edit"
          filePath="/tmp/hana-note.md"
          fileVersion={firstVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    window.removeEventListener('hana-inline-notice', onNotice);

    expect(ref.current?.getView()?.state.doc.toString()).toBe('second edit');
    expect(notices.some(notice => String(notice.text ?? '').includes('settings.fileChangedOnDisk'))).toBe(false);
  });

  it('treats a same-content file version refresh as the saved editor baseline', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const caughtUpVersion = { mtimeMs: 2, size: 10, sha256: 'caught-up' };
    const externalVersion = { mtimeMs: 3, size: 15, sha256: 'external' };

    const { rerender } = render(
      <PreviewEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'local edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="local edit"
          filePath="/tmp/hana-note.md"
          fileVersion={loadedVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="local edit"
          filePath="/tmp/hana-note.md"
          fileVersion={caughtUpVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      rerender(
        <PreviewEditor
          ref={ref}
          content="external update"
          filePath="/tmp/hana-note.md"
          fileVersion={externalVersion}
          mode="markdown"
        />,
      );
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('external update');
  });

  it('re-publishes the editor draft when rejecting an unapplied external refresh', async () => {
    const ref = createRef<PreviewEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const externalVersion = { mtimeMs: 2, size: 15, sha256: 'external' };
    const onContentChange = vi.fn();
    const notices: Array<{ text?: string; type?: string }> = [];
    const onNotice = vi.fn((event: Event) => {
      notices.push((event as CustomEvent).detail ?? {});
    });
    window.addEventListener('hana-inline-notice', onNotice);

    try {
      const { rerender } = render(
        <PreviewEditor
          ref={ref}
          content="original"
          filePath="/tmp/hana-note.md"
          fileVersion={loadedVersion}
          mode="markdown"
          onContentChange={onContentChange}
        />,
      );

      await act(async () => {
        ref.current?.getView()?.dispatch({
          changes: { from: 0, to: 'original'.length, insert: 'local draft' },
          annotations: Transaction.userEvent.of('input.type'),
        });
        await Promise.resolve();
      });

      await act(async () => {
        rerender(
          <PreviewEditor
            ref={ref}
            content="external update"
            filePath="/tmp/hana-note.md"
            fileVersion={externalVersion}
            mode="markdown"
            onContentChange={onContentChange}
          />,
        );
        await Promise.resolve();
      });

      expect(ref.current?.getView()?.state.doc.toString()).toBe('local draft');
      expect(onContentChange).toHaveBeenLastCalledWith('local draft');
      expect(onContentChange).toHaveBeenCalledTimes(2);
      expect(notices.some(notice => String(notice.text ?? '').includes('settings.fileChangedOnDisk'))).toBe(true);
    } finally {
      window.removeEventListener('hana-inline-notice', onNotice);
    }
  });

  it('pastes clipboard images into the markdown attachment folder at the cursor', async () => {
    const ref = createRef<PreviewEditorHandle>();

    const { container } = render(
      <PreviewEditor
        ref={ref}
        content={'Hello\n'}
        filePath="/tmp/note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 'Hello\n'.length } });
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'clip image.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [file],
        getData: vi.fn(() => ''),
        types: ['Files'],
      },
    });

    await act(async () => {
      container.querySelector('.cm-content')?.dispatchEvent(paste);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileBinary).toHaveBeenCalledWith(
      '/tmp/文本附件/clip image-20260522-010203.png',
      'AQID',
    );
    expect(ref.current?.getView()?.state.doc.toString()).toBe(
      'Hello\n![clip image](<文本附件/clip image-20260522-010203.png>)',
    );
  });

  it('drops external files into the markdown attachment folder without reading them into renderer memory', async () => {
    const ref = createRef<PreviewEditorHandle>();
    vi.mocked(platform.getFilePath!).mockReturnValue('/source/drop.png');

    const { container } = render(
      <PreviewEditor
        ref={ref}
        content={'Start\n'}
        filePath="/tmp/note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 'Start\n'.length } });
    });

    const file = new File([new Uint8Array([4, 5, 6])], 'drop.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: [file],
        types: ['Files'],
        dropEffect: 'copy',
        getData: vi.fn(() => ''),
      },
    });

    await act(async () => {
      container.querySelector('.cm-content')?.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.copyFile).toHaveBeenCalledWith(
      '/source/drop.png',
      '/tmp/文本附件/drop-20260522-010203.png',
    );
    expect(platform.writeFileBinary).not.toHaveBeenCalled();
    expect(ref.current?.getView()?.state.doc.toString()).toBe(
      'Start\n![drop](<文本附件/drop-20260522-010203.png>)',
    );
  });
});
