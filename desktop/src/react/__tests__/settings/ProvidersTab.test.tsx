/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore, type ProviderSummary } from '../../settings/store';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  loadSettingsConfig: vi.fn(async () => {}),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../settings/actions', () => ({
  loadSettingsConfig: () => mocks.loadSettingsConfig(),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, unknown>) => (
    params?.name ? `${key}:${params.name}` : key
  ),
  PROVIDER_PRESETS: [
    { value: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com', api: 'openai-completions' },
    { value: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  ],
  API_FORMAT_OPTIONS: [
    { value: 'openai-completions', label: 'OpenAI Compatible' },
  ],
}));

vi.mock('../../settings/tabs/providers/OtherModelsSection', () => ({
  OtherModelsSection: () => <div data-testid="other-models-section" />,
}));

vi.mock('../../settings/tabs/providers/ProviderModelList', () => ({
  ProviderModelList: () => <div data-testid="provider-model-list" />,
}));

import { ProvidersTab } from '../../settings/tabs/ProvidersTab';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function providerSummary(overrides: Partial<ProviderSummary>): ProviderSummary {
  return {
    type: 'api-key',
    auth_type: 'api-key',
    display_name: '',
    base_url: '',
    api: 'openai-completions',
    api_key: '',
    models: [],
    custom_models: [],
    has_credentials: false,
    supports_oauth: false,
    can_delete: false,
    ...overrides,
  };
}

describe('ProvidersTab provider-scoped form state', () => {
  const providersSummary = {
    deepseek: providerSummary({
      display_name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key: 'saved-deepseek-key',
      has_credentials: true,
    }),
    groq: providerSummary({
      display_name: 'Groq',
      base_url: 'https://api.groq.com/openai/v1',
      api_key: '',
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/providers/summary') {
        return Promise.resolve(jsonResponse({ providers: providersSummary }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    useSettingsStore.setState({
      providersSummary,
      selectedProviderId: 'deepseek',
      settingsConfig: {
        providers: {
          deepseek: { api_key: 'saved-deepseek-key' },
          groq: {},
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not carry an unsaved api key draft when switching providers', async () => {
    const { container } = render(<ProvidersTab />);

    const deepseekInput = await screen.findByDisplayValue('saved-deepseek-key');
    fireEvent.change(deepseekInput, { target: { value: 'unsaved-deepseek-draft' } });
    expect(screen.getByDisplayValue('unsaved-deepseek-draft')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Groq/ }));

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedProviderId).toBe('groq');
    });
    expect(screen.queryByDisplayValue('unsaved-deepseek-draft')).not.toBeInTheDocument();
    const groqKeyInput = container.querySelector('input[type="password"]');
    expect(groqKeyInput).toHaveValue('');
  });

  it('treats registry-only preset providers as setup entries after deletion', async () => {
    const registryOnlySummary = {
      deepseek: providerSummary({
        display_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        models: [],
        has_credentials: false,
        can_delete: false,
        config_status: 'needs_setup',
        is_configured: false,
      }),
    };

    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/providers/summary') {
        return Promise.resolve(jsonResponse({ providers: registryOnlySummary }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    useSettingsStore.setState({
      providersSummary: registryOnlySummary,
      selectedProviderId: null,
      settingsConfig: { providers: {} },
    });

    render(<ProvidersTab />);

    const deepseekButton = await screen.findByRole('button', { name: /DeepSeek/ });
    expect(deepseekButton.className).toContain('dim');
    fireEvent.click(deepseekButton);

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedProviderId).toBe('deepseek');
    });
    expect(screen.queryByRole('button', { name: 'settings.providers.delete' })).not.toBeInTheDocument();
  });

  it('keeps registry-only non-preset providers visible as setup entries', async () => {
    const registryOnlySummary = {
      baichuan: providerSummary({
        display_name: 'Baichuan',
        base_url: 'https://api.baichuan-ai.com/v1',
        models: [],
        has_credentials: false,
        can_delete: false,
        config_status: 'needs_setup',
        is_configured: false,
      }),
    };

    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/providers/summary') {
        return Promise.resolve(jsonResponse({ providers: registryOnlySummary }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    useSettingsStore.setState({
      providersSummary: registryOnlySummary,
      selectedProviderId: null,
      settingsConfig: { providers: {} },
    });

    render(<ProvidersTab />);

    const baichuanButton = await screen.findByRole('button', { name: /Baichuan/ });
    expect(baichuanButton.className).toContain('dim');
    fireEvent.click(baichuanButton);

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedProviderId).toBe('baichuan');
    });
    expect(screen.getByDisplayValue('https://api.baichuan-ai.com/v1')).toBeInTheDocument();
  });

  it('saves registry-only non-preset providers through the initial setup payload', async () => {
    const registryOnlySummary = {
      agnes: providerSummary({
        display_name: 'Agnes',
        base_url: 'https://apihub.agnes-ai.com/v1',
        api: 'openai-completions',
        models: [],
        has_credentials: false,
        can_delete: false,
        config_status: 'needs_setup',
        is_configured: false,
      }),
    };

    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/providers/summary') {
        return Promise.resolve(jsonResponse({ providers: registryOnlySummary }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    useSettingsStore.setState({
      providersSummary: registryOnlySummary,
      selectedProviderId: 'agnes',
      settingsConfig: { providers: {} },
    });

    const { container } = render(<ProvidersTab />);

    const input = await waitFor(() => container.querySelector('input[type="password"]') as HTMLInputElement);
    fireEvent.change(input, { target: { value: 'agnes-key' } });
    const saveButton = container.querySelector('button[title="settings.providers.verifyConnection"]') as HTMLButtonElement;
    fireEvent.click(saveButton);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
      providers: {
        agnes: {
          base_url: 'https://apihub.agnes-ai.com/v1',
          api_key: 'agnes-key',
          api: 'openai-completions',
          seed_default_models: true,
        },
      },
    });
  });

  it('keeps configured custom providers above setup entries in the API group', async () => {
    const mixedSummary = {
      deepseek: providerSummary({
        display_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        has_credentials: true,
        models: ['deepseek-chat'],
      }),
      baichuan: providerSummary({
        display_name: 'Baichuan',
        base_url: 'https://api.baichuan-ai.com/v1',
        is_configured: false,
      }),
      'my-proxy': providerSummary({
        display_name: 'My Proxy',
        base_url: 'https://proxy.example.com/v1',
        has_credentials: true,
        models: ['proxy-chat'],
        can_delete: true,
      }),
    };

    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/providers/summary') {
        return Promise.resolve(jsonResponse({ providers: mixedSummary }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    useSettingsStore.setState({
      providersSummary: mixedSummary,
      selectedProviderId: null,
      settingsConfig: {
        providers: {
          deepseek: { api_key: 'deepseek-key' },
          'my-proxy': { api_key: 'proxy-key' },
        },
      },
    });

    render(<ProvidersTab />);

    const customButton = await screen.findByRole('button', { name: /My Proxy/ });
    const unregisteredPresetButton = screen.getByRole('button', { name: /Groq/ });
    const registrySetupButton = screen.getByRole('button', { name: /Baichuan/ });

    expect(customButton.compareDocumentPosition(unregisteredPresetButton) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(customButton.compareDocumentPosition(registrySetupButton) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});
