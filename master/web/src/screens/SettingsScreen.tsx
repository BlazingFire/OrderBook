/**
 * Settings, as tabs rather than as one long stack of cards.
 *
 * The skeleton — the page, the sections, the rows and the appearance controls
 * — lives in `@orderbook/ui`'s `SettingsLayout`, shared with the Office Panel.
 * What is left here is what only the Master has: the company settings, the
 * lead sources and rules, the connection identity and the storage figures.
 *
 * Settings is offered to every signed-in person, as on the Office: Appearance
 * and Shortcuts are per-desk preferences nobody needs a permission for. The
 * other four tabs (company, leads, connection, storage) are the company's own
 * and need `settings.manage` - both in the sidebar's sub-pages (App.tsx, via
 * `settingsTabIdsFor` in `settingsTabs.ts`) and here, where the reads behind them are not made at
 * all without it, since each would only come back 403.
 *
 * The developer routes survive on the server behind the
 * `security.developerModeEnabled` setting, which stays a row of the company tab;
 * there is no Developer tab any more.
 *
 * The pairing password is deliberately absent from the connection tab: it was
 * shown once at setup and only its hash is stored, so it cannot be shown again.
 * A Server Master on the Master PC can replace it with the master key; the new
 * one is shown once, here, and panels already paired keep working.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  MasterIdentity,
  SettingGroup,
  SettingKey,
  SettingView,
  StorageUsage,
  VaultStatus,
} from '@orderbook/shared';
import { SETTINGS, SETTING_GROUPS } from '@orderbook/shared';

import { api } from '../api';
import { AutoBackupSection } from '../components/AutoBackupSection';
import { BackupAllSection } from '../components/BackupAllSection';
import { useMasterKeyPrompt } from '../components/MasterKeyPrompt';
import { StorageBackupActions } from '../components/StorageBackup';
import { optionListTransport } from '../transports';
import {
  AppearanceSettings,
  Button,
  FieldError,
  IdField,
  Input,
  KeyValueList,
  NumberSetting,
  OptionListEditor,
  SettingRow,
  SettingsPage,
  SettingsSection,
  ShortcutSettings,
  Skeleton,
  Switch,
  apiErrorText,
  formatBytes,
  formatDateTime,
  t,
  useConfirm,
  useUnsavedWork,
  type SettingsTab,
} from '@orderbook/ui';

export function SettingsScreen({
  tab,
  onTabChange,
  onSaved,
  permissions,
  settingsRevision = 0,
  sourcesRevision = 0,
  canChangePairingPassword = false,
  onMasterPc = false,
}: {
  /** Which tab is showing — remembered by the shell, chosen here or from the sidebar. */
  tab: string;
  onTabChange: (tab: string) => void;
  /**
   * A company setting was written. The shell re-reads the signed-in user, whose
   * permissions and feature switches depend on those settings, so the change
   * shows on this screen's own sidebar rather than after a reload.
   */
  onSaved: () => void;
  /**
   * The signed-in person's permissions, as the shell holds them — it re-reads
   * them after every company-setting change, this screen's own saves included.
   * Taken as a prop rather than asked for here, so they are known on the first
   * render: the tabs they decide are right from the start instead of one
   * appearing, or vanishing, a beat after the screen opens, and the reads they
   * allow start at once instead of queueing behind a round trip for the
   * session.
   */
  permissions: string[];
  /**
   * Moves on every `setting` change, from any desk. The rows were read once,
   * so a second administrator's save left them showing the old value beside a
   * sidebar that had already moved on.
   */
  settingsRevision?: number;
  /** Moves on every option-list change; the lead sources list reloads on it. */
  sourcesRevision?: number;
  /** A Server Master on the Master PC: the connection tab offers a new pairing password. */
  canChangePairingPassword?: boolean;
  /** This window is on the Master PC itself, where backing up to a drive happens. */
  onMasterPc?: boolean;
}) {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  /**
   * Which row failed, and which row is in flight.
   *
   * Both keyed by setting, not held as one flag and one string: with nine rows
   * under four headings, a banner at the top of the section appears nowhere
   * near the switch that refused, and a global "saving" would grey controls
   * somebody is not waiting on.
   */
  const [settingsError, setSettingsError] = useState<{ key: SettingKey; message: string } | null>(
    null,
  );
  const [savingKey, setSavingKey] = useState<SettingKey | null>(null);

  const confirm = useConfirm();
  const masterKey = useMasterKeyPrompt();
  /** The replacement pairing password, shown once; gone when the screen remounts. */
  const [newPairingPassword, setNewPairingPassword] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  async function changePairingPassword(): Promise<void> {
    const confirmed = await confirm({
      title: t('masterKey.pairing.change'),
      body: t('masterKey.pairing.confirm'),
      confirmLabel: t('masterKey.pairing.change'),
    });
    if (!confirmed) return;
    const token = await masterKey.ask();
    if (!token) return;

    setPairingBusy(true);
    setPairingError(null);
    try {
      setNewPairingPassword((await api.changePairingPassword(token)).pairingPassword);
    } catch (caught) {
      setPairingError(apiErrorText(caught, 'error.requestFailed'));
    } finally {
      setPairingBusy(false);
    }
  }

  /*
   * The usage figures and the connection identity are `settings.manage` at the
   * route, and export and restore are `storage.manage` — so the session's own
   * permissions decide what is read and what appears, rather than offering a
   * read or two buttons whose only possible answer is a refusal. Everybody
   * reaches this screen (Appearance, Shortcuts); only a manager reaches the rest.
   */
  const canManageSettings = permissions.includes('settings.manage');
  const canReadStorage = canManageSettings;
  const canManageStorage = permissions.includes('storage.manage');
  const canBackUpAll = permissions.includes('storage.backupAll');
  const canRevealPasswords = permissions.includes('users.viewPassword');
  // The sources are an option list, so the Fields permissions decide them —
  // the same list, and the same rule, as Fields → Values.
  const canViewSources = permissions.includes('fields.view');
  const canManageSources = permissions.includes('fields.manage');

  const loadCompanySettings = useCallback(async (canManage: boolean, canReveal: boolean) => {
    if (canManage) setSettings(await api.settings().catch(() => null));
    if (canReveal) setVault(await api.vaultStatus().catch(() => null));
  }, []);

  useEffect(() => {
    if (!canManageSettings) return;
    void api
      .identity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, [canManageSettings]);

  // Keyed on the answers, not on the array: the shell hands down a new one
  // each time it re-reads the session, and the same permissions again are no
  // reason to fetch anything twice.
  useEffect(() => {
    if (!canReadStorage) return;
    void api
      .storage()
      .then(setStorage)
      .catch(() => setStorage(null));
  }, [canReadStorage]);

  useEffect(() => {
    void loadCompanySettings(canManageSettings, canRevealPasswords);
  }, [loadCompanySettings, canManageSettings, canRevealPasswords, settingsRevision]);

  async function saveSetting(key: SettingKey, value: unknown): Promise<void> {
    setSettingsError(null);
    setSavingKey(key);
    try {
      setSettings(await api.saveSetting(key, value));
      onSaved();
      // Switching the reveal toggle off has just deleted every stored
      // password, so a stale coverage line would be a lie about what this
      // company is holding.
      setVault(await api.vaultStatus().catch(() => null));
    } catch (caught) {
      setSettingsError({ key, message: apiErrorText(caught, 'settings.company.saveFailed') });
    } finally {
      setSavingKey(null);
    }
  }

  /** One declared group's rows as a section; null when none of them was read. */
  function groupSection(rows: SettingView[], group: SettingGroup) {
    const inGroup = rows.filter((setting) => SETTINGS[setting.key].group === group);
    if (inGroup.length === 0) return null;

    return (
      <SettingsSection
        key={group}
        title={t(`settingGroup.${group}`)}
        description={group === SETTING_GROUPS[0] ? t('settings.company.subtitle') : undefined}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
          {inGroup.map((setting) => (
            <CompanySetting
              key={setting.key}
              setting={setting}
              vault={setting.key === 'security.passwordRevealEnabled' ? vault : null}
              saving={savingKey === setting.key}
              error={settingsError?.key === setting.key ? settingsError.message : null}
              onSave={saveSetting}
            />
          ))}
        </div>
      </SettingsSection>
    );
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
            /*
             * One section per declared group, in `SETTING_GROUPS` order.
             *
             * Nine rows in a single unlabelled column is a wall of switches
             * with nothing to point somebody at over the phone. Grouped by the
             * `group` each setting declares — deliberately not by the key's
             * first segment, which would give six groups for fifteen settings,
             * three of them singletons, and read worse than flat.
             *
             * A group with nothing in it is not rendered, so a heading never
             * appears empty; `shared/tests/settings.test.ts` also fails if a
             * declared group has no members at all.
             *
             * The `leads` group is the exception: it has a tab of its own.
             */
            render: () => (
              <>
                {SETTING_GROUPS.filter((group) => group !== 'leads').map((group) =>
                  groupSection(settings, group),
                )}
              </>
            ),
          },
        ]
      : []),
    /*
     * Everything a lead asks for, in one place (docs/catalogue/CATALOGUE_MODEL.md
     * §5): the sources it may come from — the same option list as Fields →
     * Values, edited under the same permissions — and the lead rules, moved
     * here from Company rather than shown on both. Absent when the reader may
     * see neither half.
     */
    ...(canManageSettings && (canViewSources || settings)
      ? [
          {
            id: 'leads',
            label: t('settings.tab.leads'),
            render: () => (
              <>
                {canViewSources && (
                  <SettingsSection
                    title={t('settings.leads.sources.title')}
                    description={t('settings.leads.sources.description')}
                  >
                    <OptionListEditor
                      listKey="lead.sourcePlatform"
                      canManage={canManageSources}
                      transport={optionListTransport}
                      revision={sourcesRevision}
                      compact
                    />
                  </SettingsSection>
                )}
                {settings && groupSection(settings, 'leads')}
              </>
            ),
          },
        ]
      : []),
    ...(canManageSettings
      ? [
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
                        {
                          label: t('settings.connection.company'),
                          value: identity.companyName ?? '—',
                        },
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
                    {canChangePairingPassword && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 'var(--s-8)',
                          marginTop: 'var(--s-12)',
                        }}
                      >
                        <Button
                          variant="secondary"
                          busy={pairingBusy}
                          onClick={() => void changePairingPassword()}
                        >
                          {t('masterKey.pairing.change')}
                        </Button>
                        {pairingError && <FieldError>{pairingError}</FieldError>}
                        {newPairingPassword && (
                          <KeyValueList
                            items={[
                              {
                                label: t('masterKey.pairing.newPassword'),
                                value: <IdField value={newPairingPassword} />,
                              },
                            ]}
                          />
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <SkeletonKeyValueRows rows={4} />
                )}
              </SettingsSection>
            ),
          },
        ]
      : []),
    // Absent, not empty, without `settings.manage` — the same rule as the
    // company tab. Inside it, export and restore still need `storage.manage`,
    // and the backup-everything sections `storage.backupAll`.
    ...(canManageSettings
      ? [
          {
            id: 'storage',
            label: t('settings.tab.storageBackup'),
            render: () => (
              <>
                <SettingsSection title={t('settings.storage.title')}>
                  {canReadStorage &&
                    (storage ? (
                      <KeyValueList
                        items={[
                          {
                            label: t('settings.storage.database'),
                            value: formatBytes(storage.databaseBytes),
                          },
                          {
                            label: t('settings.storage.uploads'),
                            value: formatBytes(storage.uploadsBytes),
                          },
                          {
                            label: t('settings.storage.total'),
                            value: (
                              <span className="ob-body-strong">
                                {formatBytes(storage.totalBytes)}
                              </span>
                            ),
                          },
                          {
                            label: t('settings.storage.free'),
                            value: formatBytes(storage.diskFreeBytes),
                          },
                        ]}
                      />
                    ) : (
                      <SkeletonKeyValueRows rows={4} />
                    ))}
                  {canManageStorage && <StorageBackupActions />}
                </SettingsSection>
                {canBackUpAll && <BackupAllSection onMasterPc={onMasterPc} />}
                {canBackUpAll && <AutoBackupSection onMasterPc={onMasterPc} />}
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <SettingsPage
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        tabs={tabs}
        activeId={tab}
        onChange={onTabChange}
      />
      {masterKey.prompt}
    </>
  );
}

/**
 * One company setting, drawn from the control its declaration names.
 *
 * A secret is its own shape — "set / not set" plus a field that writes a new
 * value and never reads the old one back — and everything else comes from the
 * declared `control`.
 *
 * This used to branch on `typeof setting.value`, with a final `else` that
 * printed `JSON.stringify(value)` beside "Edited from its own screen" — a
 * screen that does not exist. It was unreachable while every setting was a
 * boolean, so it was never seen and never typechecked; the first number
 * setting would have shipped as an uneditable row pointing nowhere. Switching
 * on the declared `control` makes that branch impossible: the `never` below is
 * a compile error the day somebody adds a control kind and forgets this file.
 */
function CompanySetting({
  setting,
  vault,
  saving,
  error,
  onSave,
}: {
  setting: SettingView;
  /** Only for the reveal toggle: how much of the company is actually covered. */
  vault: VaultStatus | null;
  saving: boolean;
  /** This row's own failure, rendered here rather than in a banner two sections away. */
  error: string | null;
  onSave: (key: SettingKey, value: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const definition = SETTINGS[setting.key];
  const label = t(definition.labelToken);
  const help = t(definition.descriptionToken);

  // "Save all and update": a secret typed into this row and not yet saved is saved.
  useUnsavedWork(
    `secret-setting:${setting.key}`,
    setting.secret && draft.length > 0
      ? {
          label: t('updates.saveAll.setting', { name: label }),
          save: async () => {
            try {
              await onSave(setting.key, draft);
              setDraft('');
              return true;
            } catch {
              return false;
            }
          },
        }
      : null,
  );

  function control() {
    if (setting.secret) {
      return (
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
            disabled={draft.length === 0 || saving}
            onClick={() => {
              const value = draft;
              setDraft('');
              void onSave(setting.key, value);
            }}
          >
            {t('settings.company.secretSave')}
          </Button>
        </div>
      );
    }

    switch (definition.control.kind) {
      case 'boolean':
        return (
          <Switch
            checked={setting.value === true}
            disabled={saving}
            onChange={(next) => void onSave(setting.key, next)}
            label={label}
          />
        );
      case 'number':
        return (
          <NumberSetting
            control={definition.control}
            value={(setting.value ?? null) as number | null}
            label={label}
            saving={saving}
            onSave={(next) => onSave(setting.key, next)}
          />
        );
      default: {
        const exhaustive: never = definition.control;
        return exhaustive;
      }
    }
  }

  return (
    <SettingRow label={label} hint={help}>
      {control()}
      {/* The coverage line is a *second* line, never a replacement for the
          help text. It used to displace it — so the moment the vault was
          switched on, the sentence explaining that switching it off deletes
          every stored password vanished, at exactly the moment it mattered. */}
      {vault?.enabled && (
        <span className="ob-small">
          {t('settings.vault.coverage', { stored: vault.stored, total: vault.total })}
        </span>
      )}
      {error && <FieldError>{error}</FieldError>}
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
