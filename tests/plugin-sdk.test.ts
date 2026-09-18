/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_UI_CAPABILITY,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_PROTOCOL_VERSION,
} from '@hana/plugin-protocol';
import { createHanaPluginSdk, HanaPluginError } from '@hana/plugin-sdk';

function makeParentWindow() {
  return { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

function makeTargetWindow(href: string) {
  const location = new URL(href);
  return {
    parent: makeParentWindow(),
    location,
    document: { referrer: '' },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  } as unknown as Window;
}

describe('plugin SDK', () => {
  it('posts ready and resize as versioned plugin UI events', () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'id-1',
    });

    sdk.ready();
    sdk.ui.resize({ width: 260, height: 210 });

    expect(parentWindow.postMessage).toHaveBeenNthCalledWith(1, {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type: 'hana.ready',
    }, 'http://127.0.0.1:3210');
    expect(parentWindow.postMessage).toHaveBeenNthCalledWith(2, {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type: PLUGIN_UI_CAPABILITY.UI_RESIZE,
      payload: { width: 260, height: 210 },
    }, 'http://127.0.0.1:3210');
  });

  it('resolves host requests only from the configured parent window and origin', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'request-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.host.request('toast.show', { message: 'hello' });
    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'request-1',
      kind: 'request',
      type: 'toast.show',
      payload: { message: 'hello' },
    }, 'http://127.0.0.1:3210');

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ignored: true },
      },
      origin: 'http://evil.test',
      source: parentWindow,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ignored: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: window,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ok: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects host request errors with a typed HanaPluginError', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'request-2',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.host.request('external.open', { url: 'https://example.com' });
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-2',
        kind: 'error',
        type: 'external.open',
        error: {
          code: 'CAPABILITY_DENIED',
          message: 'Capability denied.',
          details: { capability: 'external.open' },
        },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).rejects.toMatchObject({
      name: 'HanaPluginError',
      code: 'CAPABILITY_DENIED',
      message: 'Capability denied.',
      details: { capability: 'external.open' },
    } satisfies Partial<HanaPluginError>);
  });

  it('wraps toast.show as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'toast-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.toast.show({ message: 'Saved', type: 'success', duration: 3000 });

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'toast-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.TOAST_SHOW,
      payload: { message: 'Saved', type: 'success', duration: 3000 },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'toast-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.TOAST_SHOW,
        payload: { shown: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ shown: true });
  });

  it('wraps external.open string input as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'external-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.external.open('https://example.com/docs');

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'external-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN,
      payload: { url: 'https://example.com/docs' },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'external-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN,
        payload: { opened: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ opened: true });
  });

  it('wraps clipboard.writeText string input as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'clipboard-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.clipboard.writeText('copy me');

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'clipboard-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
      payload: { text: 'copy me' },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'clipboard-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
        payload: { written: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ written: true });
  });

  it('wraps resource helpers as browser-safe host requests', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'resource-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.resources.open({
      resource: { kind: 'session-file', fileId: 'sf_1', sessionId: 'sess_1' },
      mode: 'preview',
    });

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'resource-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.RESOURCE_OPEN,
      payload: {
        resource: { kind: 'session-file', fileId: 'sf_1', sessionId: 'sess_1' },
        mode: 'preview',
      },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'resource-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.RESOURCE_OPEN,
        payload: { opened: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ opened: true });
  });

  it('resolves plugin asset URLs from the current iframe route', () => {
    const parentWindow = makeParentWindow();
    const targetWindow = makeTargetWindow('https://hana.example/api/plugins/demo-plugin/page?hana-host-origin=https%3A%2F%2Fhana.example');
    const sdk = createHanaPluginSdk({
      parentWindow,
      targetWindow,
      targetOrigin: 'https://hana.example',
    });

    expect(sdk.assets.url('dist/app.js')).toBe('https://hana.example/api/plugins/demo-plugin/assets/dist/app.js');
    expect(sdk.assets.url('/images/logo.svg')).toBe('https://hana.example/api/plugins/demo-plugin/assets/images/logo.svg');
  });

  it('resolves plugin API URLs from the current iframe route', () => {
    const sdk = createHanaPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://hana.example/api/plugins/demo-plugin/page?pluginSurfaceSession=session-1'),
      targetOrigin: 'https://hana.example',
    });

    expect(sdk.api.url('api/translate')).toBe('https://hana.example/api/plugins/demo-plugin/api/translate');
    expect(sdk.api.url('/api/translate?mode=fast')).toBe('https://hana.example/api/plugins/demo-plugin/api/translate?mode=fast');
  });

  it('adds the plugin surface session when fetching the current plugin API', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    const targetWindow = {
      ...makeTargetWindow('https://hana.example/api/plugins/demo-plugin/page?pluginSurfaceSession=session-1'),
      fetch: fetchMock,
    } as unknown as Window;
    const sdk = createHanaPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow,
      targetOrigin: 'https://hana.example',
    });

    await sdk.api.fetch('api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'test' }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hana.example/api/plugins/demo-plugin/api/translate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ domain: 'test' }),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get(PLUGIN_SURFACE_SESSION_HEADER)).toBe('session-1');
  });

  it('rejects unsafe plugin API inputs and missing surface sessions', () => {
    const sdk = createHanaPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://hana.example/api/plugins/demo/page?pluginSurfaceSession=session-1'),
      targetOrigin: 'https://hana.example',
    });

    for (const unsafePath of [
      '../secret',
      'api/../secret',
      'api//secret',
      'https://evil.test/api',
      '/api/plugins/other-plugin/route',
      '',
      './api',
    ]) {
      expect(() => sdk.api.url(unsafePath)).toThrow(/plugin API path/i);
    }

    const missingSessionSdk = createHanaPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://hana.example/api/plugins/demo/page'),
      targetOrigin: 'https://hana.example',
    });
    expect(() => missingSessionSdk.api.fetch('api/translate')).toThrow(/pluginSurfaceSession/);
  });

  it('rejects unsafe plugin asset URL inputs', () => {
    const sdk = createHanaPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://hana.example/api/plugins/demo/page'),
      targetOrigin: 'https://hana.example',
    });

    for (const unsafePath of ['../secret.js', 'dist\\app.js', 'https://evil.test/app.js', '', './app.js']) {
      expect(() => sdk.assets.url(unsafePath)).toThrow(/asset path/i);
    }
  });
});
