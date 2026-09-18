/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { chapterRailHoverHit } from '../../components/PreviewPanel';

const RECT = { top: 100, right: 500, height: 400 };

describe('chapterRailHoverHit（提纲导轨悬停热区，右缘契约）', () => {
  it('右缘热区内命中：xFromRight in [0, 64] 且 yFromTop 落在顶部偏移到一半高度之间', () => {
    // xFromRight = 500 - 470 = 30（命中区间 [0, 64]）；yFromTop = 200 - 100 = 100（命中 [76, 276]）
    expect(chapterRailHoverHit(RECT, 470, 200)).toBe(true);
  });

  it('左缘不再命中（回归防线：翻转前左缘曾是热区）', () => {
    // xFromRight = 500 - 100 = 400，远超 64px 热区，不应命中
    expect(chapterRailHoverHit(RECT, 100, 200)).toBe(false);
  });

  it('超出右缘热区宽度（xFromRight > 64）不命中', () => {
    expect(chapterRailHoverHit(RECT, 430, 200)).toBe(false);
  });

  it('指针在矩形右边界之外（xFromRight < 0）不命中', () => {
    expect(chapterRailHoverHit(RECT, 510, 200)).toBe(false);
  });

  it('纵向超出热区范围不命中', () => {
    // yFromTop = 500 - 100 = 400，超过 top offset(76) + height*0.5(200) = 276
    expect(chapterRailHoverHit(RECT, 470, 500)).toBe(false);
  });
});
