import type { User } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapUser } from './mappers.js';

const TABLE = 'users';

export interface UserWithSecret {
  user: User;
  passwordHash: string;
}

export async function findByUsername(username: string): Promise<UserWithSecret | null> {
  const row = await db()(TABLE).whereRaw('lower(username) = lower(?)', [username]).first();
  if (!row) return null;
  return { user: mapUser(row), passwordHash: String(row.password_hash) };
}

export async function insertUser(
  values: {
    id: string;
    username: string;
    password_hash: string;
    full_name: string | null;
    role: 'admin' | 'staff';
  },
  trx?: Knex.Transaction,
): Promise<User> {
  const [row] = await (trx ?? db())(TABLE).insert(values).returning('*');
  return mapUser(row);
}

export async function touchLastLogin(userId: string): Promise<void> {
  await db()(TABLE).where({ id: userId }).update({ last_login_at: db().fn.now() });
}
