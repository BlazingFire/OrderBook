/** What the JSON parser's refusals become over HTTP. */

import { describe, expect, it } from 'vitest';

import { bodyParserFailure } from '../src/index.js';

describe('bodyParserFailure', () => {
  it('answers 400 for malformed JSON and 413 for a body over the limit', () => {
    expect(bodyParserFailure({ type: 'entity.parse.failed', status: 400 })).toMatchObject({
      status: 400,
      messageKey: 'error.generic.malformedBody',
    });
    expect(bodyParserFailure({ type: 'entity.too.large', status: 413 })).toMatchObject({
      status: 413,
      messageKey: 'error.generic.tooLarge',
    });
    expect(bodyParserFailure({ type: 'encoding.unsupported', status: 415 })).toMatchObject({ status: 400 });
  });

  it('leaves every other error alone', () => {
    expect(bodyParserFailure(new Error('boom'))).toBeNull();
    expect(bodyParserFailure({ type: 'entity.parse.failed', status: 500 })).toBeNull();
    expect(bodyParserFailure(null)).toBeNull();
    expect(bodyParserFailure({ status: 400 })).toBeNull();
  });
});
