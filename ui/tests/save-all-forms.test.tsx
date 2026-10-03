/**
 * "Save all" across the forms (1.4 R7b, extended): a party form, a product
 * drawer and a number setting with something typed in them are listed, saved
 * when they are complete, and named — not sent half-finished — when they are
 * not. Plus a guard that every editor in the product still registers.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyboardProvider } from '../src/KeyboardProvider.js';
import { NumberSetting } from '../src/SettingsLayout.js';
import { PartyFormModal } from '../src/PartyFormModal.js';
import { ProductDrawer } from '../src/ProductDrawer.js';
import { t } from '../src/i18n.js';
import {
  __resetUnsavedWorkForTests,
  listUnsavedWork,
  saveAllUnsavedWork,
} from '../src/unsavedWork.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  __resetUnsavedWorkForTests();
});
afterEach(cleanup);

describe('the party form', () => {
  function mount(createParty = vi.fn(async (_input: unknown) => ({ id: 'p-1' }))) {
    const onError = vi.fn();
    render(
      <KeyboardProvider panel="master">
        <PartyFormModal
          open
          transport={{ createParty, updateParty: vi.fn() } as never}
          onClose={vi.fn()}
          onError={onError}
        />
      </KeyboardProvider>,
    );
    return { createParty, onError };
  }

  it('is not work until something is typed', () => {
    mount();
    expect(listUnsavedWork()).toEqual([]);
  });

  it('is saved when it has a name', async () => {
    const { createParty } = mount();
    fireEvent.change(screen.getByLabelText(new RegExp(t('party.field.name'))), {
      target: { value: 'Sharma Traders' },
    });

    expect(listUnsavedWork().map((item) => item.label)).toEqual([
      t('updates.saveAll.party', { name: 'Sharma Traders' }),
    ]);
    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(createParty).toHaveBeenCalledTimes(1);
    expect(createParty.mock.calls[0]?.[0]).toMatchObject({ name: 'Sharma Traders' });
    expect(result?.saved).toHaveLength(1);
    // Saved, so the form is empty again and holds nothing to lose.
    expect(listUnsavedWork()).toEqual([]);
  });

  it('is named, and nothing is sent, when it has no name yet', async () => {
    const { createParty, onError } = mount();
    fireEvent.change(screen.getByLabelText(new RegExp(t('party.field.phone'))), {
      target: { value: '98250 00000' },
    });

    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(createParty).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(t('party.nameRequired'));
    expect(result?.unsaved).toHaveLength(1);
  });
});

describe('the product drawer', () => {
  const categories = [
    { id: 'cat-1', name: 'ONE PIECE TOILET', code: 'OPT', brand: 'Swisware+', sortOrder: 1, deletedAt: null },
  ];
  function mount(createProduct = vi.fn(async (_input: unknown) => ({ id: 'prod-1' }))) {
    const onError = vi.fn();
    render(
      <KeyboardProvider panel="master">
        <ProductDrawer
          open
          transport={{ createProduct, updateProduct: vi.fn() } as never}
          categories={categories as never}
          optionLists={[]}
          onClose={vi.fn()}
          onError={onError}
        />
      </KeyboardProvider>,
    );
    return { createProduct, onError };
  }

  it('is not work until something is typed', () => {
    mount();
    expect(listUnsavedWork()).toEqual([]);
  });

  it('is named, and nothing is sent, when the product has no product chosen', async () => {
    const { createProduct, onError } = mount();
    fireEvent.change(screen.getByLabelText(new RegExp(t('product.field.name'))), {
      target: { value: 'Aqua Closet' },
    });

    expect(listUnsavedWork().map((item) => item.label)).toEqual([
      t('updates.saveAll.product', { name: 'Aqua Closet' }),
    ]);
    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(createProduct).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(t('validation.product.categoryRequired'));
    expect(result?.unsaved).toHaveLength(1);
  });
});

describe('a number setting', () => {
  const control = { kind: 'number', min: 1, max: 24, step: 1, unitToken: 'unit.hours' } as never;

  it('is saved when the figure is in range, and named when it is not', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<NumberSetting control={control} value={8} label="Session length" saving={false} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Session length'), { target: { value: '12' } });
    expect(listUnsavedWork().map((item) => item.label)).toEqual([
      t('updates.saveAll.setting', { name: 'Session length' }),
    ]);
    await act(async () => {
      await saveAllUnsavedWork();
    });
    expect(onSave).toHaveBeenCalledWith(12);

    onSave.mockClear();
    fireEvent.change(screen.getByLabelText('Session length'), { target: { value: '99' } });
    let result: Awaited<ReturnType<typeof saveAllUnsavedWork>> | undefined;
    await act(async () => {
      result = await saveAllUnsavedWork();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(result?.unsaved).toHaveLength(1);
  });
});

describe('every editor registers', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  // One entry per editor that holds typed input; the second column is the id it registers under.
  const EDITORS: Array<[string, string]> = [
    ['ui/src/LeadEntryScreen.tsx', 'new-lead'],
    ['office/web/src/screens/AddLeadScreen.tsx', 'new-lead'],
    ['ui/src/PartyFormModal.tsx', 'party-form'],
    ['ui/src/ProductDrawer.tsx', 'product-form'],
    ['office/web/src/components/ProductDrawer.tsx', 'product-form'],
    ['ui/src/OptionListEditor.tsx', 'list-value'],
    ['ui/src/SettingsLayout.tsx', 'setting:'],
    ['ui/src/MainProductsScreen.tsx', 'main-product-form'],
    ['office/web/src/screens/MainProductsScreen.tsx', 'main-product-form'],
    ['ui/src/ChatGroupSettings.tsx', 'chat-group'],
    ['ui/src/ChatConversation.tsx', 'chat-draft:'],
    ['ui/src/OrderRecordView.tsx', 'order-note:'],
    ['ui/src/LeadRecordView.tsx', 'lead-remark:'],
    ['office/web/src/screens/OrderBoardScreen.tsx', 'order-note:'],
    ['office/web/src/screens/PartyAccessScreen.tsx', 'party-access'],
    ['office/web/src/components/StoragePathCard.tsx', 'storage-path'],
    ['master/web/src/screens/PartyAccessScreen.tsx', 'party-access'],
    ['master/web/src/screens/AccessScreen.tsx', 'role-editor'],
    ['master/web/src/screens/AccessScreen.tsx', 'user-edit'],
    ['master/web/src/screens/AccessScreen.tsx', 'new-user'],
    ['master/web/src/screens/FieldsScreen.tsx', 'field-definition'],
    ['master/web/src/screens/IntegrationsScreen.tsx', 'connector'],
    ['master/web/src/screens/IntegrationsScreen.tsx', 'connector-mapping'],
    ['master/web/src/screens/IntegrationsScreen.tsx', 'new-api-key'],
    ['master/web/src/screens/PanelsScreen.tsx', 'panel-rename'],
    ['master/web/src/screens/SettingsScreen.tsx', 'secret-setting:'],
    ['master/web/src/screens/UpdatesScreen.tsx', 'auto-update'],
    ['master/web/src/components/AutoBackupSection.tsx', 'auto-backup'],
    ['master/web/src/components/ChangePasswordDialog.tsx', 'change-password'],
  ];

  for (const [file, id] of EDITORS) {
    it(`${file} registers ${id}`, () => {
      const source = readFileSync(path.join(repo, file), 'utf8');
      expect(source).toMatch(/useUnsavedWork\(/);
      expect(source).toContain(id.endsWith(':') ? id : `'${id}'`);
    });
  }
});
