/**
 * One person on Roles & users (docs/ROLES_AND_USERS.md UI §4.3).
 *
 * A header card says who they are and carries every action on the account;
 * the Access card shows their role and, once another role is picked, what the
 * move would keep, add and take away; the facts run down the side.
 *
 * This screen lays out and asks, nothing more. Every action is `AccessScreen`'s
 * own: the password, deactivate and delete dialogs live there, the server
 * repeats every check, and a refusal lands in that screen's banner.
 *
 * Picking another role is not typed work. It is one click to make again, so
 * Back and Escape leave without asking, and nothing is saved until
 * "Change role".
 */

import { useEffect, useRef, useState } from 'react';
import type { PermissionCatalogue, Role, User } from '@orderbook/shared';
import { AVATAR_LONG_EDGE, MAX_AVATAR_SOURCE_BYTES, SERVER_MASTER_TIER } from '@orderbook/shared';

import {
  actionLabel,
  Avatar,
  avatarFileProblem,
  Button,
  Card,
  compareRoles,
  EditorScreen,
  formatDateTime,
  formatRelative,
  Icon,
  IconButton,
  IdField,
  Popover,
  ServerMasterBadge,
  SkeletonRows,
  StatusPill,
  summariseRole,
  t,
  TierPill,
  tierLabel,
  useToast,
  type PermissionCellState,
} from '@orderbook/ui';

export interface PersonScreenProps {
  user: User;
  /** Every role, to find the one the person holds. */
  roles: Role[];
  /** The roles this caller may move the person to, their own included; empty without `roles.assign`. */
  assignable: Role[];
  catalogue: PermissionCatalogue | null;
  /** Edit details, reset password, deactivate and delete: `users.manage` on somebody at or below the caller's tier. */
  canManage: boolean;
  canEditPicture: boolean;
  canReveal: boolean;
  isSelf: boolean;
  /** Why deactivating or deleting them would leave the company short of an administrator. */
  blockedReason?: string;
  onBack: () => void;
  onEdit: () => void;
  onResetPassword: () => void;
  onRevealPassword: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
  onDelete: () => void;
  /** Resolves true once the server has changed the role. */
  onChangeRole: (roleId: string) => Promise<boolean>;
  onUploadPicture: (file: File) => Promise<void>;
  onRemovePicture: () => Promise<void>;
  /** Absent without `roles.view`. */
  onManageRoles?: () => void;
  /** Absent without the Activity log. */
  onOpenActivityLog?: () => void;
}

export function PersonScreen(props: PersonScreenProps) {
  const { user, roles, assignable, catalogue } = props;
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  // The stored role moved — this change, or another administrator's: a pick is stale.
  useEffect(() => setPicked(null), [user.roleId]);

  const current = roles.find((role) => role.id === user.roleId) ?? null;
  const target =
    picked && picked !== user.roleId ? (assignable.find((role) => role.id === picked) ?? null) : null;
  const canAssign = assignable.length > 0;
  // Somebody who may not assign sees the person's role alone, not a set of disabled cards.
  const shown = canAssign ? assignable : current ? [current] : [];
  const comparison =
    catalogue && current
      ? compareRoles(current.permissions, (target ?? current).permissions, catalogue)
      : null;

  async function change(): Promise<void> {
    if (!target) return;
    const role = target;
    setChanging(true);
    try {
      if (await props.onChangeRole(role.id)) {
        setPicked(null);
        toast.push(t('access.person.roleChanged', { name: user.displayName, role: role.name }), {
          tone: 'ok',
        });
      }
    } finally {
      setChanging(false);
    }
  }

  return (
    <EditorScreen
      onBack={() => {
        props.onBack();
        return true;
      }}
      backLabel={t('access.editor.backToList')}
    >
      <PersonHead {...props} />

      <div className="ob-person-grid">
        <Card padded={false} className="ob-person-access">
          <div className="ob-person-access-head">
            <span className="ob-eyebrow">{t('access.person.access')}</span>
            <span className="ob-small">{t('access.person.accessHelp')}</span>
          </div>
          <div className="ob-person-access-body">
            <div className="ob-person-roles">
              <div className="ob-body-strong">{t('access.users.colRole')}</div>
              <div
                className="ob-person-rolelist"
                role={canAssign ? 'radiogroup' : undefined}
                aria-label={t('access.users.colRole')}
              >
                {shown.map((role) => (
                  <RoleCard
                    key={role.id}
                    role={role}
                    catalogue={catalogue}
                    name={`person-role-${user.id}`}
                    checked={role.id === (target?.id ?? user.roleId)}
                    current={role.id === user.roleId}
                    readOnly={!canAssign}
                    disabled={changing}
                    onPick={() => setPicked(role.id === user.roleId ? null : role.id)}
                  />
                ))}
              </div>
              {props.onManageRoles && (
                <button type="button" className="ob-linkbtn" onClick={props.onManageRoles}>
                  {t('access.person.manageRoles')}
                </button>
              )}
            </div>

            <div className="ob-person-compare">
              {!current ? (
                <p className="ob-help" style={{ margin: 0 }}>
                  {t('access.person.noRoleDetail')}
                </p>
              ) : !comparison || !catalogue ? (
                <SkeletonRows rows={6} columns={7} />
              ) : (
                <>
                  <div className="ob-person-comparehead">
                    <span className="ob-body-strong">
                      {current.name}
                      {target && ` → ${target.name}`}
                    </span>
                    <span className="ob-person-legend">
                      {(target
                        ? (['gained', 'kept', 'lost'] as const)
                        : (['kept', 'none'] as const)
                      ).map((state) => (
                        <span key={state}>
                          <Cell state={state} />
                          {legendWord(state, Boolean(target))}
                        </span>
                      ))}
                    </span>
                  </div>

                  <table className="ob-permcompare">
                    <thead>
                      <tr>
                        <th scope="col">{t('access.person.colModule')}</th>
                        {catalogue.actions.map((action) => (
                          <th key={action} scope="col" title={actionLabel(action)}>
                            {actionLabel(action)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.modules.map((module) => (
                        <tr key={module.key}>
                          <td>{module.label}</td>
                          {module.cells.map((cell) => (
                            <td key={cell.key}>
                              {cell.state && (
                                <Cell
                                  state={cell.state}
                                  label={t('access.person.cell', {
                                    module: module.label,
                                    action: actionLabel(cell.action),
                                    state: legendWord(cell.state, Boolean(target)),
                                  })}
                                />
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="ob-permgroups">
                    {comparison.groups.map((group) => (
                      <div key={group.key} className="ob-permgroup" data-group={group.key}>
                        <span>{group.label}</span>
                        <span className="ob-permgroup-count">{`${group.from}/${group.total}`}</span>
                        {target && (
                          <>
                            <span className="ob-permgroup-arrow" aria-hidden="true">
                              →
                            </span>
                            <span
                              className="ob-permgroup-count"
                              data-change={
                                group.to > group.from
                                  ? 'up'
                                  : group.to < group.from
                                    ? 'down'
                                    : undefined
                              }
                            >
                              {`${group.to}/${group.total}`}
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {target && (
                    <div className="ob-person-changebar">
                      <p className="ob-body" role="status">
                        {t('access.person.changeBar.lead', { name: user.displayName })}{' '}
                        <strong>{target.name}</strong>
                        {' — '}
                        <span className={comparison.gained > 0 ? 'ob-gain' : undefined}>
                          {comparison.gained === 0
                            ? t('access.person.changeBar.noneGained')
                            : comparison.gained === 1
                              ? t('access.person.changeBar.gainedOne')
                              : t('access.person.changeBar.gained', { count: comparison.gained })}
                        </span>
                        {', '}
                        <span className={comparison.lost > 0 ? 'ob-loss' : undefined}>
                          {comparison.lost === 0
                            ? t('access.person.changeBar.noneLost')
                            : t('access.person.changeBar.lost', { count: comparison.lost })}
                        </span>
                        {'. '}
                        {t('access.person.changeBar.nextSync')}
                      </p>
                      <span className="ob-person-changebar-actions">
                        <Button disabled={changing} onClick={() => setPicked(null)}>
                          {t('access.person.keep', { role: current.name })}
                        </Button>
                        <Button variant="primary" busy={changing} onClick={() => void change()}>
                          {t('access.users.roleChangeApply')}
                        </Button>
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </Card>

        <PersonFacts {...props} />
      </div>
    </EditorScreen>
  );
}

/** Face, name, state, and the account's actions. */
function PersonHead({
  user,
  canManage,
  canEditPicture,
  canReveal,
  isSelf,
  blockedReason,
  onEdit,
  onResetPassword,
  onRevealPassword,
  onDeactivate,
  onActivate,
  onDelete,
  onUploadPicture,
}: PersonScreenProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const serverMaster = user.roleTier === SERVER_MASTER_TIER;
  const thisIsYou = isSelf ? t('access.users.thisIsYou') : undefined;
  // Activating is never blocked; deactivating or deleting the last administrator, or yourself, is.
  const statusBlock = user.isActive ? (blockedReason ?? thisIsYou) : undefined;
  const deleteBlock = blockedReason ?? thisIsYou;

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    const reason = avatarFileProblem(file);
    setProblem(reason);
    if (!reason) {
      setBusy(true);
      try {
        await onUploadPicture(file);
      } finally {
        setBusy(false);
      }
    }
    // Cleared so choosing the same file again still fires a change.
    if (fileRef.current) fileRef.current.value = '';
  }

  const face = (
    <Avatar name={user.displayName} avatar={user.avatar} size="ml" highlight={serverMaster} />
  );

  return (
    <Card className="ob-person-head">
      {canEditPicture ? (
        <>
          <button
            type="button"
            className="ob-person-face"
            disabled={busy}
            aria-busy={busy}
            aria-label={t('avatar.change')}
            title={t('avatar.change')}
            onClick={() => fileRef.current?.click()}
          >
            {face}
            <span className="ob-person-face-badge" aria-hidden="true">
              <Icon name="camera" size={13} />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('avatar.choose')}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </>
      ) : (
        face
      )}

      <div className="ob-person-who">
        <div className="ob-person-name">
          <h1 className="ob-display">{user.displayName}</h1>
          <StatusPill tone={user.isActive ? 'ok' : 'default'}>
            {user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
          </StatusPill>
          {serverMaster ? (
            <ServerMasterBadge />
          ) : (
            <TierPill
              tier={user.roleTier}
              label={t('access.person.tierPill', { tier: tierLabel(user.roleTier) })}
            />
          )}
        </div>
        <div className="ob-person-sub ob-small">
          <span>
            {t('access.users.colRole')} <strong>{user.roleName}</strong>
          </span>
          <span className="ob-person-sub-sep" aria-hidden="true">
            ·
          </span>
          <IdField value={user.id} />
          <span className="ob-person-sub-sep" aria-hidden="true">
            ·
          </span>
          <span title={user.lastSignInAt ? formatDateTime(user.lastSignInAt) : undefined}>
            {user.lastSignInAt
              ? t('access.person.lastSignedIn', { when: formatRelative(user.lastSignInAt) })
              : t('access.person.neverSignedIn')}
          </span>
        </div>
        {problem && (
          <p className="ob-small" style={{ margin: 0, color: 'var(--state-conflict)' }} role="alert">
            {problem}
          </p>
        )}
      </div>

      {canManage && (
        <div className="ob-person-actions">
          <Button icon="edit" onClick={onEdit}>
            {t('access.person.editDetails')}
          </Button>
          <Button icon="lock" onClick={onResetPassword}>
            {t('access.users.resetPassword')}
          </Button>
          <span className="ob-person-more">
            <IconButton
              icon="more"
              variant="bordered"
              label={t('access.person.more')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              // The popover closes on any mousedown outside it; without this the
              // same press closed it and the click then opened it again.
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setMenuOpen((open) => !open)}
            />
            <Popover
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorStyle={{ right: 0, top: 'calc(100% + var(--s-4))' }}
            >
              <div className="ob-menu" role="menu" aria-label={t('access.person.more')}>
                {canReveal && (
                  <MenuItem
                    label={t('access.users.revealPassword')}
                    hint={t('access.person.revealHint')}
                    onSelect={() => {
                      setMenuOpen(false);
                      onRevealPassword();
                    }}
                  />
                )}
                <MenuItem
                  label={user.isActive ? t('access.users.deactivate') : t('access.users.activate')}
                  hint={
                    statusBlock ??
                    (user.isActive
                      ? t('access.person.deactivateHint')
                      : t('access.person.activateHint'))
                  }
                  disabled={Boolean(statusBlock)}
                  onSelect={() => {
                    setMenuOpen(false);
                    if (user.isActive) onDeactivate();
                    else onActivate();
                  }}
                />
                <div className="ob-menu-sep" role="separator" />
                <MenuItem
                  label={t('access.person.delete')}
                  hint={deleteBlock ?? t('access.person.deleteHint')}
                  danger
                  disabled={Boolean(deleteBlock)}
                  onSelect={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                />
              </div>
            </Popover>
          </span>
        </div>
      )}
    </Card>
  );
}

function MenuItem({
  label,
  hint,
  danger = false,
  disabled = false,
  onSelect,
}: {
  label: string;
  hint: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ob-menu-item ob-menu-item--twoline${danger ? ' ob-menu-item--danger' : ''}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="ob-body">{label}</span>
      <span className="ob-menu-item-sub">{hint}</span>
    </button>
  );
}

/** One role as a radio card: tier, how much of the catalogue it grants, who holds it. */
function RoleCard({
  role,
  catalogue,
  name,
  checked,
  current,
  readOnly,
  disabled,
  onPick,
}: {
  role: Role;
  catalogue: PermissionCatalogue | null;
  name: string;
  checked: boolean;
  current: boolean;
  readOnly: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const summary = catalogue ? summariseRole(role.permissions, catalogue) : null;
  return (
    <label
      className="ob-personrole"
      data-on={checked || undefined}
      data-readonly={readOnly || undefined}
      data-role-id={role.id}
    >
      {readOnly ? (
        <span />
      ) : (
        <input
          type="radio"
          className="ob-radio"
          name={name}
          value={role.id}
          checked={checked}
          disabled={disabled}
          onChange={onPick}
        />
      )}
      <span className="ob-personrole-head">
        <span className="ob-personrole-name">{role.name}</span>
        <TierPill tier={role.tier} />
        {current && (
          <span className="ob-personrole-current">{t('access.rolePicker.current')}</span>
        )}
      </span>
      {summary && summary.total > 0 && (
        <span className="ob-personrole-bar" aria-hidden="true">
          <span style={{ width: `${(summary.held / summary.total) * 100}%` }} />
        </span>
      )}
      <span className="ob-personrole-meta">
        <span>
          {summary
            ? t('access.rolePicker.total', { held: summary.held, total: summary.total })
            : null}
        </span>
        <span>
          {role.userCount === 1
            ? t('access.person.people.one')
            : t('access.person.people.other', { count: role.userCount })}
        </span>
      </span>
    </label>
  );
}

/** A matrix cell, or the legend's sample of one. */
function Cell({ state, label }: { state: PermissionCellState; label?: string }) {
  return (
    <span
      className="ob-permcell"
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    >
      {state === 'kept' ? (
        <Icon name="check" size={14} />
      ) : state === 'gained' ? (
        <Icon name="plus" size={12} />
      ) : state === 'lost' ? (
        <Icon name="minus" size={12} />
      ) : (
        '·'
      )}
    </span>
  );
}

/** What a cell means, as the legend and a cell's label say it. */
function legendWord(state: PermissionCellState, comparing: boolean): string {
  if (state === 'none') return t('access.person.cell.none');
  if (!comparing) return t('access.person.cell.held');
  return state === 'gained'
    ? t('access.person.cell.gained')
    : state === 'lost'
      ? t('access.person.cell.lost')
      : t('access.person.cell.kept');
}

/** Identity, activity and the picture, down the side. */
function PersonFacts({
  user,
  canEditPicture,
  onOpenActivityLog,
  onRemovePicture,
}: PersonScreenProps) {
  const [removing, setRemoving] = useState(false);
  return (
    <div className="ob-person-aside">
      <Card>
        <div className="ob-eyebrow">{t('access.users.detail.identity')}</div>
        <dl className="ob-kv ob-person-kv">
          <dt>{t('access.users.colName')}</dt>
          <dd>{user.displayName}</dd>
          <dt>{t('access.users.colUsername')}</dt>
          <dd>{user.username}</dd>
          <dt>{t('access.person.userId')}</dt>
          <dd className="ob-mono">{user.id}</dd>
          <dt>{t('access.roles.colTier')}</dt>
          <dd>{tierLabel(user.roleTier)}</dd>
          <dt>{t('access.users.colStatus')}</dt>
          <dd style={{ color: user.isActive ? 'var(--state-ok)' : 'var(--fg-secondary)' }}>
            {user.isActive ? t('access.users.statusActive') : t('access.users.statusInactive')}
          </dd>
        </dl>
      </Card>

      <Card>
        <div className="ob-eyebrow">{t('access.users.detail.activity')}</div>
        <dl className="ob-kv ob-person-kv">
          <dt>{t('access.users.colLastSignIn')}</dt>
          <dd>
            {user.lastSignInAt ? formatDateTime(user.lastSignInAt) : t('access.person.never')}
          </dd>
          <dt>{t('access.users.detail.created')}</dt>
          <dd>{formatDateTime(user.createdAt)}</dd>
          <dt>{t('access.users.detail.updated')}</dt>
          <dd>{formatDateTime(user.updatedAt)}</dd>
          <dt>{t('access.person.version')}</dt>
          <dd>{t('access.person.versionValue', { version: user.sync.version })}</dd>
        </dl>
        {onOpenActivityLog && (
          <button type="button" className="ob-linkbtn" onClick={onOpenActivityLog}>
            {t('access.person.openLog')}
          </button>
        )}
      </Card>

      {canEditPicture && (
        <Card>
          <div className="ob-eyebrow">{t('access.person.picture')}</div>
          <p className="ob-small" style={{ margin: 0 }}>
            {t('access.person.pictureHelp', {
              px: AVATAR_LONG_EDGE,
              max: `${MAX_AVATAR_SOURCE_BYTES / (1024 * 1024)} MB`,
            })}
          </p>
          {user.avatar && (
            <Button
              variant="ghost"
              size="sm"
              busy={removing}
              style={{ marginTop: 'var(--s-8)', marginLeft: 'calc(var(--s-8) * -1)' }}
              onClick={() => {
                setRemoving(true);
                void onRemovePicture().finally(() => setRemoving(false));
              }}
            >
              {t('avatar.remove')}
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
