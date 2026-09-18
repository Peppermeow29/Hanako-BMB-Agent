import { describe, expect, it } from 'vitest';
import { diffLines } from '../../utils/line-diff';

describe('diffLines', () => {
  it('marks unchanged, added and removed lines', () => {
    const result = diffLines('a\nb\nc', 'a\nx\nc')!;
    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles pure insertion and deletion', () => {
    expect(diffLines('a', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
    ]);
    expect(diffLines('a\nb', 'a')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
    ]);
  });

  it('handles identical and empty inputs', () => {
    expect(diffLines('x', 'x')).toEqual([{ kind: 'same', text: 'x' }]);
    expect(diffLines('', 'a')).toEqual([
      { kind: 'removed', text: '' },
      { kind: 'added', text: 'a' },
    ]);
  });

  it('bails out to null on oversized inputs', () => {
    const a = 'x'.repeat(2_100_000);
    const b = 'y'.repeat(10);
    expect(diffLines(a, b)).toBeNull();
  });
});
