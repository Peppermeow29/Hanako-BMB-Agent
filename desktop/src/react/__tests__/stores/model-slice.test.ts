import { describe, expect, it } from 'vitest';
import { createModelSlice, normalizeThinkingLevel, type ModelSlice } from '../../stores/model-slice';

function makeSlice(): ModelSlice {
  let state: ModelSlice;
  const set = (partial: Partial<ModelSlice>) => {
    state = { ...state, ...partial };
  };
  state = createModelSlice(set);
  return new Proxy({} as ModelSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('model-slice thinking defaults', () => {
  it('defaults new UI state to medium rather than legacy auto', () => {
    expect(makeSlice().thinkingLevel).toBe('medium');
  });

  it('normalizes legacy xhigh to the visible max tier', () => {
    expect(normalizeThinkingLevel('xhigh')).toBe('max');
  });
});
