// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharingTab } from '../SharingTab';

describe('SharingTab screenshot font settings', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
    });
    window.t = ((key: string) => key) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders screenshot font as a selector that follows the reading font by default', () => {
    render(React.createElement(SharingTab));

    expect(screen.getByText('settings.screenshot.font')).toBeTruthy();
    expect(screen.getByTitle('settings.fonts.followReading')).toBeTruthy();
  });
});
