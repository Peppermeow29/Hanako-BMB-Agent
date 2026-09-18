import { describe, expect, it } from 'vitest';
import { OUTPUT_PRESETS } from '../../settings/helpers';

describe('model output presets', () => {
  it('offers the 64K default target plus explicit 128K and 256K choices', () => {
    expect(OUTPUT_PRESETS).toEqual(expect.arrayContaining([
      { label: '64K', value: 65_536 },
      { label: '128K', value: 131_072 },
      { label: '256K', value: 262_144 },
    ]));
  });
});
