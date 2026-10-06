/**
 * Choosing a role for a person: every role as a card that says what it allows,
 * not a drop-down of names.
 *
 * A name and a tier ("Dispatch (Office)") does not tell the administrator what
 * the person will be able to do, and a role is handed out far more often than
 * it is edited. Each card shows the tier, how many people hold it, how much of
 * the catalogue it grants, the modules it can change and the ones it can only
 * look at. The summary is derived from the permission keys (`roleSummary.ts`) —
 * a role has no description field on the server.
 *
 * It is a native radio group, so arrows, Tab and screen readers behave as they
 * do for any radio set. It does not decide which roles may be offered: the
 * caller passes in only the ones this actor may assign.
 */

import type { PermissionCatalogue, Role } from '@orderbook/shared';

import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';
import { summariseRole } from './roleSummary.js';
import { TierPill } from './TierPill.js';

/** More names than this and the line ends in "+N more" (the full list is the tooltip). */
const MAX_NAMES = 6;

function nameList(names: string[]): { text: string; full: string } {
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  return {
    text:
      rest > 0
        ? `${shown.join(', ')} ${t('access.rolePicker.more', { count: rest })}`
        : shown.join(', '),
    full: names.join(', '),
  };
}

export function RolePicker({
  roles,
  catalogue,
  value,
  onChange,
  label,
  currentRoleId,
  disabled = false,
  name,
}: {
  roles: Role[];
  /** Null while the catalogue loads: the cards then show name, tier and head count only. */
  catalogue: PermissionCatalogue | null;
  value: string;
  onChange: (roleId: string) => void;
  /** The group's accessible name. */
  label: string;
  /** The role the person holds now, marked "Current". */
  currentRoleId?: string | null;
  disabled?: boolean;
  /** Radio group name; two pickers on one page need different ones. */
  name: string;
}) {
  return (
    <div className="ob-rolepicker" role="radiogroup" aria-label={label}>
      {roles.map((role) => {
        const summary = catalogue ? summariseRole(role.permissions, catalogue) : null;
        const changes = summary ? nameList(summary.changes) : null;
        const viewOnly = summary ? nameList(summary.viewOnly) : null;
        const groups = summary
          ? nameList(summary.groups.map((group) => `${group.label} ${group.held}/${group.total}`))
          : null;
        const checked = role.id === value;
        return (
          <label
            key={role.id}
            className={`ob-rolecard${checked ? ' ob-rolecard--on' : ''}`}
            data-role-id={role.id}
          >
            <input
              type="radio"
              name={name}
              value={role.id}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(role.id)}
            />
            <span className="ob-rolecard-body">
              <span className="ob-rolecard-head">
                <span className="ob-rolecard-name">{role.name}</span>
                <TierPill tier={role.tier} />
                {role.id === currentRoleId && (
                  <StatusPill tone="default">{t('access.rolePicker.current')}</StatusPill>
                )}
                <span className="ob-rolecard-count">
                  {t('access.rolePicker.holders', { count: role.userCount })}
                </span>
              </span>
              {summary ? (
                <>
                  <span className="ob-rolecard-line ob-rolecard-total">
                    {summary.held === 0
                      ? t('access.rolePicker.nothing')
                      : t('access.rolePicker.total', { held: summary.held, total: summary.total })}
                  </span>
                  {summary.parties.length > 0 && (
                    <span className="ob-rolecard-line">
                      <strong>{t('access.rolePicker.parties')}</strong> {summary.parties.join(', ')}
                    </span>
                  )}
                  {summary.notices !== 'none' && (
                    <span className="ob-rolecard-line">
                      <strong>{t('access.rolePicker.notices')}</strong>{' '}
                      {summary.notices === 'manage'
                        ? t('access.rolePicker.noticesManage')
                        : t('access.rolePicker.noticesRead')}
                    </span>
                  )}
                  {changes && summary.changes.length > 0 && (
                    <span className="ob-rolecard-line" title={changes.full}>
                      <strong>{t('access.rolePicker.changes')}</strong> {changes.text}
                    </span>
                  )}
                  {viewOnly && summary.viewOnly.length > 0 && (
                    <span className="ob-rolecard-line" title={viewOnly.full}>
                      <strong>{t('access.rolePicker.viewOnly')}</strong> {viewOnly.text}
                    </span>
                  )}
                  {groups && summary.groups.length > 0 && (
                    <span className="ob-rolecard-line" title={groups.full}>
                      <strong>{t('access.rolePicker.also')}</strong> {groups.text}
                    </span>
                  )}
                </>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
