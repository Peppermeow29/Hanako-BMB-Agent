// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceTab } from '../InterfaceTab';
import { useSettingsStore } from '../../store';
import registry from '../../../../shared/theme-registry';

const hanaFetchMock = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
}));

vi.mock('../../../services/appearance-sync', () => ({
  persistAppearancePreferences: vi.fn().mockResolvedValue(undefined),
}));

type AppearanceGlobals = typeof globalThis & {
  setTheme?: (theme: string) => void;
  setSerifFont?: (enabled: boolean) => void;
  setPaperTexture?: (enabled: boolean) => void;
};

function setAppearanceGlobals() {
  (globalThis as AppearanceGlobals).setTheme = vi.fn((theme: string) => {
    localStorage.setItem('hana-theme', theme);
    document.documentElement.setAttribute('data-theme', theme === 'auto' ? registry.DEFAULT_THEME : theme);
  });
  (globalThis as AppearanceGlobals).setSerifFont = vi.fn((enabled: boolean) => {
    localStorage.setItem('hana-font-serif', enabled ? '1' : '0');
    document.body.classList.toggle('font-sans', !enabled);
  });
  (globalThis as AppearanceGlobals).setPaperTexture = vi.fn((enabled: boolean) => {
    localStorage.setItem('hana-paper-texture', enabled ? '1' : '0');
  });
}

function seedSettings() {
  useSettingsStore.setState({
    settingsConfig: {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      hardware_acceleration: true,
      editor: {},
    },
    currentAgentId: 'agent-1',
    settingsAgentId: 'agent-1',
  } as never);
}

function readSettingsComponentStyles(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/settings/components/settings-components.module.css'),
    'utf8',
  );
}

describe('InterfaceTab appearance state', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hanaFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/preferences/sidebar-ui' && init?.method === 'PUT') {
        return {
          json: async () => ({
            sidebarUi: {
              projectView: {
                collapsedProjectIds: [],
                collapsedFolderIds: [],
                showAllProjectIds: [],
              },
              sessionList: { rowMode: 'single-line' },
            },
          }),
        };
      }
      if (path === '/api/preferences/sidebar-ui') {
        return {
          json: async () => ({
            sidebarUi: {
              projectView: {
                collapsedProjectIds: [],
                collapsedFolderIds: [],
                showAllProjectIds: [],
              },
              sessionList: { rowMode: 'two-line' },
            },
          }),
        };
      }
      return { json: async () => ({}) };
    });
    localStorage.clear();
    document.body.className = '';
    document.documentElement.setAttribute('data-theme', registry.DEFAULT_THEME);
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      settingsChanged: vi.fn(),
    } as unknown as typeof window.platform;
    setAppearanceGlobals();
    seedSettings();
  });

  it('updates the reading font card from component state after the preference changes', () => {
    localStorage.setItem('hana-font-serif', '1');

    render(React.createElement(InterfaceTab));

    const sansCard = screen.getByText('settings.fonts.sansName').closest('button');
    expect(sansCard).toBeTruthy();

    fireEvent.click(sansCard!);

    expect(globalThis.setSerifFont).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('hana-font-serif')).toBe('0');
  });

  it('recomputes paper texture availability when the selected theme changes', () => {
    localStorage.setItem('hana-theme', registry.DEFAULT_THEME);
    localStorage.setItem('hana-paper-texture', '1');

    render(React.createElement(InterfaceTab));

    const paperSwitch = () => screen.getAllByRole('switch')[0] as HTMLButtonElement;
    expect(paperSwitch().getAttribute('aria-checked')).toBe('true');
    expect(paperSwitch().disabled).toBe(false);

    const midnightTheme = screen.getByText('settings.appearance.midnight').closest('button');
    expect(midnightTheme).toBeTruthy();
    fireEvent.click(midnightTheme!);

    expect(paperSwitch().getAttribute('aria-checked')).toBe('false');
    expect(paperSwitch().disabled).toBe(true);
  });

  it('renders the hardware acceleration switch from settings config', () => {
    useSettingsStore.setState({
      settingsConfig: {
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        hardware_acceleration: false,
        editor: {},
      },
    } as never);

    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.interface.hardwareAcceleration')).toBeTruthy();
    expect(screen.getAllByRole('switch')[2].getAttribute('aria-checked')).toBe('false');
  });

  it('keeps hardware acceleration loading until settings config is ready', () => {
    useSettingsStore.setState({
      settingsConfig: null,
    } as never);

    render(React.createElement(InterfaceTab));

    const hardwareSwitch = screen.getAllByRole('switch')[2] as HTMLButtonElement;
    expect(hardwareSwitch.getAttribute('aria-checked')).toBe('mixed');
    expect(hardwareSwitch.getAttribute('aria-busy')).toBe('true');
    expect(hardwareSwitch.disabled).toBe(true);
  });

  it('renders a markdown font selector in the editor section', () => {
    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.editor.markdownFont')).toBeTruthy();
    expect(screen.getByTitle('settings.fonts.followReading')).toBeTruthy();
  });

  it('places chat body controls in the font section and editor body controls in the editor section', () => {
    render(React.createElement(InterfaceTab));

    const fontSection = screen.getByText('settings.appearance.font').closest('section');
    const editorSection = screen.getByText('settings.editor.title').closest('section');
    expect(fontSection).toBeTruthy();
    expect(editorSection).toBeTruthy();

    expect(screen.queryByText('settings.appearance.readingLayout')).toBeNull();

    const chatWidthSlider = screen.getByRole('slider', { name: 'settings.appearance.chatWidth' }) as HTMLInputElement;
    const bodySlider = screen.getByRole('slider', { name: 'settings.appearance.bodyFontSizeOffset' }) as HTMLInputElement;
    const editorWidthSlider = screen.getByRole('slider', { name: 'settings.editor.markdownContentWidth' }) as HTMLInputElement;
    const editorNumberInputs = within(editorSection!).getAllByRole('spinbutton') as HTMLInputElement[];

    expect(within(fontSection!).getByText('settings.appearance.chatWidth')).toBeTruthy();
    expect(within(fontSection!).getByText('settings.appearance.bodyFontSizeOffset')).toBeTruthy();
    expect(chatWidthSlider.min).toBe('0');
    expect(chatWidthSlider.max).toBe('3');
    expect(chatWidthSlider.step).toBe('1');
    expect(chatWidthSlider.value).toBe('1');
    expect(bodySlider.min).toBe('0');
    expect(bodySlider.max).toBe('4');
    expect(bodySlider.step).toBe('1');
    expect(bodySlider.value).toBe('2');

    expect(within(editorSection!).getByText('settings.editor.markdownContentWidth')).toBeTruthy();
    expect(within(editorSection!).getByText('settings.editor.markdownBodyFontSize')).toBeTruthy();
    expect(editorWidthSlider.min).toBe('0');
    expect(editorWidthSlider.max).toBe('3');
    expect(editorWidthSlider.step).toBe('1');
    expect(editorWidthSlider.value).toBe('1');
    expect(editorNumberInputs[0].value).toBe('16');

    expect(screen.queryByText('720 px')).toBeNull();
    expect(screen.queryByText('settings.appearance.documentWidth')).toBeNull();
  });

  it('keeps compact step slider ticks aligned to the slider stops without a value pill', () => {
    const css = readSettingsComponentStyles();

    expect(css).toMatch(/\.stepSlider\s*\{[\s\S]*width:\s*198px/);
    expect(css).toMatch(/\.stepSliderTop,\s*\.stepSliderTicks\s*\{[\s\S]*width:\s*150px/);
    expect(css).toMatch(/\.stepSliderTop,\s*\.stepSliderTicks\s*\{[\s\S]*margin:\s*0 auto/);
    expect(css).not.toMatch(/\.stepSliderValue/);
    expect(css).toMatch(/\.stepSliderTicks\s*\{[\s\S]*position:\s*relative/);
    expect(css).toMatch(/\.stepSliderTicks span\s*\{[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.stepSliderTicks span\s*\{[\s\S]*left:\s*var\(--step-slider-tick-left\)/);
    expect(css).toMatch(/\.stepSliderTicks span\s*\{[\s\S]*transform:\s*translateX\(-50%\)/);
  });

  it('keeps standard row padding inside nested setting cards on plain surfaces', () => {
    const css = readSettingsComponentStyles();

    expect(css).toMatch(/\.sectionPlain\s*>\s*\.sectionBody\s*>\s*\.row\s*\{[\s\S]*padding-left:\s*0/);
    expect(css).toMatch(/\.sectionPlain\s*>\s*\.sectionBody\s*>\s*\.row\s*\{[\s\S]*padding-right:\s*0/);
    expect(css).toMatch(/\.sectionPlain\s*>\s*\.sectionBody\s*>\s*\.row\s*\+\s*\.row::before\s*\{[\s\S]*display:\s*none/);
    expect(css).not.toMatch(/\.sectionPlain\s+\.row\s*\{/);
    expect(css).not.toMatch(/\.sectionPlain\s+\.row\s*\+\s*\.row::before\s*\{/);
  });

  it('hides fourth through sixth heading typography controls', () => {
    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.editor.markdownHeading1FontSize')).toBeTruthy();
    expect(screen.getByText('settings.editor.markdownHeading2FontSize')).toBeTruthy();
    expect(screen.getByText('settings.editor.markdownHeading3FontSize')).toBeTruthy();
    expect(screen.queryByText('settings.editor.markdownHeading4FontSize')).toBeNull();
    expect(screen.queryByText('settings.editor.markdownHeading5FontSize')).toBeNull();
    expect(screen.queryByText('settings.editor.markdownHeading6FontSize')).toBeNull();
  });

  it('renders the app-local voice recording shortcut in the interface tab', () => {
    useSettingsStore.setState({ platformName: 'darwin' } as never);

    render(React.createElement(InterfaceTab));

    expect(screen.getByText('settings.interface.shortcuts')).toBeTruthy();
    expect(screen.getByText('settings.interface.voiceRecordingShortcut')).toBeTruthy();
    expect(screen.getByLabelText('⌘ + ⇧ + M')).toBeTruthy();
  });

  it('saves the single-line session list preference through sidebar UI preferences', async () => {
    render(React.createElement(InterfaceTab));

    const label = await screen.findByText('settings.interface.sessionListSingleLine');
    const row = label.parentElement?.parentElement;
    expect(row).toBeTruthy();
    const densitySwitch = within(row as HTMLElement).getByRole('switch') as HTMLButtonElement;

    await waitFor(() => {
      expect(densitySwitch.getAttribute('aria-checked')).toBe('false');
    });
    fireEvent.click(densitySwitch);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/preferences/sidebar-ui', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ sessionList: { rowMode: 'single-line' } }),
      }));
      expect(window.platform.settingsChanged).toHaveBeenCalledWith('sidebar-ui-changed', expect.objectContaining({
        sidebarUi: expect.objectContaining({
          sessionList: { rowMode: 'single-line' },
        }),
      }));
    });
  });
});
