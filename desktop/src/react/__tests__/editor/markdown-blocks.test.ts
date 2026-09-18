import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  buildMarkdownBlockMove,
  buildMarkdownBlockRangeMove,
  collectMarkdownBlocks,
  type MarkdownBlock,
  type MarkdownBlockPlacement,
} from '../../editor/markdown-blocks';

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function applyMove(
  state: EditorState,
  source: MarkdownBlock,
  target: MarkdownBlock,
  placement: MarkdownBlockPlacement,
): { doc: string; anchor: number } | null {
  const move = buildMarkdownBlockMove(state, source, target, placement);
  if (!move) return null;

  const nextState = state.update({
    changes: move.changes,
    selection: { anchor: move.selectionAnchor },
  }).state;
  return { doc: nextState.doc.toString(), anchor: nextState.selection.main.anchor };
}

describe('collectMarkdownBlocks', () => {
  it('collects complete direct syntax-tree children with their source ranges and types', () => {
    const doc = [
      '# Heading',
      '',
      'Paragraph text.',
      '',
      '> quoted',
      '> text',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const blocks = collectMarkdownBlocks(createState(doc));

    expect(blocks.map(block => ({
      type: block.type,
      source: block.source,
      startLine: block.startLine,
      endLine: block.endLine,
    }))).toEqual([
      { type: 'ATXHeading1', source: '# Heading', startLine: 1, endLine: 1 },
      { type: 'Paragraph', source: 'Paragraph text.', startLine: 3, endLine: 3 },
      { type: 'Blockquote', source: '> quoted\n> text', startLine: 5, endLine: 6 },
      { type: 'FencedCode', source: '```ts\nconst value = 1;\n```', startLine: 8, endLine: 10 },
      { type: 'Table', source: '| A | B |\n| - | - |\n| 1 | 2 |', startLine: 12, endLine: 14 },
    ]);
    expect(blocks.map(block => doc.slice(block.from, block.to))).toEqual(
      blocks.map(block => block.source),
    );
  });

  it('keeps a nested list together as one top-level block', () => {
    const state = createState('- parent\n  - child\n    continuation\n- sibling\n\nafter');
    const blocks = collectMarkdownBlocks(state);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'BulletList',
      source: '- parent\n  - child\n    continuation\n- sibling',
      startLine: 1,
      endLine: 4,
    });
    expect(blocks[1]).toMatchObject({ type: 'Paragraph', source: 'after' });
  });

  it('protects leading frontmatter from handles and block moves', () => {
    const doc = [
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      '---',
      '# Heading',
      '',
      'Body',
    ].join('\n');
    const state = createState(doc);
    const blocks = collectMarkdownBlocks(state);

    expect(blocks.map(block => block.source)).toEqual(['# Heading', 'Body']);
    expect(applyMove(state, blocks[1], blocks[0], 'before')?.doc).toBe([
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      '---',
      'Body',
      '',
      '# Heading',
    ].join('\n'));
  });
});

describe('buildMarkdownBlockMove', () => {
  it('moves a later block before an earlier block and anchors the moved source', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma');
    const [alpha, , gamma] = collectMarkdownBlocks(state);

    expect(applyMove(state, gamma, alpha, 'before')).toEqual({
      doc: 'Gamma\n\nAlpha\n\nBeta',
      anchor: 0,
    });
  });

  it('moves an earlier block after a later block and anchors its new start', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma');
    const [alpha, , gamma] = collectMarkdownBlocks(state);

    expect(applyMove(state, alpha, gamma, 'after')).toEqual({
      doc: 'Beta\n\nGamma\n\nAlpha',
      anchor: 'Beta\n\nGamma\n\n'.length,
    });
  });

  it('returns null when before or after already describes the current order', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma');
    const [alpha, beta, gamma] = collectMarkdownBlocks(state);

    expect(buildMarkdownBlockMove(state, alpha, beta, 'before')).toBeNull();
    expect(buildMarkdownBlockMove(state, gamma, beta, 'after')).toBeNull();
    expect(buildMarkdownBlockMove(state, beta, beta, 'before')).toBeNull();
  });

  it('preserves distinct inter-block whitespace in its original slots', () => {
    const state = createState('Alpha\n\nBeta\n\n\n\nGamma');
    const [alpha, , gamma] = collectMarkdownBlocks(state);
    const result = applyMove(state, alpha, gamma, 'after');

    expect(result?.doc).toBe('Beta\n\nGamma\n\n\n\nAlpha');
    expect(result?.anchor).toBe('Beta\n\nGamma\n\n\n\n'.length);
  });

  it('returns null for stale or nonexistent block descriptors', () => {
    const original = createState('Alpha\n\nBeta');
    const [staleAlpha, beta] = collectMarkdownBlocks(original);
    const changed = createState('Omega\n\nBeta');
    const currentBeta = collectMarkdownBlocks(changed)[1];
    const nonexistent: MarkdownBlock = {
      from: 100,
      to: 107,
      type: 'Paragraph',
      startLine: 10,
      endLine: 10,
      source: 'Missing',
    };

    expect(buildMarkdownBlockMove(changed, staleAlpha, currentBeta, 'after')).toBeNull();
    expect(buildMarkdownBlockMove(original, nonexistent, beta, 'before')).toBeNull();
  });
});

describe('buildMarkdownBlockRangeMove', () => {
  it('moves a contiguous block range in one source-preserving replacement', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma\n\nDelta');
    const [alpha, beta, gamma, delta] = collectMarkdownBlocks(state);
    const move = buildMarkdownBlockRangeMove(state, [beta, gamma], alpha, 'before');

    expect(move).not.toBeNull();
    const next = state.update({ changes: move!.changes }).state;
    expect(next.doc.toString()).toBe('Beta\n\nGamma\n\nAlpha\n\nDelta');
    expect(next.doc.sliceString(move!.movedRange.from, move!.movedRange.to)).toBe('Beta\n\nGamma');
  });

  it('moves an earlier contiguous range after a later block', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma\n\nDelta');
    const [alpha, beta, , delta] = collectMarkdownBlocks(state);
    const move = buildMarkdownBlockRangeMove(state, [alpha, beta], delta, 'after');

    expect(move).not.toBeNull();
    const next = state.update({ changes: move!.changes }).state;
    expect(next.doc.toString()).toBe('Gamma\n\nDelta\n\nAlpha\n\nBeta');
    expect(next.doc.sliceString(move!.movedRange.from, move!.movedRange.to)).toBe('Alpha\n\nBeta');
  });

  it('moves the first two blocks after the final block', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma');
    const [alpha, beta, gamma] = collectMarkdownBlocks(state);
    const move = buildMarkdownBlockRangeMove(state, [alpha, beta], gamma, 'after');

    expect(move).not.toBeNull();
    expect(state.update({ changes: move!.changes }).state.doc.toString()).toBe('Gamma\n\nAlpha\n\nBeta');
  });

  it('rejects noncontiguous, stale, or self-targeting ranges', () => {
    const state = createState('Alpha\n\nBeta\n\nGamma\n\nDelta');
    const [alpha, beta, gamma, delta] = collectMarkdownBlocks(state);

    expect(buildMarkdownBlockRangeMove(state, [alpha, gamma], delta, 'after')).toBeNull();
    expect(buildMarkdownBlockRangeMove(state, [beta, gamma], beta, 'before')).toBeNull();
    expect(buildMarkdownBlockRangeMove(state, [beta, gamma], gamma, 'after')).toBeNull();
  });

  it('keeps distinct gap source in its original slots while moving a range', () => {
    const state = createState('Alpha\n\nBeta\n\n\nGamma\n\n\n\nDelta');
    const [alpha, beta, gamma, delta] = collectMarkdownBlocks(state);
    const move = buildMarkdownBlockRangeMove(state, [alpha, beta], delta, 'after');

    expect(move).not.toBeNull();
    expect(state.update({ changes: move!.changes }).state.doc.toString()).toBe(
      'Gamma\n\nDelta\n\n\nAlpha\n\n\n\nBeta',
    );
    expect(gamma.source).toBe('Gamma');
  });
});
