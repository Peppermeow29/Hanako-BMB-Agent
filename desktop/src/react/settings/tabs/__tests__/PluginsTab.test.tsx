/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore } from '../../store';
import { AUTO_DARK_DEFAULT } from '../../../../shared/theme-registry';

const hanaFetch = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

const configurablePlugin = {
  id: 'json-config-plugin',
  name: 'JSON Config Plugin',
  status: 'loaded',
  source: 'community',
  trust: 'restricted',
  contributions: ['configuration'],
};

function pluginConfig(values: Record<string, unknown>) {
  return {
    pluginId: configurablePlugin.id,
    schema: {
      properties: {
        tags: { type: 'array', title: 'Tags' },
        metadata: { type: 'object', title: 'Metadata' },
      },
    },
    values,
  };
}

function mockConfigurablePlugin(initialValues: Record<string, unknown> = {
  tags: ['alpha'],
  metadata: { theme: 'paper' },
}) {
  let savedValues = initialValues;
  hanaFetch.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/plugins?source=community') return jsonResponse([configurablePlugin]);
    if (path === `/api/plugins/${configurablePlugin.id}/config` && options?.method === 'PUT') {
      const body = JSON.parse(String(options.body));
      savedValues = { ...savedValues, ...body.values };
      return jsonResponse(pluginConfig(savedValues));
    }
    if (path === `/api/plugins/${configurablePlugin.id}/config`) {
      return jsonResponse(pluginConfig(savedValues));
    }
    return jsonResponse([]);
  });
  return () => savedValues;
}

async function openPluginConfig() {
  const { PluginsTab } = await import('../PluginsTab');
  render(<PluginsTab />);
  fireEvent.click(await screen.findByTitle('settings.plugins.configure'));
  const textareas = await screen.findAllByRole('textbox');
  return {
    tags: textareas[0] as HTMLTextAreaElement,
    metadata: textareas[1] as HTMLTextAreaElement,
  };
}

describe('PluginsTab', () => {
  beforeEach(() => {
    hanaFetch.mockResolvedValue(jsonResponse([]));
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      selectFile: vi.fn(),
      selectDirectory: vi.fn(),
      showInFinder: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
      toastMessage: '',
      toastType: '',
      toastVisible: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetch.mockReset();
    vi.unstubAllGlobals();
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
    } as never);
  });

  it('keeps permission toggles loading until plugin settings are ready', async () => {
    const { PluginsTab } = await import('../PluginsTab');

    render(<PluginsTab />);

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches.slice(-2)).toHaveLength(2);
    for (const item of switches.slice(-2)) {
      expect(item.getAttribute('aria-checked')).toBe('mixed');
      expect(item.getAttribute('aria-busy')).toBe('true');
      expect(item.disabled).toBe(true);
    }
  });

  it('preserves Backspace and multiline Enter edits, then saves parsed array and object values', async () => {
    const getSavedValues = mockConfigurablePlugin();
    const { tags, metadata } = await openPluginConfig();

    fireEvent.keyDown(tags, { key: 'Backspace' });
    fireEvent.input(tags, {
      target: { value: '[\n  "alpha"\n' },
      inputType: 'deleteContentBackward',
    });
    expect(tags).toHaveValue('[\n  "alpha"\n');
    fireEvent.blur(tags);

    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toBe('settings.plugins.invalidJson'));
    expect(tags).toHaveValue('[\n  "alpha"\n');
    expect(hanaFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);

    const multilineTags = '[\n  "alpha",\n  "beta"\n]';
    const multilineMetadata = JSON.stringify({ theme: AUTO_DARK_DEFAULT, density: 2 }, null, 2);
    fireEvent.keyDown(tags, { key: 'Enter' });
    fireEvent.input(tags, {
      target: { value: multilineTags },
      inputType: 'insertLineBreak',
    });
    fireEvent.input(metadata, {
      target: { value: multilineMetadata },
      inputType: 'insertLineBreak',
    });
    fireEvent.blur(tags);
    fireEvent.blur(metadata);

    expect(tags).toHaveValue(multilineTags);
    expect(metadata).toHaveValue(multilineMetadata);
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => expect(hanaFetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true));
    expect(getSavedValues()).toEqual({
      tags: ['alpha', 'beta'],
      metadata: { theme: AUTO_DARK_DEFAULT, density: 2 },
    });
  });

  it('blocks save on incomplete JSON without blur and keeps the exact text for correction', async () => {
    mockConfigurablePlugin();
    const { tags } = await openPluginConfig();
    const incompleteText = '[\n  "alpha",\n';

    fireEvent.input(tags, {
      target: { value: incompleteText },
      inputType: 'insertLineBreak',
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toBe('settings.plugins.invalidJson'));
    expect(tags).toHaveValue(incompleteText);
    expect(hanaFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  });

  it('reopens saved JSON values as editable JSON instead of a quoted string', async () => {
    mockConfigurablePlugin();
    const { tags } = await openPluginConfig();
    const savedText = '[\n  "alpha",\n  "beta"\n]';

    fireEvent.input(tags, { target: { value: savedText }, inputType: 'insertText' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toBe('settings.autoSaved'));

    expect(tags).toHaveValue(savedText);
    fireEvent.click(screen.getByTitle('settings.plugins.configure'));

    await waitFor(() => expect(tags).toHaveValue(savedText));
    expect(tags.value.startsWith('"')).toBe(false);
    expect(tags.value).not.toContain('\\n');
  });
});
