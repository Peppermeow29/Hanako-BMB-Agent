// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeTab } from '../../settings/tabs/BridgeTab';
import type { CredentialField } from '../../settings/tabs/bridge/PlatformSection';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';

let ActualPlatformSection: typeof import('../../settings/tabs/bridge/PlatformSection').PlatformSection;
type CapturedPlatformProps = React.ComponentProps<typeof ActualPlatformSection>;
const platformProps = new Map<string, CapturedPlatformProps>();

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector: (state: { settingsSnapshot: { data: null } }) => unknown) => (
    selector({ settingsSnapshot: { data: null } })
  ),
}));

vi.mock('../../settings/tabs/bridge/useBridgeState', () => ({
  useBridgeState: vi.fn(),
}));

vi.mock('../../settings/tabs/bridge/PlatformSection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../settings/tabs/bridge/PlatformSection')>();
  return {
    ...actual,
    PlatformSection: (props: CapturedPlatformProps) => {
      platformProps.set(props.platform, props);
      return <div data-testid={`platform-${props.platform}`} />;
    },
  };
});

vi.mock('../../settings/tabs/bridge/WechatSection', () => ({
  WechatSection: () => <div data-testid="platform-wechat" />,
}));

vi.mock('../../settings/tabs/bridge/BridgeAgentRow', () => ({
  BridgeAgentRow: () => <div data-testid="bridge-agent-row" />,
}));

function secretDraft(value = '', dirty = false, hasStored = false) {
  return { ownerId: 'hana', value, dirty, revision: dirty ? 1 : 0, hasStored };
}

function section(platform: string) {
  const props = platformProps.get(platform);
  if (!props) throw new Error(`missing ${platform} PlatformSection props`);
  return props;
}

function bridgeState(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      telegram: {},
      feishu: {},
      dingtalk: {},
      qq: {},
      wechat: {},
      permissionMode: 'auto',
      readOnly: false,
      receiptEnabled: true,
      richStreamingEnabled: true,
      knownUsers: {},
      owner: {},
    },
    globalSettingsSaving: false,
    selectedAgentId: 'hana',
    setSelectedAgentId: vi.fn(),
    publicAgentsMd: '',
    setPublicAgentsMd: vi.fn(),
    savePublicAgentsMd: vi.fn(),
    tgToken: '',
    tgTokenDraft: secretDraft('', false, true),
    setTgToken: vi.fn(),
    fsAppId: 'feishu-app',
    setFsAppId: vi.fn(),
    fsAppSecret: '',
    fsAppSecretDraft: secretDraft('', false, true),
    setFsAppSecret: vi.fn(),
    fsRegion: 'feishu_cn',
    setFsRegion: vi.fn(),
    dtCorpId: 'ding-corp',
    setDtCorpId: vi.fn(),
    dtClientId: 'ding-client',
    setDtClientId: vi.fn(),
    dtClientSecret: '',
    dtClientSecretDraft: secretDraft('', false, true),
    setDtClientSecret: vi.fn(),
    dtRobotCode: 'ding-robot',
    setDtRobotCode: vi.fn(),
    dtApiBaseUrl: 'https://api.dingtalk.com/v1.0',
    setDtApiBaseUrl: vi.fn(),
    qqAppId: 'qq-app',
    setQqAppId: vi.fn(),
    qqAppSecret: '',
    qqAppSecretDraft: secretDraft('', false, true),
    setQqAppSecret: vi.fn(),
    saveBridgeConfig: vi.fn(),
    testPlatform: vi.fn(),
    testingPlatform: null,
    showToast: vi.fn(),
    setOwner: vi.fn(),
    loadStatus: vi.fn(),
    saveGlobalSettings: vi.fn(),
    ...overrides,
  };
}

describe('BridgeTab credential custody', () => {
  beforeEach(() => {
    platformProps.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('tests stored Feishu secrets without sending masked values', () => {
    const testPlatform = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ testPlatform }) as never);

    render(<BridgeTab />);

    section('feishu').onTest();

    expect(testPlatform).toHaveBeenNthCalledWith(1, 'feishu', {
      appId: 'feishu-app',
      region: 'feishu_cn',
    }, true);
  });

  it('sends dirty plaintext secrets directly and disables saved-credential lookup', () => {
    const testPlatform = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({
      testPlatform,
      tgToken: 'telegram-plaintext',
      tgTokenDraft: secretDraft('telegram-plaintext', true, true),
      fsAppSecret: 'feishu-plaintext',
      fsAppSecretDraft: secretDraft('feishu-plaintext', true, true),
      dtClientSecret: 'dingtalk-plaintext',
      dtClientSecretDraft: secretDraft('dingtalk-plaintext', true, true),
      qqAppSecret: 'qq-plaintext',
      qqAppSecretDraft: secretDraft('qq-plaintext', true, true),
    }) as never);

    render(<BridgeTab />);

    section('feishu').onTest();

    expect(testPlatform).toHaveBeenNthCalledWith(1, 'feishu', {
      appId: 'feishu-app',
      appSecret: 'feishu-plaintext',
      region: 'feishu_cn',
    }, false);
  });

  it('saves canonical platform fields while omitting unchanged stored secrets', async () => {
    const saveBridgeConfig = vi.fn(async () => {});
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveBridgeConfig }) as never);

    render(<BridgeTab />);
    await section('feishu').onToggle(true);

    expect(saveBridgeConfig).toHaveBeenNthCalledWith(1, 'feishu', {
      appId: 'feishu-app',
      region: 'feishu_cn',
    }, true);
  });

  it('preserves dirty empty as an explicit clear when disabling a platform', async () => {
    const saveBridgeConfig = vi.fn(async () => {});
    const clearedDraft = secretDraft('', true, true);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({
      saveBridgeConfig,
      tgTokenDraft: clearedDraft,
      fsAppSecretDraft: clearedDraft,
      dtClientSecretDraft: clearedDraft,
      qqAppSecretDraft: clearedDraft,
    }) as never);

    render(<BridgeTab />);
    await section('feishu').onToggle(false);

    expect(saveBridgeConfig).toHaveBeenNthCalledWith(1, 'feishu', {
      appId: 'feishu-app',
      appSecret: '',
      region: 'feishu_cn',
    }, false);
  });

  it('persists dirty empty as an explicit clear when credential fields lose focus', async () => {
    const saveBridgeConfig = vi.fn(async () => {});
    const clearedDraft = secretDraft('', true, true);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({
      saveBridgeConfig,
      tgTokenDraft: clearedDraft,
      fsAppSecretDraft: clearedDraft,
      dtClientSecretDraft: clearedDraft,
      qqAppSecretDraft: clearedDraft,
    }) as never);

    render(<BridgeTab />);
    await section('feishu').onCredentialBlur?.();

    expect(saveBridgeConfig).toHaveBeenNthCalledWith(1, 'feishu', {
      appId: 'feishu-app',
      appSecret: '',
      region: 'feishu_cn',
    }, undefined);
  });
});

describe('PlatformSection stored secret presentation', () => {
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../settings/tabs/bridge/PlatformSection')>(
      '../../settings/tabs/bridge/PlatformSection',
    );
    ActualPlatformSection = actual.PlatformSection;
  });

  afterEach(cleanup);

  it('renders the stored placeholder with an empty clipboard source value', () => {
    const fields: CredentialField[] = [{
      key: 'token',
      label: 'Bot Token',
      type: 'secret',
      value: '',
      placeholder: 'settings.bridge.secretStoredPlaceholder',
      onChange: vi.fn(),
    }];

    const { container } = render(
      <ActualPlatformSection
        platform="feishu"
        title="Feishu"
        status={{ enabled: false }}
        credentialFields={fields}
        onToggle={vi.fn()}
        onTest={vi.fn()}
        testing={false}
      />,
    );

    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', 'settings.bridge.secretStoredPlaceholder');
    input.setSelectionRange(0, input.value.length);
    expect(input.value.slice(input.selectionStart || 0, input.selectionEnd || 0)).toBe('');
    expect(screen.queryByDisplayValue('********')).toBeNull();
  });

  it('tests a candidate secret without firing the blur autosave first', () => {
    const onCredentialBlur = vi.fn();
    const onTest = vi.fn();
    const { container } = render(
      <ActualPlatformSection
        platform="feishu"
        title="Feishu"
        status={{ enabled: false }}
        credentialFields={[{
          key: 'token',
          label: 'Bot Token',
          type: 'secret',
          value: 'candidate-secret',
          onChange: vi.fn(),
        }]}
        onToggle={vi.fn()}
        onTest={onTest}
        onCredentialBlur={onCredentialBlur}
        testing={false}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    const testButton = screen.getByRole('button', { name: /Feishu.*settings\.bridge\.test/i });

    fireEvent.pointerDown(testButton);
    fireEvent.blur(input);
    fireEvent.click(testButton);

    expect(onCredentialBlur).not.toHaveBeenCalled();
    expect(onTest).toHaveBeenCalledOnce();
  });

  it('does not autosave before a keyboard-activated credential test', () => {
    const onCredentialBlur = vi.fn();
    const onTest = vi.fn();
    const { container } = render(
      <ActualPlatformSection
        platform="feishu"
        title="Feishu"
        status={{ enabled: false }}
        credentialFields={[{
          key: 'token',
          label: 'Bot Token',
          type: 'secret',
          value: 'candidate-secret',
          onChange: vi.fn(),
        }]}
        onToggle={vi.fn()}
        onTest={onTest}
        onCredentialBlur={onCredentialBlur}
        testing={false}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    const testButton = screen.getByRole('button', { name: /Feishu.*settings\.bridge\.test/i });

    fireEvent.blur(input, { relatedTarget: testButton });
    fireEvent.focus(testButton);
    fireEvent.keyDown(testButton, { key: 'Enter' });
    fireEvent.click(testButton);

    expect(onCredentialBlur).not.toHaveBeenCalled();
    expect(onTest).toHaveBeenCalledOnce();
  });

  it('does not autosave while focus moves to the secret visibility control', () => {
    const onCredentialBlur = vi.fn();
    const { container } = render(
      <ActualPlatformSection
        platform="feishu"
        title="Feishu"
        status={{ enabled: false }}
        credentialFields={[{
          key: 'token',
          label: 'Bot Token',
          type: 'secret',
          value: 'candidate-secret',
          onChange: vi.fn(),
        }]}
        onToggle={vi.fn()}
        onTest={vi.fn()}
        onCredentialBlur={onCredentialBlur}
        testing={false}
      />,
    );
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    const revealButton = screen.getByRole('button', { name: 'settings.api.showKey' });

    fireEvent.blur(input, { relatedTarget: revealButton });

    expect(onCredentialBlur).not.toHaveBeenCalled();

    fireEvent.blur(revealButton, { relatedTarget: null });

    expect(onCredentialBlur).toHaveBeenCalledOnce();
  });
});
