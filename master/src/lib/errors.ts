/**
 * Application error types. Transport layers (HTTP routes, socket handlers)
 * translate these into status codes / command failures — services throw them
 * without knowing which transport is calling.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    /**
     * Structured facts about the failure, for a client to act on.
     *
     * The rule the guides state is "branch on the `code`, never on the message"
     * (`roles-software-flow.md` §13). That is only possible if the things a
     * client needs travel as data: which permission was missing, what version is
     * actually stored, which fields differ. They were being attached by the
     * domain layer and then dropped by the HTTP transport, so a UI that wanted
     * to name the missing permission had to read English prose — or, in
     * practice, gave up and said nothing.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'validation_error', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Not signed in') {
    super(message, 401, 'unauthorized');
  }
}

/**
 * A caller was authenticated but lacked a permission.
 *
 * Carries the permission key as well as putting it in the message, so a client
 * can react to it (hide the control, prompt for a different sign-in) rather
 * than having to parse prose.
 */
export class ForbiddenError extends AppError {
  constructor(readonly permission: string) {
    super(`Missing permission: ${permission}`, 403, 'forbidden', { permission });
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
    super(`${what} does not belong to this company`, 403, 'tenant_violation');
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, 'conflict', details);
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
