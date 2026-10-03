/**
 * Roles & Users — one screen, two tabs (docs/ROLES_AND_USERS.md UI §3–§5).
 *
 * Hiding a control here is a courtesy: every action is refused again by the
 * server without the permission. The distinction the UI does have to get right
 * is *hidden* versus *disabled* — a control the caller can never have is absent
 * (a disabled one would be a permanent tease), while a control blocked by a
 * changeable state is disabled with the reason attached.
 *
 * Server Masters (1.3) are highlighted wherever they are listed. A caller of a
 * lower tier gets no controls at all on a Server Master's row, because the
 * server refuses every one of them (`assertMayManageUser`). A Server Master
 * acting on another Server Master is asked for the master key when the server
 * says it is needed, and the call is repeated with the token.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { OneTimeSecret, PermissionCatalogue, Role, RoleTier, User } from '@orderbook/shared';
import { SERVER_MASTER_MIN_ACTIVE, SERVER_MASTER_TIER, tierRank } from '@orderbook/shared';

import { api, ApiError, type FieldDifference } from '../api';
import { useMasterKeyPrompt } from '../components/MasterKeyPrompt';
import {
  Avatar,
  AvatarPicker,
  Button,
  Card,
  ConflictBanner,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  FormField,
  IdField,
  Input,
  Modal,
  OfflineBanner,
  PermissionGrid,
  PermissionSummary,
  Segmented,
  Select,
  SkeletonRows,
  ServerMasterBadge,
  SkeletonTable,
  StatusPill,
  TierPill,
  copyText,
  formatDateTime,
  rem,
  t,
  tierLabel,
  useFilterBar,
  useSubNav,
  useTopbarActions,
  type DataTableColumn,
  PasswordInput,
} from '@orderbook/ui';

/**
 * Runs a call that may need the master key: first without a token, and, when
 * the server answers that the key is needed, again with the token the prompt
 * returns. The server decides which changes need it, so this never guesses.
 */
type WithKey = <T>(action: (masterKeyToken?: string) => Promise<T>) => Promise<T>;

const isServerMaster = (user: User): boolean => user.roleTier === SERVER_MASTER_TIER;

interface Props {
  /**
   * Bumped by the live socket whenever a user or a role changes — this
   * browser's own edit or another administrator's — so the lists are never
   * the ones this screen happened to load first.
   */
  revision: number;
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  currentUserId: string;
  /** The caller's own tier. A picker must never offer a role above it. */
  currentUserTier: RoleTier;
  /** Which tab is showing — chosen here or from the sidebar's sub-pages. */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

type Tab = 'users' | 'roles';

export function AccessScreen({
  revision,
  permissions,
  currentUserId,
  currentUserTier,
  tab,
  onTabChange,
}: Props) {
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  /**
   * Whether this company has switched the password vault on.
   *
   * Asked for separately from the permission because the two answer different
   * questions, and the permission is the weaker of them: a fresh install's
   * seeded Administrator already holds `users.viewPassword`, so hanging the
   * control on that alone would show a button whose only possible outcome is a
   * refusal.
   */
  const [vaultEnabled, setVaultEnabled] = useState(false);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  /** Which person's detail screen is open, by id so it re-reads the live row. */
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * The role editor's own dirty-aware cancel.
   *
   * Closing is no longer only its Cancel button: the sidebar entry this
   * operation gets means the operator can navigate straight out of it, and
   * doing that must ask about an unsaved draft exactly as Cancel does. The ref
   * starts as a plain close and `RoleEditor` overwrites it when it mounts, so
   * both exits run the same check rather than one of them silently discarding.
   */
  const editorCloseRef = useRef<() => boolean>(() => {
    setEditing(null);
    return true;
  });

  const can = useCallback((key: string) => permissions.includes(key), [permissions]);

  const load = useCallback(async () => {
    try {
      const [nextRoles, nextUsers] = await Promise.all([
        can('roles.view') ? api.roles() : Promise.resolve([]),
        can('users.manage') ? api.users() : Promise.resolve([]),
      ]);
      setRoles(nextRoles);
      setUsers(nextUsers);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('access.error.load'));
    } finally {
      // Until this flips, the tables render skeletons. Without it the first
      // paint said "0 people" and "Nobody here yet." — a statement about the
      // company that happened to be false.
      setLoading(false);
    }
  }, [can]);

  useEffect(() => {
    void api
      .permissionCatalogue()
      .then(setCatalogue)
      .catch(() => setCatalogue(null));
  }, []);

  useEffect(() => {
    if (!permissions.includes('users.viewPassword')) return;
    void api
      .vaultStatus()
      .then((status) => setVaultEnabled(status.enabled))
      .catch(() => setVaultEnabled(false));
  }, [permissions]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.missingPermission
          ? `${caught.message}`
          : caught instanceof Error
            ? caught.message
            : failure,
      );
    }
  }

  const tabItems: Array<{ value: Tab; label: string }> = [
    ...(can('users.manage') ? [{ value: 'users' as Tab, label: t('access.tab.users') }] : []),
    ...(can('roles.view') ? [{ value: 'roles' as Tab, label: t('access.tab.roles') }] : []),
  ];

  // `tab` is a preference, not a guarantee: a caller without `users.manage` has
  // no Users tab to select, and honouring the preference anyway showed them an
  // empty roster — "0 people" — with the roles list they came for unrendered
  // behind a tab that read as unselected.
  const active: Tab = tabItems.some((item) => item.value === tab) ? tab : 'roles';

  // Editing a role means a ten-by-six matrix plus two capability groups; it is
  // a screen, not a panel, so it takes the content area and says where it is in
  // the sidebar. Editing a person is a smaller form but the same idea, and the
  // two are mutually exclusive.
  const roleEditorOpen = editing !== null;
  const userEditorOpen = editingUser !== null;
  const openPerson = users.find((user) => user.id === openUserId) ?? null;
  const personOpen = openPerson !== null && active === 'users';

  /*
   * The Users/Roles switcher lives in the topbar, beside the screen's name,
   * rather than above the first card. It used to sit in the content next to a
   * second copy of the heading the topbar was already showing — two titles for
   * one screen, and a control that read as belonging to the card under it
   * rather than to the screen.
   *
   * Withdrawn while an editor has the screen: there is nothing to switch
   * between inside one, and a live switcher there would throw away a draft.
   */
  const masterKey = useMasterKeyPrompt();
  const withKey: WithKey = async (action) => {
    try {
      return await action();
    } catch (caught) {
      if (
        !(caught instanceof ApiError) ||
        caught.messageKey !== 'error.unauthorized.masterKeyRequired'
      ) {
        throw caught;
      }
      const token = await masterKey.ask();
      if (!token) throw caught;
      return action(token);
    }
  };

  useTopbarActions(
    tabItems.length > 1 && !roleEditorOpen && !userEditorOpen && !personOpen ? (
      <Segmented options={tabItems} value={active} onChange={onTabChange} />
    ) : null,
  );

  // Keyed by the screen it belongs to: entries are held per screen now, and
  // deliberately survive being hidden. `onExit` is gone — navigating away no
  // longer unmounts this screen, so there is no draft to lose and nothing to
  // ask about. Closing the editor is still the explicit way out.
  useSubNav(
    'access',
    roleEditorOpen
      ? {
          parentId: 'access',
          items: [
            {
              id: 'access.role',
              label:
                editing === 'new'
                  ? t('access.roleEditor.newRole')
                  : t('nav.master.editRole', { name: editing.name }),
              icon: 'shield',
            },
          ],
          activeId: 'access.role',
        }
      : userEditorOpen
        ? {
            parentId: 'access',
            items: [
              {
                id: 'access.user',
                label: t('nav.master.editUser', { name: editingUser.displayName }),
                icon: 'parties',
              },
            ],
            activeId: 'access.user',
          }
        : personOpen
          ? {
              parentId: 'access',
              items: [{ id: 'access.person', label: openPerson.displayName, icon: 'parties' }],
              activeId: 'access.person',
            }
          : null,
  );

  if (roleEditorOpen) {
    return (
      <EditorScreen
        title={editing === 'new' ? t('access.roleEditor.newRole') : editing.name}
        meta={
          editing === 'new' ? null : (
            <>
              <TierPill tier={editing.tier} />
              {editing.isSystem && (
                <StatusPill tone="default">{t('access.roles.systemBadge')}</StatusPill>
              )}
              <span className="ob-small">
                {t('access.roles.detail.metaCounts', {
                  permissions: editing.permissions.length,
                  users: editing.userCount,
                })}
              </span>
            </>
          )
        }
        onBack={() => editorCloseRef.current()}
        backLabel={t('access.editor.backToList')}
      >
        {error && (
          <div className="ob-banner ob-banner--conflict" role="alert">
            {error}
          </div>
        )}
        {catalogue ? (
          <RoleEditorLoader
            key={editing === 'new' ? 'new' : editing.id}
            catalogue={catalogue}
            role={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
            onError={setError}
            registerCancel={(fn) => {
              editorCloseRef.current = fn;
            }}
          />
        ) : (
          <SkeletonRows rows={6} columns={6} />
        )}
      </EditorScreen>
    );
  }

  if (userEditorOpen) {
    return (
      <EditorScreen
        title={editingUser.displayName}
        meta={
          <>
            <span className="ob-mono ob-small">{editingUser.username}</span>
            <StatusPill tone={editingUser.isActive ? 'ok' : 'default'}>
              {editingUser.isActive
                ? t('access.users.statusActive')
                : t('access.users.statusInactive')}
            </StatusPill>
            <span className="ob-small">{editingUser.roleName}</span>
          </>
        }
        onBack={() => {
          setEditingUser(null);
          return true;
        }}
        backLabel={t('access.editor.backToList')}
      >
        {error && (
          <div className="ob-banner ob-banner--conflict" role="alert">
            {error}
          </div>
        )}
        <UserEditForm
          key={editingUser.id}
          user={editingUser}
          onCancel={() => setEditingUser(null)}
          onSaved={() => setEditingUser(null)}
          onRun={run}
          withKey={withKey}
        />
        {masterKey.prompt}
      </EditorScreen>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {error && (
        <div className="ob-banner ob-banner--conflict" role="alert">
          {error}
        </div>
      )}

      {secret && <OneTimeSecretDialog secret={secret} onClose={() => setSecret(null)} />}
      {masterKey.prompt}

      {/* Delete is soft everywhere in this product, but until now nothing in the
          UI could undo one — `api.restoreRole`/`api.restoreUser` were declared,
          routed, and called by nobody. A mis-click had no in-product recovery. */}
      {(can('roles.delete') || can('users.manage')) && (
        <RecycleBin
          canRestoreRoles={can('roles.delete')}
          canRestoreUsers={can('users.manage')}
          onRun={run}
        />
      )}

      {active === 'users' ? (
        <UsersTab
          users={users}
          roles={roles}
          canManage={can('users.manage')}
          canAssign={can('roles.assign')}
          canReveal={can('users.viewPassword') && vaultEnabled}
          currentUserId={currentUserId}
          actorTier={currentUserTier}
          loading={loading}
          openUserId={openUserId}
          onOpenUser={setOpenUserId}
          onEdit={setEditingUser}
          onSecret={setSecret}
          onRun={run}
          withKey={withKey}
        />
      ) : (
        <RolesTab
          roles={roles}
          catalogue={catalogue}
          // Absent rather than disabled: a management-tier user can never hold
          // this, so a greyed button would be a permanent tease.
          canCreate={can('roles.create')}
          canEdit={can('roles.edit')}
          canDelete={can('roles.delete')}
          loading={loading}
          onEdit={setEditing}
          onRun={run}
        />
      )}
    </div>
  );
}

// --- Users ----------------------------------------------------------------

function UsersTab({
  users,
  roles,
  canManage,
  canAssign,
  canReveal,
  currentUserId,
  actorTier,
  loading,
  openUserId,
  onOpenUser,
  onEdit,
  onSecret,
  onRun,
  withKey,
}: {
  users: User[];
  roles: Role[];
  canManage: boolean;
  canAssign: boolean;
  /** Both the key and the company's switch — see `vaultEnabled` above. */
  canReveal: boolean;
  currentUserId: string;
  /** The caller's own tier, so the role picker cannot offer one above it. */
  actorTier: RoleTier;
  loading: boolean;
  /** The person whose detail screen is open — held by the screen so its sidebar entry can name it. */
  openUserId: string | null;
  onOpenUser: (id: string | null) => void;
  /** Opens the person's own editor screen — this tab does not host it. */
  onEdit: (user: User) => void;
  onSecret: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
  withKey: WithKey;
}) {
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [sort, setSort] = useState<'created' | 'name' | 'role' | 'lastSignIn'>('created');
  const [confirmDeactivate, setConfirmDeactivate] = useState<User | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);
  /** The person whose password is being set, and the value being set. */
  const [settingPassword, setSettingPassword] = useState<User | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  /** The person whose stored password is being revealed, and the caller's own. */
  const [revealing, setRevealing] = useState<User | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    const filtered = users.filter((user) => {
      if (roleFilter && user.roleId !== roleFilter) return false;
      if (statusFilter === 'active' && !user.isActive) return false;
      if (statusFilter === 'inactive' && user.isActive) return false;
      if (!term) return true;
      return (
        user.displayName.toLowerCase().includes(term) || user.username.toLowerCase().includes(term)
      );
    });

    // 'created' is the server's order — zero-padded ids sort lexicographically,
    // so creation order needs no separate sort key and no client work.
    if (sort === 'created') return filtered;

    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.displayName.localeCompare(b.displayName);
      if (sort === 'role') return a.roleName.localeCompare(b.roleName);
      // Never signed in sorts last rather than first, which is what somebody
      // scanning for stale accounts actually wants.
      return (b.lastSignInAt ?? '').localeCompare(a.lastSignInAt ?? '');
    });
  }, [users, search, roleFilter, statusFilter, sort]);

  /**
   * The client can work out that this would remove the last administrator, so
   * it disables the control with a reason rather than letting someone discover
   * it in a confirm dialog. The service refuses it regardless.
   */
  const adminRank = tierRank('admin');
  const isAdministrative = (user: User): boolean => tierRank(user.roleTier) >= adminRank;
  // Server Masters count too: they hold everything an administrator does.
  const activeAdmins = users.filter(
    (user) => user.isActive && !user.deletedAt && isAdministrative(user),
  );
  const activeServerMasters = users.filter(
    (user) => user.isActive && !user.deletedAt && isServerMaster(user),
  );

  function lastAdminReason(user: User): string | undefined {
    if (!isAdministrative(user) || !user.isActive) return undefined;
    if (activeAdmins.length <= 1) return t('access.users.lastAdminReason');
    // At least two Server Masters must stay active (`assertServerMastersRetained`).
    if (isServerMaster(user) && activeServerMasters.length <= SERVER_MASTER_MIN_ACTIVE) {
      return t('validation.user.serverMastersRequired', { count: SERVER_MASTER_MIN_ACTIVE });
    }
    return undefined;
  }

  /**
   * Nobody manages an account above their own tier, so an administrator gets
   * no controls on a Server Master at all: absent, not disabled.
   */
  const mayManage = (user: User): boolean => tierRank(user.roleTier) <= tierRank(actorTier);

  /** The roles this caller may hand out, plus the one the person already has. */
  const assignableFor = (user: User): Role[] =>
    roles.filter((role) => role.id === user.roleId || tierRank(role.tier) <= tierRank(actorTier));

  useFilterBar(
    !loading && users.length > 0 ? (
      <>
        <div className="ob-search">
          <Input
            aria-label={t('access.users.searchLabel')}
            placeholder={t('access.users.searchPlaceholder')}
            data-screen-search
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <FilterDivider />
        <Select
          aria-label={t('access.users.filterRoleLabel')}
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
          style={{ width: rem(160) }}
        >
          <option value="">{t('access.users.filterRoleAll')}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
        <FilterChip
          active={statusFilter === 'active'}
          onClick={() => setStatusFilter((current) => (current === 'active' ? 'all' : 'active'))}
        >
          {t('access.users.filterStatusActive')}
        </FilterChip>
        <FilterChip
          active={statusFilter === 'inactive'}
          onClick={() =>
            setStatusFilter((current) => (current === 'inactive' ? 'all' : 'inactive'))
          }
        >
          {t('access.users.filterStatusInactive')}
        </FilterChip>
        <FilterDivider />
        <Select
          aria-label={t('access.users.sortLabel')}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          style={{ width: rem(150) }}
        >
          <option value="created">{t('access.users.sortCreated')}</option>
          <option value="name">{t('access.users.sortName')}</option>
          <option value="role">{t('access.users.sortRole')}</option>
          <option value="lastSignIn">{t('access.users.sortLastSignIn')}</option>
        </Select>
      </>
    ) : null,
  );

  const columns: DataTableColumn<User>[] = [
    {
      key: 'avatar',
      header: '',
      width: rem(44),
      render: (user) => (
        <Avatar
          name={user.displayName}
          avatar={user.avatar}
          size="sm"
          highlight={isServerMaster(user)}
        />
      ),
    },
    {
      /*
       * One line, and only the name.
       *
       * This cell used to stack the display name over an `IdField`. Body cells
       * are exactly one `--row-h` tall and clip what does not fit, so the
       * second line rendered on top of the first and the roster read as a
       * rendering fault. The id is a column of its own now — visible on every
       * row, and no longer fighting the name for the same 32 pixels.
       */
      key: 'name',
      header: t('access.users.colName'),
      width: '1fr',
      render: (user) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', minWidth: 0 }}>
          <span>{user.displayName}</span>
          {isServerMaster(user) && <ServerMasterBadge />}
        </span>
      ),
    },
    {
      key: 'username',
      header: t('access.users.colUsername'),
      priority: 2,
      width: rem(150),
      render: (user) => <span className="ob-small">{user.username}</span>,
    },
    {
      key: 'id',
      header: t('access.users.colId'),
      priority: 3,
      width: rem(180),
      render: (user) => <IdField value={user.id} />,
    },
    {
      /*
       * A name, not a picker.
       *
       * Every row used to carry a live <select>, so a list somebody was reading
       * was also a control surface: a stray scroll over the wrong row silently
       * reassigned a person's role. Assigning is a deliberate act on one
       * person, so it happens in that person's dialog.
       */
      key: 'role',
      header: t('access.users.colRole'),
      width: rem(240),
      render: (user) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', minWidth: 0 }}>
          <span>{user.roleName}</span>
          <TierPill tier={user.roleTier} />
        </span>
      ),
    },
    {
      key: 'status',
      header: t('access.users.colStatus'),
      width: rem(110),
      render: (user) => (
        <StatusPill tone={user.isActive ? 'ok' : 'default'}>
          {user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
        </StatusPill>
      ),
    },
    {
      key: 'lastSignIn',
      header: t('access.users.colLastSignIn'),
      priority: 3,
      width: rem(160),
      render: (user) => <span className="ob-small">{formatDateTime(user.lastSignInAt)}</span>,
    },
    {
      /*
       * Four buttons per row was a wall: the widest column on the screen was
       * the one carrying no data. They live in the detail band now, next to
       * the person they act on, and the row keeps a single Open.
       */
      key: 'actions',
      header: '',
      width: rem(110),
      render: (user) => (
        <div
          style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}
        >
          <Button variant="secondary" size="sm" icon="expand" onClick={() => onOpenUser(user.id)}>
            {t('access.users.open')}
          </Button>
        </div>
      ),
    },
  ];

  const openUser = users.find((user) => user.id === openUserId) ?? null;

  /** The facts about one person, and the one control that changes their access. */
  function renderUserDetail(user: User) {
    return (
      <div className="ob-detail">
        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('avatar.section')}</div>
          <AvatarPicker
            user={user}
            // Your own face needs no permission; somebody else's is a roster
            // edit. The server checks the same thing again either way.
            canEdit={(canManage && mayManage(user)) || user.id === currentUserId}
            onUpload={async (file) => {
              await onRun(() => api.uploadAvatar(user.id, file), t('avatar.error.uploadFailed'));
            }}
            onRemove={async () => {
              await onRun(() => api.removeAvatar(user.id), t('avatar.error.removeFailed'));
            }}
          />
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('access.users.detail.identity')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('access.users.colId')}</dt>
              <dd>
                <IdField value={user.id} />
              </dd>
            </div>
            <div>
              <dt>{t('access.users.colName')}</dt>
              <dd>{user.displayName}</dd>
            </div>
            <div>
              <dt>{t('access.users.colUsername')}</dt>
              <dd className="ob-mono">{user.username}</dd>
            </div>
          </dl>
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('access.users.detail.access')}</div>
          {canAssign && mayManage(user) ? (
            <FormField label={t('access.users.colRole')} hint={t('access.users.roleHint')}>
              {(id) => (
                <Select
                  id={id}
                  value={user.roleId ?? ''}
                  onChange={(event) => {
                    const roleId = event.target.value;
                    void onRun(
                      () =>
                        withKey((token) =>
                          api.updateUser(
                            user.id,
                            {
                              roleId,
                              // Without this the save is last-write-wins: two
                              // administrators reassigning the same person would
                              // both "succeed" and one would silently lose.
                              expectedVersion: user.sync.version,
                            },
                            token,
                          ),
                        ),
                      t('access.users.roleChangeFailed'),
                    );
                  }}
                >
                  {assignableFor(user).map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          ) : (
            <dl className="ob-detail-grid">
              <div>
                <dt>{t('access.users.colRole')}</dt>
                <dd>{user.roleName}</dd>
              </div>
            </dl>
          )}
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('access.roles.colTier')}</dt>
              <dd>
                <TierPill tier={user.roleTier} />
              </dd>
            </div>
            <div>
              <dt>{t('access.users.colStatus')}</dt>
              <dd>
                {user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
              </dd>
            </div>
          </dl>
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('access.users.detail.activity')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('access.users.colLastSignIn')}</dt>
              <dd>{formatDateTime(user.lastSignInAt)}</dd>
            </div>
            <div>
              <dt>{t('access.users.detail.created')}</dt>
              <dd>{formatDateTime(user.createdAt)}</dd>
            </div>
            <div>
              <dt>{t('access.users.detail.updated')}</dt>
              <dd>{formatDateTime(user.updatedAt)}</dd>
            </div>
            <div>
              {/* The number a stale save is rejected against — worth showing
                  when two administrators are editing the same roster. */}
              <dt>{t('access.users.detail.version')}</dt>
              <dd className="ob-mono">{user.sync.version}</dd>
            </div>
          </dl>
        </section>
      </div>
    );
  }

  /** The dialog's actions. Destructive first and set apart, then the rest. */
  function renderUserActions(user: User) {
    const blocked = lastAdminReason(user);
    return (
      <>
        {canManage && mayManage(user) && (
          <>
            <Button
              variant="danger"
              disabled={Boolean(blocked) || user.id === currentUserId}
              title={
                blocked ?? (user.id === currentUserId ? t('access.users.thisIsYou') : undefined)
              }
              onClick={() => {
                setConfirmDelete(user);
              }}
            >
              {t('access.users.delete')}
            </Button>
            {canReveal && (
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmPassword('');
                  setRevealing(user);
                }}
              >
                {t('access.users.revealPassword')}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setPasswordValue('');
                setSettingPassword(user);
              }}
            >
              {t('access.users.resetPassword')}
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(blocked)}
              title={blocked}
              onClick={() => {
                // Deactivation is not a delete, and the difference is
                // load-bearing enough that §4.2 asks for it to be spelled out
                // at the moment somebody acts — not discovered afterwards.
                // Only deactivating asks first; reactivating never needs a
                // confirmation.
                if (user.isActive) {
                  setConfirmDeactivate(user);
                } else {
                  void onRun(
                    () =>
                      withKey((token) =>
                        api.updateUser(
                          user.id,
                          { isActive: true, expectedVersion: user.sync.version },
                          token,
                        ),
                      ),
                    t('access.users.statusChangeFailed'),
                  );
                }
              }}
            >
              {user.isActive ? t('access.users.deactivate') : t('access.users.activate')}
            </Button>
            <Button
              variant="secondary"
              icon="edit"
              onClick={() => {
                onEdit(user);
              }}
            >
              {t('access.users.edit')}
            </Button>
          </>
        )}
      </>
    );
  }

  const dialogs = (
    <>
      {/*
       * "Show this person's password" exists here only on an installation that
       * has deliberately switched the password vault on: `canReveal` is the
       * permission AND the company's own setting, so on a default install this
       * dialog is unreachable and there is nothing stored for it to show.
       *
       * `password_hash` is still a one-way scrypt digest that nothing reverses,
       * the repository still strips it from every `User`, and the type still
       * has no field for it. What the vault holds is a separately sealed copy
       * of the plaintext, in its own table, under a key outside every backup.
       */}
      <Modal
        open={Boolean(revealing)}
        onClose={() => setRevealing(null)}
        title={
          revealing ? t('access.users.revealPasswordTitle', { name: revealing.displayName }) : ''
        }
        subtitle={t('access.users.revealPasswordSubtitle')}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => setRevealing(null)}>
              {t('access.users.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const target = revealing;
                const typed = confirmPassword;
                setRevealing(null);
                setConfirmPassword('');
                if (target) {
                  void onRun(
                    async () => onSecret(await api.revealPassword(target.id, typed)),
                    t('access.users.revealPasswordFailed'),
                  );
                }
              }}
            >
              {t('access.users.reveal')}
            </Button>
          </>
        }
      >
        <FormField
          label={t('access.users.revealPasswordConfirm')}
          hint={t('access.users.revealPasswordConfirmHint')}
        >
          {(id) => (
            <PasswordInput
              id={id}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoFocus
            />
          )}
        </FormField>
      </Modal>

      <Modal
        open={Boolean(settingPassword)}
        onClose={() => setSettingPassword(null)}
        title={
          settingPassword
            ? t('access.users.setPasswordTitle', { name: settingPassword.displayName })
            : ''
        }
        subtitle={t('access.users.setPasswordSubtitle')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                const target = settingPassword;
                setSettingPassword(null);
                if (target) {
                  void onRun(
                    async () =>
                      onSecret(
                        await withKey((token) => api.resetPassword(target.id, undefined, token)),
                      ),
                    t('access.users.resetPasswordFailed'),
                  );
                }
              }}
            >
              {t('access.users.generateInstead')}
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => setSettingPassword(null)}>
              {t('access.users.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={passwordValue.trim().length < 8}
              onClick={() => {
                const target = settingPassword;
                const chosen = passwordValue.trim();
                setSettingPassword(null);
                if (target) {
                  void onRun(
                    async () =>
                      onSecret(
                        await withKey((token) => api.resetPassword(target.id, chosen, token)),
                      ),
                    t('access.users.resetPasswordFailed'),
                  );
                }
              }}
            >
              {t('access.users.setPassword')}
            </Button>
          </>
        }
      >
        <FormField label={t('access.users.newPassword')} hint={t('access.users.newPasswordHint')}>
          {(id) => (
            <PasswordInput initiallyVisible
              id={id}
              value={passwordValue}
              onChange={(event) => setPasswordValue(event.target.value)}
              autoFocus
            />
          )}
        </FormField>
      </Modal>

      <Modal
        open={Boolean(confirmDeactivate)}
        onClose={() => setConfirmDeactivate(null)}
        title={
          confirmDeactivate
            ? t('access.users.deactivateConfirmTitle', { name: confirmDeactivate.displayName })
            : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeactivate(null)}>
              {t('access.users.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmDeactivate;
                setConfirmDeactivate(null);
                if (target) {
                  void onRun(
                    () =>
                      withKey((token) =>
                        api.updateUser(
                          target.id,
                          { isActive: false, expectedVersion: target.sync.version },
                          token,
                        ),
                      ),
                    t('access.users.statusChangeFailed'),
                  );
                }
              }}
            >
              {t('access.users.deactivate')}
            </Button>
          </>
        }
      >
        <p className="ob-body">
          {confirmDeactivate
            ? t('access.users.deactivateConfirmBody', { name: confirmDeactivate.displayName })
            : ''}
        </p>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={
          confirmDelete
            ? t('access.users.deleteConfirmTitle', { name: confirmDelete.displayName })
            : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              {t('access.users.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target)
                  void onRun(
                    () => withKey((token) => api.deleteUser(target.id, token)),
                    t('access.users.deleteFailed'),
                  );
              }}
            >
              {t('access.users.delete')}
            </Button>
          </>
        }
      >
        <p className="ob-body">{confirmDelete ? t('access.users.deleteConfirmBody') : ''}</p>
      </Modal>
    </>
  );

  if (openUser) {
    return (
      <>
        <EditorScreen
          meta={
            <>
              <span className="ob-mono ob-small">{openUser.username}</span>
              <span className="ob-small">{openUser.roleName}</span>
              {isServerMaster(openUser) && <ServerMasterBadge />}
            </>
          }
          actions={renderUserActions(openUser)}
          onBack={() => {
            onOpenUser(null);
            return true;
          }}
          backLabel={t('access.editor.backToList')}
        >
          {renderUserDetail(openUser)}
        </EditorScreen>
        {dialogs}
      </>
    );
  }

  return (
    <Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--s-12)',
        }}
      >
        <h2 className="ob-title" style={{ margin: 0 }}>
          {/* Not "0 people" before the first response — that is a false claim
              about the company, and a worse one than the spinner §7 forbids. */}
          {loading
            ? t('access.users.titleLoading')
            : t('access.users.title', { count: users.length })}
        </h2>
        {canManage && (
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            {t('access.users.add')}
          </Button>
        )}
      </div>

      {adding && (
        <UserForm
          roles={roles}
          actorTier={actorTier}
          onCancel={() => setAdding(false)}
          onCreated={(secret) => {
            setAdding(false);
            onSecret(secret);
          }}
          onRun={onRun}
          withKey={withKey}
        />
      )}

      {loading ? (
        <SkeletonTable columns={columns} />
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(user) => user.id}
          rowHighlight={isServerMaster}
          selectedId={openUserId ?? undefined}
          onRowOpen={(user) => onOpenUser(user.id)}
          empty={
            <EmptyState
              title={users.length === 0 ? t('access.users.empty') : t('access.users.emptyFiltered')}
            />
          }
        />
      )}

      {dialogs}
    </Card>
  );
}

function UserForm({
  roles,
  actorTier,
  onCancel,
  onCreated,
  onRun,
  withKey,
}: {
  roles: Role[];
  actorTier: RoleTier;
  onCancel: () => void;
  onCreated: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
  withKey: WithKey;
}) {
  // G3 in the picker: you cannot mint somebody above yourself. Offering the
  // Administrator role to a management-tier actor and then answering with a 403
  // teaches the tier ceiling by refusal rather than by design.
  const assignable = roles.filter((role) => tierRank(role.tier) <= tierRank(actorTier));

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState(assignable[0]?.id ?? '');

  return (
    <Card className="ob-measure-form" style={{ marginBottom: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-12)' }}>
        <FormField label={t('access.userForm.displayName')} required>
          {(id) => (
            <Input
              id={id}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('access.userForm.username')} required>
          {(id) => (
            <Input
              id={id}
              value={username}
              // Normalised for the uniqueness check, so "Imran" and "imran" are
              // the same person as far as sign-in is concerned.
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
            />
          )}
        </FormField>
        <FormField label={t('access.userForm.role')} required>
          {(id) => (
            <Select id={id} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              {assignable.map((role) => (
                <option key={role.id} value={role.id}>
                  {`${role.name} (${tierLabel(role.tier)})`}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>

      <p className="ob-help" style={{ marginTop: 'var(--s-12)' }}>
        {t('access.userForm.helper')}
      </p>

      <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
        <Button
          variant="primary"
          disabled={!displayName.trim() || !username.trim() || !roleId}
          onClick={() =>
            void onRun(async () => {
              // A new Server Master needs the master key; anyone else does not.
              const { secret } = await withKey((token) =>
                api.createUser({ displayName, username, roleId }, token),
              );
              onCreated(secret);
            }, t('access.userForm.createFailed'))
          }
        >
          {t('access.userForm.create')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('access.userForm.cancel')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The only moment in the product where losing focus loses information, so the
 * dialog says plainly that closing it is irreversible.
 */
function OneTimeSecretDialog({ secret, onClose }: { secret: OneTimeSecret; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('access.secret.title', { username: secret.username })}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => void copyText(secret.password).then(setCopied)}
          >
            {copied ? t('access.secret.copied') : t('access.secret.copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('access.secret.done')}
          </Button>
        </>
      }
    >
      <p className="ob-body">{t('access.secret.helper')}</p>
      <code
        className="ob-mono"
        style={{
          display: 'inline-block',
          fontSize: 'var(--t-title-size)',
          padding: 'var(--s-8) var(--s-12)',
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--r-md)',
        }}
      >
        {secret.password}
      </code>
    </Modal>
  );
}

// --- Roles ----------------------------------------------------------------

function RolesTab({
  roles,
  catalogue,
  canCreate,
  canEdit,
  canDelete,
  loading,
  onEdit,
  onRun,
}: {
  roles: Role[];
  /** Null until the catalogue lands; the summary lists keys ungrouped until then. */
  catalogue: PermissionCatalogue | null;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  loading: boolean;
  /** Opens the role's own editor screen — this tab does not host it. */
  onEdit: (role: Role | 'new') => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);
  /** Which role's detail dialog is open, by id so it re-reads the live row. */
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);

  const columns: DataTableColumn<Role>[] = [
    {
      key: 'name',
      header: t('access.roles.colRole'),
      width: '1fr',
      render: (role) => (
        <span>
          {role.name}
          {role.isSystem && (
            <span style={{ marginLeft: 'var(--s-8)' }}>
              <StatusPill tone="default">{t('access.roles.systemBadge')}</StatusPill>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'tier',
      header: t('access.roles.colTier'),
      width: rem(130),
      render: (role) => <TierPill tier={role.tier} />,
    },
    {
      key: 'permissions',
      header: t('access.roles.colPermissions'),
      priority: 2,
      width: rem(130),
      align: 'right',
      render: (role) => <span className="ob-data">{role.permissions.length}</span>,
    },
    {
      key: 'users',
      header: t('access.roles.colUsers'),
      priority: 3,
      width: rem(100),
      align: 'right',
      render: (role) => <span className="ob-data">{role.userCount}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: rem(110),
      render: (role) => (
        <div
          style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}
        >
          <Button
            variant="secondary"
            size="sm"
            icon="expand"
            onClick={() => setOpenRoleId(role.id)}
          >
            {t('access.roles.open')}
          </Button>
        </div>
      ),
    },
  ];

  const openRole = roles.find((role) => role.id === openRoleId) ?? null;

  /** What one role grants, in full. */
  function renderRoleDetail(role: Role) {
    return (
      <div className="ob-detail">
        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('access.roles.detail.summary')}</div>
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('access.roles.detail.id')}</dt>
              <dd>
                <IdField value={role.id} />
              </dd>
            </div>
            <div>
              <dt>{t('access.roles.colTier')}</dt>
              <dd>
                <TierPill tier={role.tier} />
              </dd>
            </div>
            <div>
              <dt>{t('access.roles.colUsers')}</dt>
              <dd>{role.userCount}</dd>
            </div>
            <div>
              <dt>{t('access.roles.colPermissions')}</dt>
              <dd>{role.permissions.length}</dd>
            </div>
            <div>
              <dt>{t('access.roles.detail.system')}</dt>
              <dd>{role.isSystem ? t('access.roles.detail.yes') : t('access.roles.detail.no')}</dd>
            </div>
            <div>
              <dt>{t('access.roles.detail.created')}</dt>
              <dd>{formatDateTime(role.createdAt)}</dd>
            </div>
            <div>
              <dt>{t('access.roles.detail.updated')}</dt>
              <dd>{formatDateTime(role.updatedAt)}</dd>
            </div>
            <div>
              <dt>{t('access.roles.detail.version')}</dt>
              <dd className="ob-mono">{role.sync.version}</dd>
            </div>
          </dl>
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('access.roles.detail.grants')}</div>
          <PermissionSummary catalogue={catalogue} permissions={role.permissions} />
        </section>
      </div>
    );
  }

  /** The dialog's actions. Destructive first and set apart, then the rest. */
  function renderRoleActions(role: Role) {
    return (
      <>
        {/* Absent on a system role rather than disabled: it can never be
            deleted, so offering the control would be a lie. */}
        {canDelete && !role.isSystem && (
          <Button
            variant="danger"
            disabled={role.userCount > 0}
            title={role.userCount > 0 ? t('access.roles.deleteBlocked') : undefined}
            onClick={() => {
              // One dialog at a time (HIG, Modality).
              setOpenRoleId(null);
              setConfirmDelete(role);
            }}
          >
            {t('access.roles.delete')}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {/* The Server Master role is frozen: it always holds every permission,
            and the server refuses any edit (`assertServerMasterRoleFrozen`). */}
        {canEdit && role.tier !== SERVER_MASTER_TIER && (
          <Button
            variant="secondary"
            icon="edit"
            onClick={() => {
              setOpenRoleId(null);
              onEdit(role);
            }}
          >
            {t('access.roles.edit')}
          </Button>
        )}
        <Button variant="primary" onClick={() => setOpenRoleId(null)}>
          {t('action.done')}
        </Button>
      </>
    );
  }

  return (
    <Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--s-12)',
        }}
      >
        <h2 className="ob-title" style={{ margin: 0 }}>
          {loading
            ? t('access.roles.titleLoading')
            : t('access.roles.title', { count: roles.length })}
        </h2>
        {canCreate && (
          <Button variant="primary" icon="plus" onClick={() => onEdit('new')}>
            {t('access.roles.create')}
          </Button>
        )}
      </div>

      {loading ? (
        <SkeletonTable columns={columns} />
      ) : (
        <DataTable
          columns={columns}
          rows={roles}
          rowKey={(role) => role.id}
          rowHighlight={(role) => role.tier === SERVER_MASTER_TIER}
          selectedId={openRoleId ?? undefined}
          onRowOpen={(role) => setOpenRoleId(role.id)}
          empty={<EmptyState title={t('access.roles.empty')} />}
        />
      )}

      <Modal
        open={Boolean(openRole)}
        onClose={() => setOpenRoleId(null)}
        size="lg"
        title={openRole?.name ?? ''}
        subtitle={
          openRole && (
            <>
              {tierLabel(openRole.tier)}
              {openRole.isSystem ? ` · ${t('access.roles.systemBadge')}` : ''}
              {' · '}
              {t('access.roles.detail.metaCounts', {
                permissions: openRole.permissions.length,
                users: openRole.userCount,
              })}
            </>
          )
        }
        footer={openRole && renderRoleActions(openRole)}
      >
        {openRole && renderRoleDetail(openRole)}
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={
          confirmDelete ? t('access.roles.deleteConfirmTitle', { name: confirmDelete.name }) : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              {t('access.roles.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target)
                  void onRun(() => api.deleteRole(target.id), t('access.roles.deleteFailed'));
              }}
            >
              {t('access.roles.delete')}
            </Button>
          </>
        }
      >
        <p className="ob-body">{confirmDelete ? t('access.roles.deleteConfirmBody') : ''}</p>
      </Modal>
    </Card>
  );
}

/** Reads the role again on open, so the editor works on the current version and not the list row. */
function RoleEditorLoader(props: ComponentProps<typeof RoleEditor>) {
  const roleId = props.role?.id ?? null;
  const [fresh, setFresh] = useState<Role | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!roleId) return;
    let live = true;
    api
      .role(roleId)
      .then((role) => live && setFresh(role))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [roleId]);

  if (roleId && !fresh && !failed) return <SkeletonRows rows={6} columns={6} />;
  return <RoleEditor {...props} role={fresh ?? props.role} />;
}

function RoleEditor({
  catalogue,
  role,
  onCancel,
  onSaved,
  onError,
  registerCancel,
}: {
  catalogue: PermissionCatalogue;
  role: Role | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
  /** Hands the shell this editor's dirty-checking cancel, so navigating out of
   *  the operation through the sidebar asks about an unsaved draft too. */
  registerCancel: (fn: () => boolean) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [tier, setTier] = useState<RoleTier>((role?.tier as RoleTier) ?? 'office');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [pendingTier, setPendingTier] = useState<RoleTier | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    message: string;
    diff: Record<string, FieldDifference>;
  } | null>(null);
  /** What the server says is stored, once a conflict has told us. */
  const [baseVersion, setBaseVersion] = useState<number | undefined>(role?.sync.version);

  // `useCallback` rather than a plain function, because `wouldDrop` below lists
  // it as a dependency: declared in the render body it had a new identity every
  // render, which made that memo recompute every render and defeat itself.
  const rank = useCallback((value: RoleTier) => catalogue.tiers.indexOf(value), [catalogue]);

  /** Keys the draft holds that the *proposed* tier could not. */
  const wouldDrop = useMemo(() => {
    if (!pendingTier) return [];
    return [...selected].filter(
      (key) => rank(pendingTier) < rank(catalogue.minimumTier[key] ?? 'office'),
    );
  }, [pendingTier, selected, catalogue, rank]);

  // Save stays disabled until the draft actually differs — and the array is
  // compared sorted, so a reorder is not a change.
  const dirty =
    !role ||
    name !== role.name ||
    tier !== role.tier ||
    [...selected].sort().join(',') !== [...role.permissions].sort().join(',');

  /**
   * Cancel, checking first when there is something to lose. Returns whether the
   * editor actually closed, so a caller that was on its way somewhere else —
   * the sidebar, navigating to another module — can stay put when the operator
   * decides to keep the draft.
   */
  const cancel = useCallback((): boolean => {
    if (dirty && !confirm(t('access.roleEditor.discardConfirm'))) return false;
    onCancel();
    return true;
  }, [dirty, onCancel]);

  useEffect(() => {
    registerCancel(cancel);
  }, [cancel, registerCancel]);

  function toggle(key: string, next: boolean): void {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }

  function toggleMany(keys: string[], next: boolean): void {
    setSelected((current) => {
      const copy = new Set(current);
      for (const key of keys) {
        if (next) copy.add(key);
        else copy.delete(key);
      }
      return copy;
    });
  }

  async function save(overwrite = false): Promise<void> {
    setBusy(true);
    setFailure(null);
    setConflict(null);

    try {
      const input = {
        name: name.trim(),
        tier,
        permissions: [...selected].sort(),
        // On an explicit Overwrite, re-base on what the server actually holds.
        // Never automatic: taking the other administrator's version silently is
        // how their work disappears without anybody being told.
        expectedVersion: overwrite ? baseVersion : role?.sync.version,
      };

      if (role) await api.updateRole(role.id, input);
      else await api.createRole(input);

      onSaved();
    } catch (caught) {
      // Reported *here*, in the editor. This used to call `onError`, which set
      // state that only the list branch renders — so with the editor open every
      // failure, from a stale version to a permission denial, looked exactly
      // like the Save button doing nothing at all.
      if (caught instanceof ApiError && caught.isConflict && caught.storedVersion !== undefined) {
        setBaseVersion(caught.storedVersion);
        setConflict({ message: caught.message, diff: caught.diff });
      } else {
        const message =
          caught instanceof Error ? caught.message : t('access.roleEditor.saveFailedDefault');
        setFailure(message);
        onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {failure && (
        <div className="ob-banner ob-banner--conflict" role="alert">
          {failure}
        </div>
      )}

      {conflict && (
        <ConflictBanner
          action={
            <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
              {/* Reload discards this draft for theirs; Overwrite keeps this
                  draft and re-bases on their version. Nothing is applied
                  automatically — auto-overwriting loses whatever they just
                  did, silently. */}
              <Button variant="secondary" size="sm" onClick={onCancel}>
                {t('access.roleEditor.reloadTheirs')}
              </Button>
              <Button size="sm" onClick={() => void save(true)} disabled={busy}>
                {t('access.roleEditor.overwriteMine')}
              </Button>
            </div>
          }
        >
          <strong>{conflict.message}</strong>
          {Object.keys(conflict.diff).length > 0 && (
            <ul style={{ margin: 'var(--s-8) 0 0', paddingLeft: 'var(--s-20)' }}>
              {Object.entries(conflict.diff).map(([field, difference]) => (
                <li key={field}>
                  <strong>{humaniseField(field)}</strong>: {t('access.roleEditor.theirs')}{' '}
                  <code>{describeValue(difference.stored)}</code>, {t('access.roleEditor.yours')}{' '}
                  <code>{describeValue(difference.incoming)}</code>
                </li>
              ))}
            </ul>
          )}
        </ConflictBanner>
      )}

      <Card className="ob-measure-form">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
          <FormField label={t('access.roleEditor.nameLabel')}>
            {(id) => (
              <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </FormField>

          <FormField label={t('access.roleEditor.tierLabel')}>
            {(id) => (
              <Select
                id={id}
                value={tier}
                disabled={role?.isSystem}
                title={role?.isSystem ? t('access.roleEditor.tierLocked') : undefined}
                onChange={(event) => {
                  const next = event.target.value as RoleTier;
                  // Lowering the tier never silently drops keys — it asks first.
                  if (rank(next) < rank(tier)) setPendingTier(next);
                  else setTier(next);
                }}
              >
                {/* Server Master is never offered: that tier belongs to the one
                    frozen system role (`assertTierAssignable`). */}
                {catalogue.tiers
                  .filter((value) => value !== SERVER_MASTER_TIER)
                  .map((value) => (
                    <option key={value} value={value}>
                      {tierLabel(value)}
                    </option>
                  ))}
              </Select>
            )}
          </FormField>
        </div>

        {pendingTier && (
          <div style={{ marginTop: 'var(--s-16)' }}>
            <OfflineBanner
              action={
                <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
                  <Button variant="secondary" size="sm" onClick={() => setPendingTier(null)}>
                    {t('access.roleEditor.keepTier', { tier: tierLabel(tier) })}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelected((current) => {
                        const copy = new Set(current);
                        for (const key of wouldDrop) copy.delete(key);
                        return copy;
                      });
                      setTier(pendingTier);
                      setPendingTier(null);
                    }}
                  >
                    {t('access.roleEditor.changeTier', { tier: tierLabel(pendingTier) })}
                  </Button>
                </div>
              }
            >
              <strong>
                {t('access.roleEditor.pendingWarning', {
                  tier: tierLabel(pendingTier),
                  count: wouldDrop.length,
                  plural: wouldDrop.length === 1 ? '' : 's',
                })}
              </strong>
              <ul style={{ margin: 'var(--s-6) 0 0', paddingLeft: 'var(--s-20)' }}>
                {wouldDrop.map((key) => (
                  <li key={key}>
                    <code>{key}</code>
                  </li>
                ))}
              </ul>
            </OfflineBanner>
          </div>
        )}
      </Card>

      <Card>
        <PermissionGrid
          catalogue={catalogue}
          tier={tier}
          selected={selected}
          disabled={busy}
          onToggle={toggle}
          onToggleMany={toggleMany}
        />
      </Card>

      <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
        <Button
          variant="primary"
          disabled={busy || !dirty || !name.trim()}
          onClick={() => void save()}
        >
          {busy ? t('access.roleEditor.saving') : t('access.roleEditor.save')}
        </Button>
        <Button variant="secondary" onClick={() => cancel()}>
          {t('access.roleEditor.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** `permissions` -> `Permissions`, for a conflict list a person has to read. */
function humaniseField(field: string): string {
  const spaced = field.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A conflicting value, short enough to sit in a list item.
 *
 * A permission array is the interesting case and also the longest: showing all
 * sixty keys would bury the one that differs, so it is summarised by count.
 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? t('access.roleEditor.diffNone')
      : t('access.roleEditor.diffPermissionsCount', {
          count: value.length,
          plural: value.length === 1 ? '' : 's',
        });
  }
  if (value === null || value === undefined) return t('access.roleEditor.diffNotSet');
  return String(value);
}

/**
 * Deleted roles and users, and the way back.
 *
 * Collapsed by default and only fetched when opened: the common case is that
 * nothing has been deleted, and a permanent empty panel above the list would be
 * noise on every visit. Restoring a role reattaches everybody who still points
 * at it, which is why `users.role_id` deliberately carries no SQL foreign key.
 */
function RecycleBin({
  canRestoreRoles,
  canRestoreUsers,
  onRun,
}: {
  canRestoreRoles: boolean;
  canRestoreUsers: boolean;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Kept local rather than raised through `onRun`: `run` is redefined on every
  // AccessScreen render, so depending on it here would re-fire the fetch in a
  // loop.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRoles, nextUsers] = await Promise.all([
        canRestoreRoles ? api.deletedRoles() : Promise.resolve([]),
        canRestoreUsers ? api.deletedUsers() : Promise.resolve([]),
      ]);
      setRoles(nextRoles);
      setUsers(nextUsers);
      setFailure(null);
    } catch (caught) {
      // A dropped rejection left the lists at [] and the one panel whose whole
      // purpose is recovery then stated that nothing had been deleted.
      setFailure(caught instanceof Error ? caught.message : t('access.recycleBin.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [canRestoreRoles, canRestoreUsers]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const total = roles.length + users.length;

  return (
    <Card>
      <Button variant="secondary" onClick={() => setOpen((current) => !current)}>
        {open ? t('access.recycleBin.hide') : t('access.recycleBin.show')}
        {open && total > 0 ? ` (${total})` : ''}
      </Button>

      {open && (
        <div style={{ marginTop: 'var(--s-12)' }}>
          {loading ? (
            <p className="ob-small">{t('access.recycleBin.loading')}</p>
          ) : failure ? (
            <div className="ob-banner ob-banner--conflict" role="alert">
              {failure}
            </div>
          ) : total === 0 ? (
            <p className="ob-small">{t('access.recycleBin.empty')}</p>
          ) : (
            <ul
              style={{
                margin: 0,
                paddingLeft: 'var(--s-20)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-6)',
              }}
            >
              {roles.map((role) => (
                <li key={role.id}>
                  <span className="ob-body-strong">{role.name}</span>{' '}
                  <span className="ob-small">
                    {t('access.recycleBin.roleMeta', { tier: tierLabel(role.tier) })}
                  </span>{' '}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void onRun(async () => {
                        await api.restoreRole(role.id);
                        await load();
                      }, t('access.recycleBin.restoreRoleFailed'))
                    }
                  >
                    {t('access.recycleBin.restore')}
                  </Button>
                </li>
              ))}
              {users.map((user) => (
                <li key={user.id}>
                  <span className="ob-body-strong">{user.displayName}</span>{' '}
                  <span className="ob-small">
                    {t('access.recycleBin.userMeta', { username: user.username })}
                  </span>{' '}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void onRun(async () => {
                        await api.restoreUser(user.id);
                        await load();
                      }, t('access.recycleBin.restoreUserFailed'))
                    }
                  >
                    {t('access.recycleBin.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Edit a person's display name and username.
 *
 * `updateUser` has always implemented, validated and audited both, and no screen
 * called it — so a mistyped username was permanent in the product, fixable only
 * by deleting the person and creating them again.
 */
function UserEditForm({
  user,
  onCancel,
  onSaved,
  onRun,
  withKey,
}: {
  user: User;
  onCancel: () => void;
  onSaved: () => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
  withKey: WithKey;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);

  const dirty = displayName.trim() !== user.displayName || username.trim() !== user.username;

  return (
    <Card className="ob-measure-form" style={{ marginBottom: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
        <FormField label={t('access.userEdit.displayName')}>
          {(id) => (
            <Input
              id={id}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('access.userEdit.username')}>
          {(id) => (
            <Input
              id={id}
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
            />
          )}
        </FormField>
      </div>

      <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)' }}>
        <Button
          variant="primary"
          disabled={!dirty || !displayName.trim() || !username.trim()}
          onClick={() =>
            void onRun(async () => {
              // Renaming a Server Master's username needs the master key.
              await withKey((token) =>
                api.updateUser(
                  user.id,
                  {
                    displayName: displayName.trim(),
                    username: username.trim(),
                    expectedVersion: user.sync.version,
                  },
                  token,
                ),
              );
              onSaved();
            }, t('access.userEdit.saveFailed'))
          }
        >
          {t('access.userEdit.save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('access.userEdit.cancel')}
        </Button>
      </div>
    </Card>
  );
}
