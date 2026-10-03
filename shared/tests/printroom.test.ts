/**
 * The Printroom's pure rules: what a send may say, who counts as online, the
 * query a screen sends, and that the two keys, the notification and the protocol
 * number are wired the way the Master and both panels read them.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  COMMAND_MIN_PROTOCOL,
  EN_MESSAGES,
  HI_MESSAGES,
  MAX_PRINT_COPIES,
  NOTIFICATION_KINDS,
  PANEL_PROTOCOL_VERSION,
  PRINTROOM_MIN_PROTOCOL,
  PRINT_LIMITS,
  ROLE_TEMPLATES,
  cleanPrintJobInput,
  isWaiting,
  minimumTierFor,
  normalisePrintQuery,
  panelStationKey,
  parsePrintCopies,
  stationOnline,
} from '../src/index.js';

const VALID = {
  requestId: 'a'.repeat(32),
  kind: 'dispatch',
  source: 'lead',
  sourceId: 'LD0000000042',
  copies: 3,
};

describe('cleanPrintJobInput', () => {
  it('accepts a send and fills what was left out', () => {
    expect(cleanPrintJobInput(VALID)).toEqual({
      value: { ...VALID, targetStationId: null, vehicleNumber: null, note: null },
    });
  });

  it('cleans the vehicle number and keeps it only for a Dispatch note', () => {
    const dispatch = cleanPrintJobInput({ ...VALID, vehicleNumber: ' gj 01 ab-1234!! ' });
    expect('value' in dispatch && dispatch.value.vehicleNumber).toBe('GJ 01 AB-1234');
    const filling = cleanPrintJobInput({ ...VALID, kind: 'filling', vehicleNumber: 'GJ 01' });
    expect('value' in filling && filling.value.vehicleNumber).toBeNull();
  });

  it('trims the message, drops a blank one and refuses one over the limit', () => {
    const trimmed = cleanPrintJobInput({ ...VALID, note: '  Urgent  ' });
    expect('value' in trimmed && trimmed.value.note).toBe('Urgent');
    const blank = cleanPrintJobInput({ ...VALID, note: '   ' });
    expect('value' in blank && blank.value.note).toBeNull();
    expect(cleanPrintJobInput({ ...VALID, note: 'x'.repeat(PRINT_LIMITS.noteMax + 1) })).toEqual({
      errorKey: 'validation.print.note',
    });
    expect(cleanPrintJobInput({ ...VALID, note: 7 })).toEqual({ errorKey: 'validation.print.note' });
  });

  it.each([
    [{ requestId: 'A'.repeat(32) }, 'validation.print.requestId'],
    [{ requestId: 'a'.repeat(31) }, 'validation.print.requestId'],
    [{ requestId: 5 }, 'validation.print.requestId'],
    [{ kind: 'invoice' }, 'validation.print.kind'],
    [{ source: 'party' }, 'validation.print.source'],
    [{ sourceId: '' }, 'validation.print.source'],
    [{ sourceId: 'LD 1; DROP' }, 'validation.print.source'],
    [{ copies: 0 }, 'validation.print.copies'],
    [{ copies: MAX_PRINT_COPIES + 1 }, 'validation.print.copies'],
    [{ copies: 1.5 }, 'validation.print.copies'],
    [{ copies: '2' }, 'validation.print.copies'],
    [{ targetStationId: 'main-printer' }, 'validation.print.station'],
    [{ vehicleNumber: 'A'.repeat(21) }, 'validation.print.vehicle'],
    [{ vehicleNumber: 12 }, 'validation.print.vehicle'],
  ] as const)('refuses %j', (override, errorKey) => {
    expect(cleanPrintJobInput({ ...VALID, ...override })).toEqual({ errorKey });
  });

  it('refuses nothing and no object alike', () => {
    expect(cleanPrintJobInput(null)).toEqual({ errorKey: 'validation.print.requestId' });
    expect(cleanPrintJobInput('x')).toEqual({ errorKey: 'validation.print.requestId' });
  });
});

describe('parsePrintCopies', () => {
  it('takes a whole number from 1 to 50 and nothing else, rounding nothing', () => {
    expect(parsePrintCopies(1)).toBe(1);
    expect(parsePrintCopies(50)).toBe(50);
    for (const bad of [0, 51, -1, 2.5, '3', null, undefined, Number.NaN, Infinity]) {
      expect(parsePrintCopies(bad)).toBeNull();
    }
  });
});

describe('stationOnline', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  it('is online within 90 seconds of the last beat, and not after', () => {
    expect(stationOnline(new Date(now - 90_000).toISOString(), now)).toBe(true);
    expect(stationOnline(new Date(now - 90_001).toISOString(), now)).toBe(false);
    expect(stationOnline(null, now)).toBe(false);
    expect(stationOnline('garbage', now)).toBe(false);
  });

  it('beats more often than it expires', () => {
    expect(PRINT_LIMITS.stationBeatMs).toBeLessThan(PRINT_LIMITS.stationOnlineMs);
    expect(PRINT_LIMITS.claimStaleMs).toBe(10 * 60 * 1000);
  });
});

describe('normalisePrintQuery', () => {
  it('defaults to the Waiting list and a page, and clamps what it is given', () => {
    expect(normalisePrintQuery(undefined)).toEqual({ status: 'waiting', mine: false, cursor: null, limit: PRINT_LIMITS.pageSize });
    expect(normalisePrintQuery({ status: 'bogus', limit: 100000, cursor: '' }).limit).toBe(PRINT_LIMITS.pageMax);
    expect(normalisePrintQuery({ status: 'bogus' }).status).toBe('waiting');
    expect(normalisePrintQuery({ limit: 0 }).limit).toBe(1);
    expect(normalisePrintQuery({ status: 'printed', mine: true, cursor: '5:x', limit: 10 })).toEqual({
      status: 'printed',
      mine: true,
      cursor: '5:x',
      limit: 10,
    });
  });
});

describe('statuses and keys', () => {
  it('counts queued and printing as waiting for paper', () => {
    expect(isWaiting('queued')).toBe(true);
    expect(isWaiting('printing')).toBe(true);
    expect(isWaiting('printed')).toBe(false);
    expect(isWaiting('cancelled')).toBe(false);
  });

  it('names a panel\'s station from its id, so the key can never be a body field', () => {
    expect(panelStationKey('abc')).toBe('panel:abc');
  });

  it('defines print.send and print.station for the office tier, in the workflow group', () => {
    for (const key of ['print.send', 'print.station'] as const) {
      expect(CAPABILITIES.find((capability) => capability.key === key)).toMatchObject({ group: 'workflow' });
      expect(minimumTierFor(key)).toBe('office');
      expect(EN_MESSAGES).toHaveProperty(`permission.${key}`);
      expect(HI_MESSAGES).toHaveProperty(`permission.${key}`);
    }
    // The label says what the grant means.
    expect(EN_MESSAGES['permission.print.station']).toMatch(/every party/i);
  });

  it('offers print.send to the Sales and Dispatch templates, and print.station to Dispatch only', () => {
    const templates = Object.fromEntries(ROLE_TEMPLATES.map((template) => [template.nameToken, template.permissions]));
    expect(templates['roleTemplate.sales']).toContain('print.send');
    expect(templates['roleTemplate.sales']).not.toContain('print.station');
    expect(templates['roleTemplate.dispatch']).toEqual(expect.arrayContaining(['print.send', 'print.station']));
  });
});

describe('the wire', () => {
  it('puts all eight commands behind the Printroom protocol, and that is the protocol the panels speak', () => {
    const commands = [
      'print:list',
      'print:get',
      'print:send',
      'print:mark',
      'print:cancel',
      'print:claim',
      'print:stations',
      'print:station',
    ] as const;
    for (const command of commands) expect(COMMAND_MIN_PROTOCOL[command]).toBe(PRINTROOM_MIN_PROTOCOL);
    expect(PRINTROOM_MIN_PROTOCOL).toBe(6);
    expect(PANEL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(PRINTROOM_MIN_PROTOCOL);
  });

  it('adds the bell kind with its English and Hindi sentences', () => {
    expect(NOTIFICATION_KINDS).toContain('print.printed');
    expect(EN_MESSAGES['notification.print.printed']).toContain('{party}');
    expect(HI_MESSAGES['notification.print.printed']).toContain('{party}');
  });
});
