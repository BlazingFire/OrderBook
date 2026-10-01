import { describe, expect, it } from 'vitest';

import { printOptions } from '../lib/print-options.js';

const INSTALLED = ['HP LaserJet', 'Microsoft Print to PDF'];

describe('printOptions', () => {
  it('prints straight to an installed printer', () => {
    expect(printOptions({ deviceName: 'HP LaserJet' }, INSTALLED)).toMatchObject({
      silent: true,
      deviceName: 'HP LaserJet',
      pageSize: 'A4',
      printBackground: true,
    });
  });

  it('opens the dialog when no printer is named', () => {
    expect(printOptions({}, INSTALLED).silent).toBe(false);
    expect(printOptions({ deviceName: '' }, INSTALLED).silent).toBe(false);
    expect(printOptions(null, INSTALLED).silent).toBe(false);
  });

  it('opens the dialog for a printer that is no longer installed', () => {
    const result = printOptions({ deviceName: 'Unplugged Epson' }, INSTALLED);
    expect(result.silent).toBe(false);
    expect(result.deviceName).toBeUndefined();
  });

  it('ignores a name that is not a string', () => {
    expect(printOptions({ deviceName: 42 }, INSTALLED).silent).toBe(false);
  });

  it('asks for no margins so the sheet is not scaled down', () => {
    expect(printOptions({}, INSTALLED).margins).toEqual({ marginType: 'none' });
  });
});
