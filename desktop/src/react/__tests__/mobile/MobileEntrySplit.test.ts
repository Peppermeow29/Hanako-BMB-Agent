import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /^\s*import(?:\s+type)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm;
  const sideEffectImportRe = /^\s*import\s+['"]([^'"]+)['"];?/gm;
  for (const match of source.matchAll(importRe)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(sideEffectImportRe)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe('Mobile PWA entry split', () => {
  it('uses a mobile-specific CSS entry instead of the desktop global stylesheet', () => {
    const source = readFileSync(path.join(process.cwd(), 'desktop/src/mobile-main.tsx'), 'utf8');
    const imports = staticImportSpecifiers(source);

    expect(imports).toContain('./react/mobile/mobile-entry.css');
    expect(imports).not.toContain('./styles.css');
  });

  it('keeps the bundled serif font contract in the mobile-specific CSS entry', () => {
    const css = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'), 'utf8');

    expect(css).toMatch(/@import\s+url\(['"]?\.\.\/\.\.\/themes\/new-warm-paper-fonts\.css['"]?\)/);
    expect(css).toMatch(/--font-serif:\s*'EB Garamond',\s*'Noto Serif SC',\s*'Source Han Serif SC',\s*'Songti SC',\s*'STSong',\s*serif/);
    expect(css).toMatch(/body\.font-sans\s*\{[\s\S]*--font-serif:\s*var\(--font-ui\)/);
  });

  it('keeps mobile panel spacing and card chrome aligned with the desktop contract', () => {
    const css = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'), 'utf8');
    const jianInnerBlock = css.match(/\.jian-sidebar-inner\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const universalCardBlock = css.match(/\.universal-card,\s*\.jian-card\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(css).toMatch(/--panel-edge-gap:\s*var\(--space-8\);/);
    expect(css).toMatch(/--panel-card-bg:\s*var\(--bg-card,\s*var\(--bg\)\);/);
    expect(css).toMatch(/--panel-card-radius:\s*var\(--radius-lg\);/);
    expect(css).toMatch(/--panel-card-border:\s*1px solid rgba\(0,\s*0,\s*0,\s*0\.08\);/);
    expect(css).toMatch(/--panel-card-shadow:\s*none;/);
    expect(jianInnerBlock).toMatch(/padding:\s*0 var\(--panel-edge-gap\) 0 0;/);
    expect(universalCardBlock).toMatch(/background(?:-color)?:\s*var\(--panel-card-bg\);/);
    expect(universalCardBlock).toMatch(/border-radius:\s*var\(--panel-card-radius\);/);
    expect(universalCardBlock).toMatch(/border:\s*var\(--panel-card-border\);/);
    expect(universalCardBlock).toMatch(/box-shadow:\s*var\(--panel-card-shadow\);/);
  });

  it('does not statically pull desktop-only app pages or heavy preview overlays into the mobile shell', () => {
    const source = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.tsx'), 'utf8');
    const imports = staticImportSpecifiers(source);

    expect(imports).not.toContain('../components/app/AppPages');
    expect(imports).not.toContain('../components/app/WorkspaceCompanionRail');
    expect(imports).not.toContain('../components/PreviewPanel');
    expect(imports).not.toContain('../components/shared/MediaViewer/MediaViewer');
  });

  it('wires service worker update detection to an explicit mobile refresh event', () => {
    const entrySource = readFileSync(path.join(process.cwd(), 'desktop/src/mobile-main.tsx'), 'utf8');
    const serviceWorkerSource = readFileSync(path.join(process.cwd(), 'desktop/src/mobile-sw.js'), 'utf8');

    expect(entrySource).toContain('hana-mobile-update-available');
    expect(entrySource).toContain('hana-mobile-apply-update');
    expect(entrySource).toContain('__hanaMobileUpdateAvailable');
    expect(entrySource).toContain('updatefound');
    expect(entrySource).toContain('controllerchange');
    expect(entrySource).toContain('registration.update()');
    expect(serviceWorkerSource).toContain("event.data?.type === 'SKIP_WAITING'");
    expect(serviceWorkerSource).toContain('self.skipWaiting()');
  });

  it('serves mobile PWA assets explicitly in Vite dev instead of falling back to HTML', () => {
    const viteConfig = readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(viteConfig).toContain("name: 'hana-serve-mobile-pwa-static-files'");
    expect(viteConfig).toContain("['/sw.js'");
    expect(viteConfig).toContain("'application/javascript; charset=utf-8'");
    expect(viteConfig).toContain("['/manifest.webmanifest'");
    expect(viteConfig).toContain("'application/manifest+json; charset=utf-8'");
  });
});
