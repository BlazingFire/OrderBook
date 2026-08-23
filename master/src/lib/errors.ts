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
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'validation_error');
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
    super(`Missing permission: ${permission}`, 403, 'forbidden');
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
