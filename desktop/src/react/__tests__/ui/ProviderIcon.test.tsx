// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderIcon } from '../../ui/ProviderIcon';

describe('ProviderIcon', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the Fireworks provider logo through the shared icon map', () => {
    const { container } = render(<ProviderIcon provider="fireworks" />);
    const svg = container.querySelector('svg');
    const path = container.querySelector('path');

    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(path?.getAttribute('d')).toContain('M14.8 5l-2.801 6.795');
    expect(path?.getAttribute('fill')).toBeNull();
    expect(container.querySelector('rect')).toBeNull();
  });
});
