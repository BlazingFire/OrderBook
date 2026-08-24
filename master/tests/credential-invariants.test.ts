/**
 * The invariants that are stated as greppable (docs/ROLES_AND_USERS.md §11).
 *
 * Two rules in this codebase are written down as things a `grep` should prove:
 * `password_hash` is selected in exactly one query, and that query has exactly
 * one caller. Both had quietly stopped being true — `baseQuery` selected `u.*`,
 * and `changeOwnPassword` re-read the credential by username when it already
 * held the id — while comments went on asserting them.
 *
 * Neither drift leaked anything: the mapper strips the column and the `User`
 * type does not declare it. That is precisely why they went unnoticed, and why
 * a rule stated as mechanically checkable needs something mechanical checking
 * it. These tests read the source, which is unusual and is the point.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8');
}

/** Call sites, not mentions — a comment naming the function is not a caller. */
function countCalls(source: string, fn: string): number {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
    return line.includes(`${fn}(`);
  }).length;
}

describe('the credential read', () => {
  it('has exactly one caller outside the repository', () => {
    const auth = read('services/auth.service.ts');

    // "If it ever returns two, one of them is a leak." Both current callers fed
    // `verifyPassword` and neither escaped the auth service, so the drift was
    // harmless — but the next one would have been just as quiet.
    expect(countCalls(auth, 'readCredentialForVerification')).toBe(1);
  });

  it('is the only query that selects password_hash', () => {
    const repository = read('repositories/user.repository.ts');

    const selects = repository
      .split('\n')
      .filter((line) => line.includes("'password_hash'") && !line.trim().startsWith('//'));

    // One line, inside `readCredentialForVerification`. `baseQuery` used to
    // reach it through `u.*`, pulling the column into this process on every
    // list and every lookup.
    expect(selects).toHaveLength(1);
    expect(repository).not.toContain("select('u.*'");
  });

  it('is stripped by the mapper rather than mapped to a property', () => {
    const mappers = read('repositories/mappers.ts');

    // Destructured out, so the key is structurally absent from what comes back.
    expect(mappers).toContain('const { password_hash: _passwordHash, ...safe } = row;');

    // And no mapper anywhere emits it as an output property. Absent, not null:
    // `passwordHash === null` passes against a broken implementation, so the
    // shape has to make the property impossible rather than merely empty.
    expect(mappers).not.toMatch(/^\s*passwordHash:/m);
  });
});

describe('the two-layer permission check', () => {
  it('guards every access route, not just the service behind it', () => {
    const routes = read('http/routes/access.routes.ts');

    const handlers = routes.split('\n').filter((line) => /accessRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes.split('\n').filter((line) => line.includes('needs('));

    // `requirePermissionMiddleware` was defined, exported and mounted nowhere,
    // so the two gates the guides describe were in practice one — while this
    // file's own header claimed otherwise.
    //
    // Two routes are deliberately ungated: the permission catalogue (which is
    // static configuration, not company data) and `/me/password` (requiring
    // `users.manage` to change your own password would mean nobody without
    // administrative rights ever could).
    expect(guards.length).toBe(handlers.length - 2);
  });

  it('guards every fields route — no exemptions here, unlike access.routes.ts', () => {
    const routes = read('http/routes/fields.routes.ts');

    // Comment lines can mention `needs(` (this file's own header does) without
    // being a guard, so both counts are filtered the same way `countCalls`
    // filters comments above — a raw substring count would silently pass
    // whether or not a handler actually calls it.
    const handlers = routes
      .split('\n')
      .filter((line) => /fieldsRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        return line.includes('needs(');
      });

    // Every Fields endpoint is gated by `fields.view` or `fields.manage` — the
    // `- 2` exemption above is specific to `access.routes.ts`'s two genuinely
    // ungated routes and must never be copied here or generalised into a loop
    // over routers.
    expect(guards.length).toBe(handlers.length);
  });
});
