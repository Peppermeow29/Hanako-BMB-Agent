/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

type MockResponse = { json: () => Promise<unknown> };

const hanaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({ models: [] }),
}));
const showInFinderMock = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
  hanaUrl: (path: string) => path,
  yuanFallbackAvatar: (yuan: string) => `/fallback-${yuan}.png`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: vi.fn(async () => true),
}));

vi.mock('../../settings/actions', () => ({
  browseAgent: vi.fn(),
  switchToAgent: vi.fn(),
  loadSettingsConfig: vi.fn(async () => {}),
  loadAgents: vi.fn(async () => {}),
}));

vi.mock('@/ui', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel || label}
      aria-checked={on === undefined ? 'mixed' : on}
      disabled={on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    />
  ),
  SelectWidget: ({
    value,
    options = [],
    renderTrigger,
  }: {
    value?: string;
    options?: Array<{ value: string; label: string; group?: string }>;
    renderTrigger?: (option: { value: string; label: string; group?: string } | undefined, isOpen: boolean) => React.ReactNode;
  }) => {
    const current = options.find(o => o.value === value);
    return (
      <div data-testid="model-select">
        {renderTrigger ? renderTrigger(current, false) : (value || '')}
      </div>
    );
  },
  ProviderGroupHeader: ({ provider }: { provider: string }) => <div>{provider}</div>,
  ProviderIcon: ({ provider }: { provider?: string }) => <svg data-testid={`provider-icon-${provider || 'none'}`} />,
  selectWidgetStyles: { providerInset: 'providerInset' },
}));

vi.mock('../../settings/tabs/agent/AgentCardStack', () => ({
  AgentCardStack: ({
    selectedId,
    onExport,
  }: {
    selectedId: string | null;
    onExport?: (id: string) => void;
  }) => (
    <div>
      <div data-testid="selected-agent">{selectedId || ''}</div>
      {selectedId && onExport ? (
        <button data-testid="export-agent" onClick={() => onExport(selectedId)}>
          export
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../../settings/tabs/agent/YuanSelector', () => ({
  YuanSelector: () => <div data-testid="yuan-selector" />,
}));

vi.mock('../../settings/tabs/agent/AgentMemory', () => ({
  MemorySection: ({
    hasUtilityModel,
    memoryEnabled,
  }: {
    hasUtilityModel?: boolean;
    memoryEnabled?: boolean;
  }) => (
    <div
      data-testid="memory-section"
      data-has-utility={hasUtilityModel === undefined ? 'loading' : hasUtilityModel ? 'true' : 'false'}
      data-memory-enabled={memoryEnabled === undefined ? 'loading' : memoryEnabled ? 'true' : 'false'}
    />
  ),
}));

vi.mock('../../settings/tabs/agent/AgentToolsSection', () => ({
  AgentToolsSection: () => <div data-testid="agent-tools" />,
}));

vi.mock('../../settings/tabs/agent/AgentExperience', () => ({
  parseExperience: () => [],
  ExperienceBlock: () => null,
  putExperience: vi.fn(),
}));

describe('AgentTab settings agent selection', () => {
  beforeEach(() => {
    hanaFetchMock.mockImplementation(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
      json: async () => ({ models: [] }),
    }));
    showInFinderMock.mockReset();
    (window as unknown as { platform: unknown }).platform = { showInFinder: showInFinderMock };
    useSettingsStore.setState({
      agents: [
        { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: true },
        { id: 'deepseek', name: 'DeepSeek', yuan: 'deepseek', isPrimary: false },
      ],
      currentAgentId: 'hana',
      settingsAgentId: null,
      settingsConfig: {
        agent: { name: 'Hana', yuan: 'hanako' },
        memory: { enabled: true },
      },
      currentPins: [],
      globalModelsConfig: {
        models: { utility: { id: 'u' }, utility_large: { id: 'ul' } },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('rerenders when browsing a different settings agent', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('hana');
    expect(screen.getByTestId('memory-section')).toBeInTheDocument();

    act(() => {
      useSettingsStore.setState({ settingsAgentId: 'deepseek' });
    });

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('deepseek');
  });

  it('does not force memory off while global model settings are still loading', async () => {
    useSettingsStore.setState({ globalModelsConfig: null });
    const { AgentTab } = await import('../../settings/tabs/AgentTab');

    render(<AgentTab />);

    expect(screen.getByTestId('memory-section')).toHaveAttribute('data-has-utility', 'loading');
    expect(screen.getByTestId('memory-section')).toHaveAttribute('data-memory-enabled', 'true');
  });

  it('shows the provider icon in the selected agent chat model trigger', async () => {
    hanaFetchMock.mockImplementation(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
      json: async () => ({
        models: [{ id: 'glm-5.2', name: 'GLM-5.2', provider: 'zhipu-coding' }],
      }),
    }));
    useSettingsStore.setState({
      settingsConfig: {
        agent: { name: 'Hana', yuan: 'hanako' },
        memory: { enabled: true },
        models: { chat: { id: 'glm-5.2', provider: 'zhipu-coding' } },
      },
    });
    const { AgentTab } = await import('../../settings/tabs/AgentTab');

    render(<AgentTab />);

    expect(await screen.findByTestId('provider-icon-zhipu-coding')).toBeTruthy();
    expect(screen.getByTestId('model-select')).toHaveTextContent('GLM-5.2');
  });

  it('confirms character-card export from the live preview overlay', async () => {
    hanaFetchMock.mockImplementation(async (url: string, _opts?: RequestInit): Promise<MockResponse> => {
      if (url === '/api/models') return { json: async () => ({ models: [] }) };
      if (url === '/api/character-cards/export/preview') {
        return {
          json: async () => ({
            ok: true,
            plan: {
              mode: 'export',
              agentId: 'hana',
              packageName: 'hana-charactercard.zip',
              agent: { name: 'Hana', yuan: 'hanako', description: '花名册描述' },
              prompts: { identity: 'identity', agents: 'agents-md', publicAgents: 'public' },
              memory: {
                available: true,
                count: 1,
                preview: '重要事实前二十字',
                compiled: { facts: '重要事实前二十字', today: '', week: '', longterm: '' },
              },
              skills: { count: 0, bundles: [] },
              assets: {},
            },
          }),
        };
      }
      if (url === '/api/character-cards/export') {
        return {
          json: async () => ({
            ok: true,
            filePath: '/tmp/hana-charactercard.zip',
            fileName: 'hana-charactercard.zip',
          }),
        };
      }
      return { json: async () => ({ ok: true }) };
    });

    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-agent'));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(await screen.findByText('settings.characterCard.confirm'));
      await Promise.resolve();
    });

    const exportCall = hanaFetchMock.mock.calls.find((call) => {
      const [url, opts] = call as [string, RequestInit | undefined];
      return url === '/api/character-cards/export' && opts?.method === 'POST';
    }) as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(String(exportCall?.[1]?.body))).toEqual({
      agentId: 'hana',
      exportMemory: false,
    });
    expect(showInFinderMock).toHaveBeenCalledWith('/tmp/hana-charactercard.zip');
  });

  it('saves the agent name when pressing Enter in the name field (#1306)', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    const nameInput = screen.getByPlaceholderText('settings.agent.agentNameHint');

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'NewName' } });
    });
    await act(async () => {
      fireEvent.keyDown(nameInput, { key: 'Enter' });
      await Promise.resolve();
    });

    const cfgCall = hanaFetchMock.mock.calls.find((call) => {
      const [url, opts] = call as [string, RequestInit | undefined];
      return url === '/api/agents/hana/config' && opts?.method === 'PUT';
    }) as [string, RequestInit | undefined] | undefined;
    expect(cfgCall).toBeTruthy();
    expect(JSON.parse(String(cfgCall?.[1]?.body))).toEqual({ agent: { name: 'NewName' } });
  });

  it('saves only the agent name from the compact name save button', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    const { container } = render(<AgentTab />);

    const nameInput = screen.getByPlaceholderText('settings.agent.agentNameHint');
    const identityInput = container.querySelectorAll('textarea')[0];
    expect(identityInput).toBeTruthy();

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'NewName' } });
      fireEvent.change(identityInput, { target: { value: 'changed identity' } });
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'settings.save' })[0]);
      await Promise.resolve();
    });

    const cfgCall = hanaFetchMock.mock.calls.find((call) => {
      const [url, opts] = call as [string, RequestInit | undefined];
      return url === '/api/agents/hana/config' && opts?.method === 'PUT';
    }) as [string, RequestInit | undefined] | undefined;
    const identityCall = hanaFetchMock.mock.calls.find((call) => {
      const [url, opts] = call as [string, RequestInit | undefined];
      return url === '/api/agents/hana/identity' && opts?.method === 'PUT';
    });

    expect(cfgCall).toBeTruthy();
    expect(JSON.parse(String(cfgCall?.[1]?.body))).toEqual({ agent: { name: 'NewName' } });
    expect(identityCall).toBeUndefined();
  });

  it('does not save on Enter while composing with an IME (#1306)', async () => {
    const { AgentTab } = await import('../../settings/tabs/AgentTab');
    render(<AgentTab />);

    const nameInput = screen.getByPlaceholderText('settings.agent.agentNameHint');

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '小花' } });
    });
    await act(async () => {
      // 中文输入法组合态按回车确认候选词，不应触发保存
      fireEvent.keyDown(nameInput, { key: 'Enter', isComposing: true });
      await Promise.resolve();
    });

    const cfgCall = hanaFetchMock.mock.calls.find((call) => {
      const [url, opts] = call as [string, RequestInit | undefined];
      return url === '/api/agents/hana/config' && opts?.method === 'PUT';
    });
    expect(cfgCall).toBeUndefined();
  });
});
