/** Who may make this PC leave its Master: the rule alone, without a server. */

import { describe, expect, it } from 'vitest';

import { unpairAllowed } from '../src/services/unpair.service.js';

type Input = Parameters<typeof unpairAllowed>[0];
const base: Input = {
  signedIn: false,
  canManage: false,
  state: 'connected',
  notRecognised: false,
  discard: false,
};
const key = (over: Partial<Input>) => {
  const result = unpairAllowed({ ...base, ...over });
  return result.ok ? 'ok' : result.messageKey;
};

describe('unpairAllowed', () => {
  it('lets nobody leave a Master that is connected and knows this PC without signing in', () => {
    expect(key({})).toBe('connection.unpair.signInRequired');
  });

  it('lets anybody leave one that is gone or does not recognise this PC', () => {
    for (const state of ['disconnected', 'connecting', 'unpaired'] as const)
      expect(key({ state })).toBe('ok');
    expect(key({ notRecognised: true })).toBe('ok');
  });

  it('asks for panels.manage from a signed-in person, whatever the link says', () => {
    for (const over of [{}, { state: 'disconnected' as const }, { notRecognised: true }]) {
      expect(key({ ...over, signedIn: true })).toBe('connection.unpair.forbidden');
      expect(key({ ...over, signedIn: true, canManage: true })).toBe('ok');
    }
  });

  it('never discards unsent work without that right', () => {
    expect(key({ state: 'disconnected', notRecognised: true, discard: true })).toBe(
      'connection.unpair.discardNeedsSignIn',
    );
    expect(key({ signedIn: true, discard: true })).toBe('connection.unpair.forbidden');
    expect(key({ signedIn: true, canManage: true, discard: true })).toBe('ok');
  });
});
