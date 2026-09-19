/**
 * What a role grants, read-only, for somebody deciding whether to give it to
 * somebody else.
 *
 * The first version of this printed the raw key set as one flat run of chips —
 * fifty-odd `leads.create`-shaped tokens in alphabetical order. That is the
 * data, but it is not an answer to the only question anyone opens this to ask,
 * which is *what can a person with this role do*. Alphabetical order also
 * scatters each module across the wall: `leads.bulk` and `leads.view` sit six
 * rows apart with unrelated modules between them.
 *
 * So it is grouped the way the permission editor groups it — by module, then by
 * capability group — and each module shows the actions it did *not* grant as
 * well as the ones it did. Coverage is the thing being judged, and "everything
 * except delete" cannot be seen from a list of what is present.
 */

import type { PermissionCatalogue } from '@orderbook/shared';

import { t } from './i18n.js';
import { actionLabel, capabilityLabel, groupLabel, moduleLabel } from './permissionLabels';

export function PermissionSummary({
  catalogue,
  permissions,
}: {
  /** Null until the catalogue arrives; the keys are still listed, just ungrouped. */
  catalogue: PermissionCatalogue | null;
  permissions: string[];
}) {
  const held = new Set(permissions);

  if (permissions.length === 0) {
    return (
      <p className="ob-small" style={{ margin: 0 }}>
        {t('access.roles.detail.grantsNone')}
      </p>
    );
  }

  // Without the catalogue there is nothing to group by, and inventing a
  // grouping from the key strings would be a guess this screen presents as
  // fact. The flat list is the honest fallback.
  if (!catalogue) {
    return (
      <div className="ob-chiprow">
        {[...permissions].sort().map((key) => (
          <span className="ob-chip ob-mono" key={key}>
            {key}
          </span>
        ))}
      </div>
    );
  }

  const rows: Array<{
    key: string;
    label: string;
    tokens: Array<{ key: string; label: string; on: boolean }>;
  }> = [];
  const accounted = new Set<string>();

  for (const module of catalogue.modules) {
    const tokens = module.actions.map((action) => {
      const key = `${module.key}.${action}`;
      accounted.add(key);
      return { key, label: actionLabel(action), on: held.has(key) };
    });
    if (tokens.some((token) => token.on)) {
      rows.push({ key: module.key, label: moduleLabel(module.key), tokens });
    }
  }

  for (const group of catalogue.groups) {
    const capabilities = catalogue.capabilities.filter(
      (capability) => capability.group === group.key,
    );
    const tokens = capabilities.map((capability) => {
      accounted.add(capability.key);
      return {
        key: capability.key,
        label: capabilityLabel(capability.key),
        on: held.has(capability.key),
      };
    });
    if (tokens.some((token) => token.on)) {
      rows.push({ key: `group:${group.key}`, label: groupLabel(group.key), tokens });
    }
  }

  // A key the catalogue does not describe is a real signal — a permission the
  // server still honours after the catalogue stopped listing it. Showing it
  // under its own heading is the difference between noticing that and not.
  const unknown = [...held].filter((key) => !accounted.has(key)).sort();
  if (unknown.length > 0) {
    rows.push({
      key: 'unknown',
      label: t('access.roles.detail.grantsUnknown'),
      tokens: unknown.map((key) => ({ key, label: key, on: true })),
    });
  }

  const total = accounted.size;
  return (
    <div className="ob-grants">
      <p className="ob-small ob-grants-total">
        {t('access.roles.detail.grantsCount', { held: permissions.length, total })}
      </p>
      {rows.map((row) => {
        const on = row.tokens.filter((token) => token.on).length;
        return (
          <div className="ob-grants-row" key={row.key}>
            <div className="ob-grants-name">
              <span>{row.label}</span>
              <span className="ob-grants-count">
                {on}/{row.tokens.length}
              </span>
            </div>
            <div className="ob-grants-tokens">
              {row.tokens.map((token) => (
                <span
                  key={token.key}
                  className={token.on ? 'ob-grant ob-grant--on' : 'ob-grant'}
                  title={token.key}
                >
                  {token.label}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
