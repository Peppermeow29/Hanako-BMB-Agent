import { describe, expect, it } from 'vitest';

import { shouldShowContextRingTokenLabel } from '../../components/input/context-ring-visibility';

describe('context ring visibility', () => {
  it('never shows the numeric label beside the ring', () => {
    expect(shouldShowContextRingTokenLabel(99_999)).toBe(false);
    expect(shouldShowContextRingTokenLabel(100_000)).toBe(false);
    expect(shouldShowContextRingTokenLabel(219_000)).toBe(false);
  });

  it('hides the numeric label when usage is unknown or invalid', () => {
    expect(shouldShowContextRingTokenLabel(null)).toBe(false);
    expect(shouldShowContextRingTokenLabel(Number.NaN)).toBe(false);
  });
});
