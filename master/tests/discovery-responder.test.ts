/**
 * The discovery responder is a convenience: panels can always be paired by address and
 * password. A UDP port that cannot be bound (another program, a second Master, a range
 * Windows reserves) used to reject `startDiscoveryResponder`, which sits inside the Master's
 * boot, so the Master did not start at all (Connection audit M5).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

let failBind: Error | null = null;
const sockets: FakeSocket[] = [];

class FakeSocket {
  private handlers = new Map<string, Handler[]>();
  closed = false;
  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  once(event: string, handler: Handler): this {
    return this.on(event, handler);
  }
  removeAllListeners(event: string): this {
    this.handlers.delete(event);
    return this;
  }
  bind(_port: number, done: () => void): void {
    if (failBind) {
      const error = failBind;
      queueMicrotask(() => (this.handlers.get('error') ?? []).forEach((handler) => handler(error)));
    } else {
      queueMicrotask(done);
    }
  }
  setBroadcast(): void {}
  send(): void {}
  close(done?: () => void): void {
    this.closed = true;
    done?.();
  }
}

vi.mock('node:dgram', () => ({
  default: {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  },
}));

const { discoveryStatus, startDiscoveryResponder } = await import('../src/discovery/responder.js');

afterEach(() => {
  failBind = null;
  sockets.length = 0;
});

describe('startDiscoveryResponder', () => {
  it('starts, and says it is listening, when the port is free', async () => {
    const responder = await startDiscoveryResponder();
    expect(discoveryStatus()).toMatchObject({ listening: true, port: 45789, reason: null });
    await responder.stop();
    expect(discoveryStatus().listening).toBe(false);
  });

  it('does not reject when the port cannot be bound: it reports why and keeps the Master running', async () => {
    failBind = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:45789'), { code: 'EADDRINUSE' });
    const responder = await startDiscoveryResponder();
    expect(discoveryStatus()).toMatchObject({ listening: false });
    expect(discoveryStatus().reason).toContain('EADDRINUSE');
    expect(sockets.every((socket) => socket.closed)).toBe(true);
    await responder.stop();
  });
});
