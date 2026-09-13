/**
 * Settings (6-UI-DESIGN.md §10, Settings.dc.html) — as tabs, on the skeleton
 * both panels share (`@orderbook/ui`'s `SettingsLayout`).
 *
 * Theme, density and motion are per-machine and never synced (§10): they live
 * entirely in `ui/theme.ts`'s `localStorage` + `<html>` dataset pair, and the
 * controls for them are now the same component the Master uses rather than a
 * second copy that drifted from it.
 *
 * Everything on the machine and sync tabs is read-only — pairing and sign-in
 * changes happen on their own screens. The exceptions are the storage tab,
 * where the data folder can be moved, and the Developer tab, which is the only
 * way to reach this panel's reset. That tab is shown to everybody signed in:
 * the developer password is the door, not a permission
 * (`shared/src/domain/developer.ts`).
 */

import { DEVELOPER_RESET_CONFIRMATION } from '@orderbook/shared';

import type { ConnectionInfo, PanelSession } from '../api';
import { api, desktopBridge } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import { StoragePathCard } from '../components/StoragePathCard';
import {
  AppearanceSettings,
  DeveloperPanel,
  KeyValueList,
  SettingsPage,
  SettingsSection,
  ShortcutSettings,
  formatDateTime,
  t,
  useDeveloperSession,
  useUninstallTool,
  type DeveloperTool,
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
  'machine',
  'storage',
  'developer',
] as const;

export function SettingsScreen({
  connection,
  session,
  pendingCount,
  openConflicts,
  tab,
  onTabChange,
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
    { id: 'developer', label: t('settings.tab.developer'), render: () => <DeveloperTab /> },
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
 * Long enough for the "reset" toast to be read, short enough that nobody
 * starts clicking around a panel that is no longer paired with anything.
 */
const RELOAD_AFTER_RESET_MS = 1500;

/**
 * This panel's one developer tool.
 *
 * Its own component so the unlock lives and dies with the tab: mounting it is
 * what asks the panel for a status, and nothing here is fetched while somebody
 * is on Appearance.
 */
function DeveloperTab() {
  const developer = useDeveloperSession(api.developer);
  const { token } = developer;

  // Built unconditionally: it owns the "delete the data too?" switch, and a
  // hook cannot be called only when a token exists.
  const uninstall = useUninstallTool(desktopBridge());

  const tools: DeveloperTool[] = token
    ? [
        {
          id: 'reset-panel',
          danger: true,
          title: t('developer.tool.resetPanel.title'),
          description: t('developer.tool.resetPanel.description'),
          action: t('developer.tool.resetPanel.action'),
          confirmWord: DEVELOPER_RESET_CONFIRMATION,
          confirmTitle: t('developer.tool.resetPanel.confirmTitle'),
          confirmHint: t('developer.tool.resetPanel.confirmHint'),
          confirmDetails: [
            t('developer.tool.resetPanel.detail.pairing'),
            t('developer.tool.resetPanel.detail.users'),
            t('developer.tool.resetPanel.detail.queue'),
            t('developer.tool.resetPanel.detail.snapshot'),
          ],
          done: t('developer.tool.resetPanel.done'),
          run: async () => {
            await api.developer.resetAll(token);
            // The session, the cached screens and the event stream all describe
            // a pairing that no longer exists. Reloading is the only honest way
            // back to the connection screen.
            setTimeout(() => window.location.reload(), RELOAD_AFTER_RESET_MS);
          },
        },
        uninstall,
      ]
    : [];

  return (
    <DeveloperPanel
      status={developer.status}
      busy={developer.busy}
      error={developer.error}
      onUnlock={developer.unlock}
      onLock={developer.lock}
      tools={tools}
    />
  );
}
