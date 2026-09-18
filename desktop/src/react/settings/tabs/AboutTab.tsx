import React, { useEffect, useState } from 'react';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import appIconUrl from '../../../icon.png';
import styles from '../Settings.module.css';

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

export function AboutTab() {
  const hana = window.hana;
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void hana?.getAppVersion?.()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [hana]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={appIconUrl} alt="HanaAgent" />
        <div className={styles['about-name']}>HanaAgent</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {version && <div className={styles['about-version']}>v{version}</div>}
      </div>

      <SettingsSection>
        <SettingsRow
          label={t('settings.about.license')}
          control={<span>Apache License 2.0</span>}
        />
        <SettingsRow
          label={t('settings.about.copyright')}
          control={<span>© 2026 liliMozi</span>}
        />
        <SettingsRow
          label="GitHub"
          control={
            <a
              className={styles['about-link']}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                hana?.openExternal?.('https://github.com/liliMozi');
              }}
            >
              github.com/liliMozi
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          }
        />
      </SettingsSection>

      <ExpandableRow label={t('settings.about.licenseToggle')}>
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      </ExpandableRow>
    </div>
  );
}
