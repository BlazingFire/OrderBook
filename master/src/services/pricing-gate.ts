/**
 * The company's pricing switch, applied to permissions.
 *
 * `pricing.enabled` is off by default: this is order management, and most
 * desks never need a rate. Rather than teach every screen, document and report
 * a second reason to hide money, the switch strips the four `field.*Rate.*`
 * keys from every resolved permission set — so a company with pricing off
 * behaves exactly like a role that was never granted them, through the masking
 * that already exists for that role.
 *
 * Every path that resolves a role's permissions goes through here rather than
 * through `roleRepo.permissionSetForRole` directly. The repository stays pure
 * and cached by role version; this reads the (cached) setting each time, so a
 * flip takes effect on the caller's next resolution, the same promise
 * `auth.service.ts` makes for an edited role.
 */

import { FIELD_PERMISSIONS, type PermissionSet } from '@orderbook/shared';
import type { Knex } from 'knex';

import * as roleRepo from '../repositories/role.repository.js';
import { getSetting } from './settings.service.js';

const RATE_KEYS = new Set<string>(FIELD_PERMISSIONS);

export async function pricingEnabled(tenantId: string): Promise<boolean> {
  return getSetting(tenantId, 'pricing.enabled');
}

/** The set as the switch leaves it: unchanged while pricing is on. */
export async function gatePricing(tenantId: string, set: PermissionSet): Promise<PermissionSet>;
export async function gatePricing(
  tenantId: string,
  set: PermissionSet | null,
): Promise<PermissionSet | null>;
export async function gatePricing(
  tenantId: string,
  set: PermissionSet | null,
): Promise<PermissionSet | null> {
  if (!set || (await pricingEnabled(tenantId))) return set;
  return { ...set, permissions: set.permissions.filter((key) => !RATE_KEYS.has(key)) };
}

/** `roleRepo.permissionSetForRole`, gated. */
export async function permissionSetForRole(
  tenantId: string,
  roleId: string | null,
  runner?: Knex | Knex.Transaction,
): Promise<PermissionSet | null> {
  return gatePricing(tenantId, await roleRepo.permissionSetForRole(tenantId, roleId, runner));
}
