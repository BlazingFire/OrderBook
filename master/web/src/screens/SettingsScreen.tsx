/**
 * Settings, as tabs rather than as one long stack of cards.
 *
 * The skeleton — the page, the sections, the rows, the appearance controls and
 * the Developer tab — lives in `@orderbook/ui`'s `SettingsLayout`, shared with
 * the Office Panel. What is left here is what only the Master has: the company
 * settings, the connection identity, the storage figures, and the two
 * developer tools that reach the database.
 *
 * The pairing password is deliberately absent from the connection tab: it was
 * shown once at setup and only its hash is stored, so it cannot be shown again.
 *
 * The Developer tab is present for every signed-in person, with no permission
 * in front of it. That is the design (`shared/src/domain/developer.ts`): the
 * developer password is the door, and there is no permission that could grant
 * or withhold it without letting an administrator hand developer mode out.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  MasterIdentity,
  SeedDummyUsersResult,
  SettingKey,
  SettingView,
  StorageUsage,
  VaultStatus,
} from '@orderbook/shared';
import { DEVELOPER_RESET_CONFIRMATION, SETTINGS } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import {
  AppearanceSettings,
  Button,
  DataTable,
  DeveloperPanel,
  IdField,
  Input,
  KeyValueList,
  SettingRow,
  SettingsPage,
  SettingsSection,
  ShortcutSettings,
  Skeleton,
  Switch,
  formatBytes,
  formatDateTime,
  t,
  useDeveloperSession,
  useUninstallTool,
  useSettingsTab,
  type DeveloperTool,
  type SettingsTab,
} from '@orderbook/ui';

/**
 * Every tab this panel can have, including the one that needs a permission.
 *
 * The list is fixed rather than derived from the tabs actually built, because
 * the permissions arrive a tick after the screen mounts: a remembered
 * `company` validated against the tabs of that first tick would be thrown away
 * every single load. `SettingsPage` shows the first tab while a remembered one
 * has nothing to render, so nothing is left blank in the meantime.
 */
const TAB_IDS = [
  'appearance',
  'shortcuts',
  'company',
  'connection',
  'storage',
  'developer',
] as const;

export function SettingsScreen() {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [canManageStorage, setCanManageStorage] = useState(false);
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [tab, setTab] = useSettingsTab('ob.settings.tab.master', TAB_IDS, 'appearance');

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

  const tabs: SettingsTab[] = [
    {
      id: 'appearance',
      label: t('settings.tab.appearance'),
      render: () => <AppearanceSettings />,
    },
    {
      id: 'shortcuts',
      label: t('settings.tab.shortcuts'),
      render: () => (
        <SettingsSection title={t('keys.settings.title')}>
          <ShortcutSettings />
        </SettingsSection>
      ),
    },
    // Absent, not empty, without `settings.manage` — and absent too if the
    // read failed, which is what the card used to do.
    ...(settings
      ? [
          {
            id: 'company',
            label: t('settings.tab.company'),
            render: () => (
              <SettingsSection
                title={t('settings.company.title')}
                description={t('settings.company.subtitle')}
              >
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
              </SettingsSection>
            ),
          },
        ]
      : []),
    {
      id: 'connection',
      label: t('settings.tab.connection'),
      render: () => (
        <SettingsSection
          title={t('settings.connection.title')}
          description={t('settings.connection.description')}
        >
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
        </SettingsSection>
      ),
    },
    {
      id: 'storage',
      label: t('settings.tab.storage'),
      render: () => (
        <SettingsSection title={t('settings.storage.title')}>
          {storage ? (
            <KeyValueList
              items={[
                {
                  label: t('settings.storage.database'),
                  value: formatBytes(storage.databaseBytes),
                },
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
        </SettingsSection>
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
      onChange={setTab}
    />
  );
}

/**
 * Long enough for the "erased" toast to be read, short enough that nobody
 * starts clicking around an installation that no longer has a database.
 */
const RELOAD_AFTER_RESET_MS = 1500;

/**
 * The Master's developer tools.
 *
 * Its own component so the unlock lives and dies with the tab: mounting it is
 * what asks the server for a status, and nothing here is fetched while
 * somebody is on Appearance.
 */
function DeveloperTab() {
  const session = useDeveloperSession(api.developer);
  const [seeded, setSeeded] = useState<SeedDummyUsersResult | null>(null);
  const { token } = session;

  // Built unconditionally: it owns the "delete the data too?" switch, and a
  // hook cannot be called only when a token exists.
  const uninstall = useUninstallTool(desktopBridge());

  const tools: DeveloperTool[] = token
    ? [
        {
          id: 'seed',
          title: t('developer.tool.seed.title'),
          description: t('developer.tool.seed.description'),
          action: t('developer.tool.seed.action'),
          done: t('developer.tool.seed.done'),
          run: async () => setSeeded(await api.developer.seedDummyUsers(token)),
          result: seeded ? <SeedResult result={seeded} /> : undefined,
        },
        {
          id: 'reset-all',
          danger: true,
          title: t('developer.tool.resetAll.title'),
          description: t('developer.tool.resetAll.description'),
          action: t('developer.tool.resetAll.action'),
          confirmWord: DEVELOPER_RESET_CONFIRMATION,
          confirmTitle: t('developer.tool.resetAll.confirmTitle'),
          confirmHint: t('developer.tool.resetAll.confirmHint'),
          confirmDetails: [
            t('developer.tool.resetAll.detail.records'),
            t('developer.tool.resetAll.detail.files'),
            t('developer.tool.resetAll.detail.people'),
            t('developer.tool.resetAll.detail.settings'),
            t('developer.tool.resetAll.detail.pairings'),
            t('developer.tool.resetAll.detail.vault'),
          ],
          done: t('developer.tool.resetAll.done'),
          run: async () => {
            await api.developer.resetAll(token);
            // Every screen this page has visited, the signed-in session and the
            // socket now describe a Master that no longer exists. Reloading is
            // the only honest way to the first-run screen — there is nothing
            // left for this page to re-render.
            setTimeout(() => window.location.reload(), RELOAD_AFTER_RESET_MS);
          },
        },
        uninstall,
      ]
    : [];

  return (
    <DeveloperPanel
      status={session.status}
      busy={session.busy}
      error={session.error}
      onUnlock={session.unlock}
      onLock={session.lock}
      tools={tools}
    />
  );
}

/**
 * What the seed produced, as a table to be read off the screen and typed into
 * a sign-in form — which is why the credentials are monospaced and selectable
 * rather than merely printed.
 */
function SeedResult({ result }: { result: SeedDummyUsersResult }) {
  const mono = { userSelect: 'text' } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
      <DataTable
        rows={result.users}
        rowKey={(row) => row.username}
        columns={[
          {
            key: 'username',
            header: t('developer.tool.seed.username'),
            render: (row) => (
              <span className="ob-mono" style={mono}>
                {row.username}
              </span>
            ),
          },
          {
            key: 'password',
            header: t('developer.tool.seed.password'),
            render: (row) => (
              <span className="ob-mono" style={mono}>
                {row.password}
              </span>
            ),
          },
          {
            key: 'tier',
            header: t('developer.tool.seed.tier'),
            // The tier is a key, like the username — not a sentence to translate.
            render: (row) => <span className="ob-mono">{row.tier}</span>,
          },
          {
            key: 'outcome',
            header: t('developer.tool.seed.outcome'),
            render: (row) =>
              row.outcome === 'created'
                ? t('developer.tool.seed.outcomeCreated')
                : t('developer.tool.seed.outcomeReset'),
          },
        ]}
      />
      {result.pairingPassword && (
        <p className="ob-small" style={{ margin: 0 }}>
          {t('developer.tool.seed.pairingPassword')}{' '}
          <span className="ob-mono" style={mono}>
            {result.pairingPassword}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * One row of the company tab, rendered from the declaration rather than from a
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
    <SettingRow
      label={label}
      hint={
        vault && vault.enabled
          ? t('settings.vault.coverage', { stored: vault.stored, total: vault.total })
          : help
      }
    >
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
    </SettingRow>
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
