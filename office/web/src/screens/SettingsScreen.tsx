/**
 * Settings (6-UI-DESIGN.md §10, Settings.dc.html) — appearance controls and
 * read-only device info.
 *
 * Theme, density and motion are per-machine and never synced (§10): they live
 * entirely in `ui/theme.ts`'s `localStorage` + `<html>` dataset pair, which
 * until now was only reachable from the dev-only token gallery. This screen
 * is the first real, permanent home for them. Everything else on the screen
 * is read-only — pairing and sign-in changes happen on their own screens.
 */

import { useState } from 'react';

import type { ConnectionInfo, PanelSession } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import {
  Button,
  Card,
  KeyValueList,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  Segmented,
  Slider,
  Switch,
  applyDensity,
  applyMotion,
  applyScale,
  applyTheme,
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

interface Props {
  connection: ConnectionInfo;
  session: PanelSession;
  pendingCount: number;
  openConflicts: number;
}

function currentRootSize(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--root-size').trim();
}

const CONNECTION_STATE_KEY: Record<ConnectionInfo['state'], string> = {
  unpaired: 'settings.connection.state.unpaired',
  connecting: 'settings.connection.state.connecting',
  connected: 'settings.connection.state.connected',
  disconnected: 'settings.connection.state.disconnected',
};

export function SettingsScreen({ connection, session, pendingCount, openConflicts }: Props) {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [density, setDensity] = useState<Density>(loadDensity);
  const [scale, setScale] = useState<number>(loadScale);
  const [motionOn, setMotionOn] = useState<boolean>(() => !motionDisabled());

  function pickTheme(next: Theme): void {
    applyTheme(next);
    setTheme(next);
  }

  function pickDensity(next: Density): void {
    applyDensity(next);
    setDensity(next);
  }

  function pickScale(next: number): void {
    applyScale(next);
    setScale(next);
  }

  function toggleMotion(motionOff: boolean): void {
    const nextMotionOn = !motionOff;
    applyMotion(nextMotionOn);
    setMotionOn(nextMotionOn);
  }

  const machineItems = [
    { label: t('settings.machine.panel'), value: connection.panelName },
    { label: t('settings.machine.company'), value: connection.companyName ?? '—' },
    { label: t('settings.machine.connection'), value: t(CONNECTION_STATE_KEY[connection.state]) },
    {
      label: t('settings.machine.networkLink'),
      value: connection.hasNetworkLink ? t('common.yes') : t('common.no'),
    },
    {
      label: t('sync.pairedServer'),
      value: connection.masterHost ? (
        <span className="ob-mono">
          {connection.masterHost}
          {connection.masterPort ? `:${connection.masterPort}` : ''}
        </span>
      ) : (
        '—'
      ),
    },
    {
      label: t('settings.machine.signedInAs'),
      value: session.offline
        ? t('settings.machine.signedInAsOffline', {
            name: session.displayName,
            role: session.roleName,
          })
        : t('footer.signedInAs', { name: session.displayName, role: session.roleName }),
    },
  ];

  const syncItems = [
    { label: t('sync.pendingChanges'), value: pendingCount.toLocaleString('en-IN') },
    { label: t('sync.lastSuccessful'), value: formatDateTime(connection.lastSyncedAt) },
    ...(openConflicts > 0
      ? [{ label: t('nav.conflicts'), value: openConflicts.toLocaleString('en-IN') }]
      : []),
  ];

  return (
    <div
      style={{ maxWidth: rem(720), display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
    >
      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('settings.appearance.title')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
            <span className="ob-body" style={{ width: rem(140) }}>
              {t('settings.appearance.theme')}
            </span>
            <Segmented
              options={[
                { value: 'light' as const, label: t('settings.appearance.themeLight') },
                { value: 'dark' as const, label: t('settings.appearance.themeDark') },
              ]}
              value={theme}
              onChange={pickTheme}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
            <span className="ob-body" style={{ width: rem(140) }}>
              {t('settings.appearance.scale')}
            </span>
            <Slider
              value={scale}
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              label={t('settings.appearance.scale')}
              onChange={pickScale}
            />
            <span className="ob-mono ob-small" style={{ minWidth: '3.5rem', textAlign: 'right' }}>
              {Math.round((scale / SCALE_DEFAULT) * 100)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => pickScale(SCALE_DEFAULT)}
              disabled={scale === SCALE_DEFAULT}
            >
              {t('settings.appearance.scaleReset')}
            </Button>
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.appearance.scaleNote', { size: currentRootSize() })}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
            <span className="ob-body" style={{ width: rem(140) }}>
              {t('settings.appearance.density')}
            </span>
            <Segmented
              options={[
                { value: 'compact' as const, label: t('settings.appearance.densityCompact') },
                {
                  value: 'comfortable' as const,
                  label: t('settings.appearance.densityComfortable'),
                },
                { value: 'large' as const, label: t('settings.appearance.densityLarge') },
              ]}
              value={density}
              onChange={pickDensity}
            />
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.appearance.densityNote')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
            <span className="ob-body" style={{ width: rem(140) }}>
              {t('settings.appearance.motion')}
            </span>
            <Switch
              checked={!motionOn}
              onChange={toggleMotion}
              label={t('settings.appearance.motionLabel')}
            />
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {t('settings.appearance.motionHint')}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('keys.settings.title')}
        </div>
        <ShortcutSettings />
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('settings.machine.title')}
        </div>
        <KeyValueList items={machineItems} />
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
          {t('settings.sync.title')}
        </div>
        <KeyValueList items={syncItems} />
        <p className="ob-small" style={{ marginTop: 'var(--s-12)', marginBottom: 0 }}>
          {t('settings.sync.note')}
        </p>
      </Card>

      {session.permissions.includes('storage.manage') && (
        <Card>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-12)' }}>
            {t('settings.storage.title')}
          </div>
          <StorageBackupActions />
        </Card>
      )}
    </div>
  );
}
