/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelWidget } from '../../settings/widgets/ModelWidget';

vi.mock('../../settings/api', () => ({
  hanaFetch: vi.fn(async () => ({
    json: async () => ({ models: [] }),
  })),
}));

describe('ModelWidget', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the provider icon in the closed selected trigger', () => {
    render(
      <ModelWidget
        value={{ id: 'glm-5.2', provider: 'zhipu-coding' }}
        onSelect={vi.fn()}
        placeholder="select"
      />,
    );

    const trigger = screen.getByRole('button', { name: /zhipu-coding\/glm-5.2/ });
    expect(trigger.querySelector('svg')).toBeTruthy();
  });
});
