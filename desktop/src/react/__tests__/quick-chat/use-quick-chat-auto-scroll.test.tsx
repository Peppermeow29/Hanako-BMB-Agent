// @vitest-environment jsdom

import React, { useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useQuickChatAutoScroll } from '../../quick-chat/use-quick-chat-auto-scroll';

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

function Harness({
  expanded,
  isStreaming,
  sessionItems,
  sessionPath,
}: {
  expanded: boolean;
  isStreaming: boolean;
  sessionItems: unknown[];
  sessionPath: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useQuickChatAutoScroll({
    expanded,
    isStreaming,
    scrollRef,
    sessionItems,
    sessionPath,
  });
  return <div data-testid="scroll" ref={scrollRef} />;
}

describe('useQuickChatAutoScroll', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps manual scroll-up within one session but resets stickiness when the session changes', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    const { getByTestId, rerender } = render(
      <Harness expanded={false} isStreaming={false} sessionItems={[]} sessionPath="/quick/a" />,
    );
    const scroller = getByTestId('scroll');
    setScrollMetrics(scroller, metrics);

    rerender(<Harness expanded isStreaming={false} sessionItems={[{ id: 'a-1' }]} sessionPath="/quick/a" />);
    expect(metrics.scrollTop).toBe(1000);

    metrics.scrollTop = 120;
    fireEvent.scroll(scroller);
    metrics.scrollHeight = 1200;
    rerender(<Harness expanded isStreaming sessionItems={[{ id: 'a-1' }, { id: 'a-2' }]} sessionPath="/quick/a" />);
    expect(metrics.scrollTop).toBe(120);

    metrics.scrollHeight = 900;
    rerender(<Harness expanded isStreaming={false} sessionItems={[{ id: 'b-1' }]} sessionPath="/quick/b" />);
    expect(metrics.scrollTop).toBe(900);
  });
});
