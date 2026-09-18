import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App selection floating input ownership', () => {
  it('does not mount the old selection floating textarea globally', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/App.tsx'),
      'utf8',
    );

    expect(source).not.toContain('SelectionFloatingInput');
    expect(source).not.toContain("components/floating-input/SelectionFloatingInput");
  });
});
