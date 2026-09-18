// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SettingsSection } from '../SettingsSection';
import { SettingsGrid, SettingsInline, SettingsPage, SettingsStack, SettingsSurface } from '../SettingsPrimitives';

describe('SettingsSection', () => {
  it('renders section descriptions above the card body', () => {
    const { container } = render(
      <SettingsSection title="字体" description="选择正文阅读使用的字体">
        <div>衬线</div>
      </SettingsSection>,
    );

    expect(screen.getByText('字体')).toBeTruthy();
    expect(screen.getByText('选择正文阅读使用的字体')).toBeTruthy();

    const body = container.querySelector('[class*="sectionBody"]');
    const section = container.querySelector('section');
    const title = screen.getByText('字体');
    const description = screen.getByText('选择正文阅读使用的字体');
    expect(body?.textContent).toBe('衬线');
    expect(body?.textContent).not.toContain('选择正文阅读使用的字体');
    expect(section?.getAttribute('aria-labelledby')).toBe(title.id);
    expect(section?.getAttribute('aria-describedby')).toBe(description.id);
  });
});

describe('settings layout primitives', () => {
  it('owns page, surface, stack, inline and grid geometry centrally', () => {
    const { container } = render(
      <SettingsPage tab="interface">
        <SettingsStack>
          <SettingsSurface>
            <SettingsInline>
              <SettingsGrid columns={2}><span>一</span><span>二</span></SettingsGrid>
            </SettingsInline>
          </SettingsSurface>
        </SettingsStack>
      </SettingsPage>,
    );

    expect(container.querySelector('[data-settings-page="interface"]')).toBeTruthy();
    expect(container.querySelector('[data-settings-surface="card"]')).toBeTruthy();
    expect(container.querySelector('[class*="stack"]')).toBeTruthy();
    expect(container.querySelector('[class*="inline"]')).toBeTruthy();
    expect(container.querySelector('[class*="grid-2"]')).toBeTruthy();
  });

  it('makes borderless sections explicit through a plain surface', () => {
    const { container } = render(
      <SettingsSection surface="plain"><span>自定义内容</span></SettingsSection>,
    );

    expect(container.querySelector('[data-settings-surface="plain"]')).toBeTruthy();
  });
});
