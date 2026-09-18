// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeDialog } from '../../ui/NoticeDialog';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('NoticeDialog', () => {
  it('exposes dialog semantics, labels itself, and focuses the title', () => {
    render(
      <NoticeDialog
        open
        scope="window"
        title="What's New"
        confirmLabel="Got it"
        onConfirm={() => {}}
      >
        <p>Release notes</p>
      </NoticeDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: "What's New" });
    const title = screen.getByRole('heading', { name: "What's New" });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(title);
    expect(screen.getByText('Release notes')).toBeTruthy();
    act(() => vi.advanceTimersByTime(250));
  });

  it('renders a single primary button that routes to onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <NoticeDialog
        open
        scope="inline"
        title="Notice"
        confirmLabel="Acknowledge"
        onConfirm={onConfirm}
      >
        body
      </NoticeDialog>,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms on Escape by default', () => {
    const onConfirm = vi.fn();
    render(
      <NoticeDialog
        open
        scope="inline"
        title="Escapable"
        confirmLabel="OK"
        onConfirm={onConfirm}
      >
        body
      </NoticeDialog>,
    );
    act(() => vi.advanceTimersByTime(250));

    fireEvent.keyDown(screen.getByRole('heading', { name: 'Escapable' }), { key: 'Escape' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape when closeOnEsc is disabled', () => {
    const onConfirm = vi.fn();
    render(
      <NoticeDialog
        open
        scope="inline"
        title="Sticky"
        confirmLabel="OK"
        onConfirm={onConfirm}
        closeOnEsc={false}
      >
        body
      </NoticeDialog>,
    );
    act(() => vi.advanceTimersByTime(250));

    fireEvent.keyDown(screen.getByRole('heading', { name: 'Sticky' }), { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('only confirms from the backdrop when that policy is enabled', () => {
    const onConfirm = vi.fn();
    const props = {
      open: true,
      scope: 'inline' as const,
      title: 'Backdrop policy',
      confirmLabel: 'OK',
      onConfirm,
      children: 'body',
    };
    const { rerender } = render(<NoticeDialog {...props} closeOnBackdrop={false} />);

    let backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(<NoticeDialog {...props} closeOnBackdrop />);
    backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
