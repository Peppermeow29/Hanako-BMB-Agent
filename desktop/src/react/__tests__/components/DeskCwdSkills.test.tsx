/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state: Record<string, any> = {};

vi.mock('../../stores', () => {
  const useStore: any = (selector: (value: typeof state) => unknown) => selector(state);
  useStore.getState = () => state;
  useStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useStore };
});

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../../services/resource-access', () => ({ canUseNativeResourcePath: () => true }));
vi.mock('../../services/server-connection', () => ({ resolveServerConnection: () => ({}) }));
vi.mock('../../utils/platform-runtime', () => ({ isWebRuntime: () => false }));

describe('DeskCwdSkillsPanel source status', () => {
  beforeEach(() => {
    Object.assign(state, {
      cwdSkillsOpen: true,
      deskWorkspaceMountId: null,
      cwdSkills: [
        {
          name: 'standard-skill',
          description: '',
          source: 'Agents',
          filePath: '/repo/.agents/skills/standard-skill/SKILL.md',
          baseDir: '/repo/.agents/skills/standard-skill',
          active: true,
          shadowed: false,
        },
        {
          name: 'shadowed-skill',
          description: '',
          source: 'Codex',
          filePath: '/repo/.codex/skills/shadowed-skill/SKILL.md',
          baseDir: '/repo/.codex/skills/shadowed-skill',
          active: false,
          shadowed: true,
          shadowedBy: { source: 'Agents' },
        },
        {
          name: 'disabled-skill',
          description: '',
          source: 'Claude Code',
          filePath: '/repo/.claude/skills/disabled-skill/SKILL.md',
          baseDir: '/repo/.claude/skills/disabled-skill',
          active: false,
          shadowed: false,
          inactiveReason: 'policy-disabled',
        },
      ],
    });
    window.t = (key: string) => key;
  });

  afterEach(() => {
    cleanup();
    for (const key of Object.keys(state)) delete state[key];
  });

  it('shows loaded, shadowed, and policy-disabled candidates without hiding management entries', async () => {
    const { DeskCwdSkillsPanel } = await import('../../components/desk/DeskCwdSkills');
    render(<DeskCwdSkillsPanel />);

    expect(await screen.findByText('standard-skill')).toBeTruthy();
    expect(screen.getByText('shadowed-skill')).toBeTruthy();
    expect(screen.getByText('disabled-skill')).toBeTruthy();
    expect(screen.getByText('desk.cwdSkillActive')).toBeTruthy();
    expect(screen.getByText(/desk\.cwdSkillShadowed/).textContent).toContain('Agents');
    expect(screen.getByText('desk.cwdSkillInactive')).toBeTruthy();
  });
});
