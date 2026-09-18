/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsUpdateCard } from '../../components/chat/SettingsUpdateCard';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('SettingsUpdateCard', () => {
  it('renders a read-only settings update without confirmation actions', () => {
    render(
      <SettingsUpdateCard
        update={{
          status: 'applied',
          action: 'core.apply',
          key: 'locale',
          title: 'Locale updated',
          summary: 'Locale changed from zh-CN to en.',
          changes: [
            { key: 'locale', label: 'Locale', before: 'zh-CN', after: 'en' },
          ],
        }}
      />,
    );

    expect(screen.getByText('Locale updated')).toBeTruthy();
    expect(screen.getByText('Locale changed from zh-CN to en.')).toBeTruthy();
    expect(screen.getByText('zh-CN -> en')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
