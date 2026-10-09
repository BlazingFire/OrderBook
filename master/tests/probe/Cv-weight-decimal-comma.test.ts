/**
 * Probe, lens C verifier: C10 with the weight an accessory has. Weight (kg) is
 * the import's only number column (one piece, kilograms), so a single comma
 * with no dot is a decimal comma in practice; `parseNumber` reads it as one
 * only before one or two digits.
 */

import { describe, expect, it } from 'vitest';

import { matchHeaders, parseImportRow } from '../../src/domain/product-import.js';

describe('lens C verifier: decimal-comma weights', () => {
  it('Cv2 demonstrates: 0,125 kg is read as 125 kg', () => {
    const header = ['Main product', 'Sub product', 'Code', 'Weight (kg)'];
    const weight = (text: string) =>
      parseImportRow(['Accessories', 'Cap', 'ACC-1', text], matchHeaders(header), header, 2).input?.variant.weightKg;
    expect([weight('0,125'), weight('12,5'), weight('1,200.50')]).toEqual([0.125, 12.5, 1200.5]);
  });
});
