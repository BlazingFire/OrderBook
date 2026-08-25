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

  it('guards every Recycle Bin route (Stage 2 extends the pattern to its own router)', () => {
    const routes = read('http/routes/recycle-bin.routes.ts');

    const handlers = routes.split('\n').filter((line) => /recycleBinRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes.split('\n').filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions here — including the `POST /restore` route, whose guard
    // is deliberately the weaker `recycleBin.view` because the entity type
    // travels in the body and only the service can resolve which delete key
    // actually applies.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Fields route (Stage 3 extends the pattern to its own router)', () => {
    const routes = read('http/routes/fields.routes.ts');

    const handlers = routes.split('\n').filter((line) => /fieldsRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes.split('\n').filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions — the three existing unguarded reads
    // (`GET /api/pipelines`, `/api/option-lists`, `/api/custom-fields`) are a
    // deliberately separate surface on `data.routes.ts`, not on this router.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Logs route (Stage 4 extends the pattern to its own router)', () => {
    const routes = read('http/routes/log.routes.ts');

    const handlers = routes.split('\n').filter((line) => /logRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes.split('\n').filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions — `logs.export` gates a route of its own precisely so
    // the key covers a distinct code path rather than a flag on the list route.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Reports route (Stage 5 extends the pattern to its own router)', () => {
    const routes = read('http/routes/report.routes.ts');

    const handlers = routes.split('\n').filter((line) => /reportRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes.split('\n').filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions — `reports.view` and `reports.export` gate distinct
    // routes, the first enforcement site either key has ever had.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Documents route (Stage 6 extends the pattern to its own router)', () => {
    const routes = read('http/routes/document.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /documentRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions. `/render` and `/preview` guard `documents.render` here
    // and are checked AGAIN in the service for the subject's own view key,
    // which middleware cannot do because the subject is in the body — so a
    // guard count is necessary but not by itself sufficient, and the
    // second half is pinned by `document-render.integration.test.ts`.
    expect(guards.length).toBe(handlers.length);
    // Fourteen, not the thirteen `04-API-CONTRACT.md` §9.3 lists: the
    // contract gives the designer asset upload and fetch-by-id but no way to
    // discover what a tenant already has, so `GET /api/documents/assets` was
    // added alongside a matching `document:listAssets` command and Office
    // forwarding route. All three surfaces agree at fourteen.
    expect(handlers.length).toBe(14);
  });

  it('guards every panel-management route (`panels.manage` gates admission, revoke and rename)', () => {
    const routes = read('http/routes/panel.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /panelRoutes\.(get|post|put|delete|patch)\(/.test(line));
    const guards = routes.split('\n').filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Two exemptions, both read-only and both documented at the router's own
    // header: `GET /` (the shell's presence rail, for every signed-in session
    // regardless of what it administers) and `GET /pairing-window` (this
    // Master's own transient state, not company data).
    expect(guards.length).toBe(handlers.length - 2);
  });

  it('guards the identity route (`settings.manage`); leaves first-run and restore open', () => {
    const routes = read('http/routes/setup.routes.ts');

    // First-run and restore run before any user exists to hold a permission,
    // so only `GET /identity` — re-readable later, once a session exists — is
    // gated. Matched by name rather than by counting `setupRoutes.` calls,
    // since most of this router is deliberately unauthenticated.
    const identityRoute = routes.split(/(?=setupRoutes\.)/).find((block) => block.includes("'/identity'"));
    expect(identityRoute).toBeDefined();
    expect(identityRoute).toContain("needs('settings.manage')");
  });
});
