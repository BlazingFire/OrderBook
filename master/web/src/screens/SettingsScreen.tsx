/**
 * Connection details (re-readable at any time), storage usage, and the
 * per-machine appearance controls (theme/density/motion — 6-UI-DESIGN.md §10,
 * "per-machine, never synced", lives here and only here).
 *
 * The pairing password is deliberately absent: it was shown once at setup and
 * only its hash is stored, so it cannot be displayed again.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  MasterIdentity,
  SettingKey,
  SettingView,
  StorageUsage,
  VaultStatus,
} from '@orderbook/shared';
import { SETTINGS } from '@orderbook/shared';

import { api } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import {
  Button,
  Card,
  IdField,
  Input,
  KeyValueList,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  Segmented,
  Skeleton,
  Slider,
  Switch,
  applyDensity,
  applyMotion,
  applyScale,
  applyTheme,
  formatBytes,
  formatDateTime,
  loadDensity,
  loadScale,
  loadTheme,
  motionDisabled,
  rem,
  t,
  type Density,
  type Theme,
  ShortcutSettings,
} from '@orderbook/ui';

function currentRootSize(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--root-size').trim();
}

export function SettingsScreen() {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [density, setDensity] = useState<Density>(() => loadDensity());
  const [scale, setScale] = useState<number>(() => loadScale());
  const [motionOn, setMotionOn] = useState<boolean>(() => !motionDisabled());
  const [canManageStorage, setCanManageStorage] = useState(false);
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadCompanySettings = useCallback(async (canManage: boolean, canReveal: boolean) => {
    if (canManage) setSettings(await api.settings().catch(() => null));
    if (canReveal) setVault(await api.vaultStatus().catch(() => null));
  }, []);

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
      .then(({ user }) => {
        setCanManageStorage(user.permissions.includes('storage.manage'));
        return loadCompanySettings(
          user.permissions.includes('settings.manage'),
          user.permissions.includes('users.viewPassword'),
        );
      })
      .catch(() => setCanManageStorage(false));
  }, [loadCompanySettings]);

  async function saveSetting(key: SettingKey, value: unknown): Promise<void> {
    setSettingsError(null);
    try {
      setSettings(await api.saveSetting(key, value));
      // Switching the reveal toggle off has just deleted every stored
      // password, so a stale coverage line would be a lie about what this
      // company is holding.
      setVault(await api.vaultStatus().catch(() => null));
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : t('settings.company.saveFailed'));
    }
  }

  function handleThemeChange(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  function handleDensityChange(next: Density) {
    setDensity(next);
    applyDensity(next);
  }

  function handleScaleChange(next: number): void {
    applyScale(next);
    setScale(next);
  }

  // Matches the mockup's own convention (and Office's): the switch reads
  // "Turn animation off," so checked means motion is off, not on.
  function handleMotionChange(motionOff: boolean) {
    const nextMotionOn = !motionOff;
    setMotionOn(nextMotionOn);
    applyMotion(nextMotionOn);
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)', maxWidth: rem(720) }}
    >
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

          <SettingRow label={t('settings.scale.label')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
              <Slider
                value={scale}
                min={SCALE_MIN}
                max={SCALE_MAX}
                step={SCALE_STEP}
                label={t('settings.scale.label')}
                onChange={handleScaleChange}
              />
              <span className="ob-mono ob-small" style={{ minWidth: '3.5rem', textAlign: 'right' }}>
                {Math.round((scale / SCALE_DEFAULT) * 100)}%
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleScaleChange(SCALE_DEFAULT)}
                disabled={scale === SCALE_DEFAULT}
              >
                {t('settings.scale.reset')}
              </Button>
            </div>
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.scale.note', { size: currentRootSize() })}
            </span>
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
              {t('settings.density.note')}
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
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('keys.settings.title')}
        </div>
        <ShortcutSettings />
      </Card>

      {settings && (
        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
            {t('settings.company.title')}
          </div>
          <p className="ob-small" style={{ margin: '0 0 var(--s-12)' }}>
            {t('settings.company.subtitle')}
          </p>
          {settingsError && (
            <div className="ob-banner ob-banner--conflict" role="alert">
              {settingsError}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
            {settings.map((setting) => (
              <CompanySetting
                key={setting.key}
                setting={setting}
                vault={setting.key === 'security.passwordRevealEnabled' ? vault : null}
                onSave={saveSetting}
              />
            ))}
          </div>
        </Card>
      )}

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

/**
 * One row of the company card, rendered from the declaration rather than from a
 * hand-written control per key.
 *
 * Three shapes and no fourth: a boolean is a switch, a secret is "set / not
 * set" plus a field that writes a new value and never reads the old one back,
 * and anything else is shown read-only because the screen that owns it is not
 * this one. That last branch is what keeps this component honest as `SETTINGS`
 * grows — a key with no editor yet appears saying so, instead of silently
 * missing.
 */
function CompanySetting({
  setting,
  vault,
  onSave,
}: {
  setting: SettingView;
  /** Only for the reveal toggle: how much of the company is actually covered. */
  vault: VaultStatus | null;
  onSave: (key: SettingKey, value: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const label = t(SETTINGS[setting.key].labelToken);
  const help = t(SETTINGS[setting.key].descriptionToken);

  return (
    <SettingRow label={label}>
      {setting.secret ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <span className="ob-small">
            {setting.configured
              ? t('settings.company.secretSet')
              : t('settings.company.secretNotSet')}
          </span>
          <Input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={label}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={draft.length === 0}
            onClick={() => {
              const value = draft;
              setDraft('');
              void onSave(setting.key, value);
            }}
          >
            {t('settings.company.secretSave')}
          </Button>
        </div>
      ) : typeof setting.value === 'boolean' ? (
        <Switch
          checked={setting.value}
          onChange={(next) => void onSave(setting.key, next)}
          label={label}
        />
      ) : (
        <span className="ob-mono ob-small">
          {JSON.stringify(setting.value)} - {t('settings.company.editedElsewhere')}
        </span>
      )}
      <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {vault && vault.enabled
          ? t('settings.vault.coverage', { stored: vault.stored, total: vault.total })
          : help}
      </span>
    </SettingRow>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
      <span className="ob-body" style={{ width: rem(140), flex: 'none' }}>
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
