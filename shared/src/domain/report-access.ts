/**
 * Who sees Reports, and whose figures — the one place the rule lives.
 *
 * The server enforces it (`master/src/services/report.service.ts`); the screens
 * only read it to draw the right thing, so a nav row hidden here is a courtesy
 * and a refused request is the guarantee.
 *
 * - An administrator (and a Server Master, once that tier exists above it) sees
 *   Reports always and may pick any user — other administrators included.
 * - The Office and Management tiers see Reports only while their company switch
 *   is on (`reports.visibleToOffice` / `reports.visibleToManagement`, both on
 *   unless switched off) and only their own figures.
 *
 * Rank, not name: `ROLE_TIERS` lists the tiers lowest first, so "admin or
 * above" stays right when a tier is added on top.
 */

import { resolveCompanyFeatures } from './company-features.js';
import type { CompanyFeatures } from './entities.js';
import { tierRank, type RoleTier } from './permissions.js';
import { REPORT_KINDS, type ReportKind } from './reports.js';

/** May this tier ask about other people? */
export function mayReportOnOthers(tier: RoleTier): boolean {
  return tierRank(tier) >= tierRank('admin');
}

/** Has the company left Reports on for this tier? Administrators are never switched off. */
export function reportsVisibleForTier(
  tier: RoleTier,
  features: CompanyFeatures | undefined | null,
): boolean {
  if (mayReportOnOthers(tier)) return true;
  const resolved = resolveCompanyFeatures(features);
  return tier === 'management' ? resolved.reportsVisibleToManagement : resolved.reportsVisibleToOffice;
}

/** Is the Reports module offered at all: the permission, and the company switch for the tier. */
export function reportsOffered(
  tier: RoleTier,
  features: CompanyFeatures | undefined | null,
  permissions: readonly string[],
): boolean {
  return permissions.includes('reports.view') && reportsVisibleForTier(tier, features);
}

/** The kinds this person is offered: every one, or none. Per-kind rules do not exist yet; this is where one would go. */
export function offeredReportKinds(
  tier: RoleTier,
  features: CompanyFeatures | undefined | null,
  permissions: readonly string[],
): ReportKind[] {
  return reportsOffered(tier, features, permissions) ? [...REPORT_KINDS] : [];
}
