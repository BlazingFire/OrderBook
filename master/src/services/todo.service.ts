/**
 * The To-do list (2026-10-08): what the Master does with tasks.
 *
 *  - `todos.view` reads the live tasks and puts the reader's own "In progress" / "Completed" mark
 *    on one or takes it off. A mark belongs to a person, so a panel acting as itself cannot mark.
 *  - `todos.manage` writes a task (with its auto expiry) and deletes one.
 *
 * Expiry is worked out in SQL when the list is read, never by a sweeper: a task with a fixed
 * `expires_at` leaves once that passes, one with `expire_after_hours` that many hours after its
 * earliest Completed mark. Removing every Completed mark makes it not completed again.
 *
 * Every write publishes one `todo` event with no payload; an open screen reads the list again.
 */

import {
  TODO_EXPIRE_AFTER_HOURS_MAX,
  TODO_TEXT_MAX,
  isTodoMarkStatus,
  type TodoInput,
  type TodoMarkInput,
  type TodoMarkStatus,
  type TodoTask,
} from '@orderbook/shared';

import { db } from '../db/knex.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { publishChange } from './change-bus.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertTodoId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new NotFoundError('Task');
}

interface TodoRow {
  id: string;
  text: string;
  created_by_name: string | null;
  created_at: Date;
  expires_at: Date | null;
  expire_after_hours: number | null;
  completed_at: Date | null;
}

interface MarkRow {
  todo_id: string;
  user_id: string;
  name: string;
  status: TodoMarkStatus;
  marked_at: Date;
}

/**
 * The live tasks (or one of them): not deleted and not expired, newest first, with the earliest
 * Completed mark and the expiry it gives.
 */
async function liveRows(tenantId: string, id?: string): Promise<TodoRow[]> {
  const { rows } = await db().raw<{ rows: TodoRow[] }>(
    `
    SELECT t.id, t.text, u.display_name AS created_by_name, t.created_at, t.expire_after_hours,
           c.completed_at,
           COALESCE(t.expires_at, c.completed_at + make_interval(hours => t.expire_after_hours))
             AS expires_at
      FROM todos t
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN LATERAL (
        SELECT min(m.marked_at) AS completed_at
          FROM todo_marks m
         WHERE m.todo_id = t.id AND m.status = 'completed'
      ) c ON true
     WHERE t.tenant_id = ? AND t.deleted_at IS NULL ${id ? 'AND t.id = ?' : ''}
       AND (t.expires_at IS NULL OR t.expires_at > now())
       AND (t.expire_after_hours IS NULL OR c.completed_at IS NULL
            OR c.completed_at + make_interval(hours => t.expire_after_hours) > now())
     ORDER BY t.created_at DESC, t.id
    `,
    id ? [tenantId, id] : [tenantId],
  );
  return rows;
}

async function withMarks(rows: TodoRow[]): Promise<TodoTask[]> {
  const marks =
    rows.length === 0
      ? []
      : await db()('todo_marks as m')
          .join('users as u', 'u.id', 'm.user_id')
          .whereIn(
            'm.todo_id',
            rows.map((row) => row.id),
          )
          .orderBy([{ column: 'm.marked_at' }, { column: 'u.display_name' }])
          .select<MarkRow[]>('m.todo_id', 'm.user_id', 'u.display_name as name', 'm.status', 'm.marked_at');

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    expireAfterHours: row.expire_after_hours,
    completedAt: row.completed_at?.toISOString() ?? null,
    marks: marks
      .filter((mark) => mark.todo_id === row.id)
      .map((mark) => ({
        userId: mark.user_id,
        name: mark.name,
        status: mark.status,
        markedAt: mark.marked_at.toISOString(),
      })),
  }));
}

async function oneTask(tenantId: string, id: string): Promise<TodoTask> {
  const [task] = await withMarks(await liveRows(tenantId, id));
  if (!task) throw new NotFoundError('Task');
  return task;
}

function changed(id: string, action: 'created' | 'updated' | 'deleted'): void {
  publishChange({ entity: 'todo', action, id, payload: null });
}

/** The request body as a task, or a 400. */
function parseInput(body: unknown): { text: string; expiresAt: Date | null; expireAfterHours: number | null } {
  if (!body || typeof body !== 'object') throw new ValidationError('validation.todo.malformed');
  const raw = body as Partial<Record<keyof TodoInput, unknown>>;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw new ValidationError('validation.todo.textRequired');
  if (text.length > TODO_TEXT_MAX) {
    throw new ValidationError('validation.todo.textTooLong', { max: TODO_TEXT_MAX });
  }

  const hasAt = raw.expiresAt !== undefined && raw.expiresAt !== null;
  const hasAfter = raw.expireAfterHours !== undefined && raw.expireAfterHours !== null;
  if (hasAt && hasAfter) throw new ValidationError('validation.todo.expiryBoth');

  let expiresAt: Date | null = null;
  if (hasAt) {
    expiresAt = typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : new Date(NaN);
    // A time already past would hide the task the moment it is written.
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('validation.todo.expiresAtInvalid');
    }
  }
  const hours = raw.expireAfterHours;
  if (
    hasAfter &&
    !(typeof hours === 'number' && Number.isInteger(hours) && hours >= 1 && hours <= TODO_EXPIRE_AFTER_HOURS_MAX)
  ) {
    throw new ValidationError('validation.todo.expireAfterInvalid', { max: TODO_EXPIRE_AFTER_HOURS_MAX });
  }

  return { text, expiresAt, expireAfterHours: hasAfter ? (hours as number) : null };
}

export async function listTodos(actor: ActorContext): Promise<TodoTask[]> {
  requirePermission(actor, 'todos.view');
  return withMarks(await liveRows(actor.tenantId));
}

export async function createTodo(body: unknown, actor: ActorContext): Promise<TodoTask> {
  requirePermission(actor, 'todos.manage');
  const input = parseInput(body);

  const id = await db().transaction(async (trx) => {
    const [row] = await trx('todos')
      .insert({
        tenant_id: actor.tenantId,
        text: input.text,
        expires_at: input.expiresAt,
        expire_after_hours: input.expireAfterHours,
        created_by: actorUserId(actor),
      })
      .returning<Array<{ id: string }>>('id');
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'todo',
        entityId: row!.id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: input.text },
      },
      actor,
      trx,
    );
    return row!.id;
  });

  changed(id, 'created');
  return oneTask(actor.tenantId, id);
}

/** Puts the acting person's mark on a live task, or takes it off. Doing either twice changes nothing. */
export async function markTodo(input: TodoMarkInput, actor: ActorContext): Promise<TodoTask> {
  requirePermission(actor, 'todos.view');
  const userId = actorUserId(actor);
  if (!userId) throw new ConflictError('error.conflict.noTodoMarker');
  assertTodoId(input?.id);
  if (!isTodoMarkStatus(input.status) || typeof input.marked !== 'boolean') {
    throw new ValidationError('validation.todo.statusInvalid');
  }
  // Only a task still on the list can be marked: a deleted or expired one is a 404.
  await oneTask(actor.tenantId, input.id);

  if (input.marked) {
    await db()('todo_marks')
      .insert({ todo_id: input.id, user_id: userId, status: input.status })
      .onConflict(['todo_id', 'user_id', 'status'])
      .ignore();
  } else {
    await db()('todo_marks').where({ todo_id: input.id, user_id: userId, status: input.status }).delete();
  }

  changed(input.id, 'updated');
  return oneTask(actor.tenantId, input.id);
}

export async function deleteTodo(id: string, actor: ActorContext): Promise<{ id: string }> {
  requirePermission(actor, 'todos.manage');
  assertTodoId(id);

  await db().transaction(async (trx) => {
    const [row] = await trx('todos')
      .where({ id, tenant_id: actor.tenantId })
      .whereNull('deleted_at')
      .update({ deleted_at: trx.fn.now(), deleted_by: actorUserId(actor) })
      .returning<Array<{ text: string }>>('text');
    if (!row) throw new NotFoundError('Task');
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'todo',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { title: row.text },
      },
      actor,
      trx,
    );
  });

  changed(id, 'deleted');
  return { id };
}
