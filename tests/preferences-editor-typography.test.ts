import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PreferencesManager } from '../core/preferences-manager.ts';

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-prefs-editor-'));
  return new PreferencesManager({
    userDir: path.join(root, 'user'),
    agentsDir: path.join(root, 'agents'),
  });
}

describe('PreferencesManager editor typography preferences', () => {
  it('returns normalized editor defaults when no preference exists', () => {
    const prefs = makePrefs();

    expect(prefs.getEditor()).toEqual({
      markdown: {
        fontPreset: 'follow',
        bodyFontSize: 16,
        heading1FontSize: 28,
        heading2FontSize: 21,
        heading3FontSize: 18,
        heading4FontSize: 16,
        heading5FontSize: 15,
        heading6FontSize: 14,
        lineHeight: 1.5,
        contentPadding: 24,
        contentWidth: 720,
      },
    });
  });

  it('saves partial editor typography preferences through the editor key', () => {
    const prefs = makePrefs();

    prefs.setEditor({
      markdown: {
        bodyFontSize: 18,
        fontPreset: 'sans',
        lineHeight: 1.9,
      },
    });

    expect(prefs.getEditor()).toEqual({
      markdown: {
        fontPreset: 'sans',
        bodyFontSize: 18,
        heading1FontSize: 28,
        heading2FontSize: 21,
        heading3FontSize: 18,
        heading4FontSize: 16,
        heading5FontSize: 15,
        heading6FontSize: 14,
        lineHeight: 1.9,
        contentPadding: 24,
        contentWidth: 720,
      },
    });
    expect(prefs.getPreferences().editor.markdown.bodyFontSize).toBe(18);
  });

  it('merges synced appearance preferences without dropping earlier fields', () => {
    const prefs = makePrefs();

    expect(prefs.getAppearance()).toEqual({});
    prefs.setAppearance({ theme: 'warm-paper', serif: true });
    prefs.setAppearance({ paperTexture: false });

    expect(prefs.getAppearance()).toEqual({
      theme: 'warm-paper',
      serif: true,
      paperTexture: false,
    });
    expect(prefs.getPreferences().appearance).toEqual({
      theme: 'warm-paper',
      serif: true,
      paperTexture: false,
    });
  });
});
