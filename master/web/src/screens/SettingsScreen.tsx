/**
 * Connection details (re-readable at any time), storage usage, and the
 * per-machine appearance controls (theme/density/motion — 6-UI-DESIGN.md §10,
 * "per-machine, never synced", lives here and only here).
 *
 * The pairing password is deliberately absent: it was shown once at setup and
 * only its hash is stored, so it cannot be displayed again.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { MasterIdentity, StorageUsage } from '@orderbook/shared';

import { api } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import {
  Card,
  IdField,
  KeyValueList,
  Segmented,
  Skeleton,
  Switch,
  applyDensity,
  applyMotion,
  applyTheme,
  formatBytes,
  formatDateTime,
  loadDensity,
  loadTheme,
  motionDisabled,
  t,
  type Density,
  type Theme,
} from '@orderbook/ui';

function currentRootSize(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--root-size').trim();
}

export function SettingsScreen() {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [density, setDensity] = useState<Density>(() => loadDensity());
  const [motionOn, setMotionOn] = useState<boolean>(() => !motionDisabled());
  const [canManageStorage, setCanManageStorage] = useState(false);

  useEffect(() => {
    void api
      .identity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
    void api
      .storage()
      .then(setStorage)
      .catch(() => setStorage(null));
    // The usage figures are readable by anyone, but export and restore are
    // `storage.manage` at the route — so the session's own permissions decide
    // whether the actions appear, rather than offering two buttons whose only
    // possible answer is a refusal. Read here rather than taken as a prop
    // because nothing else on this screen needs the session.
    void api
      .me()
      .then(({ user }) => setCanManageStorage(user.permissions.includes('storage.manage')))
      .catch(() => setCanManageStorage(false));
  }, []);

  function handleThemeChange(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  function handleDensityChange(next: Density) {
    setDensity(next);
    applyDensity(next);
  }

  // Matches the mockup's own convention (and Office's): the switch reads
  // "Turn animation off," so checked means motion is off, not on.
  function handleMotionChange(motionOff: boolean) {
    const nextMotionOn = !motionOff;
    setMotionOn(nextMotionOn);
    applyMotion(nextMotionOn);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)', maxWidth: 720 }}>
      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
          {t('settings.appearance.title')}
        </div>
        <p className="ob-small" style={{ margin: '0 0 var(--s-12)' }}>
          {t('settings.appearance.subtitle')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
          <SettingRow label={t('settings.theme.label')}>
            <Segmented
              options={[
                { value: 'light', label: t('settings.theme.light') },
                { value: 'dark', label: t('settings.theme.dark') },
              ]}
              value={theme}
              onChange={handleThemeChange}
            />
          </SettingRow>

          <SettingRow label={t('settings.density.label')}>
            <Segmented
              options={[
                { value: 'compact', label: t('settings.density.compact') },
                { value: 'comfortable', label: t('settings.density.comfortable') },
                { value: 'large', label: t('settings.density.large') },
              ]}
              value={density}
              onChange={handleDensityChange}
            />
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.density.note', { size: currentRootSize() })}
            </span>
          </SettingRow>

          <SettingRow label={t('settings.motion.label')}>
            <Switch
              checked={!motionOn}
              onChange={handleMotionChange}
              label={t('settings.motion.turnOff')}
            />
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.motion.hint')}
            </span>
          </SettingRow>
        </div>
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
          {t('settings.connection.title')}
        </div>
        <p className="ob-small" style={{ margin: '0 0 var(--s-12)' }}>
          {t('settings.connection.description')}
        </p>
        {identity ? (
          <>
            <KeyValueList
              items={[
                { label: t('settings.connection.company'), value: identity.companyName ?? '—' },
                {
                  label:
                    identity.lanIps.length > 1
                      ? t('settings.connection.masterAddresses')
                      : t('settings.connection.masterAddress'),
                  value: identity.lanIps.length ? (
                    <span className="ob-mono">
                      {identity.lanIps.map((ip) => `${ip}:${identity.port}`).join('  •  ')}
                    </span>
                  ) : (
                    t('settings.connection.noAddress', { port: identity.port })
                  ),
                },
                {
                  label: t('settings.connection.masterId'),
                  value: <IdField value={identity.masterUniqueId} />,
                },
                {
                  label: t('settings.connection.setupCompleted'),
                  value: formatDateTime(identity.setupCompletedAt),
                },
              ]}
            />
            <p className="ob-small" style={{ marginTop: 'var(--s-12)', marginBottom: 0 }}>
              {t('settings.connection.passwordNote')}
            </p>
          </>
        ) : (
          <SkeletonKeyValueRows rows={4} />
        )}
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
          {t('settings.storage.title')}
        </div>
        {storage ? (
          <KeyValueList
            items={[
              { label: t('settings.storage.database'), value: formatBytes(storage.databaseBytes) },
              { label: t('settings.storage.uploads'), value: formatBytes(storage.uploadsBytes) },
              {
                label: t('settings.storage.total'),
                value: <span className="ob-body-strong">{formatBytes(storage.totalBytes)}</span>,
              },
              { label: t('settings.storage.free'), value: formatBytes(storage.diskFreeBytes) },
            ]}
          />
        ) : (
          <SkeletonKeyValueRows rows={4} />
        )}
        {canManageStorage && <StorageBackupActions />}
      </Card>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
      <span className="ob-body" style={{ width: 140, flex: 'none' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function SkeletonKeyValueRows({ rows }: { rows: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-16)' }}
        >
          <Skeleton width="30%" height="var(--t-small-line)" />
          <Skeleton width="45%" height="var(--t-small-line)" />
        </div>
      ))}
    </div>
  );
}
