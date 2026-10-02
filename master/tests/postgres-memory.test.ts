/**
 * The bundled cluster's memory flags (`pgMemoryOptions` in
 * `src/db/postgres-server.ts`). Pure: the flags are worked out from the PC's
 * RAM and never need a running PostgreSQL to check.
 */

import { describe, expect, it } from 'vitest';

import { POOL_MAX } from '../src/db/knex.js';
import { pgMemoryOptions } from '../src/db/postgres-server.js';

const GB = 1024;

function setting(options: string[], name: string): string | undefined {
  const flag = options.find((option) => option.startsWith(`-c ${name}=`));
  return flag?.slice(`-c ${name}=`.length);
}

describe('pgMemoryOptions', () => {
  it('leaves room for the whole knex pool plus ten on every PC', () => {
    for (const totalMb of [3 * GB, 4 * GB, 4608, 4609, 8 * GB, 64 * GB]) {
      const maxConnections = Number(setting(pgMemoryOptions(totalMb), 'max_connections'));
      expect(maxConnections).toBeGreaterThanOrEqual(POOL_MAX + 10);
    }
  });

  it('shrinks the memory settings on a PC with 4.5 GB or less', () => {
    for (const totalMb of [3 * GB, 4 * GB, 4608]) {
      const options = pgMemoryOptions(totalMb);
      expect(setting(options, 'shared_buffers')).toBe('64MB');
      expect(setting(options, 'work_mem')).toBe('2MB');
      expect(setting(options, 'effective_cache_size')).toBe('512MB');
    }
  });

  it('keeps PostgreSQL’s own memory defaults on a bigger PC', () => {
    const options = pgMemoryOptions(8 * GB);
    expect(setting(options, 'shared_buffers')).toBeUndefined();
    expect(setting(options, 'work_mem')).toBeUndefined();
  });

  it('writes every flag the way pg_ctl --options passes it on', () => {
    for (const option of [...pgMemoryOptions(4 * GB), ...pgMemoryOptions(16 * GB)]) {
      expect(option).toMatch(/^-c [a-z_]+=\w+$/);
    }
  });
});
