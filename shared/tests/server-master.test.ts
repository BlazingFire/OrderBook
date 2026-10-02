/**
 * The Server Master tier's shared primitives: where it ranks, that it holds
 * every key, and the master-key constants both panels read. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  DUMMY_SERVER_MASTERS,
  MASTER_KEY_HASH,
  MASTER_KEY_TOKEN_HEADER,
  MASTER_KEY_TOKEN_TTL_MS,
  PERMISSIONS,
  ROLE_TIERS,
  SERVER_MASTER_MIN_ACTIVE,
  SERVER_MASTER_TIER,
  SUGGESTED_SERVER_MASTER_USERNAMES,
  allPermissions,
  buildPermissionCatalogue,
  effectivePermissions,
  isPermittedForTier,
  isRoleTier,
  isServerMasterTier,
  keysAboveTier,
  tierRank,
} from '../src/index.js';

describe('the Server Master tier', () => {
  it('is the last tier, so it outranks every other', () => {
    expect(ROLE_TIERS).toEqual(['office', 'management', 'admin', 'server_master']);
    expect(tierRank('office')).toBeLessThan(tierRank('management'));
    expect(tierRank('management')).toBeLessThan(tierRank('admin'));
    expect(tierRank('admin')).toBeLessThan(tierRank('server_master'));
  });

  it('is recognised as a tier and named by one constant', () => {
    expect(SERVER_MASTER_TIER).toBe('server_master');
    expect(isRoleTier('server_master')).toBe(true);
    expect(isServerMasterTier('server_master')).toBe(true);
    for (const tier of ['office', 'management', 'admin', 'bogus', undefined]) {
      expect(isServerMasterTier(tier)).toBe(false);
    }
  });

  it('may hold every key, so its effective set is the whole catalogue', () => {
    for (const permission of PERMISSIONS) {
      expect(isPermittedForTier(permission, 'server_master')).toBe(true);
    }
    expect(effectivePermissions(allPermissions(), 'server_master')).toEqual(allPermissions());
    expect(keysAboveTier(allPermissions(), 'server_master')).toEqual([]);
  });

  it('holds at least everything an admin may', () => {
    for (const permission of PERMISSIONS) {
      if (isPermittedForTier(permission, 'admin')) {
        expect(isPermittedForTier(permission, 'server_master')).toBe(true);
      }
    }
  });

  it('is served in the catalogue tier list (the UI filters it out of its own picker)', () => {
    expect(buildPermissionCatalogue().tiers).toContain('server_master');
  });
});

describe('the master key constants', () => {
  it('stores the key as an scrypt hash in the same form as the developer password', () => {
    expect(MASTER_KEY_HASH).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('carries the header, a short token lifetime and the two-account rule', () => {
    expect(MASTER_KEY_TOKEN_HEADER).toBe('x-master-key-token');
    expect(MASTER_KEY_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
    expect(SERVER_MASTER_MIN_ACTIVE).toBe(2);
    expect(SUGGESTED_SERVER_MASTER_USERNAMES).toEqual(['master', 'master-backup']);
  });

  it('documents two dummy Server Masters with the suggested usernames', () => {
    expect(DUMMY_SERVER_MASTERS.map((spec) => spec.username)).toEqual([...SUGGESTED_SERVER_MASTER_USERNAMES]);
    for (const spec of DUMMY_SERVER_MASTERS) expect(spec.tier).toBe('server_master');
  });
});
