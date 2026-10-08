/**
 * The To-do list against a real database (2026-10-08).
 *
 * The rules under test: an administrator (`todos.manage`) writes and deletes tasks; anybody with
 * `todos.view` marks a task In progress or Completed, more than one person may mark, a person
 * takes their own mark back, and a Completed mark keeps the same person's In progress one; a
 * task with a fixed expiry, or one that expires some hours after its earliest Completed mark,
 * leaves the list (worked out by the database at read time); and every write is announced.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as roleService from '../src/services/role.service.js';
import * as todoService from '../src/services/todo.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

async function person(
  name: string,
  permissions: string[],
  tier: 'office' | 'admin' = 'office',
): Promise<{ actor: ActorContext; userId: string }> {
  const role = await roleService.createRole(
    { name: `Role ${name}`, tier, permissions, noticeBoard: false },
    admin,
  );
  const { user } = await userService.createUser(
    { username: name, displayName: name, roleId: role.id },
    admin,
  );
  const actor = await testActor({
    actorId: user.id,
    userId: user.id,
    actorName: name,
    permissions: { roleId: role.id, roleName: role.name, tier, permissions },
  });
  return { actor, userId: user.id };
}

describe.skipIf(!canRunIntegrationTests)('the To-do list (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  let boss: Awaited<ReturnType<typeof person>>;
  let ravi: Awaited<ReturnType<typeof person>>;
  let bina: Awaited<ReturnType<typeof person>>;

  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
    boss = await person('boss', ['todos.view', 'todos.manage', 'logs.view'], 'admin');
    ravi = await person('ravi', ['todos.view']);
    bina = await person('bina', ['todos.view']);
  });

  const texts = async (who = ravi) => (await todoService.listTodos(who.actor)).map((task) => task.text);

  /** Moves a task's Completed marks into the past, so completion-based expiry can be read now. */
  const completedHoursAgo = (id: string, hours: number) =>
    db().raw(
      `UPDATE todo_marks SET marked_at = now() - make_interval(hours => ?) WHERE todo_id = ? AND status = 'completed'`,
      [hours, id],
    );

  it('TD-1: an administrator writes a task, everybody reads it, newest first', async () => {
    await todoService.createTodo({ text: '  Call the tile supplier  ' }, boss.actor);
    const second = await todoService.createTodo({ text: 'Count the boxes' }, boss.actor);

    expect(second).toMatchObject({ text: 'Count the boxes', createdByName: 'boss', marks: [], completedAt: null });
    expect(await texts(ravi)).toEqual(['Count the boxes', 'Call the tile supplier']);
    expect(await texts(bina)).toEqual(['Count the boxes', 'Call the tile supplier']);
  });

  it('TD-2: writing and deleting need todos.manage; text is required and at most 500 characters', async () => {
    await expect(todoService.createTodo({ text: 'x' }, ravi.actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(todoService.createTodo({ text: '   ' }, boss.actor)).rejects.toMatchObject({
      messageKey: 'validation.todo.textRequired',
    });
    await expect(todoService.createTodo({ text: 'y'.repeat(501) }, boss.actor)).rejects.toMatchObject({
      messageKey: 'validation.todo.textTooLong',
    });
    const task = await todoService.createTodo({ text: 'Keep' }, boss.actor);
    await expect(todoService.deleteTodo(task.id, ravi.actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(await texts()).toEqual(['Keep']);
  });

  it('TD-3: two people mark, each shows with their time, and a person takes only their own mark back', async () => {
    const task = await todoService.createTodo({ text: 'Load the truck' }, boss.actor);

    await todoService.markTodo({ id: task.id, status: 'in_progress', marked: true }, ravi.actor);
    await todoService.markTodo({ id: task.id, status: 'in_progress', marked: true }, bina.actor);
    // Twice is a no-op.
    await todoService.markTodo({ id: task.id, status: 'in_progress', marked: true }, bina.actor);
    const done = await todoService.markTodo({ id: task.id, status: 'completed', marked: true }, ravi.actor);

    expect(done.completedAt).not.toBeNull();
    expect(done.marks.map((mark) => [mark.name, mark.status])).toEqual([
      ['ravi', 'in_progress'],
      ['bina', 'in_progress'],
      ['ravi', 'completed'],
    ]);
    expect(done.marks.every((mark) => typeof mark.markedAt === 'string')).toBe(true);

    const after = await todoService.markTodo({ id: task.id, status: 'in_progress', marked: false }, bina.actor);
    expect(after.marks.map((mark) => [mark.name, mark.status])).toEqual([
      ['ravi', 'in_progress'],
      ['ravi', 'completed'],
    ]);

    const reopened = await todoService.markTodo({ id: task.id, status: 'completed', marked: false }, ravi.actor);
    expect(reopened.completedAt).toBeNull();
  });

  it('TD-4: a mark needs a person, a valid status and a live task', async () => {
    const task = await todoService.createTodo({ text: 'x' }, boss.actor);
    const panel = await testActor({ actorType: 'office_panel', actorId: 'P1', userId: null, permissions: ravi.actor.permissions });
    await expect(
      todoService.markTodo({ id: task.id, status: 'completed', marked: true }, panel),
    ).rejects.toMatchObject({ messageKey: 'error.conflict.noTodoMarker' });
    await expect(
      todoService.markTodo({ id: task.id, status: 'done' as never, marked: true }, ravi.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.todo.statusInvalid' });

    await todoService.deleteTodo(task.id, boss.actor);
    await expect(
      todoService.markTodo({ id: task.id, status: 'completed', marked: true }, ravi.actor),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('TD-5: a deleted task is gone for everybody and kept as a soft delete', async () => {
    const task = await todoService.createTodo({ text: 'Gone' }, boss.actor);
    await todoService.deleteTodo(task.id, boss.actor);

    expect(await texts(ravi)).toEqual([]);
    expect(await texts(boss)).toEqual([]);
    const row = await db()('todos').where({ id: task.id }).first();
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(boss.userId);
    await expect(todoService.deleteTodo(task.id, boss.actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('TD-6: a task with a fixed expiry leaves the list once it passes; a past time is refused', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const task = await todoService.createTodo({ text: 'Fixed', expiresAt: soon }, boss.actor);
    expect(task.expiresAt).toBe(soon);
    expect(await texts()).toEqual(['Fixed']);

    await db()('todos').where({ id: task.id }).update({ expires_at: db().raw(`now() - interval '1 minute'`) });
    expect(await texts()).toEqual([]);

    await expect(
      todoService.createTodo({ text: 'Late', expiresAt: '2020-01-01T00:00:00Z' }, boss.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.todo.expiresAtInvalid' });
    await expect(
      todoService.createTodo({ text: 'Both', expiresAt: soon, expireAfterHours: 2 }, boss.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.todo.expiryBoth' });
    await expect(
      todoService.createTodo({ text: 'Zero', expireAfterHours: 0 }, boss.actor),
    ).rejects.toMatchObject({ messageKey: 'validation.todo.expireAfterInvalid' });
  });

  it('TD-7: a task that expires after completion counts from the earliest Completed mark', async () => {
    const task = await todoService.createTodo({ text: 'After', expireAfterHours: 2 }, boss.actor);
    expect(task.expiresAt).toBeNull();

    const done = await todoService.markTodo({ id: task.id, status: 'completed', marked: true }, ravi.actor);
    expect(new Date(done.expiresAt!).getTime() - new Date(done.completedAt!).getTime()).toBe(2 * 3_600_000);

    // Completed an hour ago: still on the list.
    await completedHoursAgo(task.id, 1);
    expect(await texts()).toEqual(['After']);

    // Completed three hours ago: past its two hours, gone for everybody.
    await completedHoursAgo(task.id, 3);
    expect(await texts(ravi)).toEqual([]);
    expect(await texts(boss)).toEqual([]);
  });

  it('TD-8: an uncompleted task with completion-based expiry stays, however old', async () => {
    const task = await todoService.createTodo({ text: 'Waiting', expireAfterHours: 1 }, boss.actor);
    await db()('todos').where({ id: task.id }).update({ created_at: db().raw(`now() - interval '30 days'`) });
    await todoService.markTodo({ id: task.id, status: 'in_progress', marked: true }, ravi.actor);
    expect(await texts()).toEqual(['Waiting']);
  });

  it('TD-9: every write is announced as a todo change with no payload, and logged', async () => {
    const task = await todoService.createTodo({ text: 'Announce' }, boss.actor);
    await todoService.markTodo({ id: task.id, status: 'completed', marked: true }, ravi.actor);
    await todoService.deleteTodo(task.id, boss.actor);

    const events = since(0)?.filter((event) => event.entity === 'todo') ?? [];
    expect(events.map((event) => [event.action, event.id, event.payload])).toEqual([
      ['created', task.id, null],
      ['updated', task.id, null],
      ['deleted', task.id, null],
    ]);

    const log = await db()('activity_log').where({ entity_type: 'todo', entity_id: task.id }).orderBy('id');
    expect(log.map((row: { action: string }) => row.action)).toEqual(['created', 'deleted']);
  });

  it('TD-10: a new role gets todos.view by default, and the migration-granted keys reached the seeded roles', async () => {
    const role = await roleService.createRole({ name: 'Fresh', tier: 'office', permissions: [] }, admin);
    expect(role.permissions).toContain('todos.view');
    const exact = await roleService.createRole(
      { name: 'Exact', tier: 'office', permissions: [], noticeBoard: true, todoList: false },
      admin,
    );
    expect(exact.permissions).not.toContain('todos.view');

    const seeded = await db()('roles').whereIn('name', ['Admin', 'Office']).select('name', 'permissions');
    const keys = Object.fromEntries(seeded.map((row: { name: string; permissions: string[] }) => [row.name, row.permissions]));
    expect(keys.Admin).toEqual(expect.arrayContaining(['todos.view', 'todos.manage']));
    expect(keys.Office).toContain('todos.view');
    expect(keys.Office).not.toContain('todos.manage');
  });
});
