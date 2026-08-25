/**
 * Roles & Users — one screen, two tabs (docs/ROLES_AND_USERS.md UI §3–§5).
 *
 * Hiding a control here is a courtesy: every action is refused again by the
 * server without the permission. The distinction the UI does have to get right
 * is *hidden* versus *disabled* — a control the caller can never have is absent
 * (a disabled one would be a permanent tease), while a control blocked by a
 * changeable state is disabled with the reason attached.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { OneTimeSecret, PermissionCatalogue, Role, RoleTier, User } from '@orderbook/shared';

import { api, ApiError, type FieldDifference } from '../api';
import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { IdField, StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { FilterChip, FilterDivider } from '../ui/FilterBar';
import { useFilterBar } from '../ui/FilterBarSlot';
import { FormField, Input, Select } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { PermissionGrid } from '../ui/PermissionGrid';
import { PermissionSummary } from '../ui/PermissionSummary';
import { useSubNav } from '../ui/SubNavSlot';
import { ConflictBanner, EmptyState, OfflineBanner, SkeletonRows } from '../ui/States';
import { Tabs, type TabItem } from '../ui/Tabs';

interface Props {
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  currentUserId: string;
  /** The caller's own tier. A picker must never offer a role above it. */
  currentUserTier: RoleTier;
}

type Tab = 'users' | 'roles';

export function AccessScreen({ permissions, currentUserId, currentUserTier }: Props) {
  const [tab, setTab] = useState<Tab>('users');
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
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
      setError(caught instanceof Error ? caught.message : 'Could not load');
    } finally {
      // Until this flips, the tables render skeletons. Without it the first
      // paint said "0 people" and "Nobody here yet." — a statement about the
      // company that happened to be false.
      setLoading(false);
    }
  }, [can]);

  useEffect(() => {
    void api.permissionCatalogue().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const tabItems: TabItem[] = [
    ...(can('users.manage') ? [{ id: 'users', label: t('access.tab.users') }] : []),
    ...(can('roles.view') ? [{ id: 'roles', label: t('access.tab.roles') }] : []),
  ];

  // `tab` is a preference, not a guarantee: a caller without `users.manage` has
  // no Users tab to select, and honouring the preference anyway showed them an
  // empty roster — "0 people" — with the roles list they came for unrendered
  // behind a tab that read as unselected.
  const active: Tab = tabItems.some((item) => item.id === tab) ? tab : 'roles';

  // Editing a role means a ten-by-six matrix plus two capability groups; it is
  // a screen, not a panel, so it takes the content area and says where it is in
  // the sidebar. Editing a person is a smaller form but the same idea, and the
  // two are mutually exclusive.
  const roleEditorOpen = editing !== null;
  const userEditorOpen = editingUser !== null;

  useSubNav(
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
          onExit: () => editorCloseRef.current(),
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
            onExit: () => {
              setEditingUser(null);
              return true;
            },
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
              <StatusPill tone={editing.tier === 'admin' ? 'conflict' : editing.tier === 'management' ? 'accent' : 'default'}>
                {editing.tier}
              </StatusPill>
              {editing.isSystem && <StatusPill tone="default">{t('access.roles.systemBadge')}</StatusPill>}
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
          <RoleEditor
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
              {editingUser.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
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
        />
      </EditorScreen>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('access.title')}
        </h1>
        <Tabs tabs={tabItems} activeId={active} onChange={(id) => setTab(id as Tab)} />
      </div>

      {error && (
        <div className="ob-banner ob-banner--conflict" role="alert">
          {error}
        </div>
      )}

      {secret && <OneTimeSecretDialog secret={secret} onClose={() => setSecret(null)} />}

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
          currentUserId={currentUserId}
          actorTier={currentUserTier}
          loading={loading}
          onEdit={setEditingUser}
          onSecret={setSecret}
          onRun={run}
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

/**
 * The frame a large operation runs inside: who you are editing, what they are,
 * and one way back that is always in the same place. The sidebar entry says
 * where you are; this says what you are looking at.
 */
function EditorScreen({
  title,
  meta,
  onBack,
  backLabel,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /** Returns false when the operation refused to close — an unsaved draft. */
  onBack: () => boolean;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="ob-editorscreen">
      <header className="ob-editorscreen-head">
        <Button variant="ghost" size="sm" icon="collapse" onClick={() => onBack()}>
          {backLabel}
        </Button>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {title}
        </h1>
        {meta && <div className="ob-editorscreen-meta">{meta}</div>}
      </header>
      <div className="ob-editorscreen-body">{children}</div>
    </div>
  );
}

// --- Users ----------------------------------------------------------------

function UsersTab({
  users,
  roles,
  canManage,
  canAssign,
  currentUserId,
  actorTier,
  loading,
  onEdit,
  onSecret,
  onRun,
}: {
  users: User[];
  roles: Role[];
  canManage: boolean;
  canAssign: boolean;
  currentUserId: string;
  /** The caller's own tier, so the role picker cannot offer one above it. */
  actorTier: RoleTier;
  loading: boolean;
  /** Opens the person's own editor screen — this tab does not host it. */
  onEdit: (user: User) => void;
  onSecret: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [sort, setSort] = useState<'created' | 'name' | 'role' | 'lastSignIn'>('created');
  const [confirmDeactivate, setConfirmDeactivate] = useState<User | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);
  /** Which person's detail band is open. */
  const [openUserId, setOpenUserId] = useState<string | null>(null);

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
  const activeAdmins = users.filter(
    (user) => user.isActive && !user.deletedAt && user.roleTier === 'admin',
  );

  function lastAdminReason(user: User): string | undefined {
    if (user.roleTier !== 'admin' || !user.isActive) return undefined;
    return activeAdmins.length <= 1 ? t('access.users.lastAdminReason') : undefined;
  }

  useFilterBar(
    !loading && users.length > 0 ? (
      <>
        <div className="ob-search">
          <Input
            aria-label={t('access.users.searchLabel')}
            placeholder={t('access.users.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <FilterDivider />
        <Select
          aria-label={t('access.users.filterRoleLabel')}
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
          style={{ width: 160 }}
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
          onClick={() => setStatusFilter((current) => (current === 'inactive' ? 'all' : 'inactive'))}
        >
          {t('access.users.filterStatusInactive')}
        </FilterChip>
        <FilterDivider />
        <Select
          aria-label={t('access.users.sortLabel')}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          style={{ width: 150 }}
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
      render: (user) => <span>{user.displayName}</span>,
    },
    {
      key: 'username',
      header: t('access.users.colUsername'),
      width: '150px',
      render: (user) => <span className="ob-small">{user.username}</span>,
    },
    {
      key: 'id',
      header: t('access.users.colId'),
      width: '180px',
      render: (user) => <IdField value={user.id} />,
    },
    {
      key: 'role',
      header: t('access.users.colRole'),
      width: '180px',
      render: (user) =>
        canAssign ? (
          <Select
            value={user.roleId ?? ''}
            onChange={(event) =>
              void onRun(
                () =>
                  api.updateUser(user.id, {
                    roleId: event.target.value,
                    // Without this the save is last-write-wins: two
                    // administrators reassigning the same person
                    // would both "succeed" and one would silently
                    // lose.
                    expectedVersion: user.sync.version,
                  }),
                t('access.users.roleChangeFailed'),
              )
            }
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        ) : (
          // Read-only label when the caller cannot assign roles.
          <span>{user.roleName}</span>
        ),
    },
    {
      key: 'status',
      header: t('access.users.colStatus'),
      width: '110px',
      render: (user) => (
        <StatusPill tone={user.isActive ? 'ok' : 'default'}>
          {user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
        </StatusPill>
      ),
    },
    {
      key: 'lastSignIn',
      header: t('access.users.colLastSignIn'),
      width: '160px',
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
      width: '110px',
      render: (user) => {
        const open = openUserId === user.id;
        return (
          <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
            <Button
              variant="secondary"
              size="sm"
              icon={open ? 'collapse' : 'expand'}
              aria-expanded={open}
              onClick={() => setOpenUserId(open ? null : user.id)}
            >
              {open ? t('access.users.close') : t('access.users.open')}
            </Button>
          </div>
        );
      },
    },
  ];

  /** The band under an opened person — the facts, and what can be done to them. */
  function renderUserDetail(user: User) {
    const blocked = lastAdminReason(user);
    return (
      <div className="ob-detail">
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
          <dl className="ob-detail-grid">
            <div>
              <dt>{t('access.users.colRole')}</dt>
              <dd>{user.roleName}</dd>
            </div>
            <div>
              <dt>{t('access.roles.colTier')}</dt>
              <dd>{user.roleTier}</dd>
            </div>
            <div>
              <dt>{t('access.users.colStatus')}</dt>
              <dd>{user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}</dd>
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

        {canManage && (
          <div className="ob-detail-actions">
            <Button variant="secondary" size="sm" icon="edit" onClick={() => onEdit(user)}>
              {t('access.users.edit')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void onRun(
                  async () => onSecret(await api.resetPassword(user.id)),
                  t('access.users.resetPasswordFailed'),
                )
              }
            >
              {t('access.users.resetPassword')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(blocked)}
              title={blocked}
              onClick={() => {
                // Deactivation is not a delete, and the difference is
                // load-bearing enough that §4.2 asks for it to be spelled out
                // at the moment somebody acts — not discovered afterwards.
                // Only deactivating asks first; reactivating never needs a
                // confirmation.
                if (user.isActive) setConfirmDeactivate(user);
                else
                  void onRun(
                    () =>
                      api.updateUser(user.id, {
                        isActive: true,
                        expectedVersion: user.sync.version,
                      }),
                    t('access.users.statusChangeFailed'),
                  );
              }}
            >
              {user.isActive ? t('access.users.deactivate') : t('access.users.activate')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={Boolean(blocked) || user.id === currentUserId}
              title={blocked ?? (user.id === currentUserId ? t('access.users.thisIsYou') : undefined)}
              onClick={() => setConfirmDelete(user)}
            >
              {t('access.users.delete')}
            </Button>
          </div>
        )}
      </div>
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
          {loading ? t('access.users.titleLoading') : t('access.users.title', { count: users.length })}
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
        />
      )}

      {loading ? (
        <SkeletonRows columns={6} />
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(user) => user.id}
          expandedId={openUserId}
          renderDetail={renderUserDetail}
          onRowOpen={(user) => setOpenUserId((current) => (current === user.id ? null : user.id))}
          empty={
            <EmptyState
              title={users.length === 0 ? t('access.users.empty') : t('access.users.emptyFiltered')}
            />
          }
        />
      )}

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
                      api.updateUser(target.id, {
                        isActive: false,
                        expectedVersion: target.sync.version,
                      }),
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
        title={confirmDelete ? t('access.users.deleteConfirmTitle', { name: confirmDelete.displayName }) : ''}
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
                if (target) void onRun(() => api.deleteUser(target.id), t('access.users.deleteFailed'));
              }}
            >
              {t('access.users.delete')}
            </Button>
          </>
        }
      >
        <p className="ob-body">{confirmDelete ? t('access.users.deleteConfirmBody') : ''}</p>
      </Modal>
    </Card>
  );
}

function UserForm({
  roles,
  actorTier,
  onCancel,
  onCreated,
  onRun,
}: {
  roles: Role[];
  actorTier: RoleTier;
  onCancel: () => void;
  onCreated: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  // G3 in the picker: you cannot mint somebody above yourself. Offering the
  // Administrator role to a management-tier actor and then answering with a 403
  // teaches the tier ceiling by refusal rather than by design.
  const assignable = roles.filter((role) => TIER_RANK[role.tier] <= TIER_RANK[actorTier]);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState(assignable[0]?.id ?? '');

  return (
    <Card className="ob-measure-form" style={{ marginBottom: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-12)' }}>
        <FormField label={t('access.userForm.displayName')} required>
          {(id) => (
            <Input id={id} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
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
                  {role.name} ({role.tier})
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
              const { secret } = await api.createUser({ displayName, username, roleId });
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
function OneTimeSecretDialog({
  secret,
  onClose,
}: {
  secret: OneTimeSecret;
  onClose: () => void;
}) {
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
            onClick={() => {
              void navigator.clipboard?.writeText(secret.password);
              setCopied(true);
            }}
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
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);

  const tierTone = (tier: RoleTier | Role['tier']): 'conflict' | 'accent' | 'default' =>
    tier === 'admin' ? 'conflict' : tier === 'management' ? 'accent' : 'default';

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
      width: '130px',
      render: (role) => <StatusPill tone={tierTone(role.tier)}>{role.tier}</StatusPill>,
    },
    {
      key: 'permissions',
      header: t('access.roles.colPermissions'),
      width: '130px',
      align: 'right',
      render: (role) => <span className="ob-data">{role.permissions.length}</span>,
    },
    {
      key: 'users',
      header: t('access.roles.colUsers'),
      width: '100px',
      align: 'right',
      render: (role) => <span className="ob-data">{role.userCount}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '110px',
      render: (role) => {
        const open = openRoleId === role.id;
        return (
          <div style={{ display: 'flex', gap: 'var(--s-6)', justifyContent: 'flex-end', width: '100%' }}>
            <Button
              variant="secondary"
              size="sm"
              icon={open ? 'collapse' : 'expand'}
              aria-expanded={open}
              onClick={() => setOpenRoleId(open ? null : role.id)}
            >
              {open ? t('access.roles.close') : t('access.roles.open')}
            </Button>
          </div>
        );
      },
    },
  ];

  /** The band under an opened role — what it grants, and what can be done to it. */
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
              <dd>{role.tier}</dd>
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

        {(canEdit || (canDelete && !role.isSystem)) && (
          <div className="ob-detail-actions">
            {canEdit && (
              <Button variant="secondary" size="sm" icon="edit" onClick={() => onEdit(role)}>
                {t('access.roles.edit')}
              </Button>
            )}
            {/* Absent on a system role rather than disabled: it can never be
                deleted, so offering the control would be a lie. */}
            {canDelete && !role.isSystem && (
              <Button
                variant="danger"
                size="sm"
                disabled={role.userCount > 0}
                title={role.userCount > 0 ? t('access.roles.deleteBlocked') : undefined}
                onClick={() => setConfirmDelete(role)}
              >
                {t('access.roles.delete')}
              </Button>
            )}
          </div>
        )}
      </div>
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
          {loading ? t('access.roles.titleLoading') : t('access.roles.title', { count: roles.length })}
        </h2>
        {canCreate && (
          <Button variant="primary" icon="plus" onClick={() => onEdit('new')}>
            {t('access.roles.create')}
          </Button>
        )}
      </div>

      {loading ? (
        <SkeletonRows columns={5} />
      ) : (
        <DataTable
          columns={columns}
          rows={roles}
          rowKey={(role) => role.id}
          expandedId={openRoleId}
          renderDetail={renderRoleDetail}
          onRowOpen={(role) => setOpenRoleId((current) => (current === role.id ? null : role.id))}
          empty={<EmptyState title={t('access.roles.empty')} />}
        />
      )}

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={confirmDelete ? t('access.roles.deleteConfirmTitle', { name: confirmDelete.name }) : ''}
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
                if (target) void onRun(() => api.deleteRole(target.id), t('access.roles.deleteFailed'));
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

  const rank = (value: RoleTier) => catalogue.tiers.indexOf(value);

  /** Keys the draft holds that the *proposed* tier could not. */
  const wouldDrop = useMemo(() => {
    if (!pendingTier) return [];
    return [...selected].filter(
      (key) => rank(pendingTier) < rank(catalogue.minimumTier[key] ?? 'office'),
    );
  }, [pendingTier, selected, catalogue]);

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
        const message = caught instanceof Error ? caught.message : t('access.roleEditor.saveFailedDefault');
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
            {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
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
                {catalogue.tiers.map((value) => (
                  <option key={value} value={value}>
                    {value}
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
                    {t('access.roleEditor.keepTier', { tier })}
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
                    {t('access.roleEditor.changeTier', { tier: pendingTier })}
                  </Button>
                </div>
              }
            >
              <strong>
                {t('access.roleEditor.pendingWarning', {
                  tier: pendingTier,
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
        <Button variant="primary" disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>
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
      setFailure(caught instanceof Error ? caught.message : 'Could not load');
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
                  <span className="ob-small">{t('access.recycleBin.roleMeta', { tier: role.tier })}</span>{' '}
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
                  <span className="ob-small">{t('access.recycleBin.userMeta', { username: user.username })}</span>{' '}
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

/** Tier ordering, for filtering a picker to what the actor may hand out. */
const TIER_RANK: Record<RoleTier, number> = { office: 1, management: 2, admin: 3 };

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
}: {
  user: User;
  onCancel: () => void;
  onSaved: () => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);

  const dirty = displayName.trim() !== user.displayName || username.trim() !== user.username;

  return (
    <Card className="ob-measure-form" style={{ marginBottom: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-12)' }}>
        <FormField label={t('access.userEdit.displayName')}>
          {(id) => (
            <Input id={id} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
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
              await api.updateUser(user.id, {
                displayName: displayName.trim(),
                username: username.trim(),
                expectedVersion: user.sync.version,
              });
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
