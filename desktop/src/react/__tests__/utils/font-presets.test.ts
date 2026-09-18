import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READING_FONT_PRESET_ID,
  FOLLOW_READING_FONT_ID,
  fontPresetIdFromSerif,
  getFontFamilyForPreset,
  normalizeFontPresetId,
  normalizeFontSelectionId,
  resolveSurfaceFontPresetId,
  serifFromFontPresetId,
} from '../../utils/font-presets';

describe('font preset helpers', () => {
  it('keeps the existing serif preference as the default reading font', () => {
    expect(DEFAULT_READING_FONT_PRESET_ID).toBe('serif');
    expect(fontPresetIdFromSerif(true)).toBe('serif');
    expect(fontPresetIdFromSerif(false)).toBe('sans');
    expect(serifFromFontPresetId('serif')).toBe(true);
    expect(serifFromFontPresetId('sans')).toBe(false);
  });

  it('normalizes preset ids and follow selections explicitly', () => {
    expect(normalizeFontPresetId('sans')).toBe('sans');
    expect(normalizeFontPresetId('unknown')).toBe('serif');
    expect(normalizeFontSelectionId('follow', { allowFollow: true })).toBe(FOLLOW_READING_FONT_ID);
    expect(normalizeFontSelectionId(null, { allowFollow: true, fallback: FOLLOW_READING_FONT_ID })).toBe(FOLLOW_READING_FONT_ID);
    expect(normalizeFontSelectionId('follow', { allowFollow: false })).toBe('serif');
    expect(normalizeFontSelectionId('sans', { allowFollow: true })).toBe('sans');
  });

  it('resolves surface fonts without leaking follow into render payloads', () => {
    expect(resolveSurfaceFontPresetId('follow', 'sans')).toBe('sans');
    expect(resolveSurfaceFontPresetId('serif', 'sans')).toBe('serif');
  });

  it('provides concrete CSS stacks for renderer and screenshot surfaces', () => {
    expect(getFontFamilyForPreset('serif')).toContain('Noto Serif SC');
    expect(getFontFamilyForPreset('sans')).toContain('Inter');
  });
});
