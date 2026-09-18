// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ConfirmDialog', () => {
  it('exposes dialog semantics, labels itself, and focuses the title', () => {
    render(
      <ConfirmDialog
        open
        scope="window"
        title="Enable channels"
        confirmLabel="Enable"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        <p>Channel details</p>
      </ConfirmDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Enable channels' });
    const title = screen.getByRole('heading', { name: 'Enable channels' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(title);
    act(() => vi.advanceTimersByTime(250));
  });

  it('cancels on Escape without bubbling into its inline parent', () => {
    const onCancel = vi.fn();
    const onParentKeyDown = vi.fn();
    render(
      <div onKeyDown={onParentKeyDown}>
        <ConfirmDialog
          open
          scope="inline"
          title="Nested confirmation"
          confirmLabel="Continue"
          cancelLabel="Cancel"
          onConfirm={() => {}}
          onCancel={onCancel}
        >
          nested body
        </ConfirmDialog>
      </div>,
    );
    act(() => vi.advanceTimersByTime(250));

    fireEvent.keyDown(screen.getByRole('heading', { name: 'Nested confirmation' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('routes cancel and confirm buttons to their callbacks', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        scope="inline"
        title="Choose"
        confirmLabel="Confirm action"
        cancelLabel="Cancel action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        body
      </ConfirmDialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('only cancels from the backdrop when that policy is enabled', () => {
    const onCancel = vi.fn();
    const props = {
      open: true,
      scope: 'inline' as const,
      title: 'Backdrop policy',
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      onConfirm: () => {},
      onCancel,
      children: 'body',
    };
    const { rerender } = render(<ConfirmDialog {...props} closeOnBackdrop={false} />);

    let backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onCancel).not.toHaveBeenCalled();

    rerender(<ConfirmDialog {...props} closeOnBackdrop />);
    backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the trigger after closing', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open dialog</button>
          <ConfirmDialog
            open={open}
            scope="window"
            title="Restorable"
            confirmLabel="Confirm"
            cancelLabel="Cancel"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          >
            body
          </ConfirmDialog>
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(250));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => vi.advanceTimersByTime(250));

    expect(document.activeElement).toBe(trigger);
  });
});
