// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Overlay } from '../../ui/Overlay';
import { WindowSurfaceProvider, type WindowSurface } from '../../ui/window-surface';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('Overlay scope', () => {
  it('portals window overlays outside transformed and clipping ancestors', () => {
    const ancestor = document.createElement('div');
    ancestor.style.transform = 'translateX(1px)';
    ancestor.style.overflow = 'hidden';
    const mount = document.createElement('div');
    ancestor.append(mount);
    document.body.append(ancestor);

    render(
      <Overlay
        open
        scope="window"
        onClose={() => {}}
        contentProps={{ 'data-testid': 'window-dialog' }}
      >
        content
      </Overlay>,
      { container: mount },
    );

    const dialog = document.querySelector<HTMLElement>('[data-testid="window-dialog"]');
    expect(dialog).not.toBeNull();
    expect(ancestor.contains(dialog)).toBe(false);
    expect(dialog?.parentElement?.parentElement).toBe(document.body);
  });

  it('keeps inline overlays inside their caller', () => {
    const ancestor = document.createElement('div');
    const mount = document.createElement('div');
    ancestor.append(mount);
    document.body.append(ancestor);

    render(
      <Overlay
        open
        scope="inline"
        onClose={() => {}}
        contentProps={{ 'data-testid': 'inline-dialog' }}
      >
        content
      </Overlay>,
      { container: mount },
    );

    expect(ancestor.contains(document.querySelector('[data-testid="inline-dialog"]'))).toBe(true);
  });

  it('uses the detached WindowSurface overlay root and document', () => {
    const childDocument = document.implementation.createHTMLDocument('detached');
    Object.defineProperty(childDocument, 'defaultView', { configurable: true, value: window });
    const mount = childDocument.createElement('div');
    const overlayRoot = childDocument.createElement('div');
    childDocument.body.append(mount, overlayRoot);
    const surface: WindowSurface = {
      id: 'detached:overlay-test',
      window,
      document: childDocument,
      overlayRoot,
    };

    render(
      <WindowSurfaceProvider surface={surface}>
        <Overlay open scope="window" onClose={() => {}} contentProps={{ role: 'dialog' }}>
          detached content
        </Overlay>
      </WindowSurfaceProvider>,
      { container: mount, baseElement: childDocument.body },
    );

    expect(within(overlayRoot).getByRole('dialog').textContent).toBe('detached content');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('traps Tab on the backdrop when there are no focusable descendants', () => {
    vi.useFakeTimers();
    render(
      <Overlay open scope="inline" onClose={() => {}} duration={1}>
        <span>plain content</span>
      </Overlay>,
    );
    act(() => vi.advanceTimersByTime(1));

    const backdrop = document.querySelector<HTMLElement>('[tabindex="-1"]');
    expect(document.activeElement).toBe(backdrop);
    fireEvent.keyDown(backdrop!, { key: 'Tab' });
    expect(document.activeElement).toBe(backdrop);
  });

  it('swallows Escape when closing is disabled instead of leaking to an outer modal', () => {
    const onClose = vi.fn();
    const onOuterKeyDown = vi.fn();
    render(
      <div onKeyDown={onOuterKeyDown}>
        <Overlay open scope="inline" onClose={onClose} closeOnEsc={false}>
          <button>Busy action</button>
        </Overlay>
      </div>,
    );

    fireEvent.keyDown(within(document.body).getByRole('button', { name: 'Busy action' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onOuterKeyDown).not.toHaveBeenCalled();
  });
});
