/**
 * What a person types to name a Master by hand. The connection screen and the
 * Office server read it with the same function, so a value one lets through
 * cannot become a URL nobody meant.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MASTER_PORT, parseMasterAddress } from '../src/domain/master-address.js';

describe('parseMasterAddress', () => {
  it('reads an IPv4 address with a port field', () => {
    expect(parseMasterAddress('192.168.1.10', '4100')).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: 4100,
    });
    expect(parseMasterAddress('192.168.1.10', 4200)).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: 4200,
    });
  });

  it('uses the default port only when none was given, never because the one given was bad', () => {
    expect(parseMasterAddress('192.168.1.10', '')).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: DEFAULT_MASTER_PORT,
    });
    expect(parseMasterAddress('192.168.1.10')).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: DEFAULT_MASTER_PORT,
    });
    // Each of these used to become 4100 through `Number(port) || 4100`.
    for (const bad of ['abc', '4100abc', '0', '-1', '70000', '65536', '41.5', '4 100']) {
      expect(parseMasterAddress('192.168.1.10', bad)).toEqual({
        ok: false,
        problem: 'invalid_port',
      });
    }
  });

  it('accepts the edges of the port range', () => {
    expect(parseMasterAddress('10.0.0.1', '1')).toMatchObject({ ok: true, port: 1 });
    expect(parseMasterAddress('10.0.0.1', '65535')).toMatchObject({ ok: true, port: 65535 });
  });

  it('takes a port written after the address when the port field is empty', () => {
    expect(parseMasterAddress('192.168.1.10:4300', '')).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: 4300,
    });
    // The port field wins when both say something.
    expect(parseMasterAddress('192.168.1.10:4300', '4100')).toMatchObject({ port: 4100 });
    expect(parseMasterAddress('192.168.1.10:abc', '')).toEqual({
      ok: false,
      problem: 'invalid_port',
    });
  });

  it('forgives what people paste: a scheme, a path, spaces, a trailing dot', () => {
    expect(parseMasterAddress('  http://192.168.1.10:4100/  ', '')).toEqual({
      ok: true,
      host: '192.168.1.10',
      port: 4100,
    });
    expect(parseMasterAddress('http://shop-master/app?x=1', '')).toEqual({
      ok: true,
      host: 'shop-master',
      port: 4100,
    });
    expect(parseMasterAddress('SHOP-MASTER.', '')).toMatchObject({ ok: true, host: 'SHOP-MASTER' });
  });

  it('accepts a PC name', () => {
    expect(parseMasterAddress('shop-master', '')).toMatchObject({ ok: true, host: 'shop-master' });
    expect(parseMasterAddress('master.local', '')).toMatchObject({
      ok: true,
      host: 'master.local',
    });
    expect(parseMasterAddress('localhost', '4100')).toMatchObject({ ok: true, host: 'localhost' });
  });

  it('refuses what is not an address', () => {
    expect(parseMasterAddress('', '4100')).toEqual({ ok: false, problem: 'empty' });
    expect(parseMasterAddress('   ', '')).toEqual({ ok: false, problem: 'empty' });
    expect(parseMasterAddress('http://', '')).toEqual({ ok: false, problem: 'empty' });
    for (const bad of [
      '999.1.1.1',
      '192.168.1',
      '192.168.1.1.1',
      '0.0.0.0',
      'a b',
      'master_pc',
      '-master',
      'master-',
      '::1',
      'fe80::1',
      '192.168.1.10:41:00',
    ]) {
      expect(parseMasterAddress(bad, ''), bad).toEqual({ ok: false, problem: 'invalid_host' });
    }
  });
});
