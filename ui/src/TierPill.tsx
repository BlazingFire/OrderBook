/**
 * A role tier as a pill, and the Server Master badge built on it.
 *
 * The labels come from an explicit map rather than `t(`tier.${tier}`)`, so the
 * i18n call-site check can see every key. A tier this build does not know
 * (a newer Master) shows its raw name rather than nothing.
 */

import type { RoleTier } from '@orderbook/shared';

import { StatusPill, type PillTone } from './DataDisplay.js';
import { Icon } from './icons.js';
import { t } from './i18n.js';

const TIER_LABEL_KEYS: Record<RoleTier, string> = {
  office: 'tier.office',
  management: 'tier.management',
  admin: 'tier.admin',
  server_master: 'tier.server_master',
};

const TIER_TONES: Record<RoleTier, PillTone> = {
  office: 'default',
  management: 'accent',
  admin: 'conflict',
  server_master: 'master',
};

/** The translated name of a tier ("Normal Admin" for admin). */
export function tierLabel(tier: string): string {
  const key = (TIER_LABEL_KEYS as Record<string, string | undefined>)[tier];
  return key ? t(key) : tier;
}

export function TierPill({ tier }: { tier: string }) {
  const tone = (TIER_TONES as Record<string, PillTone | undefined>)[tier] ?? 'default';
  return <StatusPill tone={tone}>{tierLabel(tier)}</StatusPill>;
}

/** Shown beside a Server Master's name wherever users appear. */
export function ServerMasterBadge() {
  return (
    <span data-server-master="">
      <StatusPill tone="master">
        <Icon name="shield" size={11} /> {t('tier.server_master')}
      </StatusPill>
    </span>
  );
}
