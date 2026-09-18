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
  SettingControl,
  SeedDummyUsersResult,
  SettingKey,
  SettingView,
  StorageUsage,
  VaultStatus,
} from '@orderbook/shared';
import { DEVELOPER_RESET_CONFIRMATION, SETTINGS, SETTING_GROUPS } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import { StorageBackupActions } from '../components/StorageBackup';
import {
  AppearanceSettings,
  Button,
  DataTable,
  FieldError,
  DeveloperPanel,
  IdField,
  Input,
  KeyValueList,
  SettingRow,
  SettingsPage,
  SettingsSection,
  ShortcutSettings,
  Select,
  Skeleton,
  Switch,
  apiErrorText,
  formatBytes,
  rem,
  formatDateTime,
  t,
  useDeveloperSession,
  useUninstallTool,
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
export const SETTINGS_TAB_IDS = [
  'appearance',
  'shortcuts',
  'company',
  'connection',
  'storage',
  'developer',
] as const;

export function SettingsScreen({
  tab,
  onTabChange,
  onSaved,
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
}) {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [canManageStorage, setCanManageStorage] = useState(false);
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
             * first segment, which would give six groups for nine settings,
             * three of them singletons, and read worse than flat.
             *
             * A group with nothing in it is not rendered, so a heading never
             * appears empty; `shared/tests/settings.test.ts` also fails if a
             * declared group has no members at all.
             */
            render: () => (
              <>
                {SETTING_GROUPS.map((group) => {
                  const inGroup = settings.filter((setting) => SETTINGS[setting.key].group === group);
                  if (inGroup.length === 0) return null;

                  return (
                    <SettingsSection
                      key={group}
                      title={t(`settingGroup.${group}`)}
                      description={
                        group === SETTING_GROUPS[0] ? t('settings.company.subtitle') : undefined
                      }
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
                        {inGroup.map((setting) => (
                          <CompanySetting
                            key={setting.key}
                            setting={setting}
                            vault={setting.key === 'security.passwordRevealEnabled' ? vault : null}
                            saving={savingKey === setting.key}
                            error={
                              settingsError?.key === setting.key ? settingsError.message : null
                            }
                            onSave={saveSetting}
                          />
                        ))}
                      </div>
                    </SettingsSection>
                  );
                })}
              </>
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
      onChange={onTabChange}
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
      case 'select':
        return (
          <SelectSetting
            control={definition.control}
            value={String(setting.value ?? '')}
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

/**
 * A closed set, saved on change rather than on a button.
 *
 * The opposite call from `NumberSetting` below, and for the reason stated
 * there: a number must not save per keystroke, because `1` on the way to `12`
 * is a legal-looking value that would be written and audited. A select has no
 * intermediate state — every legal value is in the list, one pick is one
 * decision, and `Select` emits only on a real commit, never while somebody
 * types to filter. That is the same call `Switch` already makes above.
 */
function SelectSetting({
  control,
  value,
  label,
  saving,
  onSave,
}: {
  control: Extract<SettingControl, { kind: 'select' }>;
  value: string;
  label: string;
  saving: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  return (
    <Select
      value={value}
      disabled={saving}
      aria-label={label}
      style={{ width: rem(200) }}
      onChange={(event) => void onSave(event.target.value)}
    >
      {control.options.map((option) => (
        <option key={option.value} value={option.value}>
          {t(option.labelToken)}
        </option>
      ))}
    </Select>
  );
}

/**
 * A bounded number, saved on a button rather than on change.
 *
 * A `Switch` may save on change — there is one other value and it is visible.
 * A number must not: saving each keystroke writes `1` while somebody is on
 * their way to typing `12`, and for `security.sessionHours` that is a value
 * that signs people out four times as often, written and audited.
 */
function NumberSetting({
  control,
  value,
  label,
  saving,
  onSave,
}: {
  control: Extract<SettingControl, { kind: 'number' }>;
  value: number | null;
  label: string;
  saving: boolean;
  onSave: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  // Re-seeded when the stored value changes under us — a save elsewhere, or
  // this row's own write coming back.
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
  }, [value]);

  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const valid =
    parsed === null
      ? control.nullable === true
      : Number.isFinite(parsed) && parsed >= control.min && parsed <= control.max;
  const changed = parsed !== value;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
      <Input
        type="number"
        min={control.min}
        max={control.max}
        step={control.step}
        value={draft}
        aria-label={label}
        aria-invalid={!valid || undefined}
        placeholder={control.nullable ? t('setting.number.none') : undefined}
        style={{ width: rem(110) }}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="ob-small">{t(control.unitToken)}</span>
      <Button
        variant="secondary"
        size="sm"
        busy={saving}
        disabled={!valid || !changed || saving}
        onClick={() => void onSave(parsed)}
      >
        {t('common.save')}
      </Button>
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
