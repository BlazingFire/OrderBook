/**
 * A request body or an error that carries a credential (`previousPanelSecret`, `pairingPassword`) must
 * not reach the console or a log file. Nothing logs a request body today; this keeps it that way.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, redactSecrets } from '../src/lib/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('redactSecrets', () => {
  it('replaces credential-named properties at any depth, and keeps the rest', () => {
    const body = {
      mode: 'manual',
      panelName: 'Front desk',
      pairingPassword: 'hunter2-hunter2',
      nested: { previousPanelSecret: 'old-secret-value', list: [{ apiKey: 'k', fine: 1 }] },
    };
    const text = JSON.stringify(redactSecrets(body));
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('old-secret-value');
    expect(text).toContain('Front desk');
    expect(text).toContain('"fine":1');
    expect(body.pairingPassword).toBe('hunter2-hunter2');
  });

  it('keeps an error\'s message and stack while redacting what it carries', () => {
    const error = Object.assign(new Error('pairing failed'), { body: { previousPanelSecret: 'old-secret-value' } });
    const copy = redactSecrets(error) as Error & { body: Record<string, unknown> };
    expect(copy.message).toBe('pairing failed');
    expect(copy.stack).toBe(error.stack);
    expect(JSON.stringify(copy.body)).not.toContain('old-secret-value');
  });
});

describe('the logger', () => {
  it('writes no credential from the detail it is given', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createLogger('pairing').error('Could not pair', { body: { previousPanelSecret: 'old-secret-value', pairingPassword: 'pw-pw-pw-pw' } });
    const written = JSON.stringify(error.mock.calls);
    expect(written).not.toContain('old-secret-value');
    expect(written).not.toContain('pw-pw-pw-pw');
    expect(written).toContain('[redacted]');
  });
});
