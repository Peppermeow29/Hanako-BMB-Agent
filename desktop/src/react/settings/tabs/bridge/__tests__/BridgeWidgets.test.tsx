/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeStatusDot, BridgeStatusText } from '../BridgeWidgets';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

afterEach(cleanup);

describe('Bridge status widgets', () => {
  it('renders loading status instead of disconnected while bridge status is unknown', () => {
    render(
      <div>
        <BridgeStatusDot status={undefined} />
        <BridgeStatusText status={undefined} />
      </div>,
    );

    expect(screen.getByText('common.loading')).toBeTruthy();
    expect(screen.queryByText('settings.bridge.disconnected')).toBeNull();
    expect(document.querySelector('.bridge-status-dot')?.getAttribute('aria-busy')).toBe('true');
  });

  it('renders connecting separately from disconnected', () => {
    render(
      <div>
        <BridgeStatusDot status="connecting" />
        <BridgeStatusText status="connecting" />
      </div>,
    );

    expect(screen.getByText('status.connecting')).toBeTruthy();
    expect(screen.queryByText('settings.bridge.disconnected')).toBeNull();
    expect(document.querySelector('.bridge-status-dot')?.getAttribute('aria-busy')).toBe('true');
  });
});
