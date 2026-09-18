import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PRODUCTION_TARGETS = [
  'desktop/src/react/components',
  'desktop/src/react/services',
  'desktop/src/react/workbench',
  'desktop/src/viewer-window-entry.tsx',
];

function readProductionFiles(target: string): string[] {
  const fullPath = path.join(ROOT, target);
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return [fullPath];

  const out: string[] = [];
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    const child = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...readProductionFiles(path.relative(ROOT, child)));
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
  }
  return out;
}

describe('ResourceIO watch architecture', () => {
  it('does not call native file or workspace watch APIs from production renderer code', () => {
    const offenders: string[] = [];

    for (const target of PRODUCTION_TARGETS) {
      for (const filePath of readProductionFiles(target)) {
        const rel = path.relative(ROOT, filePath);
        const source = fs.readFileSync(filePath, 'utf-8');
        if (
          source.includes('watchFileChanges(')
          || source.includes('.watchFile(')
          || source.includes('.watchWorkspace(')
          || source.includes('onFileChanged(')
          || source.includes('onWorkspaceChanged(')
        ) {
          offenders.push(rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps renderer file freshness bridges on backend ResourceIO subscriptions', () => {
    const subscriptionBridgeFiles = [
      'desktop/src/react/components/app/OpenPreviewDocumentWatchBridge.tsx',
      'desktop/src/react/components/app/WorkspaceFileChangeBridge.tsx',
    ];

    for (const rel of subscriptionBridgeFiles) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(source).toContain('retainResourceWatch');
      expect(source).not.toContain('window.platform.watchFile');
      expect(source).not.toContain('window.platform.watchWorkspace');
      expect(source).not.toContain('.watchFile(');
      expect(source).not.toContain('.watchWorkspace(');
    }

    const aliasBridge = fs.readFileSync(
      path.join(ROOT, 'desktop/src/react/components/right-workspace/WorkspaceFileWatchBridge.tsx'),
      'utf-8',
    );
    expect(aliasBridge).toContain('WorkspaceFileChangeBridge');
    expect(aliasBridge).not.toContain('window.platform.watchFile');
    expect(aliasBridge).not.toContain('window.platform.watchWorkspace');
    expect(aliasBridge).not.toContain('.watchFile(');
    expect(aliasBridge).not.toContain('.watchWorkspace(');
  });
});
