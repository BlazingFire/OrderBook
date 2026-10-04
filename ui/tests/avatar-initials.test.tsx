/** Avatar initials skip punctuation-led words: "Management (test)" is MT, not "M(". */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Avatar } from '../src/Avatar.js';

afterEach(cleanup);

const initials = (name: string) => {
  const { container } = render(<Avatar name={name} avatar={null} />);
  return container.querySelector('span[aria-hidden="true"]')?.textContent;
};

describe('Avatar initials', () => {
  it('uses the first letters of the first and last words', () => {
    expect(initials('Akshit Verma')).toBe('AV');
  });

  it('ignores a word that starts with punctuation', () => {
    expect(initials('Management (test)')).toBe('M');
    expect(initials('Admin - Sales')).toBe('AS');
  });

  it('falls back to ? for a name with no letters', () => {
    expect(initials('()')).toBe('?');
  });
});
