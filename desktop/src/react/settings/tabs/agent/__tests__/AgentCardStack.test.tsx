/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentCardStack } from '../AgentCardStack';
import type { Agent } from '../../../store';
import styles from '../../../Settings.module.css';

const noop = vi.fn();

function renderStack({
  agents,
  currentAgentId,
  selectedId = currentAgentId,
}: {
  agents: Agent[];
  currentAgentId: string | null;
  selectedId?: string | null;
}) {
  return render(
    <AgentCardStack
      agents={agents}
      selectedId={selectedId}
      currentAgentId={currentAgentId}
      onSelect={noop}
      onAvatarClick={noop}
      onSetPrimary={noop}
      onDelete={noop}
      onExport={noop}
      onAdd={noop}
    />
  );
}

afterEach(() => {
  cleanup();
  noop.mockClear();
});

describe('AgentCardStack', () => {
  it('renders the primary badge from the server-provided isPrimary flag', () => {
    const agents: Agent[] = [
      { id: 'agent-a', name: '小花', yuan: 'hanako', isPrimary: false },
      { id: 'agent-b', name: '毛毛', yuan: 'butter', isPrimary: true },
    ];

    const { container } = renderStack({
      agents,
      currentAgentId: 'agent-a',
    });

    const currentCard = container.querySelector('[data-agent-id="agent-a"]');
    const primaryCard = container.querySelector('[data-agent-id="agent-b"]');
    const badgeSelector = `.${styles['agent-card-badge']}`;

    expect(currentCard?.querySelector(badgeSelector)).not.toBeInTheDocument();
    expect(primaryCard?.querySelector(badgeSelector)).toBeInTheDocument();
  });
});
