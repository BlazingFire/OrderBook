/**
 * The Party Access editor (Party Access redesign, D2.2 – D2.5), mounted on its own against each
 * panel's real `api.ts` with only `fetch` answered. It exists twice and must behave the same, so
 * every case runs for both panels.
 *
 * The editor is imported through a variable path for the reason `panel-harness.ts` gives.
 */

import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignablePerson, PartyAccessAssignee, PartyAccessRow } from '@orderbook/shared';

import { configureUi } from '../src/config.js';
import { setLocale, t } from '../src/i18n.js';
import { __resetUnsavedWorkForTests, listUnsavedWork } from '../src/unsavedWork.js';
import { installBrowserStubs, json, routeFetch, wait, type Call } from './panel-harness.js';

interface EditorProps {
  party: PartyAccessRow;
  people: AssignablePerson[];
  canEdit: boolean;
  onSaved: (row: PartyAccessRow) => void;
  onClose: () => void;
}

async function loadEditor(panel: 'master' | 'office'): Promise<ComponentType<EditorProps>> {
  configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  const path = `../../${panel}/web/src/screens/PartyAccessEditor.tsx`;
  const module = (await import(/* @vite-ignore */ path)) as {
    PartyAccessEditor: ComponentType<EditorProps>;
  };
  return module.PartyAccessEditor;
}

function person(id: string, displayName: string, roleName: string): AssignablePerson {
  return { id, displayName, username: displayName.split(' ')[0]!.toLowerCase(), roleName, roleTier: 'office', avatar: null };
}

const PEOPLE = [
  person('u1', 'Asha Rao', 'Sales'),
  person('u2', 'Bela Shah', 'Dispatch'),
  person('u3', 'Chirag Mehta', 'Sales'),
  person('u4', 'Dev Patel', 'Accounts'),
];

function grant(userId: string, level: 'view' | 'manage', over: Partial<PartyAccessAssignee> = {}): PartyAccessAssignee {
  const who = PEOPLE.find((p) => p.id === userId);
  return {
    userId,
    level,
    displayName: who?.displayName ?? userId,
    username: who?.username ?? userId,
    roleName: who?.roleName ?? 'Office',
    roleTier: 'office',
    isActive: true,
    avatar: null,
    ...over,
  };
}

function party(assignees: PartyAccessAssignee[] = [], over: Partial<PartyAccessRow> = {}): PartyAccessRow {
  return {
    partyId: 'P1',
    partyCode: 'P-0001',
    partyName: 'Alpha Tiles',
    city: 'Rajkot',
    version: 3,
    isRestricted: assignees.length > 0,
    assignees,
    ...over,
  };
}

const onSaved = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  installBrowserStubs();
  setLocale('en');
  onSaved.mockClear();
  onClose.mockClear();
  Element.prototype.scrollIntoView = () => undefined;
  // After the commit, as a browser's is: a synchronous stub would focus the field before the panel is gone.
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0)) as unknown as typeof window.requestAnimationFrame;
});

afterEach(() => {
  cleanup();
  __resetUnsavedWorkForTests();
  vi.unstubAllGlobals();
});

type Route = (call: Call) => Response | Promise<Response> | undefined;

async function mount(
  panel: 'master' | 'office',
  props: Partial<EditorProps> = {},
  route: Route = () => undefined,
): Promise<Call[]> {
  const calls = routeFetch(route);
  const Editor = await loadEditor(panel);
  render(
    <Editor party={party()} people={PEOPLE} canEdit onSaved={onSaved} onClose={onClose} {...props} />,
  );
  return calls;
}

const addField = () => screen.getByRole('combobox', { name: t('partyAccess.editor.addLabel') }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: t('partyAccess.action.save') }) as HTMLButtonElement;
const cancel = () => screen.getByRole('button', { name: t('partyAccess.action.cancel') }) as HTMLButtonElement;
const rowOf = (name: string) =>
  screen.getAllByText(name).find((el) => el.matches('span[title]'))!.closest('li') as HTMLElement;
const optionLabels = () => screen.getAllByRole('option').map((o) => o.querySelector('.ob-combobox-label')?.textContent);
const names = () => Array.from(document.querySelectorAll('li[data-user]')).map((li) => li.querySelector(':scope > span > span[title]')?.textContent);

function addByTyping(text: string): void {
  fireEvent.focus(addField());
  fireEvent.change(addField(), { target: { value: text } });
  fireEvent.keyDown(addField(), { key: 'Enter' });
}

describe.each(['master', 'office'] as const)('the Party Access editor on the %s panel', (panel) => {
  describe('the header and the explainer (D2.2a, D2.2b)', () => {
    it('names the party, its code and city, and says it is open to everyone while nobody is assigned', async () => {
      await mount(panel);
      const dialog = screen.getByRole('dialog', { name: 'Alpha Tiles' });
      expect(within(dialog).getByText('P-0001')).toBeTruthy();
      expect(within(dialog).getByText('Rajkot')).toBeTruthy();
      expect(within(dialog).getByText(t('partyAccess.editor.stateOpen'))).toBeTruthy();
      expect(within(dialog).getByText(t('partyAccess.explainOpen'))).toBeTruthy();
    });

    it('turns into a restricted pill and a different explainer as people are added and removed', async () => {
      await mount(panel);
      addByTyping('asha');
      expect(screen.getByText(t('partyAccess.editor.stateRestricted.one'))).toBeTruthy();
      expect(screen.getByText(t('partyAccess.explainRestricted'))).toBeTruthy();
      expect(screen.queryByText(t('partyAccess.explainOpen'))).toBeNull();

      addByTyping('bela');
      expect(screen.getByText(t('partyAccess.editor.stateRestricted.other', { count: 2 }))).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) }));
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Bela Shah' }) }));
      expect(screen.getByText(t('partyAccess.editor.stateOpen'))).toBeTruthy();
      expect(screen.getByText(t('partyAccess.explainOpen'))).toBeTruthy();
    });
  });

  describe('the people on the party (D2.2c)', () => {
    it('lists each person by full name and role, in name order, each with a level switch and Remove', async () => {
      await mount(panel, { party: party([grant('u3', 'view'), grant('u1', 'manage')]) });
      expect(names()).toEqual(['Asha Rao', 'Chirag Mehta']);
      const asha = rowOf('Asha Rao');
      expect(within(asha).getByText('Sales')).toBeTruthy();
      const level = within(asha).getByRole('group', { name: t('partyAccess.editor.levelFor', { name: 'Asha Rao' }) });
      expect(within(level).getByRole('button', { name: t('partyAccess.level.manage') }).getAttribute('aria-pressed')).toBe('true');
      expect(within(asha).getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) })).toBeTruthy();
    });

    it('moves the keyboard to the next Remove button, else the previous, when a row is removed', async () => {
      await mount(panel, { party: party([grant('u1', 'view'), grant('u2', 'view'), grant('u3', 'view')]) });
      const removeOf = (name: string) => screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name }) });
      fireEvent.click(removeOf('Bela Shah'));
      await waitFor(() => expect(document.activeElement).toBe(removeOf('Chirag Mehta')));
      fireEvent.click(removeOf('Chirag Mehta'));
      await waitFor(() => expect(document.activeElement).toBe(removeOf('Asha Rao')));
    });

    it('puts the keyboard on the add field, list closed, when the last row is removed', async () => {
      await mount(panel, { party: party([grant('u1', 'view')]) });
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) }));
      await waitFor(() => expect(document.activeElement).toBe(addField()));
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('announces changes in a screen-reader-only live region, not as visible text', async () => {
      await mount(panel, { party: party([grant('u1', 'view')]) });
      fireEvent.click(within(rowOf('Asha Rao')).getByRole('button', { name: t('partyAccess.level.manage') }));
      const live = screen.getByText(t('partyAccess.editor.levelSet', { name: 'Asha Rao', level: t('partyAccess.level.manage') }));
      expect(live.getAttribute('role')).toBe('status');
      expect(live.className).toContain('sr-only');
    });

    it('changes a level from the switch, and removes a row', async () => {
      await mount(panel, { party: party([grant('u1', 'view'), grant('u2', 'view')]) });
      const bela = rowOf('Bela Shah');
      fireEvent.click(within(bela).getByRole('button', { name: t('partyAccess.level.manage') }));
      expect(within(bela).getByRole('button', { name: t('partyAccess.level.manage') }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText(t('partyAccess.editor.levelSet', { name: 'Bela Shah', level: t('partyAccess.level.manage') }))).toBeTruthy();

      fireEvent.click(within(bela).getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Bela Shah' }) }));
      expect(names()).toEqual(['Asha Rao']);
      expect(screen.getByText(t('partyAccess.editor.removed', { name: 'Bela Shah' }))).toBeTruthy();
    });

    it('marks an inactive user, keeps them below the live people, and lets Remove clear them (CH1 audit item 1)', async () => {
      await mount(panel, {
        party: party([grant('u2', 'view', { isActive: false }), grant('u1', 'view'), grant('u9', 'manage', { displayName: 'Aaron Gone', roleName: 'Office', isActive: false })]),
      });
      // Live people first, then the inactive ones by name.
      expect(names()).toEqual(['Asha Rao', 'Aaron Gone', 'Bela Shah']);
      expect(within(rowOf('Bela Shah')).getByText(t('partyAccess.editor.deactivated'))).toBeTruthy();
      expect(within(rowOf('Asha Rao')).queryByText(t('partyAccess.editor.deactivated'))).toBeNull();
      expect(screen.getByText(t('partyAccess.editor.deactivatedHelp'))).toBeTruthy();
      // The header still counts them: the party is restricted to three, and a reader saw "Restricted" on the list.
      expect(screen.getByText(t('partyAccess.editor.stateRestricted.other', { count: 3 }))).toBeTruthy();

      fireEvent.click(within(rowOf('Aaron Gone')).getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Aaron Gone' }) }));
      expect(names()).toEqual(['Asha Rao', 'Bela Shah']);
    });

    it('sends an inactive user it was not asked to remove back with the rest on Save', async () => {
      const calls = await mount(
        panel,
        { party: party([grant('u1', 'view'), grant('u2', 'view', { isActive: false })]) },
        ({ method, url }) =>
          method === 'PUT' && url === '/api/party-access/P1' ? json(party([grant('u1', 'manage'), grant('u2', 'view', { isActive: false })], { version: 4 })) : undefined,
      );
      fireEvent.click(within(rowOf('Asha Rao')).getByRole('button', { name: t('partyAccess.level.manage') }));
      fireEvent.click(save());
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const put = calls.find((call) => call.method === 'PUT')!;
      expect(put.body).toEqual({
        entries: [
          { userId: 'u1', level: 'manage' },
          { userId: 'u2', level: 'view' },
        ],
        expectedVersion: 3,
      });
    });
  });

  describe('adding a person (D2.2e – D2.2h)', () => {
    it('filters by name or by role as you type', async () => {
      await mount(panel);
      fireEvent.focus(addField());
      expect(screen.getAllByRole('option')).toHaveLength(4);
      fireEvent.change(addField(), { target: { value: 'disp' } });
      expect(optionLabels()).toEqual(['Bela Shah']);
      fireEvent.change(addField(), { target: { value: 'sales' } });
      expect(screen.getAllByRole('option')).toHaveLength(2);
    });

    it('moves with the arrow keys and adds with Enter, with View access, and drops the person from the list', async () => {
      await mount(panel);
      fireEvent.focus(addField());
      fireEvent.keyDown(addField(), { key: 'ArrowDown' });
      fireEvent.keyDown(addField(), { key: 'ArrowDown' });
      fireEvent.keyDown(addField(), { key: 'Enter' });
      expect(names()).toEqual(['Chirag Mehta']);
      expect(screen.getByText(t('partyAccess.editor.added', { name: 'Chirag Mehta', level: t('partyAccess.level.view') }))).toBeTruthy();
      expect(within(rowOf('Chirag Mehta')).getByRole('button', { name: t('partyAccess.level.view') }).getAttribute('aria-pressed')).toBe('true');

      fireEvent.focus(addField());
      expect(optionLabels()).not.toContain('Chirag Mehta');
    });

    it('closes its list on the first Escape and the dialog on the second', async () => {
      await mount(panel);
      fireEvent.focus(addField());
      expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

      const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        addField().dispatchEvent(first);
      });
      expect(screen.queryAllByRole('option')).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();

      const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        addField().dispatchEvent(second);
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the caret in the field after adding, by keyboard and by mouse', async () => {
      await mount(panel);
      act(() => addField().focus());
      fireEvent.change(addField(), { target: { value: 'asha' } });
      fireEvent.keyDown(addField(), { key: 'Enter' });
      expect(document.activeElement).toBe(addField());

      act(() => addField().blur());
      fireEvent.focus(addField());
      act(() => addField().blur());
      fireEvent.mouseDown(screen.getAllByRole('option')[0]!);
      expect(document.activeElement).toBe(addField());
    });

    it('says everybody is already assigned when there is no one left to add, and that there is nobody when none were offered', async () => {
      await mount(panel, { party: party(PEOPLE.map((p) => grant(p.id, 'view'))) });
      fireEvent.focus(addField());
      expect(screen.getByText(t('partyAccess.editor.allAssigned'))).toBeTruthy();
      cleanup();

      await mount(panel, { people: [] });
      fireEvent.focus(addField());
      expect(screen.getByText(t('partyAccess.editor.noPeople'))).toBeTruthy();
    });
  });

  describe('the footer and Save (D2.2i, D2.4c – D2.4e)', () => {
    it('keeps Save off until something changed, shows an unsaved marker, and goes back off when the change is undone', async () => {
      await mount(panel);
      expect(save().disabled).toBe(true);
      expect(screen.getByText(t('partyAccess.editor.noChanges'))).toBeTruthy();

      addByTyping('asha');
      expect(save().disabled).toBe(false);
      expect(screen.getByText(t('partyAccess.editor.unsaved'))).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) }));
      expect(save().disabled).toBe(true);
      expect(screen.getByText(t('partyAccess.editor.noChanges'))).toBeTruthy();
    });

    it('does not count a reordering as a change', async () => {
      await mount(panel, { party: party([grant('u2', 'view'), grant('u1', 'view')]) });
      expect(save().disabled).toBe(true);
    });

    it('saves the whole set against the version it was opened on, and hands the row back', async () => {
      const saved = party([grant('u1', 'manage')], { version: 4 });
      const calls = await mount(panel, {}, ({ method, url }) =>
        method === 'PUT' && url === '/api/party-access/P1' ? json(saved) : undefined,
      );
      addByTyping('asha');
      fireEvent.click(within(rowOf('Asha Rao')).getByRole('button', { name: t('partyAccess.level.manage') }));
      fireEvent.click(save());

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
      expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
        entries: [{ userId: 'u1', level: 'manage' }],
        expectedVersion: 3,
      });
    });

    it('shows a busy Save while the Master answers, and will not close or double-submit meanwhile', async () => {
      let answer: (response: Response) => void = () => undefined;
      const calls = await mount(
        panel,
        {},
        ({ method }) => (method === 'PUT' ? new Promise<Response>((resolve) => (answer = resolve)) : undefined),
      );
      addByTyping('asha');
      fireEvent.click(save());

      await waitFor(() => expect(save().getAttribute('aria-busy')).toBe('true'));
      expect(save().disabled).toBe(true);
      expect(cancel().disabled).toBe(true);
      fireEvent.click(save());
      expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);

      await act(async () => {
        answer(json(party([grant('u1', 'view')], { version: 4 })));
        await wait(0);
      });
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('says why a save failed, inline, and stays open with the draft intact', async () => {
      await mount(panel, {}, ({ method }) =>
        method === 'PUT' ? json({ error: 'internal', message: 'The Master said no' }, 500) : undefined,
      );
      addByTyping('asha');
      fireEvent.click(save());

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('partyAccess.error.save'));
      expect(alert.textContent).toContain('The Master said no');
      expect(onSaved).not.toHaveBeenCalled();
      expect(names()).toEqual(['Asha Rao']);
      expect(save().disabled).toBe(false);
    });

    it('warns that everyone will see the party when the last person is removed, and says nothing when it was already open', async () => {
      await mount(panel, { party: party([grant('u1', 'view')]) });
      expect(screen.queryByText(t('partyAccess.editor.openWarningTitle'))).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) }));
      expect(screen.getByText(t('partyAccess.editor.openWarningTitle'))).toBeTruthy();

      cleanup();
      await mount(panel);
      addByTyping('asha');
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.removeFor', { name: 'Asha Rao' }) }));
      expect(screen.queryByText(t('partyAccess.editor.openWarningTitle'))).toBeNull();
    });
  });

  describe('unsaved work (D2.4a)', () => {
    it('closes at once when nothing changed', async () => {
      await mount(panel);
      fireEvent.click(cancel());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('asks before throwing a change away, in the same dialog, and Keep editing keeps it', async () => {
      await mount(panel);
      addByTyping('asha');
      fireEvent.click(cancel());

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText(t('partyAccess.editor.discardTitle'))).toBeTruthy();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.keepEditing') }));
      expect(screen.queryByText(t('partyAccess.editor.discardTitle'))).toBeNull();
      expect(names()).toEqual(['Asha Rao']);
    });

    it('puts the keyboard on Keep editing when the question appears', async () => {
      await mount(panel);
      addByTyping('asha');
      fireEvent.click(cancel());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: t('partyAccess.editor.keepEditing') })));
    });

    it('keeps the same two-line minimum footer height with or without the question, which may wrap, so the dialog does not move', async () => {
      await mount(panel);
      addByTyping('asha');
      const foot = () => document.querySelector('.ob-modal-foot > div') as HTMLElement;
      const before = { minHeight: foot().style.minHeight, wrap: foot().style.flexWrap };
      fireEvent.click(cancel());
      const after = { minHeight: foot().style.minHeight, wrap: foot().style.flexWrap };
      expect(before.minHeight).not.toBe('');
      expect(after).toEqual({ minHeight: before.minHeight, wrap: 'wrap' });
      expect(before.minHeight).toBe('3.4286rem');
      const text = screen.getByText(t('partyAccess.editor.discardTitle')).parentElement as HTMLElement;
      expect(text.style.whiteSpace).not.toBe('nowrap');
      expect(text.style.textOverflow).toBe('');
    });

    it('Discard closes without saving; Escape while asked means keep editing', async () => {
      const calls = await mount(panel);
      addByTyping('asha');
      fireEvent.click(cancel());

      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        document.dispatchEvent(escape);
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText(t('partyAccess.editor.discardTitle'))).toBeNull();

      fireEvent.click(cancel());
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.discard') }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    });

    it('asks on the header close button and on Escape too, not only on Cancel', async () => {
      await mount(panel);
      addByTyping('asha');
      fireEvent.click(screen.getByRole('button', { name: t('modal.close') }));
      expect(screen.getByText(t('partyAccess.editor.discardTitle'))).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('registers the draft for "Save all and update" while it is unsaved, and only then', async () => {
      await mount(panel, {}, ({ method }) =>
        method === 'PUT' ? json(party([grant('u1', 'view')], { version: 4 })) : undefined,
      );
      expect(listUnsavedWork()).toEqual([]);
      addByTyping('asha');
      const items = listUnsavedWork();
      expect(items.map((item) => item.label)).toEqual([t('updates.saveAll.partyAccess', { name: 'Alpha Tiles' })]);

      await act(async () => {
        await items[0]!.save!();
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });

  describe('a save that raced another administrator (D2.4b)', () => {
    it('shows the conflict banner, and Reload brings in the stored state and drops the draft', async () => {
      const stored = party([grant('u4', 'manage')], { version: 4 });
      const calls = await mount(panel, {}, ({ method, url }) => {
        if (method === 'PUT') return json({ error: 'conflict', message: 'Changed first', details: { storedVersion: 4 } }, 409);
        if (method === 'GET' && url === '/api/party-access/P1') return json(stored);
        return undefined;
      });
      addByTyping('asha');
      fireEvent.click(save());

      const banner = await screen.findByText(t('partyAccess.staleSave'));
      expect(banner.closest('[role="alert"]')).toBeTruthy();
      // The conflict is the banner, not a second red message beside it.
      expect(screen.getAllByRole('alert')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.reload') }));
      await waitFor(() => expect(screen.queryByText(t('partyAccess.staleSave'))).toBeNull());
      expect(names()).toEqual(['Dev Patel']);
      expect(save().disabled).toBe(true);
      expect(calls.some((call) => call.method === 'GET' && call.url === '/api/party-access/P1')).toBe(true);

      // The next save goes against the version just reloaded.
      fireEvent.click(within(rowOf('Dev Patel')).getByRole('button', { name: t('partyAccess.level.view') }));
      calls.length = 0;
      fireEvent.click(save());
      await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
      expect(calls.find((call) => call.method === 'PUT')!.body).toMatchObject({ expectedVersion: 4 });
    });
  });

  describe('add several people (D2.3a)', () => {
    it('ticks several, gives them one level, adds them together and hands the keyboard back', async () => {
      await mount(panel, { party: party([grant('u1', 'view')]) });
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.bulkButton') }));

      const panelBox = screen.getByRole('group', { name: t('partyAccess.editor.bulkTitle') });
      // Only people not already on the party are offered.
      const options = within(panelBox).getAllByRole('option');
      expect(options.map((o) => o.getAttribute('title'))).toEqual(['Bela Shah · Dispatch', 'Chirag Mehta · Sales', 'Dev Patel · Accounts']);

      fireEvent.click(options[0]!);
      fireEvent.click(options[2]!);
      fireEvent.click(within(panelBox).getByRole('button', { name: t('partyAccess.level.manage') }));
      fireEvent.click(within(panelBox).getByRole('button', { name: t('partyAccess.editor.bulkAdd.other', { count: 2 }) }));

      expect(screen.queryByRole('group', { name: t('partyAccess.editor.bulkTitle') })).toBeNull();
      expect(names()).toEqual(['Asha Rao', 'Bela Shah', 'Dev Patel']);
      expect(within(rowOf('Bela Shah')).getByRole('button', { name: t('partyAccess.level.manage') }).getAttribute('aria-pressed')).toBe('true');
      expect(within(rowOf('Asha Rao')).getByRole('button', { name: t('partyAccess.level.view') }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText(t('partyAccess.editor.bulkDone.other', { count: 2, level: t('partyAccess.level.manage') }))).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(addField()));
      expect(save().disabled).toBe(false);
    });

    it('offers nothing to add until somebody is ticked, and Escape or Cancel closes it with nothing added', async () => {
      await mount(panel);
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.bulkButton') }));
      const panelBox = screen.getByRole('group', { name: t('partyAccess.editor.bulkTitle') });
      const add = within(panelBox).getByRole('button', { name: t('partyAccess.editor.bulkAdd.other', { count: 0 }) }) as HTMLButtonElement;
      expect(add.disabled).toBe(true);

      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        within(panelBox).getByRole('combobox').dispatchEvent(escape);
      });
      expect(screen.queryByRole('group', { name: t('partyAccess.editor.bulkTitle') })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(names()).toEqual([]);
    });
  });

  describe('copy access from another party (D2.3b)', () => {
    const source = party([grant('u2', 'manage'), grant('u3', 'view'), grant('u9', 'view', { displayName: 'Gone Guy', isActive: false })], {
      partyId: 'P2',
      partyCode: 'P-0002',
      partyName: 'Beta Ceramics',
      city: 'Morbi',
    });
    const open = party([], { partyId: 'P3', partyCode: 'P-0003', partyName: 'Gamma Bath', city: null });
    const listRoute: Route = ({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/party-access?')) {
        const search = new URL(url, 'http://x').searchParams.get('search') ?? '';
        const all = [party([], { partyId: 'P1' }), source, open];
        const items = search ? all.filter((row) => row.partyName.toLowerCase().includes(search.toLowerCase())) : all;
        return json({ items, total: items.length, limit: 21, offset: 0 });
      }
      return undefined;
    };

    it('lists other parties (not this one) with their code, city and how many hold them, asking the Master', async () => {
      const calls = await mount(panel, {}, listRoute);
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      const options = await screen.findAllByRole('option');
      expect(options.map((o) => o.getAttribute('title'))).toEqual([
        `Beta Ceramics · P-0002 · Morbi · ${t('partyAccess.editor.copyPeopleHint', { count: 3 })}`,
        `Gamma Bath · P-0003 · ${t('partyAccess.editor.copyOpenHint')}`,
      ]);
      const asked = calls.find((call) => call.url.startsWith('/api/party-access?'))!;
      expect(new URL(asked.url, 'http://x').searchParams.get('limit')).toBe('21');
    });

    it('searches the Master as you type, after a short wait', async () => {
      const calls = await mount(panel, {}, listRoute);
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      await screen.findAllByRole('option');
      const field = screen.getByRole('combobox', { name: t('partyAccess.editor.copyTitle') });
      fireEvent.change(field, { target: { value: 'gam' } });
      await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Gamma Bath')]));
      expect(calls.some((call) => new URL(call.url, 'http://x').searchParams.get('search') === 'gam')).toBe(true);
    });

    it('brings over the live people with their levels, leaves the inactive one out and says so, and fills the draft only', async () => {
      const calls = await mount(panel, { party: party([grant('u3', 'manage')]) }, listRoute);
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      const options = await screen.findAllByRole('option');
      fireEvent.mouseDown(options[0]!);

      // Bela comes over as Manage; Chirag was already here and keeps his own level (Manage, not the source's View).
      expect(names()).toEqual(['Bela Shah', 'Chirag Mehta']);
      expect(within(rowOf('Bela Shah')).getByRole('button', { name: t('partyAccess.level.manage') }).getAttribute('aria-pressed')).toBe('true');
      expect(within(rowOf('Chirag Mehta')).getByRole('button', { name: t('partyAccess.level.manage') }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText(/Copied 1 person from Beta Ceramics/)).toBeTruthy();
      expect(screen.getByText(/1 deactivated account was left out/)).toBeTruthy();
      expect(screen.queryByRole('group', { name: t('partyAccess.editor.copyTitle') })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(addField()));
      // The keyboard came back without popping the add list open over the result.
      expect(screen.queryAllByRole('option')).toHaveLength(0);
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
      expect(save().disabled).toBe(false);
    });

    it('says there is nothing to copy from an open party, and when everyone is already here', async () => {
      await mount(panel, { party: party([grant('u2', 'view'), grant('u3', 'view')]) }, listRoute);
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      const options = await screen.findAllByRole('option');
      fireEvent.mouseDown(options[0]!);
      expect(screen.getByText(new RegExp(t('partyAccess.editor.copyAlreadyHere', { party: 'Beta Ceramics' })))).toBeTruthy();
      expect(save().disabled).toBe(true);
      // Let the first copy hand the keyboard back before the second panel takes it.
      await waitFor(() => expect(document.activeElement).toBe(addField()));

      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      // The add field is focused again and its own list is open too: look only inside the copy panel.
      const copyBox = () => screen.getByRole('group', { name: t('partyAccess.editor.copyTitle') });
      await waitFor(() => expect(within(copyBox()).getAllByRole('option')).toHaveLength(2));
      fireEvent.mouseDown(within(copyBox()).getAllByRole('option')[1]!);
      expect(screen.getByText(t('partyAccess.editor.copyNothing', { party: 'Gamma Bath' }))).toBeTruthy();
      expect(save().disabled).toBe(true);
    });

    it('says when it could not load the parties, and offers Cancel', async () => {
      await mount(panel, {}, ({ method, url }) =>
        method === 'GET' && url.startsWith('/api/party-access?') ? json({ error: 'internal', message: 'Master offline' }, 503) : undefined,
      );
      fireEvent.click(screen.getByRole('button', { name: t('partyAccess.editor.copyButton') }));
      const alert = await screen.findByText(new RegExp(t('partyAccess.editor.copyError')));
      expect(alert.textContent).toContain('Master offline');
      fireEvent.click(within(screen.getByRole('group', { name: t('partyAccess.editor.copyTitle') })).getByRole('button', { name: t('action.cancel') }));
      expect(screen.queryByRole('group', { name: t('partyAccess.editor.copyTitle') })).toBeNull();
    });
  });

  describe('a reader without party.assign (D2.6 of the brief: absent, not greyed)', () => {
    it('shows the people and their levels and nothing that edits', async () => {
      await mount(panel, { canEdit: false, people: [], party: party([grant('u1', 'manage'), grant('u2', 'view')]) });
      expect(names()).toEqual(['Asha Rao', 'Bela Shah']);
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button', { name: t('partyAccess.action.save') })).toBeNull();
      expect(screen.queryByRole('button', { name: t('partyAccess.editor.bulkButton') })).toBeNull();
      expect(screen.queryByRole('button', { name: t('partyAccess.editor.copyButton') })).toBeNull();
      expect(screen.queryByRole('button', { name: new RegExp(t('partyAccess.remove')) })).toBeNull();
      expect(screen.getByText(t('partyAccess.editor.readOnlyRestricted'))).toBeTruthy();
      expect(within(rowOf('Asha Rao')).getByText(t('partyAccess.level.manage'))).toBeTruthy();

      fireEvent.click(screen.getAllByRole('button', { name: t('action.close') }).at(-1)!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('says the party is open to everyone when nobody is assigned', async () => {
      await mount(panel, { canEdit: false, people: [] });
      expect(screen.getByText(t('partyAccess.editor.readOnlyOpen'))).toBeTruthy();
    });

    it('registers no unsaved work (there is nothing it can change)', async () => {
      await mount(panel, { canEdit: false, people: [] });
      expect(listUnsavedWork()).toEqual([]);
    });
  });

  describe('Hindi (D2.5)', () => {
    it('renders the header, the rows, the footer and the pickers in Hindi, long names intact', async () => {
      setLocale('hi');
      const long = 'वेंकटसुब्रमण्यम रामचंद्रन अय्यर-नटराजन';
      await mount(panel, {
        party: party([grant('u1', 'view', { displayName: long })]),
        people: [...PEOPLE.slice(1)],
      });
      expect(screen.getByText(t('partyAccess.editor.stateRestricted.one'))).toBeTruthy();
      expect(screen.getAllByText(long).some((el) => el.getAttribute('title') === long)).toBe(true);
      expect(screen.getByText(t('partyAccess.explainRestricted'))).toBeTruthy();
      expect(screen.getByRole('button', { name: t('partyAccess.editor.bulkButton') })).toBeTruthy();
      expect(save().textContent).toBe(t('partyAccess.action.save'));
      // Not English: the editor's own labels are real Hindi.
      expect(t('partyAccess.action.save')).not.toBe('Save');
      expect(t('partyAccess.level.view')).not.toBe('View');
    });
  });
});
