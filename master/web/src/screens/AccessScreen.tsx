/**
 * Roles & Users — one screen, two tabs (docs/ROLES_AND_USERS.md UI §3–§5).
 *
 * Hiding a control here is a courtesy: every action is refused again by the
 * server without the permission. The distinction the UI does have to get right
 * is *hidden* versus *disabled* — a control the caller can never have is absent
 * (a disabled one would be a permanent tease), while a control blocked by a
 * changeable state is disabled with the reason attached.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OneTimeSecret, PermissionCatalogue, Role, RoleTier, User } from '@orderbook/shared';

import { api, ApiError, type FieldDifference } from '../api';
import { Field } from '../components/Field';
import { PermissionGrid } from '../components/PermissionGrid';
import { formatDateTime } from '../format';

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
  const [loading, setLoading] = useState(true);

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

  if (editing && catalogue) {
    return (
      <RoleEditor
        catalogue={catalogue}
        role={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
        onError={setError}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ marginBottom: 0 }}>Roles &amp; Users</h2>
        <nav className="row">
          {can('users.manage') && (
            <button className={tab === 'users' ? '' : 'secondary'} onClick={() => setTab('users')}>
              Users
            </button>
          )}
          {can('roles.view') && (
            <button className={tab === 'roles' ? '' : 'secondary'} onClick={() => setTab('roles')}>
              Roles
            </button>
          )}
        </nav>
      </div>

      {error && (
        <div className="error" role="alert">
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

      {tab === 'users' ? (
        <UsersTab
          users={users}
          roles={roles}
          canManage={can('users.manage')}
          canAssign={can('roles.assign')}
          currentUserId={currentUserId}
          actorTier={currentUserTier}
          loading={loading}
          onSecret={setSecret}
          onRun={run}
        />
      ) : (
        <RolesTab
          roles={roles}
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
  currentUserId,
  actorTier,
  loading,
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
  onSecret: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [sort, setSort] = useState<'created' | 'name' | 'role' | 'lastSignIn'>('created');

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
    return activeAdmins.length <= 1
      ? 'At least one active administrator must remain'
      : undefined;
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>
          {/* Not "0 people" before the first response — that is a false claim
              about the company, and a worse one than the spinner §7 forbids. */}
          {loading ? 'People' : `${users.length} people`}
        </h3>
        {canManage && <button onClick={() => setAdding(true)}>+ Add user</button>}
      </div>

      {!loading && users.length > 0 && (
        <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input
            placeholder="Search name or username…"
            aria-label="Search people"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter by role"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
          >
            <option value="">All roles</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            aria-label="Sort by"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="created">Creation order</option>
            <option value="name">Name</option>
            <option value="role">Role</option>
            <option value="lastSignIn">Last sign-in</option>
          </select>
        </div>
      )}

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

      {editing && (
        <UserEditForm
          user={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
          onRun={onRun}
        />
      )}

      {loading ? (
        <SkeletonRows columns={6} />
      ) : users.length === 0 ? (
        <p className="muted">Nobody here yet.</p>
      ) : visible.length === 0 ? (
        <p className="muted">Nobody matches those filters.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((user) => {
              const blocked = lastAdminReason(user);

              return (
                <tr key={user.id}>
                  <td>{user.displayName}</td>
                  <td className="muted">{user.username}</td>
                  <td>
                    {canAssign ? (
                      <select
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
                            'Could not change the role',
                          )
                        }
                      >
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      // Read-only label when the caller cannot assign roles.
                      <span>{user.roleName}</span>
                    )}
                  </td>
                  <td>
                    <span className={`dot ${user.isActive ? 'on' : 'off'}`} />
                    {user.isActive ? 'Active' : 'Inactive'}
                  </td>
                  <td className="muted">{formatDateTime(user.lastSignInAt)}</td>
                  <td>
                    {canManage && (
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="secondary" onClick={() => setEditing(user)}>
                          Edit
                        </button>
                        <button
                          className="secondary"
                          onClick={() =>
                            void onRun(
                              async () => onSecret(await api.resetPassword(user.id)),
                              'Could not reset the password',
                            )
                          }
                        >
                          Reset password
                        </button>
                        <button
                          className="secondary"
                          disabled={Boolean(blocked)}
                          title={blocked}
                          onClick={() => {
                            // Deactivation is not a delete, and the difference
                            // is load-bearing enough that §4.2 asks for it to be
                            // spelled out at the moment somebody acts — not
                            // discovered afterwards.
                            if (
                              user.isActive &&
                              !confirm(
                                `${user.displayName} will not be able to sign in.\n\n` +
                                  'Their leads, orders and audit history are unchanged. This is ' +
                                  'not a delete — use Delete to send them to the Recycle Bin.',
                              )
                            ) {
                              return;
                            }

                            void onRun(
                              () =>
                                api.updateUser(user.id, {
                                  isActive: !user.isActive,
                                  expectedVersion: user.sync.version,
                                }),
                              'Could not change the status',
                            );
                          }}
                        >
                          {user.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="danger"
                          disabled={Boolean(blocked) || user.id === currentUserId}
                          title={blocked ?? (user.id === currentUserId ? 'This is you' : undefined)}
                          onClick={() => {
                            if (
                              !confirm(
                                `Delete ${user.displayName}?\n\n` +
                                  'They go to the Recycle Bin and can be restored. Their records ' +
                                  'and audit history stay exactly as they are.',
                              )
                            ) {
                              return;
                            }

                            void onRun(() => api.deleteUser(user.id), 'Could not delete');
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
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
    <div className="line-card">
      <div className="line-grid">
        <Field label="Display name *">
          {(id) => (
            <input
              id={id}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Username *">
          {(id) => (
            <input
              id={id}
              value={username}
              // Normalised for the uniqueness check, so "Imran" and "imran" are
              // the same person as far as sign-in is concerned.
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
            />
          )}
        </Field>
        <Field label="Role *">
          {(id) => (
            <select id={id} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              {assignable.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} ({role.tier})
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        A temporary password is generated and shown once. There is no way to see it again.
      </p>

      <div className="row" style={{ gap: 8 }}>
        <button
          disabled={!displayName.trim() || !username.trim() || !roleId}
          onClick={() =>
            void onRun(async () => {
              const { secret } = await api.createUser({ displayName, username, roleId });
              onCreated(secret);
            }, 'Could not create the user')
          }
        >
          Create user
        </button>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
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
    <div className="card" style={{ borderColor: 'var(--accent)' }} role="dialog" aria-modal="true">
      <h3 style={{ marginTop: 0 }}>Temporary password for {secret.username}</h3>

      <p className="muted" style={{ marginTop: 0 }}>
        Copy this now and hand it over. It cannot be shown again — recovery is another reset.
      </p>

      <div className="row" style={{ gap: 8 }}>
        <code style={{ fontSize: 20, padding: '8px 12px', background: '#eef2f6', borderRadius: 6 }}>
          {secret.password}
        </code>
        <button
          className="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(secret.password);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// --- Roles ----------------------------------------------------------------

function RolesTab({
  roles,
  canCreate,
  canEdit,
  canDelete,
  loading,
  onEdit,
  onRun,
}: {
  roles: Role[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  loading: boolean;
  onEdit: (role: Role | 'new') => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{loading ? 'Roles' : `${roles.length} roles`}</h3>
        {canCreate && <button onClick={() => onEdit('new')}>+ Create role</button>}
      </div>

      {loading && <SkeletonRows columns={5} />}

      {!loading && roles.length === 0 && (
        <p className="muted">
          No roles yet. The Administrator role was created with this company.
        </p>
      )}

      <table hidden={loading || roles.length === 0}>
        <thead>
          <tr>
            <th>Role</th>
            <th>Tier</th>
            <th className="right">Permissions</th>
            <th className="right">Users</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id}>
              <td>
                {role.name}
                {role.isSystem && (
                  <span className="chip" style={{ marginLeft: 8 }}>
                    system
                  </span>
                )}
              </td>
              <td>{role.tier}</td>
              <td className="right num">{role.permissions.length}</td>
              <td className="right num">{role.userCount}</td>
              <td>
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {canEdit && (
                    <button className="secondary" onClick={() => onEdit(role)}>
                      Edit
                    </button>
                  )}
                  {/* Absent on a system role rather than disabled: it can never
                      be deleted, so offering the control would be a lie. */}
                  {canDelete && !role.isSystem && (
                    <button
                      className="danger"
                      disabled={role.userCount > 0}
                      title={
                        role.userCount > 0
                          ? 'Still assigned to somebody — move them first'
                          : undefined
                      }
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete the "${role.name}" role?\n\n` +
                              'It goes to the Recycle Bin and can be restored, and anybody who ' +
                              'still holds it reattaches when it comes back.',
                          )
                        ) {
                          return;
                        }

                        void onRun(() => api.deleteRole(role.id), 'Could not delete');
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleEditor({
  catalogue,
  role,
  onCancel,
  onSaved,
  onError,
}: {
  catalogue: PermissionCatalogue;
  role: Role | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
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
   * Cancel, checking first when there is something to lose.
   *
   * `dirty` was already computed for the Save button, so the editor knew the
   * draft was unsaved and discarded it anyway — including on Escape, which §9
   * asks to cancel *with a confirm if dirty*.
   */
  const cancel = useCallback(() => {
    if (dirty && !confirm('Discard your unsaved changes to this role?')) return;
    onCancel();
  }, [dirty, onCancel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancel]);

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
        setFailure(caught instanceof Error ? caught.message : 'Could not save the role');
        onError(caught instanceof Error ? caught.message : 'Could not save the role');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{role ? role.name : 'New role'}</h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={cancel}>
            Cancel
          </button>
          <button disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {failure && (
        <div className="error" role="alert">
          {failure}
        </div>
      )}

      {conflict && (
        <div className="notice" role="alert">
          <strong>{conflict.message}</strong>
          {Object.keys(conflict.diff).length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {Object.entries(conflict.diff).map(([field, difference]) => (
                <li key={field}>
                  <strong>{humaniseField(field)}</strong>: theirs{' '}
                  <code>{describeValue(difference.stored)}</code>, yours{' '}
                  <code>{describeValue(difference.incoming)}</code>
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            {/* Reload discards this draft for theirs; Overwrite keeps this draft
                and re-bases on their version. Nothing is applied automatically —
                auto-overwriting loses whatever they just did, silently. */}
            <button className="secondary" onClick={onCancel}>
              Reload theirs
            </button>
            <button onClick={() => void save(true)} disabled={busy}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="line-grid">
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          <Field label="Tier">
            {(id) => (
              <select
                id={id}
                value={tier}
                disabled={role?.isSystem}
                title={role?.isSystem ? 'A system role’s tier is locked' : undefined}
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
              </select>
            )}
          </Field>
        </div>

        {pendingTier && (
          <div className="error" style={{ background: '#fdf1dc', borderColor: '#e6c98a', color: '#8a6115' }}>
            <strong>
              Changing to {pendingTier} will remove {wouldDrop.length} permission
              {wouldDrop.length === 1 ? '' : 's'}:
            </strong>
            <ul style={{ margin: '6px 0 10px', paddingLeft: 18 }}>
              {wouldDrop.map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
            <div className="row" style={{ gap: 8 }}>
              <button className="secondary" onClick={() => setPendingTier(null)}>
                Keep {tier}
              </button>
              <button
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
                Change to {pendingTier}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <PermissionGrid
          catalogue={catalogue}
          tier={tier}
          selected={selected}
          disabled={busy}
          onToggle={toggle}
          onToggleMany={toggleMany}
        />
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
    return value.length === 0 ? 'none' : `${value.length} permission${value.length === 1 ? '' : 's'}`;
  }
  if (value === null || value === undefined) return 'not set';
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRoles, nextUsers] = await Promise.all([
        canRestoreRoles ? api.deletedRoles() : Promise.resolve([]),
        canRestoreUsers ? api.deletedUsers() : Promise.resolve([]),
      ]);
      setRoles(nextRoles);
      setUsers(nextUsers);
    } finally {
      setLoading(false);
    }
  }, [canRestoreRoles, canRestoreUsers]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const total = roles.length + users.length;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <button className="secondary" onClick={() => setOpen((current) => !current)}>
        {open ? 'Hide' : 'Show'} deleted roles and people
        {open && total > 0 ? ` (${total})` : ''}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : total === 0 ? (
            <p className="muted">Nothing has been deleted.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {roles.map((role) => (
                <li key={role.id} style={{ marginBottom: 6 }}>
                  <strong>{role.name}</strong> <span className="muted">role · {role.tier}</span>{' '}
                  <button
                    className="secondary"
                    onClick={() =>
                      void onRun(async () => {
                        await api.restoreRole(role.id);
                        await load();
                      }, 'Could not restore the role')
                    }
                  >
                    Restore
                  </button>
                </li>
              ))}
              {users.map((user) => (
                <li key={user.id} style={{ marginBottom: 6 }}>
                  <strong>{user.displayName}</strong>{' '}
                  <span className="muted">person · {user.username}</span>{' '}
                  <button
                    className="secondary"
                    onClick={() =>
                      void onRun(async () => {
                        await api.restoreUser(user.id);
                        await load();
                      }, 'Could not restore the person')
                    }
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Tier ordering, for filtering a picker to what the actor may hand out. */
const TIER_RANK: Record<RoleTier, number> = { office: 1, management: 2, admin: 3 };

/**
 * Placeholder rows while the first response is in flight.
 *
 * §7 asks for skeleton rows rather than a spinner over an empty page — and,
 * more importantly, rather than the empty *state*, which asserts something false
 * about the company for as long as the request takes.
 */
function SkeletonRows({ columns }: { columns: number }) {
  return (
    <table aria-busy="true">
      <tbody>
        {[0, 1, 2].map((row) => (
          <tr key={row}>
            {Array.from({ length: columns }, (_, column) => (
              <td key={column}>
                <span
                  aria-hidden="true"
                  style={{
                    display: 'block',
                    height: 12,
                    borderRadius: 4,
                    background: 'currentColor',
                    opacity: 0.12,
                  }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
    <div className="line-card">
      <div className="line-grid">
        <Field label="Display name">
          {(id) => (
            <input
              id={id}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Username">
          {(id) => (
            <input
              id={id}
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
            />
          )}
        </Field>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button
          disabled={!dirty || !displayName.trim() || !username.trim()}
          onClick={() =>
            void onRun(async () => {
              await api.updateUser(user.id, {
                displayName: displayName.trim(),
                username: username.trim(),
                expectedVersion: user.sync.version,
              });
              onSaved();
            }, 'Could not save')
          }
        >
          Save
        </button>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
