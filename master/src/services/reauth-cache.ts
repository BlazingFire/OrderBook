/**
 * "This person typed their password again, recently."
 *
 * Its one consumer is the password reveal, which asks an administrator to
 * re-authenticate before it will show anybody's stored plaintext. Revealing
 * three people's passwords in a row should not be three password prompts, and a
 * session that has been left open all afternoon should not still count as
 * re-authenticated.
 *
 * A module of its own rather than two more exports beside `auth.service.ts`'s
 * `sessions` map, purely to keep the imports acyclic: `auth.service` calls the
 * vault (to seal a password on sign-in) and the vault needs this cache, so the
 * cache cannot live in `auth.service`.
 *
 * It is still `auth.service`'s obligation to sweep and clear it — see
 * `purgeExpiredSessions` and `resetAuthState`. An unswept map keyed by session
 * token is the defect `auth.service.ts`'s own `failures` map already carries.
 */

const REAUTH_TTL_MS = 5 * 60 * 1000;

/** Session token to the moment its re-authentication stops counting. */
const recentReauth = new Map<string, number>();

export function noteRecentReauth(token: string | undefined): void {
  if (!token) return;
  recentReauth.set(token, Date.now() + REAUTH_TTL_MS);
}

export function hasRecentReauth(token: string | undefined): boolean {
  if (!token) return false;

  const until = recentReauth.get(token);
  if (until === undefined) return false;

  if (until <= Date.now()) {
    recentReauth.delete(token);
    return false;
  }

  return true;
}

/** Called from `purgeExpiredSessions`, on the same interval as the session sweep. */
export function sweepRecentReauth(): void {
  const now = Date.now();
  for (const [token, until] of recentReauth) {
    if (until <= now) recentReauth.delete(token);
  }
}

/**
 * Test seam, called from `resetAuthState`.
 *
 * In-memory state survives a `TRUNCATE`, and with `fileParallelism: false` a
 * leaked entry surfaces in an unrelated suite as a reveal that mysteriously
 * needed no password.
 */
export function clearRecentReauth(): void {
  recentReauth.clear();
}
