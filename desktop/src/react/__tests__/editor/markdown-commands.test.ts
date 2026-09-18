/**
 * @vitest-environment jsdom
 */
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  insertCodeBlock,
  setHeading,
  toggleBlockquote,
  toggleBold,
  toggleList,
  toggleStrikethrough,
} from '../../editor/markdown-commands';

const views: EditorView[] = [];

function createView(doc: string, from = 0, to = doc.length): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [history()],
    }),
  });
  views.push(view);
  return view;
}

function text(view: EditorView): string {
  return view.state.doc.toString();
}

afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('line-aware Markdown block commands', () => {
  it('normalizes mixed headings to H2, keeps empty lines untouched, then removes H2 uniformly', () => {
    const view = createView('# First\n\n### Third\nPlain');

    setHeading(view, 2);
    expect(text(view)).toBe('## First\n\n## Third\n## Plain');

    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
    setHeading(view, 2);
    expect(text(view)).toBe('First\n\nThird\nPlain');
  });

  it('normalizes headings and mixed list markers into one unordered list', () => {
    const view = createView('## Heading\n1. Ordered\n- Bullet\n+ Plus\n\n');

    toggleList(view);
    expect(text(view)).toBe('- Heading\n- Ordered\n- Bullet\n- Plus\n\n');

    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
    toggleList(view);
    expect(text(view)).toBe('Heading\nOrdered\nBullet\nPlus\n\n');
  });

  it('treats a task checkbox as list body when toggling its unordered marker', () => {
    const view = createView('- [ ] Task');

    toggleList(view);

    expect(text(view)).toBe('[ ] Task');
  });

  it('keeps fenced code intact when applying headings across mixed blocks', () => {
    const view = createView([
      'Before',
      '',
      '```ts',
      '# code heading',
      '- code list',
      '```',
      '',
      'After',
    ].join('\n'));

    setHeading(view, 2);

    expect(text(view)).toBe([
      '## Before',
      '',
      '```ts',
      '# code heading',
      '- code list',
      '```',
      '',
      '## After',
    ].join('\n'));
  });

  it('wraps multiple blocks as one continuous quote and removes exactly one outer layer', () => {
    const original = 'Alpha\n\n## Beta\n> existing inner quote';
    const view = createView(original);

    toggleBlockquote(view);
    expect(text(view)).toBe('> Alpha\n>\n> ## Beta\n> > existing inner quote');

    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
    toggleBlockquote(view);
    expect(text(view)).toBe(original);
  });
});

describe('fenced code block toggle', () => {
  it('chooses a fence longer than backtick runs in the selection and unwraps losslessly', () => {
    const original = 'alpha\n```\nomega';
    const view = createView(original);

    insertCodeBlock(view);
    expect(text(view)).toBe('````\nalpha\n```\nomega\n````');

    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
    insertCodeBlock(view);
    expect(text(view)).toBe(original);
  });

  it('keeps the empty-selection insertion behavior in one dispatch', () => {
    const view = createView('Alpha', 5, 5);
    const dispatch = vi.spyOn(view, 'dispatch');

    insertCodeBlock(view);

    expect(text(view)).toBe('Alpha\n```\n\n```\n');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('');
  });
});

describe('structure-safe inline formatting', () => {
  it('formats heading, list, task, and quote bodies without touching structural prefixes', () => {
    const view = createView([
      '# Heading',
      '- item',
      '> quote',
      '1. ordered',
      '- [ ] task',
      '> - nested',
    ].join('\n'));

    toggleStrikethrough(view, { blockRange: true });

    expect(text(view)).toBe([
      '# ~~Heading~~',
      '- ~~item~~',
      '> ~~quote~~',
      '1. ~~ordered~~',
      '- [ ] ~~task~~',
      '> - ~~nested~~',
    ].join('\n'));
  });

  it('skips fence lines and fenced code content while formatting surrounding blocks', () => {
    const view = createView([
      'Before',
      '',
      '```ts',
      '# not a heading',
      '- not a list',
      '```',
      '',
      'After',
    ].join('\n'));

    toggleStrikethrough(view, { blockRange: true });

    expect(text(view)).toBe([
      '~~Before~~',
      '',
      '```ts',
      '# not a heading',
      '- not a list',
      '```',
      '',
      '~~After~~',
    ].join('\n'));
  });

  it('uses the structure-safe path for a complete single-line Markdown block', () => {
    const view = createView('# Heading');

    toggleBold(view, { blockRange: true });

    expect(text(view)).toBe('# **Heading**');
  });

  it('keeps ordinary partial text selection behavior', () => {
    const view = createView('plain text', 0, 5);

    toggleBold(view);

    expect(text(view)).toBe('**plain** text');
    expect(view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    )).toBe('plain');
  });

  it('keeps a normal multi-line text selection exact outside block-range mode', () => {
    const view = createView('alpha\nbeta', 2, 8);

    toggleBold(view);

    expect(text(view)).toBe('al**pha\nbe**ta');
  });

  it('dispatches one undoable transaction for the whole batch', () => {
    const original = '# Heading\n- item\n> quote';
    const view = createView(original);
    const dispatch = vi.spyOn(view, 'dispatch');

    toggleStrikethrough(view, { blockRange: true });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(undo(view)).toBe(true);
    expect(text(view)).toBe(original);
  });
});
