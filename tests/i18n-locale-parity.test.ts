import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const localesDir = path.join(process.cwd(), 'desktop/src/locales');
const locales = ['en', 'zh', 'zh-TW', 'ja', 'ko'];

function load(name: string) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf8'));
}

function get(obj: Record<string, unknown>, dotPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, dotPath)) return obj[dotPath];
  return dotPath.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      return (cur as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function collectLeaves(obj: Record<string, unknown>, prefix = '', out = new Set<string>()) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('.') && (typeof value === 'string' || Array.isArray(value))) {
      out.add(key);
      continue;
    }
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectLeaves(value as Record<string, unknown>, dotPath, out);
    } else {
      out.add(dotPath);
    }
  }
  return out;
}

describe('locale parity vs en.json', () => {
  const en = load('en');
  const enKeys = collectLeaves(en);

  for (const locale of locales.filter((name) => name !== 'en')) {
    it(`${locale}.json resolves every en leaf key`, () => {
      const data = load(locale);
      const missing = [...enKeys].filter((key) => get(data, key) === undefined);
      expect(missing, `missing in ${locale}: ${missing.slice(0, 10).join(', ')}`).toEqual([]);
    });
  }
});
