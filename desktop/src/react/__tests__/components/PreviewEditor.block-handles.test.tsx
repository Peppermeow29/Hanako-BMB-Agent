/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markdownBlockHandlePlugin,
  type MarkdownBlockMenuRequest,
} from '../../editor/markdown-block-handles';
import {
  markdownBlockSelectionPlugin,
  selectedMarkdownBlocks,
  setMarkdownBlockSelection,
} from '../../editor/markdown-block-selection';
import { collectMarkdownBlocks } from '../../editor/markdown-blocks';
import { markdownCoverField } from '../../editor/cover-field';
import { markdownDecoPlugin } from '../../editor/md-decorations';
import { tableDecoField } from '../../editor/table-field';

function elementRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 960,
    height: 640,
    top: 0,
    right: 960,
    bottom: 640,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(type: string, pointerId: number, clientY: number, clientX = 40): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

describe('markdown block handle rail', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let coordsSpy: ReturnType<typeof vi.spyOn>;
  let lineBlockSpy: ReturnType<typeof vi.spyOn>;
  let lineBoundarySpy: ReturnType<typeof vi.spyOn>;
  let posAtCoordsSpy: ReturnType<typeof vi.spyOn>;
  let documentTopSpy: ReturnType<typeof vi.spyOn>;
  let scaleYSpy: ReturnType<typeof vi.spyOn>;
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cancelRafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(elementRect);
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => elementRect());
    coordsSpy = vi.spyOn(EditorView.prototype, 'coordsAtPos').mockImplementation(function coords(
      this: EditorView,
      pos: number,
    ) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    lineBlockSpy = vi.spyOn(EditorView.prototype, 'lineBlockAt').mockImplementation(function lineBlock(
      this: EditorView,
      pos: number,
    ) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number * 32;
      return { top, bottom: top + 24, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    lineBoundarySpy = vi.spyOn(EditorView.prototype, 'moveToLineBoundary').mockImplementation(function boundary(
      this: EditorView,
      start,
    ) {
      return EditorSelection.cursor(this.state.doc.lineAt(start.head).to);
    });
    posAtCoordsSpy = vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function posAtCoords(
      this: EditorView,
      coordinates: { x: number; y: number },
    ) {
      const lineNumber = Math.min(
        this.state.doc.lines,
        Math.max(1, Math.floor(coordinates.y / 32)),
      );
      return this.state.doc.line(lineNumber).from;
    });
    documentTopSpy = vi.spyOn(EditorView.prototype, 'documentTop', 'get').mockReturnValue(0);
    scaleYSpy = vi.spyOn(EditorView.prototype, 'scaleY', 'get').mockReturnValue(1);
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => (
      window.setTimeout(() => callback(0), 0)
    ));
    cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    rectSpy.mockRestore();
    coordsSpy.mockRestore();
    lineBlockSpy.mockRestore();
    lineBoundarySpy.mockRestore();
    posAtCoordsSpy.mockRestore();
    documentTopSpy.mockRestore();
    scaleYSpy.mockRestore();
    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
    vi.useRealTimers();
  });

  function createView(
    onOpenMenu = vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
    doc = 'Alpha\n\nBeta\n\nGamma',
  ): {
    view: EditorView;
    onOpenMenu: typeof onOpenMenu;
  } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          markdownBlockSelectionPlugin(),
          markdownBlockHandlePlugin({ onOpenMenu }),
        ],
      }),
    });
    vi.runOnlyPendingTimers();
    return { view, onOpenMenu };
  }

  it('opens the shared menu with the clicked top-level block as its target', () => {
    const { view, onOpenMenu } = createView();
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(handles).toHaveLength(3);
    fireEvent.click(handles[1]);

    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        type: 'Paragraph',
        source: 'Beta',
        blocks: [expect.objectContaining({ source: 'Beta' })],
      }),
    }));
    view.destroy();
  });

  it('keeps the same Grabber DOM node after a click-only pointer sequence', () => {
    const { view, onOpenMenu } = createView();
    const firstHandle = view.dom.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    fireEvent(firstHandle!, pointerEvent('pointerdown', 33, 32));
    fireEvent(firstHandle!, pointerEvent('pointerup', 33, 32));
    fireEvent.click(firstHandle!);
    vi.runOnlyPendingTimers();

    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector('.cm-markdown-block-handle')).toBe(firstHandle);
    view.destroy();
  });

  it('opens one menu target for the whole highlighted block range', () => {
    const { view, onOpenMenu } = createView();
    const [alpha, beta] = collectMarkdownBlocks(view.state);
    view.dispatch({ effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }) });
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    fireEvent.click(handles[1]);

    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        type: 'BlockRange',
        from: alpha.from,
        to: beta.to,
        source: 'Alpha\n\nBeta',
        blocks: [
          expect.objectContaining({ source: 'Alpha' }),
          expect.objectContaining({ source: 'Beta' }),
        ],
      }),
    }));
    view.destroy();
  });

  it('clears an old block range before opening a handle outside that range', () => {
    const { view, onOpenMenu } = createView();
    const [alpha, beta] = collectMarkdownBlocks(view.state);
    view.dispatch({ effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }) });
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    fireEvent.click(handles[2]);

    expect(selectedMarkdownBlocks(view.state)).toEqual([]);
    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        type: 'Paragraph',
        source: 'Gamma',
        blocks: [expect.objectContaining({ source: 'Gamma' })],
      }),
    }));
    view.destroy();
  });

  it('moves a block with pointer drag as one undoable transaction', () => {
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 7, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 7, 220));
    fireEvent(firstHandle, pointerEvent('pointerup', 7, 220));

    expect(view.state.doc.toString()).toBe('Beta\n\nGamma\n\nAlpha');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Alpha\n\nBeta\n\nGamma');
    view.destroy();
  });

  it('marquee-selects a contiguous top-level block range from the side gutter', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();

    fireEvent(view.dom, pointerEvent('pointerdown', 21, 32, 100));
    fireEvent(view.dom, pointerEvent('pointermove', 21, 100, 100));
    vi.runOnlyPendingTimers();

    expect(selectedMarkdownBlocks(view.state).map(block => block.source)).toEqual(['Alpha', 'Beta']);
    const surface = view.dom.querySelector<HTMLElement>('.cm-markdown-block-selection-surface');
    expect(surface?.hidden).toBe(false);
    expect(surface?.style.left).toBe('200px');
    expect(surface?.style.width).toBe('560px');

    fireEvent(view.dom, pointerEvent('pointerup', 21, 100, 100));
    const editorDom = view.dom;
    view.destroy();
    expect(editorDom.classList.contains('cm-markdown-block-selection-active')).toBe(false);
  });

  it('draws a clipped rubber-band rectangle from the pointer origin until release', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();

    fireEvent(view.dom, pointerEvent('pointerdown', 31, 32, 100));
    fireEvent(view.dom, pointerEvent('pointermove', 31, 132, 500));
    vi.runOnlyPendingTimers();

    const marquee = view.dom.querySelector<HTMLElement>('.cm-markdown-block-marquee');
    expect(marquee?.hidden).toBe(false);
    expect(marquee?.style.left).toBe('100px');
    expect(marquee?.style.top).toBe('32px');
    expect(marquee?.style.width).toBe('400px');
    expect(marquee?.style.height).toBe('100px');

    fireEvent(view.dom, pointerEvent('pointerup', 31, 132, 500));
    vi.runOnlyPendingTimers();
    expect(marquee?.hidden).toBe(true);
    view.destroy();
  });

  it('copies the exact raw Markdown source for a block range with Mod-c', () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const doc = [
      '# Heading',
      '',
      '> quoted text',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n');
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      doc,
    );
    const blocks = collectMarkdownBlocks(view.state);
    view.dispatch({
      effects: setMarkdownBlockSelection.of({
        anchor: blocks[0].from,
        head: blocks[blocks.length - 1].from,
      }),
    });
    view.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith(doc);
    view.destroy();
  });

  it('leaves Mod-c to the native text copy path without a block selection', () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      'Paragraph text',
    );
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    view.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    view.destroy();
  });

  it('keeps the rubber-band origin attached to document content while scrolling', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();

    fireEvent(view.dom, pointerEvent('pointerdown', 32, 96, 100));
    fireEvent(view.dom, pointerEvent('pointermove', 32, 200, 500));
    vi.runOnlyPendingTimers();
    const marquee = view.dom.querySelector<HTMLElement>('.cm-markdown-block-marquee');
    expect(marquee?.style.top).toBe('96px');
    expect(marquee?.style.height).toBe('104px');

    view.scrollDOM.scrollTop = 80;
    fireEvent.scroll(view.scrollDOM);
    vi.runOnlyPendingTimers();

    expect(marquee?.style.top).toBe('16px');
    expect(marquee?.style.height).toBe('184px');
    view.destroy();
  });

  it('keeps text editing native and clears block selection on block-body pointerdown', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();
    const [alpha, beta] = collectMarkdownBlocks(view.state);
    view.dispatch({ effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }) });
    const firstLine = view.contentDOM.querySelector<HTMLElement>('.cm-line');
    const event = pointerEvent('pointerdown', 22, 32, 300);

    fireEvent(firstLine!, event);

    expect(event.defaultPrevented).toBe(false);
    expect(selectedMarkdownBlocks(view.state)).toEqual([]);
    view.destroy();
  });

  it('clears selection without moving the caret on a gutter click or outside click', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();
    const [alpha, beta] = collectMarkdownBlocks(view.state);
    view.dispatch({
      selection: EditorSelection.cursor(beta.from),
      effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }),
    });
    const gutterDown = pointerEvent('pointerdown', 29, 32, 100);

    fireEvent(view.dom, gutterDown);
    fireEvent(view.dom, pointerEvent('pointerup', 29, 32, 100));

    expect(gutterDown.defaultPrevented).toBe(true);
    expect(view.state.selection.main.anchor).toBe(beta.from);
    expect(selectedMarkdownBlocks(view.state)).toEqual([]);

    view.dispatch({ effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }) });
    fireEvent(document.body, pointerEvent('pointerdown', 30, 10, 10));
    expect(selectedMarkdownBlocks(view.state)).toEqual([]);
    view.destroy();
  });

  it('uses the default-cursor marquee zone only for gutters outside the text column', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const { view } = createView();
    const lines = view.contentDOM.querySelectorAll<HTMLElement>('.cm-line');

    fireEvent(lines[0], pointerEvent('pointermove', 23, 32, 300));
    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(false);

    fireEvent(lines[1], pointerEvent('pointermove', 23, 64, 300));
    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(false);

    fireEvent(view.dom, pointerEvent('pointermove', 23, 32, 100));
    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(true);
    fireEvent.pointerLeave(view.dom);
    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(false);
    view.destroy();
  });

  it('keeps measured gaps inside the text column in the native text-cursor zone', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    posAtCoordsSpy.mockImplementation(function posAtCoords(this: EditorView) {
      return this.state.doc.line(1).from;
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      '# Heading\nParagraph',
    );
    const line = view.contentDOM.querySelector<HTMLElement>('.cm-line');

    fireEvent(line!, pointerEvent('pointermove', 26, 60, 300));

    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(false);
    view.destroy();
  });

  it('does not turn an internal visual-row gap of a wrapped block into a marquee zone', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    lineBlockSpy.mockImplementation(function lineBlock(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.number === 1) {
        return { top: 32, bottom: 104, height: 72 } as ReturnType<EditorView['lineBlockAt']>;
      }
      const top = line.number * 32;
      return { top, bottom: top + 24, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      'A long paragraph that wraps onto another visual row\n\nAfter',
    );
    const line = view.contentDOM.querySelector<HTMLElement>('.cm-line');

    fireEvent(line!, pointerEvent('pointermove', 27, 70, 300));

    expect(view.dom.classList.contains('cm-markdown-block-marquee-zone')).toBe(false);
    view.destroy();
  });

  it('owns pointer listeners and selection UI in the editor child document', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const childDocument = document.implementation.createHTMLDocument('detached-markdown-selection');
    Object.defineProperty(childDocument, 'defaultView', { configurable: true, value: window });
    const parent = childDocument.createElement('div');
    childDocument.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'Alpha\n\nBeta',
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownBlockSelectionPlugin(),
        ],
      }),
    });
    vi.runOnlyPendingTimers();

    expect(view.dom.ownerDocument).toBe(childDocument);
    expect(view.dom.querySelector('.cm-markdown-block-selection-layer')?.ownerDocument).toBe(childDocument);
    fireEvent(view.dom, pointerEvent('pointerdown', 28, 32, 100));
    fireEvent(view.dom, pointerEvent('pointermove', 28, 100, 100));
    expect(selectedMarkdownBlocks(view.state).map(block => block.source)).toEqual(['Alpha', 'Beta']);

    view.destroy();
  });

  it('projects one rounded selection surface over a replacement block widget', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')
        || this.classList.contains('cm-table-widget')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const doc = [
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      'After',
    ].join('\n');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [
          markdown({ base: markdownLanguage }),
          tableDecoField,
          markdownBlockSelectionPlugin(),
        ],
      }),
    });
    const blocks = collectMarkdownBlocks(view.state);
    view.dispatch({
      effects: setMarkdownBlockSelection.of({
        anchor: blocks[0].from,
        head: blocks[blocks.length - 1].from,
      }),
    });
    vi.runOnlyPendingTimers();

    expect(view.dom.querySelector('.cm-table-widget')).toBeInstanceOf(HTMLElement);
    const surfaces = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-selection-surface:not([hidden])');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].style.width).toBe('560px');
    view.destroy();
  });

  it('uses the full rendered heading bounds without extending into a top cover', () => {
    const doc = [
      '---',
      'cover:',
      '  image: cover.png',
      '---',
      '# Dream',
      '',
      'After',
    ].join('\n');
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number === 5 ? 520 : line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    lineBlockSpy.mockImplementation(function lineBlock(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.number === 5) {
        return { top: 0, bottom: 584, height: 584 } as ReturnType<EditorView['lineBlockAt']>;
      }
      const top = line.number * 32;
      return { top, bottom: top + 24, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line') && this.textContent?.includes('Dream')) {
        return {
          ...elementRect(),
          top: 500,
          bottom: 584,
          height: 84,
          left: 200,
          right: 760,
          width: 560,
        } as DOMRect;
      }
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownCoverField,
          markdownBlockSelectionPlugin(),
        ],
      }),
    });
    const heading = collectMarkdownBlocks(view.state)[0];
    const headingLine = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')]
      .find(line => line.textContent?.includes('Dream'));
    if (!headingLine) throw new Error('Expected the rendered heading line.');
    Object.defineProperty(headingLine, 'offsetHeight', { configurable: true, value: 84 });

    view.dispatch({
      effects: setMarkdownBlockSelection.of({ anchor: heading.from, head: heading.from }),
    });
    vi.runOnlyPendingTimers();

    const surface = view.dom.querySelector<HTMLElement>(
      '.cm-markdown-block-selection-surface:not([hidden])',
    );
    expect(heading.source).toBe('# Dream');
    expect(surface?.style.top).toBe('500px');
    expect(surface?.style.height).toBe('84px');
    view.destroy();
  });

  it('extends a held marquee through offscreen blocks when the editor scrolls', () => {
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    let scrollLines = 0;
    posAtCoordsSpy.mockImplementation(function posAtCoords(
      this: EditorView,
      coordinates: { x: number; y: number },
    ) {
      const lineNumber = Math.min(
        this.state.doc.lines,
        Math.max(1, Math.floor(coordinates.y / 32) + scrollLines),
      );
      return this.state.doc.line(lineNumber).from;
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      'Alpha\n\nBeta\n\nGamma\n\nDelta\n\nEpsilon',
    );

    fireEvent(view.dom, pointerEvent('pointerdown', 24, 32, 100));
    fireEvent(view.dom, pointerEvent('pointermove', 24, 100, 100));
    expect(selectedMarkdownBlocks(view.state).map(block => block.source)).toEqual(['Alpha', 'Beta']);

    scrollLines = 6;
    fireEvent.scroll(view.scrollDOM);
    expect(selectedMarkdownBlocks(view.state).map(block => block.source)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
      'Epsilon',
    ]);

    fireEvent(view.dom, pointerEvent('pointerup', 24, 100, 100));
    view.destroy();
  });

  it('drags a selected block range as one undoable transaction', () => {
    const { view } = createView();
    const [alpha, beta] = collectMarkdownBlocks(view.state);
    view.dispatch({ effects: setMarkdownBlockSelection.of({ anchor: alpha.from, head: beta.from }) });
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 25, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 25, 220));
    expect(view.dom.querySelector('.cm-markdown-block-drag-count')?.textContent).toBe('2');
    fireEvent(firstHandle, pointerEvent('pointerup', 25, 220));

    expect(view.state.doc.toString()).toBe('Gamma\n\nAlpha\n\nBeta');
    expect(selectedMarkdownBlocks(view.state).map(block => block.source)).toEqual(['Alpha', 'Beta']);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Alpha\n\nBeta\n\nGamma');
    view.destroy();
  });

  it('moves a translucent text copy while leaving the original block untouched', () => {
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 11, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 11, 110));

    expect(view.dom.querySelector('.cm-markdown-block-drag-source')).toBeNull();
    expect(view.dom.querySelector('.cm-markdown-block-drop-target')).toBeNull();
    const preview = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drag-preview');
    expect(preview).toBeInstanceOf(HTMLElement);
    expect(preview?.textContent).toContain('Alpha');
    expect(preview?.style.transform).toBe('translate3d(0px, 78px, 0)');

    fireEvent(firstHandle, pointerEvent('pointermove', 11, 130, 52));
    expect(preview?.style.transform).toBe('translate3d(12px, 98px, 0)');

    fireEvent(firstHandle, pointerEvent('pointercancel', 11, 110));
    expect(view.dom.querySelector('.cm-markdown-block-drag-preview')).toBeNull();
    view.destroy();
  });

  it('centers the handle against the first visible text line', () => {
    coordsSpy.mockImplementation(() => ({ left: 200, right: 400, top: 96, bottom: 120 }));
    lineBlockSpy.mockImplementation(() => ({ top: 32, bottom: 72, height: 40 }) as ReturnType<EditorView['lineBlockAt']>);
    const { view } = createView();
    const firstHandle = view.dom.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(firstHandle?.style.top).toBe('8px');
    view.destroy();
  });

  it('updates the caret-block marker in place as the selection focus moves', () => {
    const { view } = createView();
    const blocks = collectMarkdownBlocks(view.state);
    const initialItems = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item');

    expect(initialItems[0].classList.contains('is-caret-block')).toBe(true);
    expect(initialItems[1].classList.contains('is-caret-block')).toBe(false);

    view.dispatch({ selection: EditorSelection.cursor(blocks[1].from) });
    const movedItems = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item');

    expect(movedItems[0]).toBe(initialItems[0]);
    expect(movedItems[0].classList.contains('is-caret-block')).toBe(false);
    expect(movedItems[1].classList.contains('is-caret-block')).toBe(true);

    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from) });
    expect(view.dom.querySelectorAll('.cm-markdown-block-rail-item.is-caret-block')).toHaveLength(0);
    view.destroy();
  });

  it('aligns a blockquote handle with the shared block rail instead of its indented text', () => {
    const doc = 'Alpha\n\n> quoted';
    rectSpy.mockImplementation(function rect(this: HTMLElement) {
      if (this.classList.contains('cm-line')) {
        return { ...elementRect(), left: 200, right: 760, width: 560 } as DOMRect;
      }
      return elementRect();
    });
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number * 32;
      const left = line.number === 3 ? 224 : 200;
      return { left, right: 400, top, bottom: top + 24 };
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownDecoPlugin,
          markdownBlockSelectionPlugin(),
          markdownBlockHandlePlugin({ onOpenMenu: vi.fn() }),
        ],
      }),
    });
    vi.runOnlyPendingTimers();

    expect(view.dom.querySelector('.cm-blockquote-line')).toBeInstanceOf(HTMLElement);
    const items = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item');
    expect(items).toHaveLength(2);
    expect(items[0].style.left).toBe('172px');
    expect(items[1].style.left).toBe(items[0].style.left);
    view.destroy();
  });

  it('centers the handle on the first visual row when the first logical line wraps', () => {
    coordsSpy.mockImplementation(() => ({ left: 200, right: 400, top: 32, bottom: 56 }));
    lineBlockSpy.mockImplementation(() => ({ top: 32, bottom: 104, height: 72 }) as ReturnType<EditorView['lineBlockAt']>);
    lineBoundarySpy.mockImplementation(function boundary(
      this: EditorView,
      start: Parameters<EditorView['moveToLineBoundary']>[0],
    ) {
      const line = this.state.doc.lineAt(start.head);
      return EditorSelection.cursor(Math.min(line.from + 3, line.to - 1));
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      'A long first logical line that wraps visually\n\nAfter',
    );
    const firstHandle = view.dom.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(firstHandle?.style.top).toBe('0px');
    view.destroy();
  });

  it('renders the drop indicator inside CodeMirror content at a block boundary', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = (line.number * 32) + 13;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView();
    const secondHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[1];

    fireEvent(secondHandle, pointerEvent('pointerdown', 13, 96));
    fireEvent(secondHandle, pointerEvent('pointermove', 13, 40));

    const indicator = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.closest('.cm-content')).toBe(view.contentDOM);
    expect(indicator?.style.top).toBe('');
    expect(indicator?.style.left).toBe('');
    fireEvent(secondHandle, pointerEvent('pointercancel', 13, 40));
    view.destroy();
  });

  it('leaves drop indicator width to the shared document-column CSS', () => {
    const { view } = createView();
    const secondHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[1];

    fireEvent(secondHandle, pointerEvent('pointerdown', 14, 96));
    fireEvent(secondHandle, pointerEvent('pointermove', 14, 40));

    const indicator = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator');
    expect(indicator?.closest('.cm-content')).toBe(view.contentDOM);
    expect(indicator?.style.left).toBe('');
    expect(indicator?.style.right).toBe('');
    expect(indicator?.style.width).toBe('');
    fireEvent(secondHandle, pointerEvent('pointercancel', 14, 40));
    expect(indicator?.classList.contains('is-visible')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(view.dom.querySelector('.cm-markdown-block-drop-indicator')).toBeNull();
    view.destroy();
  });

  it('keeps a fenced code block handle when its hidden fence lines have no coordinates', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.text.startsWith('```')) return null;
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      '```ts\nconst value = 1;\n```\n\nAfter',
    );
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(handles).toHaveLength(2);
    expect(handles[0].closest<HTMLElement>('.cm-markdown-block-rail-item')?.dataset.blockFrom).toBe('0');

    fireEvent(handles[1], pointerEvent('pointerdown', 12, 160));
    fireEvent(handles[1], pointerEvent('pointermove', 12, 50));
    expect(
      view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator')?.classList.contains('is-visible'),
    ).toBe(true);
    fireEvent(handles[1], pointerEvent('pointercancel', 12, 50));
    view.destroy();
  });

  it('aligns a fenced code handle horizontally to code text and vertically to its opening row', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const left = line.text.startsWith('```') ? 800 : 200;
      const top = line.number * 32;
      return { left, right: left + 200, top, bottom: top + 24 };
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      '```ts\nconst value = 1;\n```\n\nAfter',
    );
    const items = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item');

    expect(items).toHaveLength(2);
    expect(items[0].style.left).toBe('172px');
    expect(items[0].style.top).toBe('32px');
    expect(items[1].style.left).toBe('172px');
    view.destroy();
  });

  it('never treats an unmeasured offscreen block as the drop target', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.number >= 5) return null;
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 8, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 8, 220));
    fireEvent(firstHandle, pointerEvent('pointerup', 8, 220));

    expect(view.state.doc.toString()).toBe('Beta\n\nAlpha\n\nGamma');
    view.destroy();
  });

  it('remeasures visible blocks while scrolling during an active drag', () => {
    const viewportSpy = vi.spyOn(EditorView.prototype, 'viewport', 'get').mockImplementation(function viewport(
      this: EditorView,
    ) {
      return { from: 0, to: this.state.doc.length };
    });
    let scrollOffset = 0;
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = (line.number * 32) - scrollOffset;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    lineBlockSpy.mockImplementation(function lineBlock(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = (line.number * 32) - scrollOffset;
      return { top, bottom: top + 24, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 15, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 15, 100));

    scrollOffset = 100;
    fireEvent.scroll(view.scrollDOM);
    vi.runOnlyPendingTimers();
    fireEvent(firstHandle, pointerEvent('pointerup', 15, 100));

    expect(view.state.doc.toString()).toBe('Beta\n\nGamma\n\nAlpha');
    view.destroy();
    viewportSpy.mockRestore();
  });

  it('does not render editing handles in read-only configuration', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'Alpha\n\nBeta',
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownBlockHandlePlugin({ readOnly: true, onOpenMenu: vi.fn() }),
        ],
      }),
    });
    vi.runOnlyPendingTimers();

    expect(view.dom.querySelector('.cm-markdown-block-handle')).toBeNull();
    view.destroy();
  });
});
