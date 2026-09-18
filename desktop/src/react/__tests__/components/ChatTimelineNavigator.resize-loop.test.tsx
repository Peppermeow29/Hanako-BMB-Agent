// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTimelineNavigator } from '../../components/chat/ChatTimelineNavigator';
import type { TimelineAnchor } from '../../components/chat/timeline-anchors';

let timelineRailRenderCount = 0;

vi.mock('../../components/shared/TimelineRailNavigator', () => ({
  TimelineRailNavigator: () => {
    timelineRailRenderCount += 1;
    return null;
  },
}));

function measuredDiv(rect: DOMRect): HTMLDivElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = vi.fn(() => rect);
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

type ObserverCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

function setupNavigator() {
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

  return {
    panel,
    content,
    firstMessage,
    secondMessage,
    anchors,
    scrollRef,
    contentRef,
    messageElementsRef,
  };
}

describe('ChatTimelineNavigator resize observer loop guards', () => {
  let resizeObserverCallback: ObserverCallback | null = null;
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    timelineRailRenderCount = 0;
    resizeObserverCallback = null;
    rafCallbacks = [];

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => {};
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ObserverCallback) {
        resizeObserverCallback = callback;
      }
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
    vi.restoreAllMocks();
  });

  function flushMeasureRaf() {
    const callbacks = [...rafCallbacks];
    rafCallbacks = [];
    for (const callback of callbacks) {
      callback(0);
    }
  }

  function triggerResizeObserver() {
    if (!resizeObserverCallback) {
      throw new Error('ResizeObserver callback was not registered');
    }
    resizeObserverCallback([], {} as ResizeObserver);
  }

  it('does not re-render when resize observer fires with unchanged geometry', () => {
    const {
      anchors,
      scrollRef,
      contentRef,
      messageElementsRef,
    } = setupNavigator();

    render(
      <ChatTimelineNavigator
        anchors={anchors}
        scrollRef={scrollRef}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active
        railVisible={false}
      />,
    );

    const rendersAfterMount = timelineRailRenderCount;

    act(() => {
      triggerResizeObserver();
      flushMeasureRaf();
    });
    act(() => {
      triggerResizeObserver();
      flushMeasureRaf();
    });
    act(() => {
      triggerResizeObserver();
      flushMeasureRaf();
    });

    expect(timelineRailRenderCount).toBe(rendersAfterMount);
  });

  it('coalesces multiple resize observer callbacks into one measure per frame', () => {
    const {
      anchors,
      scrollRef,
      contentRef,
      messageElementsRef,
      panel,
      firstMessage,
      secondMessage,
    } = setupNavigator();

    const panelRectSpy = panel.getBoundingClientRect as ReturnType<typeof vi.fn>;
    const firstRectSpy = firstMessage.getBoundingClientRect as ReturnType<typeof vi.fn>;
    const secondRectSpy = secondMessage.getBoundingClientRect as ReturnType<typeof vi.fn>;

    render(
      <ChatTimelineNavigator
        anchors={anchors}
        scrollRef={scrollRef}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active
        railVisible={false}
      />,
    );

    panelRectSpy.mockClear();
    firstRectSpy.mockClear();
    secondRectSpy.mockClear();

    act(() => {
      triggerResizeObserver();
      triggerResizeObserver();
      triggerResizeObserver();
    });

    expect(panelRectSpy).not.toHaveBeenCalled();
    expect(firstRectSpy).not.toHaveBeenCalled();
    expect(secondRectSpy).not.toHaveBeenCalled();

    act(() => {
      flushMeasureRaf();
    });

    expect(panelRectSpy).toHaveBeenCalledTimes(1);
    expect(firstRectSpy).toHaveBeenCalledTimes(1);
    expect(secondRectSpy).toHaveBeenCalledTimes(1);
  });
});
