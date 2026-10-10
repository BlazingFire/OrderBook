/**
 * The To-do list (2026-10-08), the sidebar's "To-do list" module on both panels.
 *
 * An administrator (`canManage`, `todos.manage`) writes a task with its auto expiry and deletes
 * one; everybody marks a task "In progress" or "Completed", and presses again to take their own
 * mark back. Each task lists who marked what, and when.
 *
 * The list is read from the Master through `transport` and read again whenever `revision` moves
 * (a `todo` change from anybody). The transport is held in a ref (the transports rule).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  TODO_EXPIRE_AFTER_HOURS_MAX,
  TODO_TEXT_MAX,
  type TodoInput,
  type TodoMarkInput,
  type TodoMarkStatus,
  type TodoTask,
} from '@orderbook/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmDialog.js';
import { apiErrorText } from './errorText.js';
import { formatDateTime } from './format.js';
import { FieldError, FormField, Input, NumberInput, Textarea } from './Form.js';
import { t } from './i18n.js';
import { ConflictBanner, EmptyState, ErrorState, SkeletonRows } from './States.js';
import { Select } from './SuggestInput.js';

export interface TodoTransport {
  list: () => Promise<TodoTask[]>;
  create: (input: TodoInput) => Promise<TodoTask>;
  mark: (input: TodoMarkInput) => Promise<TodoTask>;
  remove: (id: string) => Promise<{ id: string }>;
}

export interface TodoListViewProps {
  transport: TodoTransport;
  /** `todos.manage`: the Add task form and Delete. */
  canManage: boolean;
  /** The person signed in, whose own marks show as pressed. */
  userId: string | null;
  revision?: number;
}

type ExpiryChoice = 'none' | 'at' | '1' | '24' | '168' | 'custom';

/** What the form's expiry choice sends, or null when the custom amount is not a whole number. */
function expiryInput(
  choice: ExpiryChoice,
  at: string,
  amount: string,
  unit: 'hours' | 'days',
): Partial<Pick<TodoInput, 'expiresAt' | 'expireAfterHours'>> | null {
  if (choice === 'none') return {};
  if (choice === 'at') {
    const when = new Date(at);
    return Number.isNaN(when.getTime()) ? null : { expiresAt: when.toISOString() };
  }
  if (choice !== 'custom') return { expireAfterHours: Number(choice) };
  const hours = Number(amount) * (unit === 'days' ? 24 : 1);
  if (!Number.isInteger(hours) || hours < 1 || hours > TODO_EXPIRE_AFTER_HOURS_MAX) return null;
  return { expireAfterHours: hours };
}

export function TodoListView({ transport, canManage, userId, revision }: TodoListViewProps) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const confirm = useConfirm();

  const [tasks, setTasks] = useState<TodoTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    transportRef.current.list().then(
      (list) => {
        if (!live) return;
        setTasks(list);
        setLoadError(null);
      },
      (caught: unknown) => live && setLoadError(apiErrorText(caught, 'todos.loadFailed')),
    );
    return () => {
      live = false;
    };
  }, [revision, reload]);

  /** One write at a time; the list is read again after it, whatever this panel's events do. */
  async function run(key: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      setReload((count) => count + 1);
      return true;
    } catch (caught) {
      setActionError(apiErrorText(caught, 'todos.actionFailed'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (tasks === null && loadError) {
    return (
      <ErrorState
        title={t('todos.loadFailed')}
        description={loadError}
        actionLabel={t('action.retryNow')}
        onAction={() => setReload((count) => count + 1)}
      />
    );
  }
  if (tasks === null) return <SkeletonRows rows={4} columns={1} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)', maxWidth: '56rem' }}>
      {canManage && <AddTask busy={busy === 'add'} onAdd={(input) => run('add', () => transportRef.current.create(input))} />}
      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      {tasks.length === 0 ? (
        <EmptyState title={t('todos.empty.title')} description={t('todos.empty.body')} />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          {tasks.map((task) => (
            <TodoItem
              key={task.id}
              task={task}
              userId={userId}
              canManage={canManage}
              busy={busy}
              onMark={(status, marked) =>
                void run(`${task.id}:${status}`, () => transportRef.current.mark({ id: task.id, status, marked }))
              }
              onDelete={async () => {
                const sure = await confirm({
                  title: t('todos.delete.confirmTitle'),
                  body: t('todos.delete.confirmBody'),
                  confirmLabel: t('todos.delete'),
                  tone: 'danger',
                });
                if (sure) await run(`${task.id}:delete`, () => transportRef.current.remove(task.id));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddTask({ busy, onAdd }: { busy: boolean; onAdd: (input: TodoInput) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<ExpiryChoice>('none');
  const [at, setAt] = useState('');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'hours' | 'days'>('hours');
  const expiry = expiryInput(choice, at, amount, unit);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!text.trim() || !expiry) return;
    if (await onAdd({ text: text.trim(), ...expiry })) {
      setText('');
      setChoice('none');
      setAt('');
      setAmount('');
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label={t('todos.add.title')}
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-surface)',
        padding: 'var(--s-12) var(--s-16)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-8)',
      }}
    >
      <FormField label={t('todos.add.text')} required>
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={text}
            maxLength={TODO_TEXT_MAX}
            placeholder={t('todos.add.placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </FormField>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
        <div style={{ width: '16rem' }}>
          <FormField label={t('todos.add.expiry')}>
            {(id) => (
              <Select id={id} value={choice} onChange={(event) => setChoice(event.target.value as ExpiryChoice)}>
                <option value="none">{t('todos.expiry.none')}</option>
                <option value="at">{t('todos.expiry.at')}</option>
                <option value="1">{t('todos.expiry.after1h')}</option>
                <option value="24">{t('todos.expiry.after1d')}</option>
                <option value="168">{t('todos.expiry.after7d')}</option>
                <option value="custom">{t('todos.expiry.afterCustom')}</option>
              </Select>
            )}
          </FormField>
        </div>
        {choice === 'at' && (
          <FormField label={t('todos.expiry.atLabel')} required>
            {(id) => (
              <Input id={id} type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
            )}
          </FormField>
        )}
        {choice === 'custom' && (
          <>
            <div style={{ width: '10rem' }}>
              <FormField label={t('todos.expiry.amount')} required>
                {(id) => (
                  <NumberInput id={id} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
                )}
              </FormField>
            </div>
            <div style={{ width: '8rem' }}>
              <FormField label={t('todos.expiry.unit')}>
                {(id) => (
                  <Select id={id} value={unit} onChange={(event) => setUnit(event.target.value as 'hours' | 'days')}>
                    <option value="hours">{t('todos.expiry.unit.hours')}</option>
                    <option value="days">{t('todos.expiry.unit.days')}</option>
                  </Select>
                )}
              </FormField>
            </div>
          </>
        )}
      </div>
      {!expiry && (choice === 'at' ? at : amount) && (
        <FieldError>
          {choice === 'at'
            ? t('validation.todo.expiresAtInvalid')
            : t('validation.todo.expireAfterInvalid', { max: TODO_EXPIRE_AFTER_HOURS_MAX })}
        </FieldError>
      )}
      <div>
        <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={!text.trim() || !expiry}>
          {t('todos.add.submit')}
        </Button>
      </div>
    </form>
  );
}

function TodoItem({
  task,
  userId,
  canManage,
  busy,
  onMark,
  onDelete,
}: {
  task: TodoTask;
  userId: string | null;
  canManage: boolean;
  busy: string | null;
  onMark: (status: TodoMarkStatus, marked: boolean) => void;
  onDelete: () => void;
}) {
  const marksOf = (status: TodoMarkStatus) => task.marks.filter((mark) => mark.status === status);
  const mine = (status: TodoMarkStatus) => marksOf(status).some((mark) => mark.userId === userId);
  const names = (status: TodoMarkStatus) =>
    marksOf(status)
      .map((mark) => t('todos.marks.entry', { name: mark.name, when: formatDateTime(mark.markedAt) }))
      .join(', ');

  const expiry = task.expiresAt
    ? t('todos.meta.expiresAt', { when: formatDateTime(task.expiresAt) })
    : task.expireAfterHours
      ? t('todos.meta.expiresAfter', { hours: task.expireAfterHours })
      : null;

  return (
    <li
      data-todo={task.id}
      data-completed={task.completedAt ? true : undefined}
      style={{
        border: '1px solid var(--line)',
        borderLeft: task.completedAt ? '3px solid var(--state-ok)' : '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-surface)',
        padding: 'var(--s-12) var(--s-16)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-8)',
      }}
    >
      <p className="ob-body" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {task.text}
      </p>
      <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {t('todos.meta.by', { author: task.createdByName ?? '—', when: formatDateTime(task.createdAt) })}
        {expiry ? ` · ${expiry}` : ''}
      </span>
      {(['in_progress', 'completed'] as const).map((status) =>
        marksOf(status).length > 0 ? (
          <span key={status} className="ob-small">
            {t(status === 'in_progress' ? 'todos.marks.inProgress' : 'todos.marks.completed', { names: names(status) })}
          </span>
        ) : null,
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
        {(['in_progress', 'completed'] as const).map((status) => (
          <Button
            key={status}
            size="sm"
            variant={mine(status) ? 'primary' : 'secondary'}
            icon={status === 'completed' ? 'check' : 'task'}
            aria-pressed={mine(status)}
            busy={busy === `${task.id}:${status}`}
            disabled={busy !== null || !userId}
            onClick={() => onMark(status, !mine(status))}
          >
            {t(status === 'in_progress' ? 'todos.mark.inProgress' : 'todos.mark.completed')}
          </Button>
        ))}
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            style={{ marginLeft: 'auto' }}
            busy={busy === `${task.id}:delete`}
            disabled={busy !== null}
            onClick={onDelete}
          >
            {t('todos.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}
