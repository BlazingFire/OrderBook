/**
 * The To-do list screen (2026-10-08): the Add task form and its expiry choices for an
 * administrator, the In progress / Completed buttons (pressed for the viewer's own mark) with the
 * names and times of who marked, Delete behind a confirm, and a re-read when `revision` moves.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoTask } from '@orderbook/shared';

import { configureUi } from '../src/config.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { TodoListView, type TodoTransport } from '../src/TodoListView.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

function task(id: string, over: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    text: `Task ${id}`,
    createdByName: 'Asha',
    createdAt: '2026-10-08T10:00:00.000Z',
    expiresAt: null,
    expireAfterHours: null,
    completedAt: null,
    marks: [],
    ...over,
  };
}

function transportWith(tasks: TodoTask[]): TodoTransport & { [K in keyof TodoTransport]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => tasks),
    create: vi.fn(async (input) => task('new', { text: input.text })),
    mark: vi.fn(async ({ id }) => task(id)),
    remove: vi.fn(async (id: string) => ({ id })),
  };
}

const item = (id: string) => document.querySelector(`[data-todo="${id}"]`) as HTMLElement;

describe('TodoListView', () => {
  it('shows each task with who marked it and when, pressed for the viewer’s own marks', async () => {
    const transport = transportWith([
      task('a', {
        expireAfterHours: 24,
        marks: [
          { userId: 'u1', name: 'Ravi', status: 'in_progress', markedAt: '2026-10-08T10:05:00.000Z' },
          { userId: 'u2', name: 'Bina', status: 'in_progress', markedAt: '2026-10-08T10:06:00.000Z' },
          { userId: 'u2', name: 'Bina', status: 'completed', markedAt: '2026-10-08T11:00:00.000Z' },
        ],
      }),
    ]);
    render(<TodoListView transport={transport} canManage={false} userId="u1" />);

    await waitFor(() => expect(item('a')).toBeTruthy());
    const row = item('a');
    expect(row.textContent).toContain('Task a');
    expect(row.textContent).toContain(t('todos.meta.expiresAfter', { hours: 24 }));
    expect(row.textContent).toMatch(/In progress: Ravi \(.+\), Bina \(.+\)/);
    expect(row.textContent).toMatch(/Completed: Bina \(.+\)/);

    const inProgress = within(row).getByRole('button', { name: t('todos.mark.inProgress') });
    const completed = within(row).getByRole('button', { name: t('todos.mark.completed') });
    expect(inProgress.getAttribute('aria-pressed')).toBe('true');
    expect(completed.getAttribute('aria-pressed')).toBe('false');

    // No form and no Delete without todos.manage.
    expect(screen.queryByRole('form', { name: t('todos.add.title') })).toBeNull();
    expect(within(row).queryByRole('button', { name: t('todos.delete') })).toBeNull();

    // Pressing an own mark takes it off; pressing another puts it on. Each write re-reads the list.
    fireEvent.click(inProgress);
    await waitFor(() => expect(transport.mark).toHaveBeenCalledWith({ id: 'a', status: 'in_progress', marked: false }));
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
    fireEvent.click(within(item('a')).getByRole('button', { name: t('todos.mark.completed') }));
    await waitFor(() => expect(transport.mark).toHaveBeenCalledWith({ id: 'a', status: 'completed', marked: true }));
  });

  it('an administrator adds a task with an expiry after completion, and deletes one after confirming', async () => {
    const transport = transportWith([task('a')]);
    render(
      <ConfirmProvider>
        <TodoListView transport={transport} canManage userId="u1" />
      </ConfirmProvider>,
    );
    const form = await screen.findByRole('form', { name: t('todos.add.title') });

    fireEvent.change(within(form).getByLabelText(new RegExp(t('todos.add.text'))), { target: { value: '  Ship order 12  ' } });
    fireEvent.focus(within(form).getByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: t('todos.expiry.after1d') }));
    fireEvent.click(within(form).getByRole('button', { name: t('todos.add.submit') }));
    await waitFor(() => expect(transport.create).toHaveBeenCalledWith({ text: 'Ship order 12', expireAfterHours: 24 }));

    fireEvent.click(within(item('a')).getByRole('button', { name: t('todos.delete') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('todos.delete') }));
    await waitFor(() => expect(transport.remove).toHaveBeenCalledWith('a'));
  });

  it('a custom expiry in days is sent as hours, and a fixed time as an ISO time', async () => {
    const transport = transportWith([]);
    render(<TodoListView transport={transport} canManage userId="u1" />);
    const form = await screen.findByRole('form', { name: t('todos.add.title') });
    fireEvent.change(within(form).getByLabelText(new RegExp(t('todos.add.text'))), { target: { value: 'Custom' } });

    fireEvent.focus(within(form).getByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: t('todos.expiry.afterCustom') }));
    fireEvent.change(within(form).getByLabelText(new RegExp(t('todos.expiry.amount'))), { target: { value: '3' } });
    fireEvent.focus(within(form).getAllByRole('combobox')[1]!);
    fireEvent.mouseDown(screen.getByRole('option', { name: t('todos.expiry.unit.days') }));
    fireEvent.click(within(form).getByRole('button', { name: t('todos.add.submit') }));
    await waitFor(() => expect(transport.create).toHaveBeenCalledWith({ text: 'Custom', expireAfterHours: 72 }));

    fireEvent.change(within(form).getByLabelText(new RegExp(t('todos.add.text'))), { target: { value: 'Fixed' } });
    fireEvent.focus(within(form).getAllByRole('combobox')[0]!);
    fireEvent.mouseDown(screen.getByRole('option', { name: t('todos.expiry.at') }));
    fireEvent.change(within(form).getByLabelText(new RegExp(t('todos.expiry.atLabel'))), {
      target: { value: '2030-01-02T09:30' },
    });
    fireEvent.click(within(form).getByRole('button', { name: t('todos.add.submit') }));
    await waitFor(() =>
      expect(transport.create).toHaveBeenLastCalledWith({
        text: 'Fixed',
        expiresAt: new Date('2030-01-02T09:30').toISOString(),
      }),
    );
  });

  it('reads the list again when the revision moves (a change from somebody else)', async () => {
    const transport = transportWith([]);
    const { rerender } = render(<TodoListView transport={transport} canManage={false} userId="u1" revision={0} />);
    await screen.findByText(t('todos.empty.title'));
    rerender(<TodoListView transport={transport} canManage={false} userId="u1" revision={1} />);
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
  });
});
