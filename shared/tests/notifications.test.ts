/**
 * The notification kinds and the long-offline rule both panels and the Master
 * read from `notifications.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  EN_MESSAGES,
  LONG_OFFLINE_MS,
  NOTIFICATION_KINDS,
  isLongOffline,
  isNotificationKind,
  type OfficePanelWithPresence,
} from '../src/index.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function panel(overrides: Partial<OfficePanelWithPresence>): OfficePanelWithPresence {
  return {
    status: 'active',
    isConnected: false,
    lastSeenAt: new Date(NOW - LONG_OFFLINE_MS).toISOString(),
    ...overrides,
  } as OfficePanelWithPresence;
}

describe('notification kinds', () => {
  it('each has an English message, and a shape the table accepts', () => {
    for (const kind of NOTIFICATION_KINDS) {
      // The `user_notifications.kind` CHECK constraint.
      expect(kind).toMatch(/^[a-z]+[.][a-zA-Z]+$/);
      expect(EN_MESSAGES).toHaveProperty(`notification.${kind}`);
    }
  });

  it('isNotificationKind accepts only the listed kinds', () => {
    expect(isNotificationKind('panel.offlineLong')).toBe(true);
    expect(isNotificationKind('panel.offline')).toBe(false);
    expect(isNotificationKind(undefined)).toBe(false);
  });
});

describe('isLongOffline', () => {
  it('counts an active panel away for the full hour', () => {
    expect(isLongOffline(panel({}), NOW)).toBe(true);
    expect(isLongOffline(panel({ lastSeenAt: new Date(NOW - LONG_OFFLINE_MS + 1).toISOString() }), NOW)).toBe(false);
  });

  it('never counts a connected, revoked or never-seen panel', () => {
    expect(isLongOffline(panel({ isConnected: true }), NOW)).toBe(false);
    expect(isLongOffline(panel({ status: 'revoked' }), NOW)).toBe(false);
    expect(isLongOffline(panel({ lastSeenAt: null }), NOW)).toBe(false);
    expect(isLongOffline(panel({ lastSeenAt: 'not a date' }), NOW)).toBe(false);
  });
});
