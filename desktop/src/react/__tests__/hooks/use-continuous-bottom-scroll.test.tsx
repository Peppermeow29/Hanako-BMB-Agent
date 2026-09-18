// @vitest-environment jsdom

import React, { useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContinuousBottomScroll, type ContinuousBottomScrollController } from '../../hooks/use-continuous-bottom-scroll';

type ResizeCallback = ResizeObserverCallback;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  private readonly callback: ResizeCallback;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let rafCallbacks: FrameRequestCallback[] = [];

function installRaf() {
  rafCallbacks = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
}

function flushRaf(frameTime = 16) {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  callbacks.forEach((cb) => cb(frameTime));
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value) => { metrics.scrollTop = value; },
  });
}

function Harness({ onController }: { onController: (controller: ContinuousBottomScrollController) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useContinuousBottomScroll({
    scrollRef,
    contentRef,
    active: true,
    stickyThreshold: 40,
    largeJumpPx: 400,
  });

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return (
    <div data-testid="scroll" ref={scrollRef}>
      <div data-testid="content" ref={contentRef} />
    </div>
  );
}

describe('useContinuousBottomScroll', () => {
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalResizeObserver = window.ResizeObserver;
    originalMatchMedia = window.matchMedia;
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    MockResizeObserver.instances = [];
    installRaf();
  });

  afterEach(() => {
    cleanup();
    window.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  it('follows new bottom continuously instead of jumping on content growth', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={() => {}} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
    });

    expect(metrics.scrollTop).toBe(700);

    act(() => {
      flushRaf(16);
    });

    expect(metrics.scrollTop).toBeGreaterThan(700);
    expect(metrics.scrollTop).toBeLessThan(760);
  });

  it('does not force an upward snap when content shrinks during active follow', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={() => {}} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBeGreaterThan(700);
    const scrollTopDuringFollow = metrics.scrollTop;

    act(() => {
      metrics.scrollHeight = 920;
      MockResizeObserver.instances[0].trigger();
      flushRaf(32);
    });

    expect(metrics.scrollTop).toBe(scrollTopDuringFollow);
  });

  it('does not follow content growth after the user scrolls away from bottom', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={() => {}} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollTop = 420;
      fireEvent.scroll(scrollEl);
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });

    expect(metrics.scrollTop).toBe(420);
  });

  it('cancels an active follow when the user changes scrollTop through a scroll-only path', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={() => {}} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBeGreaterThan(700);

    act(() => {
      metrics.scrollTop = 520;
      fireEvent.scroll(scrollEl);
      metrics.scrollHeight = 1120;
      MockResizeObserver.instances[0].trigger();
      flushRaf(32);
    });

    expect(metrics.scrollTop).toBe(520);
  });

  it('can be explicitly marked sticky again and jump to bottom', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      fireEvent.scroll(scrollEl);
      controller?.scrollToBottom({ mode: 'instant', forceSticky: true });
    });

    expect(metrics.scrollTop).toBe(700);

    act(() => {
      metrics.scrollHeight = 1040;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });

    expect(metrics.scrollTop).toBeGreaterThan(700);
  });

  it('snaps instantly (no animation) on the first content growth after arming an instant landing', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    // Simulate "switch to this session": arm instant landing, then content hydrates (grows).
    act(() => {
      controller?.armInstantLanding();
      metrics.scrollHeight = 1400; // big hydrate growth while panel is visible
      MockResizeObserver.instances[0].trigger();
    });

    // Must already be at the new bottom synchronously — no mid-position animated frame.
    expect(metrics.scrollTop).toBe(1100);

    // A flushed frame must not move it further (the arm did not start an animation loop).
    act(() => {
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBe(1100);
  });

  it('resumes animated follow on growth after the armed instant landing was consumed', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    // First growth after arm = instant landing (consumes the arm).
    act(() => {
      controller?.armInstantLanding();
      metrics.scrollHeight = 1100;
      MockResizeObserver.instances[0].trigger();
    });
    expect(metrics.scrollTop).toBe(800);

    // Subsequent growth (streaming append, delta under largeJumpPx) must animate again.
    act(() => {
      metrics.scrollHeight = 1160;
      MockResizeObserver.instances[0].trigger();
    });
    expect(metrics.scrollTop).toBe(800); // not yet moved before a frame runs

    act(() => {
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBeGreaterThan(800);
    expect(metrics.scrollTop).toBeLessThan(860);
  });

  it('does not write non-finite scroll positions when DOM metrics are invalid', () => {
    const metrics = { scrollHeight: Number.POSITIVE_INFINITY, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={() => {}} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      MockResizeObserver.instances[0].trigger();
      flushRaf(Number.POSITIVE_INFINITY);
    });

    expect(Number.isFinite(metrics.scrollTop)).toBe(true);
  });

  it('preserves the armed instant landing through a no-op follow (already at bottom)', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    // Arm, then a no-op follow (already at bottom, delta=0) must NOT consume the arm —
    // the arm is reserved for the first meaningful growth (the async hydrate after a switch).
    act(() => {
      controller?.armInstantLanding();
      MockResizeObserver.instances[0].trigger(); // no growth
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBe(700);

    // The first real growth still snaps instantly — the arm survived the no-op.
    act(() => {
      metrics.scrollHeight = 1400;
      MockResizeObserver.instances[0].trigger();
    });
    expect(metrics.scrollTop).toBe(1100);
    act(() => { flushRaf(16); });
    expect(metrics.scrollTop).toBe(1100);
  });

  it('content shrink while sticky keeps following to the new bottom', () => {
    let controller: ContinuousBottomScrollController | null = null;
    // Start pinned to the bottom (scrollTop === maxScrollTop), the normal turn-end state.
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    // Warm-up trigger (a no-op growth) establishes lastObservedScrollHeightRef against the mocked
    // metrics — mirrors every other test in this file, since the hook's own mount effect samples
    // el.scrollHeight before setScrollMetrics() has replaced jsdom's real (unmocked) getters.
    act(() => {
      MockResizeObserver.instances[0].trigger();
    });
    expect((controller as unknown as ContinuousBottomScrollController).isStickyRef.current).toBe(true);

    // Turn ends: process-fold collapse / typing-indicator removal shrinks the content. This
    // leaves scrollTop (700) resting past the new maxScrollTop (860-300=560) — an overscroll the
    // real browser clamps natively, but the important, JS-observable contract is that sticky
    // survives the shrink instead of being dropped (old code: stopFollow(); checkSticky() would
    // see distanceFromBottom go negative-then-still-within-threshold by luck, but for a bigger
    // shrink it would read as "scrolled away" and cancel — this asserts sticky is preserved
    // deliberately, not by accident of the numbers).
    act(() => {
      metrics.scrollHeight = 860;
      MockResizeObserver.instances[0].trigger();
    });
    expect((controller as unknown as ContinuousBottomScrollController).isStickyRef.current).toBe(true);

    // Prove sticky wasn't just left true in name only: the next real growth (streaming
    // continues) must still be followed to the new bottom, exactly like normal follow behavior.
    act(() => {
      metrics.scrollHeight = 920; // grows again after the shrink
      MockResizeObserver.instances[0].trigger();
      // The follow animates exponentially toward the target; flush enough frames with
      // monotonically increasing timestamps (like real requestAnimationFrame ticks) for it to
      // converge within SCROLL_EPSILON_PX (matches the decay driven by FOLLOW_TIME_CONSTANT_MS).
      for (let frameTime = 16; frameTime <= 16 * 30; frameTime += 16) flushRaf(frameTime);
    });

    expect(metrics.scrollTop).toBe(620); // new maxScrollTop = 920 - 300
  });

  it('browser-generated scroll during follow (scrollHeight changed) does not cancel follow', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBeGreaterThan(700);

    // Simulate a browser-generated scroll event (clamp/anchoring) accompanying a content-height
    // change, without going through the ResizeObserver path: scrollHeight changes in the same
    // "frame" as the scroll event, and scrollTop deviates from the expected programmatic value
    // by more than 1px, and distanceFromBottom exceeds the sticky threshold.
    act(() => {
      metrics.scrollHeight = 820; // shrinks below lastObservedScrollHeightRef
      metrics.scrollTop = 300; // far from bottom, deviates from programmatic expectation
      fireEvent.scroll(scrollEl);
    });

    // Must remain sticky: the scrollHeight change in the same tick as the scroll event marks
    // this as browser-generated (clamp/anchoring), not user intent, so follow must not cancel.
    expect((controller as unknown as ContinuousBottomScrollController).isStickyRef.current).toBe(true);
  });

  it('user scrollbar drag during follow still cancels', () => {
    let controller: ContinuousBottomScrollController | null = null;
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    render(<Harness onController={(next) => { controller = next; }} />);
    const scrollEl = document.querySelector('[data-testid="scroll"]') as HTMLElement;
    setScrollMetrics(scrollEl, metrics);

    act(() => {
      metrics.scrollHeight = 1060;
      MockResizeObserver.instances[0].trigger();
      flushRaf(16);
    });
    expect(metrics.scrollTop).toBeGreaterThan(700);

    // scrollHeight matches lastObserved (no content-size change): this is a genuine
    // user-driven scroll (e.g. scrollbar drag), and must still cancel follow.
    act(() => {
      metrics.scrollTop = 300; // far from bottom
      fireEvent.scroll(scrollEl);
    });

    expect((controller as unknown as ContinuousBottomScrollController).isStickyRef.current).toBe(false);
  });
});
