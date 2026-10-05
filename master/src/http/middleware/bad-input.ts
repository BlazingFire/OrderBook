import type { NextFunction, Request, Response } from 'express';

import { ValidationError } from '../../lib/errors.js';

/**
 * PostgreSQL's "the value you gave cannot be that type" family, all of which a
 * caller causes and none of which is the server's fault:
 * 22P02 bad text for a type (a non-uuid id), 22003 number out of range,
 * 22007 / 22008 bad date or time, 22001 value too long, 22021 invalid byte
 * sequence (a NUL character in a string).
 */
const BAD_INPUT_CODES: ReadonlySet<string> = new Set(['22P02', '22003', '22007', '22008', '22001', '22021']);

/**
 * Express's own "Failed to decode param" (a malformed percent-escape such as
 * `/api/orders/%E0%A4%A`): a URIError carrying `status: 400` that the generic
 * handler used to ignore and answer 500.
 */
export function isUriDecodeError(error: unknown): boolean {
  return (
    error instanceof URIError ||
    (error instanceof Error && /^Failed to decode param/.test(error.message))
  );
}

export function isBadInputError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && BAD_INPUT_CODES.has(code)) || isUriDecodeError(error);
}

/**
 * Before `errorHandler`: turns such a database error into a 400. Routes check
 * what they know to check; this is for the id, date or string that reached a
 * query nobody thought to guard, which used to come back as a 500.
 */
export function badInputHandler(
  error: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(isBadInputError(error) ? new ValidationError('validation.request.badInput') : error);
}
