/**
 * Whose authority an Office Panel's commands carry (docs/ROLES_AND_USERS.md §13).
 *
 * Before per-user sign-in existed, an Office Panel acted as a machine and
 * everyone who walked up to it inherited the panel's role. Now a panel presents
 * a session token and its commands run as that person — which introduces
 * exactly one way to get this dangerously wrong.
 *
 * The panel must present a **token**, never an identity. If the Master ever
 * takes a panel's word for who it is acting as, a modified panel names itself an
 * administrator and the entire permission model is decoration. So the tests that
 * matter most here are the negative ones: an invented token, a token from
 * another company, and a token belonging to somebody who has since been
 * deactivated must all fail *closed*, back to the panel's own role.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { hashPassword } from '../src/lib/password.js';
import * as panelRepo from '../src/repositories/office-panel.repository.js';
import * as authService from '../src/services/auth.service.js';
import { resolvePanelActor } from '../src/services/panel-actor.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;
let tenantId: string;
let panelId: string;

const DEVICE_CODE = 'K7M2QX';

/** A paired panel holding the narrowest role we can give it. */
async function createPanel(roleId: string | null): Promise<string> {
  const id = randomUUID();

  await panelRepo.insertPanel({
    id,
    tenant_id: tenantId,
    name: 'Front Desk',
    device_code: DEVICE_CODE,
    secret_hash: await hashPassword('panel-secret'),
    lan_ip: '192.168.1.20',
    status: 'active',
    paired_at: new Date(),
  });

  await db()('office_panels').where({ id }).update({ role_id: roleId });
  return id;
}

/** Somebody with a role well above whatever the panel itself holds. */
async function signedInManager(password = 'correct-horse'): Promise<{ token: string; userId: string }> {
  const role = await roleService.createRole(
    {
      name: 'Sales',
      tier: 'management',
      permissions: ['leads.view', 'leads.create', 'leads.export', 'orders.view'],
    },
    admin,
  );

  const { user } = await userService.createUser(
    { username: 'sunita', displayName: 'Sunita Shah', roleId: role.id, password },
    admin,
  );

  const { token } = await authService.signIn('sunita', password);
  return { token, userId: user.id };
}

describe.skipIf(!canRunIntegrationTests)('the actor behind an Office Panel command', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    tenantId = await testTenantId();

    const dispatch = await roleService.createRole(
      { name: 'Dispatch', tier: 'office', permissions: ['orders.view'] },
      admin,
    );
    panelId = await createPanel(dispatch.id);
  });

  it('acts as the panel when nobody has signed in', async () => {
    const { actor, tokenAccepted } = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: undefined,
    });

    expect(actor.actorType).toBe('office_panel');
    expect(actor.userId).toBeNull();
    expect(actor.permissions?.permissions).toContain('orders.view');
    expect(actor.permissions?.permissions).not.toContain('leads.create');

    // No token was presented, so there is nothing for the caller to discard.
    expect(tokenAccepted).toBe(true);
  });

  it('acts as the signed-in person, with their role rather than the panel’s', async () => {
    const { token, userId } = await signedInManager();

    const { actor, tokenAccepted } = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });

    expect(tokenAccepted).toBe(true);
    expect(actor.actorType).toBe('user');
    expect(actor.userId).toBe(userId);

    // Theirs, not the panel's — the panel alone could not raise a lead.
    expect(actor.permissions?.permissions).toContain('leads.create');
    expect(actor.permissions?.tier).toBe('management');
  });

  it('keeps the panel’s device code, because ids identify the machine', async () => {
    const { token } = await signedInManager();

    const { actor } = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });

    // A temporary id and an HLC timestamp say which machine minted them. If the
    // person's identity displaced the device code, two panels could mint the
    // same temporary id and the sync ordering would stop being total.
    expect(actor.deviceCode).toBe(DEVICE_CODE);
  });

  it('falls back to the panel’s own role when the token is invented', async () => {
    const { actor, tokenAccepted } = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: 'not-a-real-token',
    });

    expect(tokenAccepted).toBe(false);
    expect(actor.actorType).toBe('office_panel');
    expect(actor.permissions?.permissions).not.toContain('leads.create');
  });

  it('refuses a valid token spent against a different company', async () => {
    const { token } = await signedInManager();
    const otherTenant = randomUUID();

    const { actor, tokenAccepted } = await resolvePanelActor({
      tenantId: otherTenant,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });

    // The token is genuine; it simply does not belong here. Honouring it would
    // be a cross-company leak, which the tenant check exists to make impossible.
    expect(tokenAccepted).toBe(false);
    expect(actor.userId).toBeNull();
  });

  it('stops acting as somebody the moment they are deactivated', async () => {
    const { token, userId } = await signedInManager();

    const before = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });
    expect(before.actor.permissions?.permissions).toContain('leads.create');

    await userService.updateUser(userId, { isActive: false, expectedVersion: 1 }, admin);

    const after = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });

    // No re-login, no restart, no waiting for a cache to expire: the next
    // command resolves the session again and finds nothing.
    expect(after.tokenAccepted).toBe(false);
    expect(after.actor.actorType).toBe('office_panel');
  });

  it('picks up a permission revoked from the signed-in person’s role on the next command', async () => {
    const { token } = await signedInManager();

    const before = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });
    expect(before.actor.permissions?.permissions).toContain('leads.export');

    const roles = await roleService.listRoles(admin);
    const sales = roles.find((entry) => entry.name === 'Sales');
    if (!sales) throw new Error('The Sales role was not created');

    await roleService.updateRole(
      sales.id,
      {
        name: 'Sales',
        tier: 'management',
        permissions: ['leads.view', 'leads.create', 'orders.view'],
        expectedVersion: sales.sync.version,
      },
      admin,
    );

    const after = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: DEVICE_CODE,
      actingUserToken: token,
    });

    expect(after.actor.permissions?.permissions).not.toContain('leads.export');
    // Still signed in — a revoked permission is not a revoked session.
    expect(after.actor.actorType).toBe('user');
  });
});
