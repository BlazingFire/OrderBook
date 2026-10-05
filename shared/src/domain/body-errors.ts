/**
 * A request body the JSON parser refused (malformed, too large, wrong encoding), as the
 * HTTP answer it deserves. Without this the parser's own error fell through to the
 * generic handler and answered 500 "something went wrong on the server" for what is the
 * caller's mistake.
 */

export interface BodyFailureAnswer {
  status: 400 | 413;
  error: 'invalid_request' | 'payload_too_large';
  message: string;
  messageKey: 'error.generic.malformedBody' | 'error.generic.tooLarge';
}

export function bodyParserFailure(error: unknown): BodyFailureAnswer | null {
  const failure = error as { type?: unknown; status?: unknown } | null;
  if (typeof failure?.type !== 'string' || typeof failure.status !== 'number') return null;
  if (failure.status < 400 || failure.status > 499) return null;

  if (failure.type === 'entity.too.large') {
    return {
      status: 413,
      error: 'payload_too_large',
      message: 'That request is too large',
      messageKey: 'error.generic.tooLarge',
    };
  }
  if (failure.type.startsWith('entity.') || failure.type.endsWith('.unsupported')) {
    return {
      status: 400,
      error: 'invalid_request',
      message: 'That request could not be read',
      messageKey: 'error.generic.malformedBody',
    };
  }
  return null;
}
