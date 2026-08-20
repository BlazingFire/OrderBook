/**
 * Master Panel sign-in. Sessions live in memory: the Master is a single
 * long-running process on one PC, and signing admins out on restart is
 * acceptable (and arguably correct) for physically-local software.
 */

import { randomBytes } from 'node:crypto';
import type { User } from '@orderbook/shared';
import bcrypt from 'bcryptjs';

import { config } from '../config/index.js';
import { UnauthorizedError } from '../lib/errors.js';
import { findByUsername, touchLastLogin } from '../repositories/user.repository.js';

interface Session {
  user: User;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export async function signIn(username: string, password: string): Promise<{ token: string; user: User }> {
  const found = await findByUsername(username);
  // Compare against a dummy hash when the user is missing so a wrong username
  // and a wrong password take the same time to answer.
  const passwordHash = found?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
  const matches = await bcrypt.compare(password, passwordHash);

  if (!found || !matches || !found.user.isActive) {
    throw new UnauthorizedError('Incorrect ID or password');
  }

  await touchLastLogin(found.user.id);

  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { user: found.user, expiresAt: Date.now() + config.session.ttlMs });

  return { token, user: found.user };
}

export function resolveSession(token: string | undefined): User | null {
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session.user;
}

export function signOut(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}
