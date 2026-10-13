/**
 * The shell's record of an update (1.5, `lib/update-run.ts`): written at the
 * hand-over, settled by the next start, and the source of the next estimate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { UpdateRunFile as SharedRunFile } from '@orderbook/shared';

import {
  abandonUpdateRun,
  beginUpdateRun,
  EMPTY_UPDATE_RUN,
  finishingLine,
  MAX_ESTIMATE_SECONDS,
  readUpdateRun,
  settleUpdateRun,
  writeUpdateRun,
  type UpdateRunFile,
} from '../lib/update-run.js';

const START = new Date('2026-10-13T10:00:00.000Z');
const after = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe('the record', () => {
  it('has the shape the page reads (shared UpdateRunFile)', () => {
    expectTypeOf<UpdateRunFile>().toEqualTypeOf<SharedRunFile>();
  });

  it('settles as updated, timed from the hand-over, when the new version starts', () => {
    const begun = beginUpdateRun(EMPTY_UPDATE_RUN, '1.4.9', '1.5.0', START);
    const settled = settleUpdateRun(begun, '1.5.0', after(102));
    expect(settled).toEqual({
      pending: null,
      last: {
        from: '1.4.9',
        to: '1.5.0',
        outcome: 'updated',
        startedAt: START.toISOString(),
        finishedAt: after(102).toISOString(),
        seconds: 102,
      },
      installSeconds: 102,
    });
  });

  it('settles as not installed when the old version starts again, keeping the last estimate', () => {
    const begun = beginUpdateRun(
      { ...EMPTY_UPDATE_RUN, installSeconds: 80 },
      '1.4.9',
      '1.5.0',
      START,
    );
    const settled = settleUpdateRun(begun, '1.4.9', after(300));
    expect(settled?.last).toMatchObject({ outcome: 'notInstalled', seconds: null });
    expect(settled?.installSeconds).toBe(80);
  });

  it('never makes an overnight gap the next estimate', () => {
    const begun = beginUpdateRun(
      { ...EMPTY_UPDATE_RUN, installSeconds: 95 },
      '1.4.9',
      '1.5.0',
      START,
    );
    const settled = settleUpdateRun(begun, '1.5.0', after(MAX_ESTIMATE_SECONDS + 1));
    expect(settled?.last?.seconds).toBe(MAX_ESTIMATE_SECONDS + 1);
    expect(settled?.installSeconds).toBe(95);
  });

  it('has nothing to settle without a hand-over, or after an abandoned one', () => {
    expect(settleUpdateRun(EMPTY_UPDATE_RUN, '1.5.0', START)).toBeNull();
    const abandoned = abandonUpdateRun(beginUpdateRun(EMPTY_UPDATE_RUN, '1.4.9', '1.5.0', START));
    expect(settleUpdateRun(abandoned, '1.5.0', START)).toBeNull();
  });

  it('gives the splash its line only on the start that runs the new version', () => {
    const begun = beginUpdateRun(EMPTY_UPDATE_RUN, '1.4.9', '1.5.0', START);
    expect(finishingLine(begun, '1.5.0')).toBe('Finishing the update to 1.5.0…');
    expect(finishingLine(begun, '1.4.9')).toBeNull();
    expect(finishingLine(EMPTY_UPDATE_RUN, '1.5.0')).toBeNull();
  });
});

describe('the file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-update-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips', () => {
    const file = path.join(dir, 'nested', 'update-run.json');
    const settled = settleUpdateRun(
      beginUpdateRun(EMPTY_UPDATE_RUN, '1.4.9', '1.5.0', START),
      '1.5.0',
      after(60),
    );
    writeUpdateRun(file, settled ?? EMPTY_UPDATE_RUN);
    expect(readUpdateRun(file)).toEqual(settled);
  });

  it('reads absent, corrupt or foreign content as empty', () => {
    const file = path.join(dir, 'update-run.json');
    expect(readUpdateRun(file)).toEqual(EMPTY_UPDATE_RUN);
    fs.writeFileSync(file, '{not json');
    expect(readUpdateRun(file)).toEqual(EMPTY_UPDATE_RUN);
    fs.writeFileSync(
      file,
      JSON.stringify({ pending: { from: 1 }, last: { outcome: 'maybe' }, installSeconds: -3 }),
    );
    expect(readUpdateRun(file)).toEqual(EMPTY_UPDATE_RUN);
  });
});

describe('the shell', () => {
  const shell = fs.readFileSync(path.join(import.meta.dirname, '..', 'shell.ts'), 'utf8');

  it('records the hand-over before it stops the server, and forgets it if the installer did not start', () => {
    const begin = shell.indexOf(
      'beginUpdateRun(readUpdateRun(updateRunPath()), app.getVersion(), prepared.version',
    );
    const stop = shell.indexOf('say(`Stopping the server before installing ${prepared.version}`)');
    expect(begin).toBeGreaterThan(0);
    expect(begin).toBeLessThan(stop);
    expect(shell).toMatch(
      /updatingSince = null;\s+writeUpdateRun\(updateRunPath\(\), abandonUpdateRun\(/,
    );
  });

  it('settles the record once the panel answers, and hands it only to its own window', () => {
    expect(shell).toContain("if (outcome.kind === 'ready') settleUpdate();");
    expect(shell).toMatch(
      /ipcMain\.handle\('orderbook:getUpdateRun', \(event\) =>\s+event\.sender === mainWindow\?\.webContents \? readUpdateRun\(updateRunPath\(\)\) : null/,
    );
  });
});
