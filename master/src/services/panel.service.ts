/**
 * Office Panel pairing and presence.
 *
 * Auto pairing is gated on an operator having the Master's "Add Office Panel"
 * screen open — the pairing window below. Without it, a panel that discovers
 * the Master over UDP is refused, so joining the system always requires a
 * deliberate action at the Master.
 */

import { randomBytes } from 'node:crypto';
import type {
  OfficePanel,
  OfficePanelWithPresence,
  PairingRequest,
  PairingSuccess,
  PermissionSet,
} from '@orderbook/shared';
import { deviceCodeFromSeed } from '@orderbook/shared';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { systemActor } from '../domain/actor.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as panelRepo from '../repositories/office-panel.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import { roleIdForTier } from '../repositories/user.repository.js';
import { publishChange } from './change-bus.js';
import { getIdentity, verifyPairingPassword } from './setup.service.js';

const log = createLogger('pairing');
const BCRYPT_ROUNDS = 10;

/** Auto-pairing stays open only this long after the operator opens the screen. */
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

let pairingWindowClosesAt = 0;

/** Panel ids with a live socket right now. Presence is runtime state, not a column. */
const connectedPanelIds = new Set<string>();

export function openPairingWindow(): { closesAt: number } {
  pairingWindowClosesAt = Date.now() + PAIRING_WINDOW_MS;
  log.info('Pairing window opened');
  return { closesAt: pairingWindowClosesAt };
}

export function closePairingWindow(): void {
  pairingWindowClosesAt = 0;
  log.info('Pairing window closed');
}

export function isAcceptingPairing(): boolean {
  return Date.now() < pairingWindowClosesAt;
}

export async function pairPanel(request: PairingRequest, remoteIp: string | null): Promise<PairingSuccess> {
  const identity = await getIdentity();
  if (!identity) throw new ValidationError('validation.panel.setupIncomplete');

  if (request.mode === 'auto') {
    if (!isAcceptingPairing()) {
      throw new UnauthorizedError('error.unauthorized.pairingNotAccepting');
    }
  } else {
    if (!request.pairingPassword || !(await verifyPairingPassword(request.pairingPassword))) {
      throw new UnauthorizedError('error.unauthorized.incorrectPairingPassword');
    }
    if (request.masterUniqueId && request.masterUniqueId !== identity.masterUniqueId) {
      throw new UnauthorizedError('error.unauthorized.differentMaster');
    }
  }

  const panelSecret = randomBytes(32).toString('base64url');
  const panelId = uuid();
  const panel = await panelRepo.insertPanel({
    id: panelId,
    tenant_id: identity.tenantId,
    name: request.panelName?.trim() || (await defaultPanelName(identity.tenantId)),
    // Derived from the panel id rather than stored randomly, so a panel that
    // loses its local files recovers the same code — and its existing
    // temporary ids stay attributable to it.
    device_code: deviceCodeFromSeed(panelId),
    secret_hash: await bcrypt.hash(panelSecret, BCRYPT_ROUNDS),
    lan_ip: remoteIp,
    status: 'active',
    paired_at: new Date(),
  });

  // One panel per opening of the screen: the window closes as soon as a panel
  // pairs, so leaving the screen open does not silently admit others.
  if (request.mode === 'auto') closePairingWindow();

  await activityLog.recordDetachedActivity({
    tenantId: identity.tenantId,
    entityType: 'office_panel',
    entityId: panel.id,
    action: 'created',
    actorType: 'system',
    actorId: null,
    details: { mode: request.mode, hostname: request.hostname },
  }, systemActor(identity.tenantId), db());
  publishChange({ entity: 'office_panel', action: 'created', id: panel.id, payload: panel });

  log.info(`Paired office panel "${panel.name}" (${panel.id}) via ${request.mode}`);

  return {
    panelId: panel.id,
    panelSecret,
    masterUniqueId: identity.masterUniqueId,
    companyName: identity.companyName,
  };
}

export async function authenticatePanel(
  panelId: string,
  panelSecret: string,
  /** What the panel says it is running. Absent from panels older than the field. */
  appVersion?: string,
): Promise<OfficePanel> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.status !== 'active') throw new UnauthorizedError('error.unauthorized.panelNotPaired');

  const secretHash = await panelRepo.findPanelSecretHash(panelId);
  if (!secretHash || !(await bcrypt.compare(panelSecret, secretHash))) {
    throw new UnauthorizedError('error.unauthorized.panelCredentialsInvalid');
  }

  // Recorded only when it has actually changed, so a panel reconnecting every
  // few seconds on a flaky link does not write a row every time.
  if (appVersion && appVersion !== panel.appVersion) {
    const updated = await panelRepo.updatePanelAppVersion(panelId, appVersion);
    if (updated) return updated;
  }

  return panel;
}

export async function revokePanel(panelId: string): Promise<OfficePanel> {
  const panel = await panelRepo.updatePanelStatus(panelId, 'revoked');
  if (!panel) throw new ValidationError('error.notFound', { what: 'Panel' });

  connectedPanelIds.delete(panelId);

  await activityLog.recordDetachedActivity({
    tenantId: panel.tenantId,
    entityType: 'office_panel',
    entityId: panelId,
    action: 'updated',
    actorType: 'user',
    actorId: null,
    details: { status: 'revoked' },
  }, systemActor(panel.tenantId), db());
  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });

  return panel;
}

export async function renamePanel(panelId: string, name: string): Promise<OfficePanel> {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('validation.panel.nameEmpty');

  const panel = await panelRepo.renamePanel(panelId, trimmed);
  if (!panel) throw new ValidationError('error.notFound', { what: 'Panel' });

  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  return panel;
}

export async function listPanelsWithPresence(
  tenantId: string,
): Promise<OfficePanelWithPresence[]> {
  const panels = await panelRepo.listPanels(tenantId);
  return panels.map((panel) => ({ ...panel, isConnected: connectedPanelIds.has(panel.id) }));
}

/**
 * What a panel's commands are allowed to do.
 *
 * A panel with no role explicitly assigned falls back to the seeded Office
 * tier: enough to raise and progress a lead, and nothing more. Defaulting to
 * "no permissions" would leave a freshly paired panel unable to do the one job
 * it exists for; defaulting to admin would make pairing a privilege escalation.
 */
export async function permissionsForPanel(
  tenantId: string,
  panelId: string,
): Promise<PermissionSet | null> {
  const roleId =
    (await panelRepo.findPanelRoleId(panelId)) ?? (await roleIdForTier(tenantId, 'office'));
  return permissionSetForRole(tenantId, roleId);
}

export async function markPanelConnected(panelId: string, lanIp: string | null): Promise<void> {
  connectedPanelIds.add(panelId);
  await panelRepo.touchLastSeen(panelId, lanIp);
}

export async function markPanelDisconnected(panelId: string): Promise<void> {
  connectedPanelIds.delete(panelId);
  await panelRepo.touchLastSeen(panelId, null);
}

export function isPanelConnected(panelId: string): boolean {
  return connectedPanelIds.has(panelId);
}

async function defaultPanelName(tenantId: string): Promise<string> {
  const existing = await panelRepo.countPanelsNamed(tenantId, 'Office Panel');
  return `Office Panel ${existing + 1}`;
}
