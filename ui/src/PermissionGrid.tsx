/**
 * The module x action matrix and the capability groups
 * (docs/ROLES_AND_USERS.md UI §5.2). Rendered entirely from the catalogue the
 * server sends, never from a list typed in here.
 *
 * Three cell states, and the difference between them is the whole point:
 *   checkbox  this tier may hold it; toggle freely
 *   dash      the module does not declare this action — it cannot exist
 *   blocked   the key exists, but this tier may not hold it
 *
 * A blocked cell is disabled and explained, never hidden — an administrator
 * needs to see that raising the tier would unlock it.
 *
 * Every heading here is a name rather than a key: a matrix whose row and column
 * labels read `recycleBin` / `verifyChain` is a database schema on screen, and
 * the person granting access to a shop floor is not reading a schema. The keys
 * are still one hover away on every control, because that is what an
 * administrator quotes when something is refused.
 */

import type { PermissionCatalogue, RoleTier } from '@orderbook/shared';

import { t } from './i18n.js';
import { actionLabel, capabilityLabel, groupLabel, moduleLabel } from './permissionLabels';

export function PermissionGrid({
  catalogue,
  tier,
  selected,
  disabled = false,
  onToggle,
  onToggleMany,
}: {
  catalogue: PermissionCatalogue;
  tier: RoleTier;
  selected: Set<string>;
  disabled?: boolean;
  onToggle: (key: string, next: boolean) => void;
  onToggleMany: (keys: string[], next: boolean) => void;
}) {
  const rank = catalogue.tiers.indexOf(tier);
  const permitted = (key: string): boolean =>
    rank >= catalogue.tiers.indexOf(catalogue.minimumTier[key] ?? 'office');

  function togglable(keys: string[]): string[] {
    return keys.filter(permitted);
  }

  const moduleKeys = catalogue.modules.flatMap((module) =>
    module.actions.map((action) => `${module.key}.${action}`),
  );
  const moduleHeld = moduleKeys.filter((key) => selected.has(key)).length;

  return (
    <div className="ob-permsections">
      <section className="ob-permsection">
        <div className="ob-permsection-head">
          <h4 className="ob-eyebrow" style={{ margin: 0 }}>
            {t('access.permissions.modules')}
          </h4>
          <span className="ob-permsection-count">
            {moduleHeld}/{moduleKeys.length}
          </span>
        </div>

        <div className="ob-tablewrap ob-permwrap">
          <table className="ob-permgrid">
            <thead>
              <tr>
                <th scope="col">{t('access.permissions.module')}</th>
                {catalogue.actions.map((action) => {
                  const columnKeys = togglable(
                    catalogue.modules
                      .filter((module) => module.actions.includes(action))
                      .map((module) => `${module.key}.${action}`),
                  );
                  const allOn =
                    columnKeys.length > 0 && columnKeys.every((key) => selected.has(key));
                  return (
                    <th scope="col" key={action}>
                      <button
                        type="button"
                        className="ob-permtoggle"
                        aria-pressed={allOn}
                        disabled={disabled || columnKeys.length === 0}
                        title={t('access.permissions.toggleColumn', {
                          action: actionLabel(action),
                        })}
                        onClick={() => onToggleMany(columnKeys, !allOn)}
                      >
                        {actionLabel(action)}
                      </button>
                    </th>
                  );
                })}
                <th scope="col" className="ob-permgrid-tally">
                  {t('access.permissions.tally')}
                </th>
              </tr>
            </thead>
            <tbody>
              {catalogue.modules.map((module) => {
                const declaredKeys = module.actions.map((action) => `${module.key}.${action}`);
                const rowKeys = togglable(declaredKeys);
                const allOn = rowKeys.length > 0 && rowKeys.every((key) => selected.has(key));
                const rowHeld = declaredKeys.filter((key) => selected.has(key)).length;
                return (
                  <tr key={module.key} data-all={allOn || undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="ob-permtoggle ob-permtoggle--row"
                        aria-pressed={allOn}
                        disabled={disabled || rowKeys.length === 0}
                        title={t('access.permissions.toggleRow', { module: module.key })}
                        onClick={() => onToggleMany(rowKeys, !allOn)}
                      >
                        {moduleLabel(module.key)}
                      </button>
                    </th>
                    {catalogue.actions.map((action) => {
                      const key = `${module.key}.${action}`;
                      const declared = module.actions.includes(action);
                      if (!declared) {
                        return (
                          <td
                            key={action}
                            className="ob-cell-na"
                            title={t('access.permissions.notApplicable')}
                            aria-label={t('access.permissions.notApplicable')}
                          >
                            &mdash;
                          </td>
                        );
                      }
                      const allowed = permitted(key);
                      const reason = t('access.permissions.blocked', {
                        tier: catalogue.minimumTier[key] ?? 'office',
                      });
                      return (
                        <td key={action} className={allowed ? undefined : 'ob-cell-blocked'}>
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={disabled || !allowed}
                            aria-disabled={!allowed}
                            aria-label={`${moduleLabel(module.key)} — ${actionLabel(action)}`}
                            aria-describedby={allowed ? undefined : `why-${key}`}
                            title={allowed ? key : `${key} · ${reason}`}
                            onChange={(e) => onToggle(key, e.target.checked)}
                          />
                          {!allowed && (
                            <span id={`why-${key}`} className="sr-only">
                              {reason}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="ob-permgrid-tally">
                      {rowHeld}/{declaredKeys.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {catalogue.groups.map((group) => {
        const capabilities = catalogue.capabilities.filter((c) => c.group === group.key);
        if (capabilities.length === 0) return null;
        const groupKeys = togglable(capabilities.map((capability) => capability.key));
        const allOn = groupKeys.length > 0 && groupKeys.every((key) => selected.has(key));
        const held = capabilities.filter((capability) => selected.has(capability.key)).length;
        return (
          <section className="ob-permsection" key={group.key}>
            <div className="ob-permsection-head">
              <h4 className="ob-eyebrow" style={{ margin: 0 }}>
                {groupLabel(group.key)}
              </h4>
              <span className="ob-permsection-count">
                {held}/{capabilities.length}
              </span>
              <button
                type="button"
                className="ob-permtoggle"
                aria-pressed={allOn}
                disabled={disabled || groupKeys.length === 0}
                onClick={() => onToggleMany(groupKeys, !allOn)}
              >
                {allOn ? t('access.permissions.clearAll') : t('access.permissions.selectAll')}
              </button>
            </div>

            <div className="ob-capgrid">
              {capabilities.map((capability) => {
                const allowed = permitted(capability.key);
                const reason = t('access.permissions.blocked', {
                  tier: catalogue.minimumTier[capability.key] ?? 'office',
                });
                const hint = allowed ? capabilityHint(capability.key) : reason;
                return (
                  <label
                    key={capability.key}
                    className={`ob-capability${allowed ? '' : ' ob-capability--blocked'}`}
                    title={allowed ? capability.key : `${capability.key} · ${reason}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(capability.key)}
                      disabled={disabled || !allowed}
                      aria-disabled={!allowed}
                      aria-describedby={hint ? `why-${capability.key}` : undefined}
                      onChange={(e) => onToggle(capability.key, e.target.checked)}
                    />
                    <span className="ob-capability-body">
                      <span className="ob-capability-name">{capabilityLabel(capability.key)}</span>
                      {/* The description target is the visible text itself. It
                          used to be a duplicate `sr-only` copy, from when the
                          hint lived only in a `title` — a screen reader read
                          the sentence twice. */}
                      {hint && (
                        <span id={`why-${capability.key}`} className="ob-capability-hint">
                          {hint}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function capabilityHint(_key: string): string | undefined {
  return undefined;
}
