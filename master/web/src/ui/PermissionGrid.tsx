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
 */

import type { PermissionCatalogue, RoleTier } from '@orderbook/shared';

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div>
        <h4 className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          Modules
        </h4>
        <div className="ob-tablewrap" style={{ maxHeight: 420 }}>
          <table className="ob-permgrid">
            <thead>
              <tr>
                <th scope="col">Module</th>
                {catalogue.actions.map((action) => {
                  const columnKeys = togglable(
                    catalogue.modules
                      .filter((module) => module.actions.includes(action))
                      .map((module) => `${module.key}.${action}`),
                  );
                  const allOn = columnKeys.length > 0 && columnKeys.every((key) => selected.has(key));
                  return (
                    <th scope="col" key={action}>
                      <button
                        type="button"
                        className="ob-linkbtn"
                        disabled={disabled || columnKeys.length === 0}
                        title={`Toggle ${action} for every module`}
                        onClick={() => onToggleMany(columnKeys, !allOn)}
                      >
                        {action}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {catalogue.modules.map((module) => {
                const rowKeys = togglable(module.actions.map((action) => `${module.key}.${action}`));
                const allOn = rowKeys.length > 0 && rowKeys.every((key) => selected.has(key));
                return (
                  <tr key={module.key}>
                    <th scope="row">
                      <button
                        type="button"
                        className="ob-linkbtn"
                        disabled={disabled || rowKeys.length === 0}
                        title={`Toggle every action for ${module.key}`}
                        onClick={() => onToggleMany(rowKeys, !allOn)}
                      >
                        {module.key}
                      </button>
                    </th>
                    {catalogue.actions.map((action) => {
                      const key = `${module.key}.${action}`;
                      const declared = module.actions.includes(action);
                      if (!declared) {
                        return (
                          <td key={action} className="ob-cell-na" aria-label="not applicable">
                            &mdash;
                          </td>
                        );
                      }
                      const allowed = permitted(key);
                      const reason = `Requires ${catalogue.minimumTier[key]} tier. Change the tier above to enable.`;
                      return (
                        <td key={action}>
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={disabled || !allowed}
                            aria-disabled={!allowed}
                            aria-label={`${module.key} ${action}`}
                            aria-describedby={allowed ? undefined : `why-${key}`}
                            title={allowed ? undefined : reason}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {catalogue.groups.map((group) => {
        const capabilities = catalogue.capabilities.filter((c) => c.group === group.key);
        if (capabilities.length === 0) return null;
        return (
          <div key={group.key}>
            <h4 className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
              {group.key}
            </h4>
            <div className="ob-capgrid">
              {capabilities.map((capability) => {
                const allowed = permitted(capability.key);
                const reason = `Requires ${catalogue.minimumTier[capability.key]} tier.`;
                const hint = allowed ? capabilityHint(capability.key) : reason;
                return (
                  <label
                    key={capability.key}
                    className={`ob-capability${allowed ? '' : ' ob-capability--blocked'}`}
                    title={hint}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(capability.key)}
                      disabled={disabled || !allowed}
                      aria-disabled={!allowed}
                      aria-describedby={hint ? `why-${capability.key}` : undefined}
                      onChange={(e) => onToggle(capability.key, e.target.checked)}
                    />
                    <span>{humanise(capability.key)}</span>
                    {hint && (
                      <span id={`why-${capability.key}`} className="sr-only">
                        {hint}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The one place the absent-versus-null rule is explained to the person about to turn it off. */
function capabilityHint(key: string): string | undefined {
  if (key === 'field.saleRate.view') {
    return 'Without this, the rate is not sent to the user’s machine at all — the column disappears rather than showing blank.';
  }
  return undefined;
}

function humanise(key: string): string {
  const last = key.split('.').slice(-1)[0] ?? key;
  const spaced = last.replace(/([A-Z])/g, ' $1').toLowerCase();
  const label = `${key.split('.').slice(0, -1).join(' ')} ${spaced}`.trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}
