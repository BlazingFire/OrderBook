import { describe, expect, it } from 'vitest';

import { DEFAULT_RELEASES_REPO, releasesRepo } from '../src/domain/release-keys.js';

describe('releasesRepo (1.4)', () => {
  it('defaults to the public releases repository', () => {
    expect(DEFAULT_RELEASES_REPO).toBe('BlazingFire/OrderBook-Releases');
    expect(releasesRepo({})).toBe('BlazingFire/OrderBook-Releases');
    expect(releasesRepo({ NODE_ENV: 'production' })).toBe('BlazingFire/OrderBook-Releases');
  });

  it('lets .env point elsewhere, and trims it', () => {
    expect(releasesRepo({ ORDERBOOK_RELEASES_GITHUB_REPO: ' me/other ' })).toBe('me/other');
  });

  it('switches fetching off when it is set to nothing, for an air-gapped site', () => {
    expect(releasesRepo({ ORDERBOOK_RELEASES_GITHUB_REPO: '' })).toBeNull();
    expect(releasesRepo({ ORDERBOOK_RELEASES_GITHUB_REPO: '   ' })).toBeNull();
  });

  it('is off under tests, so no suite reaches for the network', () => {
    expect(releasesRepo({ NODE_ENV: 'test' })).toBeNull();
    expect(releasesRepo({ NODE_ENV: 'test', ORDERBOOK_RELEASES_GITHUB_REPO: 'a/b' })).toBe('a/b');
  });
});
