import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_MAGIC,
  DISCOVERY_PROTOCOL_VERSION,
  createDiscoverMessage,
  createHelloMessage,
  decodeDiscoveryMessage,
  encodeDiscoveryMessage,
} from '../src/protocol/discovery.js';

describe('discovery protocol', () => {
  it('round-trips a DISCOVER message', () => {
    const message = createDiscoverMessage('nonce-1', 'front-desk');
    const decoded = decodeDiscoveryMessage(encodeDiscoveryMessage(message));

    expect(decoded).toEqual(message);
  });

  it('round-trips a HELLO message', () => {
    const message = createHelloMessage({
      nonce: 'nonce-1',
      masterUniqueId: 'e7c9c0a4-0000-4000-8000-000000000000',
      companyName: 'Shree Ceramics',
      lanIp: '192.168.1.10',
      httpPort: 4100,
      acceptingPairing: true,
    });

    expect(decodeDiscoveryMessage(encodeDiscoveryMessage(message))).toEqual(message);
  });

  it('preserves a null company name rather than dropping the field', () => {
    const message = createHelloMessage({
      nonce: 'n',
      masterUniqueId: 'm',
      companyName: null,
      lanIp: '10.0.0.2',
      httpPort: 4100,
      acceptingPairing: false,
    });

    const decoded = decodeDiscoveryMessage(encodeDiscoveryMessage(message));
    expect(decoded).toMatchObject({ companyName: null, acceptingPairing: false });
  });

  // The discovery port receives whatever else is broadcasting on the LAN.
  // Every one of these must return null instead of throwing, or a stray packet
  // would take down a panel's discovery socket.
  describe('rejects traffic that is not ours', () => {
    const cases: Array<[string, Buffer]> = [
      ['not JSON', Buffer.from('hello world')],
      ['empty buffer', Buffer.alloc(0)],
      ['JSON array', Buffer.from('[1,2,3]')],
      ['JSON null', Buffer.from('null')],
      ['JSON string', Buffer.from('"nope"')],
      ['object without magic', Buffer.from(JSON.stringify({ type: 'DISCOVER', nonce: 'x' }))],
      [
        'wrong magic',
        Buffer.from(
          JSON.stringify({ magic: 'SOMETHINGELSE', version: 1, type: 'DISCOVER', nonce: 'x', hostname: 'h' }),
        ),
      ],
      [
        'unknown type',
        Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            version: DISCOVERY_PROTOCOL_VERSION,
            type: 'GOODBYE',
            nonce: 'x',
          }),
        ),
      ],
      [
        'DISCOVER missing hostname',
        Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            version: DISCOVERY_PROTOCOL_VERSION,
            type: 'DISCOVER',
            nonce: 'x',
          }),
        ),
      ],
      [
        'HELLO missing port',
        Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            version: DISCOVERY_PROTOCOL_VERSION,
            type: 'HELLO',
            nonce: 'x',
            masterUniqueId: 'm',
            lanIp: '10.0.0.1',
            acceptingPairing: true,
          }),
        ),
      ],
      [
        'HELLO with port as a string',
        Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            version: DISCOVERY_PROTOCOL_VERSION,
            type: 'HELLO',
            nonce: 'x',
            masterUniqueId: 'm',
            lanIp: '10.0.0.1',
            httpPort: '4100',
            acceptingPairing: true,
          }),
        ),
      ],
      [
        'non-string nonce',
        Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            version: DISCOVERY_PROTOCOL_VERSION,
            type: 'DISCOVER',
            nonce: 42,
            hostname: 'h',
          }),
        ),
      ],
    ];

    it.each(cases)('%s', (_label, buffer) => {
      expect(decodeDiscoveryMessage(buffer)).toBeNull();
    });
  });

  it('rejects a different protocol version so mismatched builds do not pair', () => {
    const future = Buffer.from(
      JSON.stringify({
        magic: DISCOVERY_MAGIC,
        version: DISCOVERY_PROTOCOL_VERSION + 1,
        type: 'DISCOVER',
        nonce: 'x',
        hostname: 'h',
      }),
    );

    expect(decodeDiscoveryMessage(future)).toBeNull();
  });
});
