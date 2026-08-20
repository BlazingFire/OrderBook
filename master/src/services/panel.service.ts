/**
 * Office Panel pairing and presence.
 *
 * Auto pairing is gated on an operator having the Master's "Add Office Panel"
 * screen open — the pairing window below. Without it, a panel that discovers
 * the Master over UDP is refused, so joining the system always requires a
 * deliberate action at the Master.
 */

import { randomBytes } from 'node:crypto';
import type { OfficePanel, OfficePanelWithPresence, PairingRequest, PairingSuccess } from '@orderbook/shared';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as panelRepo from '../repositories/office-panel.repository.js';
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
  if (!identity) throw new ValidationError('This Master Panel has not finished its first-run setup');

  if (request.mode === 'auto') {
    if (!isAcceptingPairing()) {
      throw new UnauthorizedError(
        'The Master Panel is not accepting new panels right now. Open "Add Office Panel" on the Master and try again.',
      );
    }
  } else {
    if (!request.pairingPassword || !(await verifyPairingPassword(request.pairingPassword))) {
      throw new UnauthorizedError('Incorrect pairing password');
    }
    if (request.masterUniqueId && request.masterUniqueId !== identity.masterUniqueId) {
      throw new UnauthorizedError('This is a different Master Panel than the one you entered');
    }
  }

  const panelSecret = randomBytes(32).toString('base64url');
  const panel = await panelRepo.insertPanel({
    id: uuid(),
    name: request.panelName?.trim() || (await defaultPanelName()),
    secret_hash: await bcrypt.hash(panelSecret, BCRYPT_ROUNDS),
    lan_ip: remoteIp,
    status: 'active',
    paired_at: new Date(),
  });

  // One panel per opening of the screen: the window closes as soon as a panel
  // pairs, so leaving the screen open does not silently admit others.
  if (request.mode === 'auto') closePairingWindow();

  await activityLog.recordActivity({
    entityType: 'office_panel',
    entityId: panel.id,
    action: 'created',
    actorType: 'system',
    actorId: null,
    details: { mode: request.mode, hostname: request.hostname },
  });
  publishChange({ entity: 'office_panel', action: 'created', id: panel.id, payload: panel });

  log.info(`Paired office panel "${panel.name}" (${panel.id}) via ${request.mode}`);

  return {
    panelId: panel.id,
    panelSecret,
    masterUniqueId: identity.masterUniqueId,
    companyName: identity.companyName,
  };
}

export async function authenticatePanel(panelId: string, panelSecret: string): Promise<OfficePanel> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.status !== 'active') throw new UnauthorizedError('This panel is not paired');

  const secretHash = await panelRepo.findPanelSecretHash(panelId);
  if (!secretHash || !(await bcrypt.compare(panelSecret, secretHash))) {
    throw new UnauthorizedError('Panel credentials are not valid');
  }

  return panel;
}

export async function revokePanel(panelId: string): Promise<OfficePanel> {
  const panel = await panelRepo.updatePanelStatus(panelId, 'revoked');
  if (!panel) throw new ValidationError('Panel not found');

  connectedPanelIds.delete(panelId);

  await activityLog.recordActivity({
    entityType: 'office_panel',
    entityId: panelId,
    action: 'updated',
    actorType: 'user',
    actorId: null,
    details: { status: 'revoked' },
  });
  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });

  return panel;
}

export async function renamePanel(panelId: string, name: string): Promise<OfficePanel> {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('Panel name cannot be empty');

  const panel = await panelRepo.renamePanel(panelId, trimmed);
  if (!panel) throw new ValidationError('Panel not found');

  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  return panel;
}

export async function listPanelsWithPresence(): Promise<OfficePanelWithPresence[]> {
  const panels = await panelRepo.listPanels();
  return panels.map((panel) => ({ ...panel, isConnected: connectedPanelIds.has(panel.id) }));
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

async function defaultPanelName(): Promise<string> {
  const existing = await panelRepo.countPanelsNamed('Office Panel');
  return `Office Panel ${existing + 1}`;
}
