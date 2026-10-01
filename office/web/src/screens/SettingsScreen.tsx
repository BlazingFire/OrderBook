/**
 * Settings (6-UI-DESIGN.md §10, Settings.dc.html) — as tabs, on the skeleton
 * both panels share (`@orderbook/ui`'s `SettingsLayout`).
 *
 * Theme, density and motion are per-machine and never synced (§10): they live
 * entirely in `ui/theme.ts`'s `localStorage` + `<html>` dataset pair, and the
 * controls for them are now the same component the Master uses rather than a
 * second copy that drifted from it.
 *
 * Everything on the Machine tab — this machine and its sync, one section each
 * — is read-only; pairing and sign-in changes happen on their own screens.
 * The exceptions are the storage tab,
 * where the data folder can be moved, and the Developer tab, which is the only
 * way to reach this panel's reset. That tab is shown to everybody signed in:
 * the developer password is the door, not a permission
 * (`shared/src/domain/developer.ts`).
 *
 * The Leads tab is the one place this panel edits company-wide values: the
 * lead sources and the follow-up default (docs/catalogue/CATALOGUE_MODEL.md
 * §5). Both are forwarded to the Master, which checks the permission again —
 * so, like the rest of the forwarded writes, they need the Master reachable.
 */

import { useState } from 'react';
import { SETTINGS } from '@orderbook/shared';

import type { ConnectionInfo, PanelSession } from '../api';
import { api } from '../api';
import { optionListTransport } from '../optionListTransport';
import { StorageBackupActions } from '../components/StorageBackup';
import { StoragePathCard } from '../components/StoragePathCard';
import {
  AppearanceSettings,
  FieldError,
  KeyValueList,
  NumberSetting,
  OptionListEditor,
  SettingRow,
  SettingsPage,
  SettingsSection,
  ShortcutSettings,
  apiErrorText,
  formatDateTime,
  t,
  type SettingsTab,
} from '@orderbook/ui';

interface Props {
  connection: ConnectionInfo;
  session: PanelSession;
  pendingCount: number;
  openConflicts: number;
  /** Which tab is showing — remembered by the shell, chosen here or from the sidebar. */
  tab: string;
  onTabChange: (tab: string) => void;
  /**
   * The company's follow-up default, resolved from the synced view's features;
   * null before the first sync, when there is no company value to show yet.
   * A save here is not echoed locally: the setting change forces a snapshot,
   * and the new value arrives through this prop like anybody else's.
   */
  followUpDays: number | null;
  /** Moves whenever the synced option lists do; the sources list reloads on it. */
  sourcesRevision: number;
}

const CONNECTION_STATE_KEY: Record<ConnectionInfo['state'], string> = {
  unpaired: 'settings.connection.state.unpaired',
  connecting: 'settings.connection.state.connecting',
  connected: 'settings.connection.state.connected',
  disconnected: 'settings.connection.state.disconnected',
};

export const SETTINGS_TAB_IDS = [
  'appearance',
  'shortcuts',
  'leads',
  'machine',
  'storage',
] as const;

export function SettingsScreen({
  connection,
  session,
  pendingCount,
  openConflicts,
  tab,
  onTabChange,
  followUpDays,
  sourcesRevision,
}: Props) {
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

  const tabs: SettingsTab[] = [
    { id: 'appearance', label: t('settings.tab.appearance'), render: () => <AppearanceSettings /> },
    {
      id: 'shortcuts',
      label: t('settings.tab.shortcuts'),
      render: () => (
        <SettingsSection title={t('keys.settings.title')}>
          <ShortcutSettings />
        </SettingsSection>
      ),
    },
    {
      id: 'leads',
      label: t('settings.tab.leads'),
      render: () => (
        <>
          {/* The same option list, and the same permissions, as the Master's
              Fields → Values. */}
          {session.permissions.includes('fields.view') && (
            <SettingsSection
              title={t('settings.leads.sources.title')}
              description={t('settings.leads.sources.description')}
            >
              <OptionListEditor
                listKey="lead.sourcePlatform"
                canManage={session.permissions.includes('fields.manage')}
                transport={optionListTransport}
                revision={sourcesRevision}
                compact
              />
            </SettingsSection>
          )}
          <SettingsSection title={t('settingGroup.leads')}>
            <FollowUpDefault
              days={followUpDays}
              canManage={session.permissions.includes('settings.manage')}
            />
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'machine',
      label: t('settings.tab.machine'),
      render: () => (
        <>
          <SettingsSection title={t('settings.machine.title')}>
            <KeyValueList items={machineItems} />
          </SettingsSection>
          <SettingsSection title={t('settings.sync.title')}>
            <KeyValueList items={syncItems} />
            <p className="ob-small" style={{ marginTop: 'var(--s-12)', marginBottom: 0 }}>
              {t('settings.sync.note')}
            </p>
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'storage',
      label: t('settings.tab.storage'),
      render: () => (
        <>
          {/* Its own card, and its own eyebrow — it stays the collapsed
              one-liner it is on the sign-in screen rather than growing a
              second heading here. */}
          <StoragePathCard />
          {session.permissions.includes('storage.manage') && (
            <SettingsSection title={t('settings.storage.title')}>
              <StorageBackupActions />
            </SettingsSection>
          )}
        </>
      ),
    },
  ];

  return (
    <SettingsPage
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      tabs={tabs}
      activeId={tab}
      onChange={onTabChange}
    />
  );
}

/**
 * `leads.followUpDefaultDays` — the one company setting this panel may write.
 *
 * Saved through `PUT /api/settings/:key`, which the Master accepts from a panel
 * for this key alone and still checks `settings.manage` on. Without that
 * permission the value is shown, not offered: a greyed box on a permission the
 * reader's role cannot gain here would be a permanent tease.
 */
function FollowUpDefault({ days, canManage }: { days: number | null; canManage: boolean }) {
  const definition = SETTINGS['leads.followUpDefaultDays'];
  const label = t(definition.labelToken);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api.saveSetting('leads.followUpDefaultDays', next);
    } catch (caught) {
      setError(apiErrorText(caught, 'settings.company.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow label={label} hint={t(definition.descriptionToken)}>
      {canManage ? (
        <NumberSetting
          control={definition.control}
          value={days}
          label={label}
          saving={saving}
          onSave={save}
        />
      ) : (
        <span className="ob-body">
          {days === null ? '—' : `${days} ${t(definition.control.unitToken)}`}
        </span>
      )}
      {error && <FieldError>{error}</FieldError>}
    </SettingRow>
  );
}
