// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuotedSelectionCard } from '../../components/input/QuotedSelectionCard';
import { useStore } from '../../stores';

describe('QuotedSelectionCard', () => {
  beforeEach(() => {
    useStore.getState().clearQuotedSelections();
  });

  afterEach(() => {
    cleanup();
    useStore.getState().clearQuotedSelections();
  });

  it('uses a text cursor icon for committed text quote chips', () => {
    useStore.getState().setQuotedSelections([{
      text: '2026年秋天的某段文字',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      charCount: 12,
    }]);

    render(<QuotedSelectionCard />);

    const chipText = screen.getByText('2026年秋天的某段文字');
    const chip = chipText.closest('span');
    const icon = chip?.querySelector('svg[data-icon="text-cursor"]');

    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('fill')).toBe('none');
    expect(icon?.getAttribute('stroke')).toBe('currentColor');
    expect(icon?.querySelectorAll('path')).toHaveLength(3);
  });
});
