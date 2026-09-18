/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

function runPlatformScript(): void {
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop/src/modules/platform.js'), 'utf-8');
  new Function(source)();
}

describe('web platform fallback capability contract', () => {
  beforeEach(() => {
    delete (window as any).hana;
    delete (window as any).platform;
    delete (window as any).__HANA_DEV_WEB__;
    (globalThis as any).localStorage = {
      getItem: () => '',
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
  });

  it('does not expose system trash when the browser environment cannot provide it', () => {
    runPlatformScript();

    expect((window as any).platform.trashItem).toBeUndefined();
  });

  it('uses injected dev-web server info for browser preview API access', async () => {
    (window as any).__HANA_DEV_WEB__ = {
      serverPort: 5173,
      apiBaseUrl: 'http://127.0.0.1:5173',
    };
    const fetchMock = vi.fn(async () => new Response('file contents'));
    vi.stubGlobal('fetch', fetchMock);

    runPlatformScript();

    expect(await (window as any).platform.getServerPort()).toBe('5173');
    expect(await (window as any).platform.getServerToken()).toBe('');

    const content = await (window as any).platform.readFile('/tmp/demo.md');
    expect(content).toBe('file contents');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/api/fs/read?path=%2Ftmp%2Fdemo.md',
      expect.objectContaining({
        headers: {},
      }),
    );
  });
});
