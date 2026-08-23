import type { RoleTierName, User } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapUser } from './mappers.js';

const TABLE = 'users';

type Runner = Knex | Knex.Transaction;

export interface UserWithSecret {
  user: User;
  passwordHash: string;
}

/** Joined to the role so a user always carries the tier and role name it holds. */
function baseQuery(runner: Runner = db()) {
  return runner(`${TABLE} as u`)
    .leftJoin('roles as r', 'r.id', 'u.role_id')
    .select('u.*', 'r.name as role_name', 'r.tier as role_tier');
}

export async function findByUsername(username: string): Promise<UserWithSecret | null> {
  const row = await baseQuery().whereRaw('lower(u.username) = lower(?)', [username]).first();
  if (!row) return null;
  return { user: mapUser(row), passwordHash: String(row.password_hash) };
}

export async function findById(id: string, runner: Runner = db()): Promise<User | null> {
  const row = await baseQuery(runner).where('u.id', id).first();
  return row ? mapUser(row) : null;
}

export async function listUsers(tenantId: string, runner: Runner = db()): Promise<User[]> {
  const rows = await baseQuery(runner).where('u.tenant_id', tenantId).orderBy('u.username');
  return rows.map(mapUser);
}

export async function insertUser(
  values: {
    id: string;
    tenant_id: string;
    username: string;
    password_hash: string;
    full_name: string | null;
    role_id: string | null;
  },
  trx?: Knex.Transaction,
): Promise<User> {
  await (trx ?? db())(TABLE).insert(values);

  const created = await findById(values.id, trx ?? db());
  if (!created) throw new Error('User disappeared immediately after insert');
  return created;
}

/** The seeded role for a tier, used when creating the first admin at setup. */
export async function roleIdForTier(
  tenantId: string,
  tier: RoleTierName,
  runner: Runner = db(),
): Promise<string | null> {
  const row = await runner('roles')
    .where({ tenant_id: tenantId, tier })
    .first<{ id: string } | undefined>('id');
  return row?.id ?? null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await db()(TABLE).where({ id: userId }).update({ last_login_at: db().fn.now() });
}
