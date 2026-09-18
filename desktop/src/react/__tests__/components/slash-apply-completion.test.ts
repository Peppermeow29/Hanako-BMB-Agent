import { beforeAll, describe, expect, it, vi } from 'vitest';

let applySlashCompletion: typeof import('../../components/input/slash-commands').applySlashCompletion;

beforeAll(async () => {
  vi.stubGlobal('window', { i18n: { locale: 'zh' } });
  ({ applySlashCompletion } = await import('../../components/input/slash-commands'));
});

describe('applySlashCompletion', () => {
  it('expands a bare slash to the canonical command', () => {
    expect(applySlashCompletion('/', { name: 'plans' })).toBe('/plans');
  });

  it('expands a partial slash token to the canonical command', () => {
    expect(applySlashCompletion('/pl', { name: 'plans' })).toBe('/plans');
  });

  it('is idempotent when the text already is the canonical command', () => {
    expect(applySlashCompletion('/plans', { name: 'plans' })).toBe('/plans');
  });

  it('preserves trailing arguments after the slash token', () => {
    expect(applySlashCompletion('/pl arg1 arg2', { name: 'plans' })).toBe('/plans arg1 arg2');
  });

  it('preserves multiline content after the slash token', () => {
    expect(applySlashCompletion('/pl 第一行\n第二行', { name: 'plans' })).toBe('/plans 第一行\n第二行');
  });

  it('always replaces with the canonical name, even for a full alias match', () => {
    expect(applySlashCompletion('/alias-full', { name: 'plans' })).toBe('/plans');
  });

  it('falls back to the canonical command when the text does not start with a slash', () => {
    expect(applySlashCompletion('no-slash text', { name: 'plans' })).toBe('/plans');
  });
});
