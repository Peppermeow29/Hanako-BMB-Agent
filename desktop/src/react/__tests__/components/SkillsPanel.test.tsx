// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWindowTestT } from '../helpers/i18n-test-strings';
import { useStore } from '../../stores';
import { SkillsPanel } from '../../components/SkillsPanel';

const fetchMock = vi.fn();
vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

async function flushMicrotasks(ticks = 3) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

describe('SkillsPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    installWindowTestT({
      'settings.skills.installSuccess': 'installed {name}',
    });
    window.platform = {
      getFilePath: vi.fn(() => '/tmp/new-skill.skill'),
      openSkillViewer: vi.fn(),
    } as unknown as typeof window.platform;
    useStore.setState({
      activePanel: 'skills',
      currentAgentId: 'agent-a',
      agentName: 'Hana',
      agentYuan: 'hanako',
      agents: [
        { id: 'agent-a', name: 'Hana', yuan: 'hanako', isPrimary: true },
        { id: 'agent-b', name: 'Mao', yuan: 'butter', isPrimary: false },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('installs dropped skills for the selected agent, returns to all skills, and highlights the installed row', async () => {
    let installed = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/install')) {
        expect(url).toContain('agentId=agent-b');
        expect(JSON.parse(String(opts?.body || '{}'))).toMatchObject({ path: '/tmp/new-skill.skill' });
        installed = true;
        return Promise.resolve(jsonResponse({ ok: true, skill: { name: 'new-skill' } }));
      }
      if (url.includes('/api/skills/bundles')) {
        return Promise.resolve(jsonResponse({ bundles: [] }));
      }
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: installed
            ? [
                { name: 'old-skill', enabled: true, source: 'user', description: 'Existing' },
                { name: 'new-skill', enabled: true, source: 'user', description: 'Fresh' },
              ]
            : [
                { name: 'old-skill', enabled: true, source: 'user', description: 'Existing' },
              ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    expect(fetchMock.mock.calls.some((call) =>
      typeof call[0] === 'string'
      && call[0].includes('/api/skills?agentId=agent-a')
      && call[0].includes('runtime=1'),
    )).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Mao' }));

    const file = new File(['skill'], 'new-skill.skill');
    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(fetchMock.mock.calls.some((call) =>
      typeof call[0] === 'string' && call[0].includes('/api/skills/install?agentId=agent-b'),
    )).toBe(true));
    await flushMicrotasks(6);

    expect(screen.getByRole('tab', { name: 'skills.panel.allTab' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-highlighted-skill="new-skill"]')).toBeTruthy();
  });

  it('installs dropped skills for the current agent from all skills by default', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/install')) {
        expect(url).toContain('agentId=agent-a');
        expect(JSON.parse(String(opts?.body || '{}'))).toMatchObject({ path: '/tmp/new-skill.skill' });
        return Promise.resolve(jsonResponse({ ok: true, skill: { name: 'current-agent-skill' } }));
      }
      if (url.includes('/api/skills/bundles')) {
        return Promise.resolve(jsonResponse({ bundles: [] }));
      }
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'current-agent-skill', enabled: true, source: 'user', description: 'Fresh' },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    const file = new File(['skill'], 'new-skill.skill');
    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(fetchMock.mock.calls.some((call) =>
      typeof call[0] === 'string' && call[0].includes('/api/skills/install?agentId=agent-a'),
    )).toBe(true));
    await flushMicrotasks(6);

    expect(screen.getByRole('tab', { name: 'skills.panel.allTab' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-highlighted-skill="current-agent-skill"]')).toBeTruthy();
  });

  it('creates skill bundles from the all skills page for the current agent view', async () => {
    let created = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/bundles') && opts?.method === 'POST') {
        expect(url).toContain('agentId=agent-a');
        expect(JSON.parse(String(opts.body || '{}'))).toMatchObject({
          name: 'Research',
          skillNames: [],
        });
        created = true;
        return Promise.resolve(jsonResponse({ ok: true, bundle: { id: 'research', name: 'Research', skillNames: [] } }));
      }
      if (url.includes('/api/skills/bundles')) {
        return Promise.resolve(jsonResponse({ bundles: [] }));
      }
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: true, source: 'user', description: 'Read' },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.createBundleAriaLabel' }));
    fireEvent.change(screen.getByLabelText('settings.skills.bundleDialog.bundleNameLabel'), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.bundleDialog.createBtn' }));

    await waitFor(() => expect(created).toBe(true));
  });

  it('toggles a skill from an agent tab with the same agent skills API as settings', async () => {
    let toggled = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/agents/agent-b/skills/reader')) {
        expect(opts?.method).toBe('PATCH');
        expect(JSON.parse(String(opts?.body || '{}'))).toEqual({ enabled: true });
        toggled = true;
        return Promise.resolve(jsonResponse({ ok: true, enabled: ['reader'], changed: ['reader'] }));
      }
      if (url.includes('/api/skills/bundles')) {
        return Promise.resolve(jsonResponse({ bundles: [] }));
      }
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: toggled, source: 'user', description: 'Read' },
          ],
        }));
      }
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({ skills: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Mao' }));
    await screen.findByText('reader');

    fireEvent.click(screen.getByRole('button', { name: '启用 reader' }));

    await waitFor(() => expect(toggled).toBe(true));
  });

  it('toggles a skill bundle from an agent tab with the same bundle API as settings', async () => {
    let bundleToggled = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/agents/agent-b/skill-bundles/writing-bundle')) {
        expect(opts?.method).toBe('PATCH');
        expect(JSON.parse(String(opts?.body || '{}'))).toEqual({ enabled: true });
        bundleToggled = true;
        return Promise.resolve(jsonResponse({ ok: true, enabled: ['reader'], changed: ['reader'] }));
      }
      if (url.includes('/api/skills/bundles?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          bundles: [
            { id: 'writing-bundle', name: 'Writing Bundle', skillNames: ['reader'] },
          ],
        }));
      }
      if (url.includes('/api/skills/bundles')) {
        return Promise.resolve(jsonResponse({ bundles: [] }));
      }
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: bundleToggled, source: 'user', description: 'Read' },
          ],
        }));
      }
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({ skills: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Mao' }));
    await screen.findByText('Writing Bundle');

    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.expandBundleAriaLabel' }));
    expect(screen.getByText('reader')).toBeTruthy();

    fireEvent.click(screen.getByTestId('skill-bundle-toggle-writing-bundle'));

    await waitFor(() => expect(bundleToggled).toBe(true));
    expect(screen.getByText('reader')).toBeTruthy();
    expect(screen.queryByText('status.loading')).toBeNull();
  });
});
