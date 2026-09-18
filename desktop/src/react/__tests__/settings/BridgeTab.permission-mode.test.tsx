// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeTab } from '../../settings/tabs/BridgeTab';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/tabs/bridge/useBridgeState', () => ({
  useBridgeState: vi.fn(),
}));

vi.mock('../../settings/tabs/bridge/PlatformSection', () => ({
  PlatformSection: ({ platform }: { platform: string }) => <div data-testid={`platform-${platform}`} />,
}));

vi.mock('../../settings/tabs/bridge/WechatSection', () => ({
  WechatSection: () => <div data-testid="platform-wechat" />,
}));

vi.mock('../../settings/tabs/bridge/BridgeAgentRow', () => ({
  BridgeAgentRow: () => <div data-testid="bridge-agent-row" />,
}));

function bridgeState(overrides = {}) {
  const emptyDraft = { ownerId: 'hana', value: '', dirty: false, revision: 0, hasStored: false };
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
    tgTokenDraft: emptyDraft,
    setTgToken: vi.fn(),
    fsAppId: '',
    setFsAppId: vi.fn(),
    fsAppSecret: '',
    fsAppSecretDraft: emptyDraft,
    setFsAppSecret: vi.fn(),
    fsRegion: 'feishu_cn',
    setFsRegion: vi.fn(),
    dtClientId: '',
    setDtClientId: vi.fn(),
    dtCorpId: '',
    setDtCorpId: vi.fn(),
    dtClientSecret: '',
    dtClientSecretDraft: emptyDraft,
    setDtClientSecret: vi.fn(),
    dtRobotCode: '',
    setDtRobotCode: vi.fn(),
    dtApiBaseUrl: '',
    setDtApiBaseUrl: vi.fn(),
    qqAppId: '',
    setQqAppId: vi.fn(),
    qqAppSecret: '',
    qqAppSecretDraft: emptyDraft,
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

describe('BridgeTab permission mode', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders bridge permission mode as a three-option select without ask mode', async () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    expect(screen.getByText('settings.bridge.receiptEnabled')).not.toBeNull();
    expect(screen.getByText('settings.bridge.richStreamingEnabled')).not.toBeNull();
    expect(screen.queryByText('settings.bridge.readOnly')).toBeNull();
    expect(screen.getByText('settings.bridge.permissionMode')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /settings\.bridge\.permissionModeAuto/ }));

    expect(screen.getByRole('option', { name: /settings\.bridge\.permissionModeAuto/ })).not.toBeNull();
    expect(screen.getByRole('option', { name: /settings\.bridge\.permissionModeOperate/ })).not.toBeNull();
    expect(screen.getByRole('option', { name: /settings\.bridge\.permissionModeReadOnly/ })).not.toBeNull();
    expect(screen.queryByRole('option', { name: /ask/i })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /settings\.bridge\.permissionModeOperate/ }));

    await waitFor(() => {
      expect(saveGlobalSettings).toHaveBeenCalledWith({ permissionMode: 'operate' });
    });
  });

  it('saves the bridge receipt toggle through global bridge settings', async () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    const receiptToggle = screen.getByRole('switch', { name: /settings\.bridge\.receiptEnabled/ });
    expect(receiptToggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(receiptToggle);

    expect(saveGlobalSettings).toHaveBeenCalledWith({ receiptEnabled: false });
  });

  it('saves the rich streaming toggle through global bridge settings', async () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    const richToggle = screen.getByRole('switch', { name: /settings\.bridge\.richStreamingEnabled/ });
    expect(richToggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(richToggle);

    expect(saveGlobalSettings).toHaveBeenCalledWith({ richStreamingEnabled: false });
  });

  it('keeps bridge permission mode in loading state until backend truth arrives', () => {
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ status: null }) as never);

    render(<BridgeTab />);

    const trigger = screen.getByRole('button', { name: /common\.loading/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /settings\.bridge\.permissionModeAuto/ })).toBeNull();
  });

  it('renders only retained platforms in descriptor order', () => {
    vi.mocked(useBridgeState).mockReturnValue(bridgeState() as never);

    render(<BridgeTab />);

    const ids = ['wechat', 'feishu'];
    const positions = ids.map((id) => {
      const element = screen.getByTestId(`platform-${id}`);
      return Array.from(document.body.querySelectorAll('[data-testid^="platform-"]')).indexOf(element);
    });

    expect(positions).toEqual([0, 1]);
  });
});
