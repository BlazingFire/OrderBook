import type { NextFunction, Request, Response } from 'express';

/**
 * Before `errorHandler`: Express's "Failed to decode param" (a malformed
 * percent-escape such as `/api/orders/%E0%A4%A`) is the caller's mistake, a
 * 400, not the 500 the generic handler used to answer.
 */
export function badRequestHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    error instanceof URIError ||
    (error instanceof Error && /^Failed to decode param/.test(error.message))
  ) {
    res.status(400).json({
      error: 'validation_error',
      message: 'Part of the request is not valid',
      messageKey: 'validation.request.badInput',
    });
    return;
  }
  next(error);
}
