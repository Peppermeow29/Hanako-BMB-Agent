import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readTimelineRailCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/shared/TimelineRailNavigator.module.css'),
    'utf8',
  );
}

function readTimelineNavigatorSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/ChatTimelineNavigator.tsx'),
    'utf8',
  );
}

function readChatMessageSurfaceSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/ChatMessageSurface.tsx'),
    'utf8',
  );
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

function selectorsWithPointerAuto(css: string): string[] {
  const selectors: string[] = [];
  const rulePattern = /(?<selector>[^{}]+)\{(?<body>[^{}]+)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const body = match.groups?.body || '';
    if (/pointer-events:\s*auto/.test(body)) {
      selectors.push(match.groups?.selector.trim() || '');
    }
  }
  return selectors;
}

describe('ChatTimelineNavigator layout', () => {
  it('keeps the idle rail click-through while allowing the expanded card to hold hover', () => {
    const css = readTimelineRailCss();
    const navBlock = cssBlock(css, '.timelineNav');
    const pointerAutoSelectors = selectorsWithPointerAuto(css);

    expect(navBlock).toMatch(/pointer-events:\s*none/);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineCard'))).toBe(true);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineMarker'))).toBe(false);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineNavExpanded .timelineLabel'))).toBe(true);
    expect(pointerAutoSelectors.some(selector => selector.includes('.timelineLine'))).toBe(true);
  });

  it('keeps the left rail as a mirror of the shared timeline card', () => {
    const css = readTimelineRailCss();
    const navBlock = cssBlock(css, '.timelineNav');
    const leftNavBlock = cssBlock(css, '.timelineNavLeft');
    const leftCardBlock = cssBlock(css, '.timelineNavLeft .timelineCard');
    const markerBlock = cssBlock(css, '.timelineMarker');
    const lineBlock = cssBlock(css, '.timelineLine');

    expect(navBlock).toMatch(/top:\s*76px/);
    expect(navBlock).toMatch(/width:\s*64px/);
    expect(navBlock).toMatch(/height:\s*50%/);
    expect(leftNavBlock).toMatch(/left:\s*0/);
    expect(leftCardBlock).toMatch(/left:\s*var\(--timeline-marker-right\)/);
    expect(markerBlock).toMatch(/--timeline-marker-max-width:\s*1em/);
    expect(lineBlock).toMatch(/height:\s*4px/);
    expect(lineBlock).toMatch(/min-width:\s*0\.5em/);
    expect(lineBlock).toMatch(/max-width:\s*var\(--timeline-marker-max-width\)/);
  });

  it('guards DOM measurements before writing marker layout and CSS variables', () => {
    const source = readTimelineNavigatorSource();

    expect(source).toContain('finiteNumber(panel.scrollHeight)');
    expect(source).toContain('finiteNumber(panel.scrollTop)');
    expect(source).toContain('finiteNumber(rect.top)');
    expect(source).toContain('markerWidthEm');
    expect(source).toContain('const shouldMeasure = active && anchors.length > 0');
    expect(source).toContain('if (!panel || !shouldMeasure) return');
    expect(source).not.toContain('panel.scrollTop + rect.top - panelRect.top');
  });

  it('keeps timeline anchor construction behind the active hover preparation gate', () => {
    const source = readChatMessageSurfaceSource();

    expect(source).toContain('active && timelinePrepared ? buildTimelineAnchors(items) : EMPTY_TIMELINE_ANCHORS');
    expect(source).toContain('if (active && inRailX && inRailY) setTimelinePrepared(true)');
    expect(source).toContain('setTimelinePrepared(false)');
  });
});
