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
