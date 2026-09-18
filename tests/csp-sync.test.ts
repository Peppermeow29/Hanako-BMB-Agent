import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as vm from 'node:vm';

/**
 * CSP 双源同步检查：
 * 确保 vite.csp-profiles.ts 中的 CSP_PROFILES 与 HTML 源文件中的 meta tag 保持一致。
 * 如果测试失败，说明有人改了 CSP_PROFILES 但忘了同步 HTML 源文件（或反之）。
 *
 * CSP_PROFILES 原本内联在 vite.config.ts，启用双 artifact 管线后拆到
 * vite.csp-profiles.ts（vite.config.ts 与 vite.config.splash.ts 共享同一份）。
 */

// 从 vite.csp-profiles.ts 源码中提取 CSP_PROFILES（不 import，避免引入 Vite 依赖）
function extractCspProfiles(): Record<string, string> {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'vite.csp-profiles.ts'), 'utf-8');
  const profiles: Record<string, string> = {};

  // 匹配 'filename.html': "csp-value" 或 'filename.html':\n    "csp-value"
  const re = /'([^']+\.html)':\s*\n?\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    profiles[m[1]] = m[2];
  }
  return profiles;
}

// 从 HTML 文件中提取 CSP content 属性值
function extractHtmlCsp(htmlPath: string): string | null {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/s);
  return m ? m[1] : null;
}

// 标准化 CSP：去除末尾分号，排序指令
function normalizeCsp(csp: string): string {
  return csp
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .sort()
    .join('; ');
}

describe('CSP sync', () => {
  const profiles = extractCspProfiles();
  const htmlDir = path.resolve(__dirname, '..', 'desktop', 'src');

  it('should have extracted all 8 profiles', () => {
    expect(Object.keys(profiles)).toHaveLength(8);
  });

  for (const [filename, profileCsp] of Object.entries(profiles)) {
    it(`${filename}: HTML source matches CSP_PROFILES`, () => {
      if (filename === 'index.html' || filename === 'settings.html') {
        const html = fs.readFileSync(path.join(htmlDir, filename), 'utf-8');
        expect(html).toContain('modules/connection-csp.js');
        expect(extractHtmlCsp(path.join(htmlDir, filename))).toBeNull();
        return;
      }
      const htmlPath = path.join(htmlDir, filename);
      const htmlCsp = extractHtmlCsp(htmlPath);
      expect(htmlCsp).not.toBeNull();
      expect(normalizeCsp(htmlCsp!)).toBe(normalizeCsp(profileCsp));
    });
  }

  it('desktop index CSP is not widened to all remote origins', () => {
    const indexCsp = profiles['index.html'];
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(indexCsp).toBeTruthy();
    expect(indexCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
    expect(runtimeCsp).toContain('serverConnections');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
  });

  it('desktop index CSP allows local PDF iframe sources without widening connections', () => {
    const indexCsp = profiles['index.html'];
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(indexCsp).toMatch(/frame-src[^;]*\sfile:(?:\s|;|$)/);
    expect(runtimeCsp).toMatch(/"frame-src":\s*\[[^\]]*"file:"/s);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\sfile:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/"connect-src":\s*\[[^\]]*"file:"/s);
  });

  it('settings window uses the same dynamic scoped connection CSP as the desktop index', () => {
    const html = fs.readFileSync(path.join(htmlDir, 'settings.html'), 'utf-8');
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(html).toContain('modules/connection-csp.js');
    expect(extractHtmlCsp(path.join(htmlDir, 'settings.html'))).toBeNull();
    expect(runtimeCsp).toContain('serverConnections');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
  });

  it('dynamic desktop CSP keeps saved remote origins available after active selection is cleared', () => {
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');
    let written = '';
    const storage = {
      'hana-server-connections-v1': JSON.stringify({
        schemaVersion: 1,
        activeServerConnectionId: null,
        serverConnections: {
          'lan:node:studio': {
            connectionId: 'lan:node:studio',
            kind: 'lan',
            baseUrl: 'http://192.168.1.9:14500',
            wsUrl: 'ws://192.168.1.9:14500',
          },
        },
      }),
    };
    vm.runInNewContext(runtimeCsp, {
      URL,
      window: {
        location: {
          host: '127.0.0.1:5173',
          hostname: '127.0.0.1',
        },
      },
      localStorage: {
        getItem(key: string) {
          return storage[key] || null;
        },
      },
      document: {
        write(value: string) {
          written += value;
        },
      },
    });

    expect(written).toContain('http://192.168.1.9:14500');
    expect(written).toContain('ws://192.168.1.9:14500');
  });
});
