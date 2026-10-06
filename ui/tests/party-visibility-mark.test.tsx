/**
 * "Private" / "Shared with N" beside a party. The number is only a hint: a missing
 * one draws nothing, so a party that arrived after the snapshot is never mislabelled
 * as open (or as private).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PartyVisibilityMark } from '../src/PartyVisibilityMark.js';

afterEach(cleanup);

describe('PartyVisibilityMark', () => {
  it('says Private for one holder and Shared with N for more', () => {
    const { rerender } = render(<PartyVisibilityMark count={1} />);
    expect(screen.getByText('Private')).toBeTruthy();

    rerender(<PartyVisibilityMark count={4} />);
    expect(screen.getByText('Shared with 4')).toBeTruthy();
    expect(screen.queryByText('Private')).toBeNull();
  });

  it('draws nothing for an open party or an unknown count', () => {
    for (const count of [0, undefined, null]) {
      const { container, unmount } = render(<PartyVisibilityMark count={count} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });
});
