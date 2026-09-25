/**
 * Tenants.
 *
 * One installation currently serves one company, but every table is keyed by
 * tenant so that a second one is a new row rather than a data migration. The
 * tenancy migration seeds the first tenant, which is why setup looks one up
 * instead of creating it.
 */

import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';

import { db } from '../db/knex.js';

const TABLE = 'tenants';

type Runner = Knex | Knex.Transaction;

/**
 * The tenant this installation belongs to, or null — a read that never creates
 * one.
 *
 * For a caller with no signed-in actor to take a tenant from, on a path where
 * inventing a tenant would be a write nobody asked for: the public API's off
 * switch reads it before any key is checked, on a request anybody on the LAN
 * can send.
 */
export async function findDefaultTenantId(runner: Runner = db()): Promise<string | null> {
  const row = await runner(TABLE).orderBy('created_at').first<{ id: string } | undefined>('id');
  return row?.id ?? null;
}

/**
 * The tenant this installation belongs to.
 *
 * Creates one if the table is somehow empty — a Master that cannot name its
 * tenant cannot write anything at all, so failing to start would be a worse
 * outcome than adopting a default.
 */
export async function resolveDefaultTenantId(runner: Runner = db()): Promise<string> {
  const existing = await findDefaultTenantId(runner);
  if (existing) return existing;

  const id = randomUUID();
  await runner(TABLE).insert({ id, name: 'Default', slug: 'default', is_active: true });
  return id;
}
