// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTimelineNavigator } from '../../components/chat/ChatTimelineNavigator';
import type { TimelineAnchor } from '../../components/chat/timeline-anchors';

function measuredDiv(rect: DOMRect): HTMLDivElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => rect;
  return element;
}

function scrollPanel(): HTMLDivElement {
  const panel = measuredDiv(new DOMRect(0, 0, 640, 720));
  Object.defineProperties(panel, {
    clientHeight: { value: 720, configurable: true },
    scrollHeight: { value: 1440, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });
  panel.scrollTo = vi.fn();
  return panel;
}

function renderNavigator({ active = true }: { active?: boolean } = {}) {
  const panel = scrollPanel();
  const content = measuredDiv(new DOMRect(0, 0, 640, 1440));
  const firstMessage = measuredDiv(new DOMRect(0, 120, 420, 80));
  const secondMessage = measuredDiv(new DOMRect(0, 520, 420, 80));
  const anchors: TimelineAnchor[] = [
    {
      messageId: 'u1',
      timestamp: null,
      label: '你知道大学...',
      role: 'user',
      markerWidthEm: 0.75,
    },
    {
      messageId: 'u2',
      timestamp: null,
      label: '好，你现在...',
      role: 'user',
      markerWidthEm: 1,
    },
  ];

  const scrollRef = { current: panel } satisfies RefObject<HTMLDivElement | null>;
  const contentRef = { current: content } satisfies RefObject<HTMLDivElement | null>;
  const messageElementsRef = {
    current: new Map<string, HTMLDivElement>([
      ['u1', firstMessage],
      ['u2', secondMessage],
    ]),
  } satisfies RefObject<Map<string, HTMLDivElement>>;

  return render(
    <ChatTimelineNavigator
      anchors={anchors}
      scrollRef={scrollRef}
      contentRef={contentRef}
      messageElementsRef={messageElementsRef}
      active={active}
      railVisible={false}
    />,
  );
}

describe('ChatTimelineNavigator hover behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.assign(window, {
      t: (key: string) => ({
        'chat.timeline.navAriaLabel': 'Turn navigation',
        'chat.timeline.jumpTo': 'Jump to {label}',
      }[key] || key),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens from the short rail but stays open while the pointer moves inside the expanded card', () => {
    const { container } = renderNavigator();
    const nav = screen.getByRole('navigation', { name: 'Turn navigation' });
    const firstMarker = screen.getByRole('button', { name: 'Jump to 你知道大学...' });
    const card = container.querySelector('[class*="timelineCard"]') as HTMLElement;
    expect(firstMarker.querySelector('[class*="timelineLine"]')).toBeTruthy();

    fireEvent.mouseEnter(firstMarker);

    expect(nav.className).toContain('timelineNavExpanded');

    fireEvent.mouseLeave(firstMarker, { relatedTarget: card });
    act(() => {
      vi.advanceTimersByTime(130);
    });

    expect(nav.className).toContain('timelineNavExpanded');

    fireEvent.pointerLeave(card);
    act(() => {
      vi.advanceTimersByTime(130);
    });

    expect(nav.className).not.toContain('timelineNavExpanded');
  });

  it('does not attach layout observers for inactive preserved panels', () => {
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe(...args: unknown[]) { observe(...args); }
      unobserve() {}
      disconnect() {}
    });

    renderNavigator({ active: false });

    expect(observe).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: 'Turn navigation' })).not.toBeInTheDocument();
  });
});
