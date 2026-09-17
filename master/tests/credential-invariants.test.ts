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
const SHARED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'shared',
  'src',
);

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

    const handlers = routes
      .split('\n')
      .filter((line) => /accessRoutes\.(get|post|put|delete)\(/.test(line));
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

    const handlers = routes
      .split('\n')
      .filter((line) => /recycleBinRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions here — including the `POST /restore` route, whose guard
    // is deliberately the weaker `recycleBin.view` because the entity type
    // travels in the body and only the service can resolve which delete key
    // actually applies.
    expect(guards.length).toBe(handlers.length);
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
    const guards = routes.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      return line.includes('needs(');
    });

    // Every Fields endpoint is gated by `fields.view` or `fields.manage` — the
    // `- 2` exemption above is specific to `access.routes.ts`'s two genuinely
    // ungated routes and must never be copied here or generalised into a loop
    // over routers. The three pre-existing ungated reads (`GET /api/pipelines`,
    // `/api/option-lists`, `/api/custom-fields`) are a deliberately separate
    // surface on `data.routes.ts`, not on this router.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Logs route (Stage 4 extends the pattern to its own router)', () => {
    const routes = read('http/routes/log.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /logRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Zero exemptions — `logs.export` gates a route of its own precisely so
    // the key covers a distinct code path rather than a flag on the list route.
    expect(guards.length).toBe(handlers.length);
  });

  it('guards every Reports route (Stage 5 extends the pattern to its own router)', () => {
    const routes = read('http/routes/report.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /reportRoutes\.(get|post|put|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

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
    // Fifteen, not the thirteen `04-API-CONTRACT.md` §9.3 lists: the
    // contract gives the designer asset upload and fetch-by-id but no way to
    // discover what a tenant already has, so `GET /api/documents/assets` was
    // added alongside a matching `document:listAssets` command and Office
    // forwarding route — and no way to remove a wrong upload, so
    // `DELETE /api/documents/assets/:id` was added the same way, alongside
    // `document:deleteAsset` and its own Office forwarding route. All three
    // surfaces agree at fifteen.
    expect(handlers.length).toBe(15);
  });

  it('guards every panel-management route (`panels.manage` gates admission, revoke and rename)', () => {
    const routes = read('http/routes/panel.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /panelRoutes\.(get|post|put|delete|patch)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // Two exemptions, both read-only and both documented at the router's own
    // header: `GET /` (the shell's presence rail, for every signed-in session
    // regardless of what it administers) and `GET /pairing-window` (this
    // Master's own transient state, not company data).
    expect(guards.length).toBe(handlers.length - 2);
  });

  /*
   * The API key's digest is the third credential in this codebase, and it gets
   * the same greppable treatment as the first two: a rule stated in a comment
   * stops being true quietly, so something mechanical checks it.
   */
  it('never declares an API key token on the shape the browser receives', () => {
    // Comments stripped first: this file's header explains at length what it
    // does not declare, and a test that read prose would fail on the
    // explanation rather than on the code.
    const shape = readFileSync(path.join(SHARED, 'domain', 'api-keys.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // Not the value and not the digest. The plaintext exists for exactly one
    // response, and `IssuedApiKey` — a separate type, in the service — is where
    // that one response is typed.
    expect(shape).not.toMatch(/\btoken\s*[?]?:/);
    expect(shape).not.toMatch(/tokenHash/);
  });

  it('strips the digest in the mapper rather than trusting the type to hide it', () => {
    const repository = read('repositories/api-key.repository.ts');

    // Destructured away, so adding a column to the row type cannot silently
    // start returning it — the same discipline as the panel secret above.
    expect(repository).toContain('const { token_hash: _hash, ...rest } = row;');
  });

  it('guards every integration route (`api.manage` gates keys and connections)', () => {
    const routes = read('http/routes/integration.routes.ts');

    const handlers = routes
      .split('\n')
      .filter((line) => /integrationRoutes\.(get|post|put|patch|delete)\(/.test(line));
    const guards = routes
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('needs('));

    // No exemptions. Every one of these either mints a credential, points this
    // Master at another system, or reads what those did.
    expect(handlers.length).toBeGreaterThan(0);
    expect(guards.length).toBe(handlers.length);
  });

  it('guards the identity route (`settings.manage`); leaves first-run and restore open', () => {
    const routes = read('http/routes/setup.routes.ts');

    // First-run and restore run before any user exists to hold a permission,
    // so only `GET /identity` — re-readable later, once a session exists — is
    // gated. Matched by name rather than by counting `setupRoutes.` calls,
    // since most of this router is deliberately unauthenticated.
    const identityRoute = routes
      .split(/(?=setupRoutes\.)/)
      .find((block) => block.includes("'/identity'"));
    expect(identityRoute).toBeDefined();
    expect(identityRoute).toContain("needs('settings.manage')");
  });
});

describe('the password minimum', () => {
  /**
   * Every function in `services/` that hashes a password, and what it hashes.
   *
   * Split on every top-level declaration, exported or not, because the rule is
   * per-function: a check five functions up the file is not a check. `export`
   * alone would not do — the bcrypt rewrite lives in `attemptSignIn`, which is
   * private, and would be read as part of `signIn` above it.
   */
  function blocksThatHash(relative: string): Array<{ name: string; body: string }> {
    return read(relative)
      .split(/(?=^(?:export )?(?:async )?function )/m)
      .filter((block) => countCalls(block, 'hashPassword') > 0)
      .map((block) => ({
        name: /^(?:export )?(?:async )?function (\w+)/.exec(block)?.[1] ?? '(module scope)',
        body: block,
      }));
  }

  /**
   * The two that hash a password nobody typed. Both are exempt for a reason
   * that would survive review, and both are named here rather than skipped by
   * a pattern, so a third one has to be argued for.
   */
  const HASHES_NOTHING_A_CALLER_CHOSE: Record<string, string> = {
    // The bcrypt→scrypt rewrite on sign-in. The password is already correct
    // and already stored; refusing it here would lock out every account
    // created before the minimum existed.
    attemptSignIn: 'services/auth.service.ts',
    // Fixed developer-mode fixtures from `DUMMY_USERS`, not caller input.
    seedDummyUsers: 'services/developer.service.ts',
  };

  it('is applied wherever a caller-supplied password is hashed', () => {
    // `createUser` and `resetPassword` hashed `input.password` with no length
    // check at all, while `changeOwnPassword` enforced eight characters — so
    // the weaker of the two paths was the one that mints accounts.
    const unchecked: string[] = [];

    for (const relative of [
      'services/user.service.ts',
      'services/auth.service.ts',
      'services/developer.service.ts',
      'services/setup.service.ts',
    ]) {
      for (const { name, body } of blocksThatHash(relative)) {
        if (HASHES_NOTHING_A_CALLER_CHOSE[name] === relative) continue;
        if (countCalls(body, 'assertPasswordLongEnough') === 0) unchecked.push(`${name} (${relative})`);
      }
    }

    expect(unchecked).toEqual([]);
  });

  it('covers the three paths it is supposed to cover, so the list above cannot go empty', () => {
    // Without this, deleting every call site would satisfy the test above.
    const checked = [
      ...blocksThatHash('services/user.service.ts'),
      ...blocksThatHash('services/auth.service.ts'),
    ]
      .filter(({ body }) => countCalls(body, 'assertPasswordLongEnough') > 0)
      .map(({ name }) => name)
      .sort();

    expect(checked).toEqual(['changeOwnPassword', 'createUser', 'resetPassword']);
  });

  it('is checked on the supplied password, never on the generated fallback', () => {
    // `input.password?.trim() || generateTemporaryPassword()` collapses the
    // two into one variable. Checking *that* would enforce nothing: a
    // generated password is twelve characters and always passes, so a short
    // supplied one would be replaced by... itself, unchecked.
    const source = read('services/user.service.ts');

    for (const block of source.split(/(?=^(?:export )?(?:async )?function )/m)) {
      if (countCalls(block, 'generateTemporaryPassword') === 0) continue;

      const check = block.indexOf('assertPasswordLongEnough(');
      const fallback = block.indexOf('generateTemporaryPassword()');
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(fallback);
    }
  });
});
