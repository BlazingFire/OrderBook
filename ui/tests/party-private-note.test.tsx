/**
 * The party form tells a creator who lacks `party.accessAll` that only they and the
 * administrators will see the party, before it is saved. Creating only: an edit is of a
 * party that already has its audience.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { PartyFormModal } from '../src/PartyFormModal.js';
import { setCreatedPartiesPrivate } from '../src/partyPrivacy.js';
import { t } from '../src/i18n.js';
import { installBrowserStubs } from './panel-harness.js';

const transport = { createParty: vi.fn(), updateParty: vi.fn() };

function form(party?: Parameters<typeof PartyFormModal>[0]['party']) {
  return (
    <PartyFormModal open transport={transport} party={party} onClose={vi.fn()} onError={vi.fn()} />
  );
}

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'office', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(() => {
  cleanup();
  setCreatedPartiesPrivate(false);
});

describe('the party form’s privacy note', () => {
  it('is shown to a creator whose parties are private to them', () => {
    setCreatedPartiesPrivate(true);
    render(form());
    expect(screen.getByTestId('party-private-note').textContent).toBe(t('party.private.note'));
    expect(t('party.private.note')).toBe('Only you and administrators will see this party.');
  });

  it('is not shown to somebody who holds party.accessAll', () => {
    setCreatedPartiesPrivate(false);
    render(form());
    expect(screen.queryByTestId('party-private-note')).toBeNull();
  });

  it('is not shown when editing a party that already exists', () => {
    setCreatedPartiesPrivate(true);
    render(form({ id: 'PT0000000001', name: 'Old Co' } as never));
    expect(screen.queryByTestId('party-private-note')).toBeNull();
  });

  it('follows the signed-in person while the form is open', () => {
    render(form());
    expect(screen.queryByTestId('party-private-note')).toBeNull();
    act(() => setCreatedPartiesPrivate(true));
    expect(screen.getByTestId('party-private-note')).toBeTruthy();
  });
});
