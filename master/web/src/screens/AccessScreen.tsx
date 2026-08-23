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

import { api, ApiError } from '../api';
import { Field } from '../components/Field';
import { PermissionGrid } from '../components/PermissionGrid';
import { formatDateTime } from '../format';

interface Props {
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  currentUserId: string;
}

type Tab = 'users' | 'roles';

export function AccessScreen({ permissions, currentUserId }: Props) {
  const [tab, setTab] = useState<Tab>('users');
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

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

      {tab === 'users' ? (
        <UsersTab
          users={users}
          roles={roles}
          canManage={can('users.manage')}
          canAssign={can('roles.assign')}
          currentUserId={currentUserId}
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
  onSecret,
  onRun,
}: {
  users: User[];
  roles: Role[];
  canManage: boolean;
  canAssign: boolean;
  currentUserId: string;
  onSecret: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);

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
        <h3 style={{ margin: 0 }}>{users.length} people</h3>
        {canManage && <button onClick={() => setAdding(true)}>+ Add user</button>}
      </div>

      {adding && (
        <UserForm
          roles={roles}
          onCancel={() => setAdding(false)}
          onCreated={(secret) => {
            setAdding(false);
            onSecret(secret);
          }}
          onRun={onRun}
        />
      )}

      {users.length === 0 ? (
        <p className="muted">Nobody here yet.</p>
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
            {users.map((user) => {
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
                            () => api.updateUser(user.id, { roleId: event.target.value }),
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
                          onClick={() =>
                            void onRun(
                              () => api.updateUser(user.id, { isActive: !user.isActive }),
                              'Could not change the status',
                            )
                          }
                        >
                          {user.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="danger"
                          disabled={Boolean(blocked) || user.id === currentUserId}
                          title={blocked ?? (user.id === currentUserId ? 'This is you' : undefined)}
                          onClick={() =>
                            void onRun(() => api.deleteUser(user.id), 'Could not delete')
                          }
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
  onCancel,
  onCreated,
  onRun,
}: {
  roles: Role[];
  onCancel: () => void;
  onCreated: (secret: OneTimeSecret) => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');

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
              {roles.map((role) => (
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
  onEdit,
  onRun,
}: {
  roles: Role[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (role: Role | 'new') => void;
  onRun: (action: () => Promise<unknown>, failure: string) => Promise<void>;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{roles.length} roles</h3>
        {canCreate && <button onClick={() => onEdit('new')}>+ Create role</button>}
      </div>

      <table>
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
                      onClick={() => void onRun(() => api.deleteRole(role.id), 'Could not delete')}
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

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const input = {
        name: name.trim(),
        tier,
        permissions: [...selected].sort(),
        expectedVersion: role?.sync.version,
      };

      if (role) await api.updateRole(role.id, input);
      else await api.createRole(input);

      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save the role');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{role ? role.name : 'New role'}</h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

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
