// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegionalErrorBoundary } from '../../components/RegionalErrorBoundary';

vi.mock('../../../../../shared/error-bus.js', () => ({
  errorBus: { report: vi.fn() },
}));

vi.mock('../../../../../shared/errors.js', () => ({
  AppError: class AppError extends Error {
    context: Record<string, unknown> = {};

    constructor(code: string) {
      super(code);
      this.name = 'AppError';
    }

    static wrap(error: unknown) {
      if (error instanceof Error) {
        const wrapped = new AppError(error.message);
        wrapped.context = {};
        return wrapped;
      }
      return new AppError(String(error));
    }
  },
}));

describe('RegionalErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = { locale: 'zh-CN' } as typeof window.i18n;
  });

  afterEach(async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    cleanup();
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('auto-recovers a transient mobile input crash without showing the retry fallback', async () => {
    let releaseCrash = false;
    function TransientChild({ crash }: { crash: boolean }) {
      if (crash && !releaseCrash) throw new Error('transient input mount failure');
      return <div>input ready</div>;
    }

    const { rerender } = render(
      <RegionalErrorBoundary
        region="mobile-input"
        autoRetry={{ attempts: 1, delayMs: 5 }}
      >
        <TransientChild crash={false} />
      </RegionalErrorBoundary>,
      { onCaughtError: () => {}, onRecoverableError: () => {} },
    );

    rerender(
      <RegionalErrorBoundary
        region="mobile-input"
        autoRetry={{ attempts: 1, delayMs: 5 }}
      >
        <TransientChild crash />
      </RegionalErrorBoundary>,
    );

    expect(screen.queryByText('此区域暂时无法显示')).not.toBeInTheDocument();

    releaseCrash = true;
    await act(async () => {
      vi.advanceTimersByTime(5);
    });

    expect(screen.getByText('input ready')).toBeInTheDocument();
  });

  it('shows the retry fallback after auto-retry attempts are exhausted', async () => {
    function BrokenChild({ crash }: { crash: boolean }) {
      if (crash) throw new Error('stable input crash');
      return <div>input ready</div>;
    }

    const { rerender } = render(
      <RegionalErrorBoundary
        region="mobile-input"
        autoRetry={{ attempts: 1, delayMs: 5 }}
      >
        <BrokenChild crash={false} />
      </RegionalErrorBoundary>,
      { onCaughtError: () => {}, onRecoverableError: () => {} },
    );

    rerender(
      <RegionalErrorBoundary
        region="mobile-input"
        autoRetry={{ attempts: 1, delayMs: 5 }}
      >
        <BrokenChild crash />
      </RegionalErrorBoundary>,
    );

    await act(async () => {
      vi.advanceTimersByTime(5);
    });

    expect(screen.getByText('此区域暂时无法显示')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
