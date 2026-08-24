/**
 * Application error types. Transport layers (HTTP routes, socket handlers)
 * translate these into status codes / command failures — services throw them
 * without knowing which transport is calling.
 *
 * `messageKey` is a REQUIRED constructor argument (`docs/backend-modules/09-I18N.md`
 * §7, Option A) — the server never renders a user-facing sentence, it names a
 * stable token plus named params, and `message` is *derived* from the English
 * catalogue so it stays byte-identical to what existing tests already assert.
 * The alternative — optional, with a coarse `error.<code>` fallback forever —
 * was rejected because it makes an untranslated error permanently possible,
 * which is the same shape of defect `HANDOFF.md` already names as a trap: "a
 * permission that enforces nothing is worse than a missing one".
 */

import { t, type MessageKey, type MessageParams } from '@orderbook/shared';

export class AppError extends Error {
  constructor(
    readonly messageKey: MessageKey,
    readonly params: MessageParams,
    readonly statusCode: number,
    readonly code: string,
    /**
     * Structured facts about the failure, for a client to act on.
     *
     * The rule the guides state is "branch on the `code`, never on the message"
     * (`roles-software-flow.md` §13). That is only possible if the things a
     * client needs travel as data: which permission was missing, what version is
     * actually stored, which fields differ.
     */
    readonly details?: Record<string, unknown>,
  ) {
    // `params as never` is deliberate: at this generic boundary `messageKey`
    // is widened to the whole `MessageKey` union, so `ParamsFor<K>` cannot be
    // checked per-call the way a literal `t('en', 'some.key', {...})` call
    // can be. Each throw site below still names a real token; this cast only
    // waives the per-site placeholder check at the point where the message is
    // derived, not the requirement to name a token at all.
    super(t('en', messageKey, params as never));
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(messageKey: MessageKey, params: MessageParams = {}, details?: Record<string, unknown>) {
    super(messageKey, params, 400, 'validation_error', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(messageKey: MessageKey = 'error.unauthorized', params: MessageParams = {}) {
    super(messageKey, params, 401, 'unauthorized');
  }
}

/**
 * A caller was authenticated but lacked a permission.
 *
 * Carries the permission key as well as putting it in `details`, so a client
 * can react to it (hide the control, prompt for a different sign-in) rather
 * than having to parse prose.
 */
export class ForbiddenError extends AppError {
  constructor(readonly permission: string) {
    super('error.forbidden.missingPermission', { permission }, 403, 'forbidden', { permission });
  }
}

/**
 * A role or user id belonging to another company.
 *
 * Distinct from `NotFoundError` on purpose, and logged at error level: a client
 * asking for an id it cannot possibly have seen is either a bug worth finding or
 * a probe worth noticing, and "404" makes both invisible.
 */
export class TenantViolationError extends AppError {
  constructor(what: string) {
    super('error.tenantViolation', { what }, 403, 'tenant_violation');
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('error.notFound', { what }, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(messageKey: MessageKey, params: MessageParams = {}, details?: Record<string, unknown>) {
    super(messageKey, params, 409, 'conflict', details);
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
