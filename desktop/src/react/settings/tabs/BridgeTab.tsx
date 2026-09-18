import React from 'react';
import { t } from '../helpers';
import { PlatformSection } from './bridge/PlatformSection';
import { WechatSection } from './bridge/WechatSection';
import { useBridgeState } from './bridge/useBridgeState';
import type { BridgeSecretDraft } from './bridge/useBridgeSecretDrafts';
import { BridgeAgentRow } from './bridge/BridgeAgentRow';
import { BridgePermissionModeSelect, type BridgePermissionMode } from './bridge/BridgeWidgets';
import {
  BRIDGE_SETTINGS_PLATFORMS,
  bridgePlatformLabel,
  type BridgePlatform,
} from '../../utils/bridge-platforms';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '@/ui';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

function pendingSecret(draft: BridgeSecretDraft) {
  const value = draft.value.trim();
  return draft.dirty && value ? value : null;
}

function hasUsableSecret(draft: BridgeSecretDraft) {
  return draft.dirty ? pendingSecret(draft) !== null : draft.hasStored;
}

function credentialPayload(
  fields: Record<string, string>,
  secretField: string,
  draft: BridgeSecretDraft,
) {
  if (!draft.dirty) return fields;
  return { ...fields, [secretField]: draft.value.trim() };
}

function shouldUseSavedSecret(draft: BridgeSecretDraft) {
  return !draft.dirty && draft.hasStored;
}

function storedSecretPlaceholder(draft: BridgeSecretDraft) {
  return draft.hasStored && !draft.dirty
    ? t('settings.bridge.secretStoredPlaceholder')
    : '';
}

export function BridgeTab() {
  const b = useBridgeState();
  const snapshotBridge = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.bridge);
  // 注意：不能用 `|| {}` 兜底——空对象会让 Toggle 的 `!!status?.enabled` 显示成"假关"。
  // 传 undefined 让 Toggle 走加载态。
  const fsInfo = b.status?.feishu;
  const wxInfo = b.status?.wechat;
  const permissionMode = (b.status?.permissionMode || snapshotBridge?.permissionMode) as BridgePermissionMode | undefined;
  const receiptEnabled = typeof b.status?.receiptEnabled === 'boolean'
    ? b.status.receiptEnabled
    : snapshotBridge?.receiptEnabled;
  const richStreamingEnabled = typeof b.status?.richStreamingEnabled === 'boolean'
    ? b.status.richStreamingEnabled
    : snapshotBridge
      ? snapshotBridge.richStreamingEnabled !== false
      : undefined;
  const feishuRegionOptions = [
    { value: 'feishu_cn', label: t('settings.bridge.feishuRegionFeishuCn') },
    { value: 'lark_global', label: t('settings.bridge.feishuRegionLarkGlobal') },
  ];
  const globalSettingsPending = !permissionMode || b.globalSettingsSaving;
  const platformSections: Partial<Record<BridgePlatform, React.ReactNode>> = {
    wechat: (
      <WechatSection
        status={wxInfo}
        showToast={b.showToast}
        onSaveConfig={(creds, enabled) => b.saveBridgeConfig('wechat', creds, enabled)}
        onReload={b.loadStatus}
        agentId={b.selectedAgentId}
      />
    ),
    feishu: (
      <PlatformSection
        platform="feishu"
        title={bridgePlatformLabel('feishu', t)}
        status={fsInfo}
        credentialFields={[
          {
            key: 'region',
            label: t('settings.bridge.feishuRegion'),
            type: 'select',
            value: b.fsRegion,
            onChange: (value) => {
              b.setFsRegion(value as typeof b.fsRegion);
              if (b.fsAppId.trim() && hasUsableSecret(b.fsAppSecretDraft)) {
                b.saveBridgeConfig('feishu', credentialPayload(
                  { appId: b.fsAppId.trim(), region: value },
                  'appSecret',
                  b.fsAppSecretDraft,
                ), undefined);
              }
            },
            options: feishuRegionOptions,
          },
          { key: 'appId', label: t('settings.bridge.feishuAppId'), type: 'text', value: b.fsAppId, onChange: b.setFsAppId },
          {
            key: 'appSecret',
            label: t('settings.bridge.feishuAppSecret'),
            type: 'secret',
            value: b.fsAppSecret,
            placeholder: storedSecretPlaceholder(b.fsAppSecretDraft),
            onChange: b.setFsAppSecret,
          },
        ]}
        onToggle={async (on) => {
          if (on && (!b.fsAppId.trim() || !hasUsableSecret(b.fsAppSecretDraft))) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('feishu', credentialPayload(
            { appId: b.fsAppId.trim(), region: b.fsRegion },
            'appSecret',
            b.fsAppSecretDraft,
          ), on);
        }}
        onTest={() => {
          if (!b.fsAppId.trim() || !hasUsableSecret(b.fsAppSecretDraft)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('feishu', credentialPayload(
            { appId: b.fsAppId.trim(), region: b.fsRegion },
            'appSecret',
            b.fsAppSecretDraft,
          ), shouldUseSavedSecret(b.fsAppSecretDraft));
        }}
        onCredentialBlur={async () => {
          if (b.fsAppId.trim() && (b.fsAppSecretDraft.dirty || b.fsAppSecretDraft.hasStored)) {
            await b.saveBridgeConfig('feishu', credentialPayload(
              { appId: b.fsAppId.trim(), region: b.fsRegion },
              'appSecret',
              b.fsAppSecretDraft,
            ), undefined);
          }
        }}
        testing={b.testingPlatform === 'feishu'}
        hint={t('settings.bridge.feishuHint')}
        ownerUsers={b.status?.knownUsers?.feishu || []}
        currentOwner={b.status?.owner?.feishu}
        onOwnerChange={(userId) => b.setOwner('feishu', userId)}
      />
    ),
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      <SettingsSection title={t('settings.bridge.globalSettings')}>
        <SettingsRow
          label={t('settings.bridge.permissionMode')}
          hint={t('settings.bridge.permissionModeDesc')}
          control={
            <BridgePermissionModeSelect
              value={permissionMode}
              onChange={(mode) => b.saveGlobalSettings({ permissionMode: mode })}
              disabled={globalSettingsPending}
            />
          }
        />
        <SettingsRow
          label={t('settings.bridge.receiptEnabled')}
          hint={t('settings.bridge.receiptEnabledDesc')}
          control={
            <Toggle
              on={receiptEnabled}
              ariaLabel={t('settings.bridge.receiptEnabled')}
              onChange={(on) => b.saveGlobalSettings({ receiptEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          }
        />
        <SettingsRow
          label={t('settings.bridge.richStreamingEnabled')}
          hint={t('settings.bridge.richStreamingEnabledDesc')}
          control={
            <Toggle
              on={richStreamingEnabled}
              ariaLabel={t('settings.bridge.richStreamingEnabled')}
              onChange={(on) => b.saveGlobalSettings({ richStreamingEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.bridge.agentSettings')} surface="plain">
        {/* BridgeAgentRow：tab 级 context，水平平铺头像+名字
         * 未超宽时居中显示，超宽时横向滚动；selected 高亮对齐 AgentCardStack */}
        <BridgeAgentRow
          value={b.selectedAgentId}
          onChange={b.setSelectedAgentId}
        />
      </SettingsSection>

      {/* 对外意识：hint 在上、textarea 在下，直接作为 section body children（单 textarea 不套 row） */}
      <SettingsSection title={t('settings.agent.publicAgentsMd')}>
        <div className={styles['settings-section-inset']}>
          <div className={styles['settings-section-hint']}>
            {t('settings.agent.publicAgentsMdHint')}
          </div>
          <textarea
            className={styles['settings-textarea']}
            rows={6}
            spellCheck={false}
            value={b.publicAgentsMd}
            onChange={(e) => b.setPublicAgentsMd(e.target.value)}
            onBlur={b.savePublicAgentsMd}
          />
        </div>
      </SettingsSection>

      <div className="bridge-help-link-row">
        <span className="bridge-help-link" onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}>
          {t('settings.bridge.howTo')}
        </span>
      </div>

      {BRIDGE_SETTINGS_PLATFORMS.map((descriptor) => (
        <React.Fragment key={descriptor.id}>
          {platformSections[descriptor.id]}
        </React.Fragment>
      ))}
    </div>
  );
}
