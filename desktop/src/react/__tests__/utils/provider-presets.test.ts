import { describe, expect, it } from 'vitest';

import { API_PROVIDER_PRESETS } from '../../utils/provider-presets';

describe('provider presets', () => {
  it('exposes xAI Grok through the OpenAI-compatible API key flow', () => {
    expect(API_PROVIDER_PRESETS).toContainEqual(expect.objectContaining({
      value: 'xai',
      label: 'xAI (Grok)',
      url: 'https://api.x.ai/v1',
      api: 'openai-completions',
    }));
  });
});
