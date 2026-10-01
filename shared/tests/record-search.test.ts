import { describe, expect, it } from 'vitest';

import { matchesRecordSearch } from '../src/index.js';
import type { LineItem } from '../src/index.js';

const record = {
  id: 'LD0000000003',
  partyName: 'New Home Ceramics',
  ownerName: 'Asha',
  notes: 'Call before noon',
  items: [
    { productName: '29', categoryName: 'One Piece Basin Damru Plus Vitrosa', code: 'DPV-0001', packaging: 'Grass', colour: null },
  ] as unknown as LineItem[],
};

describe('matchesRecordSearch', () => {
  it('matches everything on an empty term', () => {
    expect(matchesRecordSearch(record, '  ')).toBe(true);
  });

  it('finds by id, party, owner, notes, product, code and packaging, ignoring case', () => {
    for (const term of ['ld0000000003', 'home', 'asha', 'noon', 'damru', 'dpv-0001', 'GRASS']) {
      expect(matchesRecordSearch(record, term)).toBe(true);
    }
  });

  it('needs every word, in any order', () => {
    expect(matchesRecordSearch(record, 'grass damru')).toBe(true);
    expect(matchesRecordSearch(record, 'damru box')).toBe(false);
  });
});
