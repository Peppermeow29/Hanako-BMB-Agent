/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PluginPageView } from '../../components/plugin/PluginPageView';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';

const mockState = {
  pluginPages: [{
    pluginId: 'plain-plugin',
    routeUrl: '/api/plugins/plain-plugin/page',
    hostCapabilities: [],
  }],
  currentAgentId: 'agent-1',
};

vi.mock('../../stores', () => ({
  useStore: vi.fn((selector: (state: typeof mockState) => unknown) => selector(mockState)),
}));

vi.mock('../../hooks/use-plugin-surface-url', () => ({
  usePluginSurfaceUrl: vi.fn(() => ({
    status: 'ready',
    iframeSrc: 'http://127.0.0.1:3210/api/plugins/plain-plugin/page?ticket=abc',
    retry: vi.fn(),
  })),
}));

vi.mock('../../hooks/use-plugin-iframe', () => ({
  usePluginIframe: vi.fn(() => ({
    iframeRef: { current: null },
    status: 'ready',
    postToIframe: vi.fn(),
    retry: vi.fn(),
  })),
}));

describe('PluginPageView', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(usePluginIframe).mockClear();
  });

  it('lets plain HTML plugin pages become visible even without an SDK ready handshake', () => {
    render(<PluginPageView pluginId="plain-plugin" />);

    expect(usePluginIframe).toHaveBeenCalledWith(
      'http://127.0.0.1:3210/api/plugins/plain-plugin/page?ticket=abc',
      expect.objectContaining({
        pluginId: 'plain-plugin',
        slot: 'page',
        readyOnTimeout: true,
      }),
    );
  });
});
