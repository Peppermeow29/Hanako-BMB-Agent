// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetButtons } from '../../components/plugin/WidgetButtons';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WidgetButtons', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockImplementation(async () => jsonResponse({ ok: true }));
    useStore.setState({
      currentTab: 'chat',
      locale: 'zh-CN',
      pluginWidgets: [
        {
          pluginId: 'dream-notes',
          title: 'Dream Notes',
          icon: null,
          routeUrl: '/api/plugins/dream-notes/widget',
          hostCapabilities: [],
        },
      ],
      hiddenWidgets: ['dream-notes'],
      jianView: 'desk',
      jianOpen: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens a hidden widget when its dropdown label is selected', () => {
    const { container } = render(
      <div className="titlebar">
        <WidgetButtons />
      </div>,
    );
    const titlebar = container.querySelector('.titlebar');
    expect(titlebar).not.toBeNull();

    fireEvent.click(screen.getByTitle('plugin.widget.hiddenPlugins'));
    const hiddenWidgetButton = screen.getByRole('button', { name: 'Dream Notes' });
    expect(titlebar).not.toContainElement(hiddenWidgetButton);

    fireEvent.click(hiddenWidgetButton);

    expect(useStore.getState().hiddenWidgets).toEqual([]);
    expect(useStore.getState().jianView).toBe('widget:dream-notes');
    expect(useStore.getState().jianOpen).toBe(true);
  });
});
