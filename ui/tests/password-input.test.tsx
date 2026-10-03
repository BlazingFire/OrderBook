/**
 * R1: every password field has an eye button. One kit component does it, and a
 * grep guard keeps a raw `type="password"` from creeping back in elsewhere.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PasswordInput } from '../src/Form.js';

afterEach(cleanup);

describe('PasswordInput', () => {
  it('toggles the field between password and text with an aria-labelled button', () => {
    render(<PasswordInput aria-label="Secret" defaultValue="abc" />);
    const input = screen.getByLabelText('Secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('type')).toBe('button');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.type).toBe('password');
  });

  it('starts visible when asked', () => {
    render(<PasswordInput aria-label="Secret" initiallyVisible defaultValue="abc" />);
    expect((screen.getByLabelText('Secret') as HTMLInputElement).type).toBe('text');
  });

  it('does not submit the form when the eye is clicked', () => {
    let submitted = 0;
    render(
      <form onSubmit={(event) => { event.preventDefault(); submitted += 1; }}>
        <PasswordInput aria-label="Secret" />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(submitted).toBe(0);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

describe('raw password inputs', () => {
  it('exist only inside the PasswordInput component', () => {
    const roots = ['../src', '../../master/web/src', '../../office/web/src'];
    const offenders = roots
      .flatMap((root) => sources(new URL(root, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
      .filter((file) => !file.endsWith('Form.tsx'))
      .filter((file) => /type=["']password["']/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
