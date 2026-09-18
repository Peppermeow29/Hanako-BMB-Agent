import { describe, it, expect } from 'vitest';
import {
  rectFromPoints,
  rectsIntersect,
  hitTestMessages,
  rangeIds,
  type SelectionRect,
} from '../desktop/src/react/utils/box-selection';

describe('rectFromPoints', () => {
  it('normalizes points regardless of drag direction', () => {
    expect(rectFromPoints(30, 40, 10, 20)).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });
});

describe('rectsIntersect', () => {
  const a: SelectionRect = { left: 0, top: 0, right: 10, bottom: 10 };
  it('true when overlapping', () => {
    expect(rectsIntersect(a, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
  });
  it('false when fully apart', () => {
    expect(rectsIntersect(a, { left: 20, top: 20, right: 30, bottom: 30 })).toBe(false);
  });
  it('false when only edges touch', () => {
    expect(rectsIntersect(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });
});

describe('hitTestMessages', () => {
  it('returns ids of messages whose rect intersects the box', () => {
    const box: SelectionRect = { left: 0, top: 0, right: 100, bottom: 50 };
    const elements = [
      { id: 'a', rect: { left: 10, top: 10, right: 90, bottom: 40 } },   // in
      { id: 'b', rect: { left: 10, top: 60, right: 90, bottom: 80 } },   // below box
      { id: 'c', rect: { left: 10, top: 45, right: 90, bottom: 70 } },   // partial overlap
    ];
    expect(hitTestMessages(box, elements)).toEqual(['a', 'c']);
  });
});

describe('rangeIds', () => {
  const ordered = ['m1', 'm2', 'm3', 'm4', 'm5'];
  it('inclusive range, anchor before target', () => {
    expect(rangeIds(ordered, 'm2', 'm4')).toEqual(['m2', 'm3', 'm4']);
  });
  it('inclusive range, anchor after target', () => {
    expect(rangeIds(ordered, 'm4', 'm2')).toEqual(['m2', 'm3', 'm4']);
  });
  it('single id when anchor === target', () => {
    expect(rangeIds(ordered, 'm3', 'm3')).toEqual(['m3']);
  });
  it('empty when an id is missing', () => {
    expect(rangeIds(ordered, 'mX', 'm3')).toEqual([]);
  });
});
