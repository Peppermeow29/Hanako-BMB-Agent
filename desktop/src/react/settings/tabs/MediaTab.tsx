import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { updateSettingsSnapshot } from '../actions';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import styles from '../Settings.module.css';

type SpeechModel = { id: string; name?: string; displayName?: string; adapterAvailable?: boolean };
type SpeechProvider = {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  models: SpeechModel[];
  availableModels?: Array<{ id: string; name: string }>;
};
type SpeechConfig = { enabled: boolean; defaultModel?: { id: string; provider: string } };
type SpeechConfigPatch = { enabled?: boolean; defaultModel?: SpeechConfig['defaultModel'] | null };

const LOADING_SELECT_VALUE = '__loading';

function mergeConfig(previous: SpeechConfig, incoming: any): SpeechConfig {
  const next = { ...previous };
  if (typeof incoming?.enabled === 'boolean') next.enabled = incoming.enabled;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'defaultModel')) {
    if (incoming.defaultModel) next.defaultModel = incoming.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function runnableModels(provider: SpeechProvider) {
  if (!provider.hasCredentials) return [];
  if (Array.isArray(provider.availableModels)) return provider.availableModels;
  return (provider.models || [])
    .filter(model => model.adapterAvailable !== false)
    .map(model => ({ id: model.id, name: model.displayName || model.name || model.id }));
}

/** Voice transcription remains available; image and video generation were removed. */
export function MediaTab() {
  const snapshotConfig = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.speechRecognition);
  const showToast = useSettingsStore(s => s.showToast);
  const [providers, setProviders] = useState<Record<string, SpeechProvider>>({});
  const [config, setConfig] = useState<SpeechConfig | null>(() => (
    snapshotConfig ? mergeConfig({ enabled: false }, snapshotConfig) : null
  ));
  const [loading, setLoading] = useState(() => !snapshotConfig);

  useEffect(() => {
    if (snapshotConfig) setConfig(mergeConfig({ enabled: false }, snapshotConfig));
  }, [snapshotConfig]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await hanaFetch('/api/speech-recognition/providers');
      const data = await response.json();
      setProviders(data.providers || {});
      setConfig(mergeConfig({ enabled: false }, data.config || {}));
    } catch (error: any) {
      setProviders({});
      showToast(error?.message || 'Failed to load speech recognition providers', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const models = Object.entries(providers).flatMap(([provider, item]) =>
    runnableModels(item).map(model => ({ ...model, provider })),
  );
  const defaultValue = !loading && config?.defaultModel
    ? `${config.defaultModel.provider}/${config.defaultModel.id}`
    : !loading ? '' : LOADING_SELECT_VALUE;
  const enabledLabel = t('settings.media.speechRecognitionEnabled') === 'settings.media.speechRecognitionEnabled'
    ? '发送语音条时转录'
    : t('settings.media.speechRecognitionEnabled');
  const defaultLabel = t('settings.media.defaultSpeechModel') === 'settings.media.defaultSpeechModel'
    ? '语音条转录模型'
    : t('settings.media.defaultSpeechModel');

  const save = async (patch: SpeechConfigPatch) => {
    try {
      const values = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]));
      const response = await hanaFetch('/api/speech-recognition/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const data = await response.json();
      const next = mergeConfig(config || { enabled: false }, data.config || patch);
      setConfig(next);
      updateSettingsSnapshot(snapshot => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, speechRecognition: next },
      }));
      showToast(t('settings.saved'), 'success');
    } catch (error: any) {
      showToast(error?.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles.active}`} data-tab="media">
      <SettingsSection title={t('settings.media.speechRecognition')}>
        <SettingsRow
          label={enabledLabel}
          control={<Toggle ariaLabel={enabledLabel} on={config?.enabled === true} onChange={(enabled) => void save({ enabled })} />}
        />
        <SettingsRow
          label={defaultLabel}
          control={(
            <SelectWidget
              value={defaultValue}
              disabled={loading}
              onChange={(value) => {
                const [provider, ...idParts] = value.split('/');
                void save({ defaultModel: provider && idParts.length ? { provider, id: idParts.join('/') } : null });
              }}
              options={[
                ...(loading ? [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }] : []),
                { value: '', label: t('settings.media.defaultOption') },
                ...models.map(model => ({ value: `${model.provider}/${model.id}`, label: `${providers[model.provider]?.displayName || model.provider} / ${model.name}` })),
              ]}
            />
          )}
        />
      </SettingsSection>
    </div>
  );
}
