/**
 * Office Panel pairing and presence.
 *
 * Auto pairing is gated on an operator having the Master's "Add Office Panel"
 * screen open — the pairing window below. Without it, a panel that discovers
 * the Master over UDP is refused, so joining the system always requires a
 * deliberate action at the Master.
 */

import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  ActivityLogEntry,
  OfficePanel,
  OfficePanelDetail,
  OfficePanelReportInput,
  OfficePanelRuntime,
  OfficePanelUpdateInput,
  OfficePanelWithPresence,
  PairingRequest,
  PairingSuccess,
  PanelSecretRotation,
  PanelStoragePathInput,
  PanelStoragePathResult,
  PermissionSet,
} from '@orderbook/shared';
import {
  deviceCodeFromSeed,
  isServerMasterTier,
  LONG_OFFLINE_MS,
  MASTER_PROOF_CONTEXT,
  masterProofMessage,
  type MasterProofResponse,
} from '@orderbook/shared';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import type { ActorContext } from '../domain/actor.js';
import { systemActor } from '../domain/actor.js';
import { normalisePanelReport } from '../domain/panel-report.js';
import { NotFoundError, toErrorMessage, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { panelLink } from '../realtime/panel-link.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as panelRepo from '../repositories/office-panel.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { findActiveUserIdsWithPermission, roleIdForTier } from '../repositories/user.repository.js';
import { publishChange } from './change-bus.js';
import { notify } from './notification.service.js';
import { getSetting } from './settings.service.js';
import { getIdentity, verifyPairingPassword } from './setup.service.js';

const log = createLogger('pairing');
const BCRYPT_ROUNDS = 10;

/** Auto-pairing stays open only this long after the operator opens the screen. */
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

let pairingWindowClosesAt = 0;

/** Panel ids with a live socket right now. Presence is runtime state, not a column. */
const connectedPanelIds = new Set<string>();

/**
 * Figures that are only true for the life of one connection.
 *
 * Deliberately not columns. A stored "12 changes pending" would keep asserting
 * a backlog for a panel that has been switched off for a week, and an operator
 * reading it would go looking for work that was pushed long ago. Presence is
 * runtime state, and so is everything derived from it.
 */
const panelRuntime = new Map<string, OfficePanelRuntime>();

/** Longest a note may be. Enough for "front desk, near the printer". */
const MAX_NOTE_LENGTH = 500;

export function openPairingWindow(): { closesAt: number } {
  pairingWindowClosesAt = Date.now() + PAIRING_WINDOW_MS;
  log.info('Pairing window opened');
  return { closesAt: pairingWindowClosesAt };
}

export function closePairingWindow(): void {
  pairingWindowClosesAt = 0;
  log.info('Pairing window closed');
}

/**
 * `openPairingWindow` / `closePairingWindow` for an administrator's click,
 * with the entry the trail needs. The window is memory, not a row, so the
 * entry has a small transaction of its own. The entry is written first and
 * the window changes only once it commits, so a refused entry leaves the
 * window as it was. The bare functions stay for the Master's own closes (a
 * panel pairing in auto mode) and for tests.
 */
export async function openPairingWindowBy(actor: ActorContext): Promise<{ closesAt: number }> {
  await db().transaction((trx) =>
    activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pairing_window',
        entityId: actor.tenantId,
        action: 'opened',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { minutes: PAIRING_WINDOW_MS / 60_000 },
      },
      actor,
      trx,
    ),
  );
  return openPairingWindow();
}

export async function closePairingWindowBy(actor: ActorContext): Promise<void> {
  await db().transaction((trx) =>
    activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'pairing_window',
        entityId: actor.tenantId,
        action: 'closed',
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
      actor,
      trx,
    ),
  );
  closePairingWindow();
}

export function isAcceptingPairing(): boolean {
  return Date.now() < pairingWindowClosesAt;
}

/** The window half of `PairingWindowState`; the route adds the addresses and the discovery status. */
export async function pairingWindowSnapshot(
  tenantId: string,
): Promise<{ open: boolean; closesAt: number | null; autoPairingEnabled: boolean; accepting: boolean }> {
  const open = isAcceptingPairing();
  const autoPairingEnabled = await getSetting(tenantId, 'panels.autoPairingEnabled');
  return {
    open,
    closesAt: open ? pairingWindowClosesAt : null,
    autoPairingEnabled,
    accepting: open && autoPairingEnabled,
  };
}

/**
 * Whether a panel may join right now with no password.
 *
 * Both halves in one place, because three readers ask the question and they
 * must agree. If the discovery reply said yes while `pairPanel` said no, a
 * panel would select this Master, POST auto, and be refused — while the
 * Master's own screen sat waiting for a panel that could never arrive.
 *
 * The window alone used to be the whole answer, which meant that while the Add
 * Office Panel screen was open, any machine on the shop's WiFi could become a
 * trusted panel with one click. `panels.manage` says who may open the window;
 * only this setting says whether an open window may admit a stranger.
 */
export async function isAutoPairingOpen(tenantId: string): Promise<boolean> {
  if (!isAcceptingPairing()) return false;
  return getSetting(tenantId, 'panels.autoPairingEnabled');
}

export async function pairPanel(request: PairingRequest, remoteIp: string | null): Promise<PairingSuccess> {
  const identity = await getIdentity();
  if (!identity) throw new ValidationError('validation.panel.setupIncomplete');

  if (request.mode === 'auto') {
    if (!(await isAutoPairingOpen(identity.tenantId))) {
      // Two different reasons, two different next steps: telling somebody to open a window that is
      // already open (and has the setting off) sends them round in a circle.
      throw new UnauthorizedError(
        isAcceptingPairing() ? 'error.unauthorized.pairingAutoOff' : 'error.unauthorized.pairingNotAccepting',
      );
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
  const asked = request.panelName?.trim();
  const name = asked
    ? uniquePanelName(asked, await panelRepo.liveNames(identity.tenantId))
    : await defaultPanelName(identity.tenantId);
  const secretHash = await bcrypt.hash(panelSecret, BCRYPT_ROUNDS);

  // A PC that was removed and pairs again gets its old row back instead of a second one next to
  // it: the row it names, or the removed one with its machine name. Only a removed row, only
  // after the window or the password has already let this request in (above), so a matching name
  // grants nothing by itself, and a working pairing is never taken over. A PC reinstalled without
  // being removed first is a new panel; the old row is for the administrator to remove.
  const returning =
    // Checked first: a PC that proves it owns an ACTIVE row (the id and the secret it held; it unpaired
    // itself while the Master could not be told) must get that row, not a removed one that happens to
    // share its machine name.
    (await ownedActivePanel(identity.tenantId, request.previousPanelId, request.previousPanelSecret)) ??
    (await panelRepo.findRemovedFor(
      identity.tenantId,
      request.hostname && request.hostname !== 'unknown' ? request.hostname : null,
      request.previousPanelId ?? null,
    )) ??
    undefined;

  const panel = await db().transaction(async (trx) => {
    if (returning) {
      const others = await panelRepo.liveNames(identity.tenantId, returning.id);
      const row = await panelRepo.reviveForPairing(
        returning.id,
        {
          secret_hash: secretHash,
          master_proof_key: masterProofKey(panelSecret),
          lan_ip: remoteIp,
          // The name it had, not whatever the Office proposes now (its default name would overwrite a name
          // somebody chose); numbered if a panel in use took it while this one was away.
          name: uniquePanelName(returning.name, others),
        },
        trx,
      );
      await activityLog.recordActivity(
        {
          tenantId: identity.tenantId,
          entityType: 'office_panel',
          entityId: row.id,
          action: 're_paired',
          actorType: 'system',
          actorId: null,
          // Names the row it replaced: the same row, as it stood (removed, or offline and never removed).
          details: {
            name: row.name,
            mode: request.mode,
            hostname: request.hostname,
            previousPanelId: returning.id,
            previousName: returning.name,
            previousStatus: returning.status === 'revoked' ? 'removed' : 'active',
          },
        },
        systemActor(identity.tenantId),
        trx,
      );
      return row;
    }

    const row = await panelRepo.insertPanel(
      {
        id: panelId,
        tenant_id: identity.tenantId,
        name,
        // Derived from the panel id rather than stored randomly, so a panel that
        // loses its local files recovers the same code — and its existing
        // temporary ids stay attributable to it.
        device_code: deviceCodeFromSeed(panelId),
        secret_hash: secretHash,
        master_proof_key: masterProofKey(panelSecret),
        lan_ip: remoteIp,
        status: 'active',
        paired_at: new Date(),
      },
      trx,
    );

    await activityLog.recordActivity({
      tenantId: identity.tenantId,
      entityType: 'office_panel',
      entityId: row.id,
      action: 'created',
      actorType: 'system',
      actorId: null,
      // `{name}` is what the catalogue's "paired the office panel {name}"
      // renders; this carried only the mode and the hostname, and the Logs
      // screen showed the placeholder itself.
      details: { name: row.name, mode: request.mode, hostname: request.hostname },
    }, systemActor(identity.tenantId), trx);

    return row;
  });

  // One panel per opening of the screen: the window closes as soon as a panel
  // pairs, so leaving the screen open does not silently admit others.
  if (request.mode === 'auto') closePairingWindow();

  // The old pairing's socket (an active row that was replaced) must not outlive its secret.
  if (returning && returning.status !== 'revoked') disconnectPanel(returning.id);

  publishChange({
    entity: 'office_panel',
    action: returning ? 'updated' : 'created',
    id: panel.id,
    payload: panel,
  });

  log.info(`${returning ? 'Paired again' : 'Paired'} office panel "${panel.name}" (${panel.id}) via ${request.mode}`);

  return {
    panelId: panel.id,
    panelSecret,
    masterUniqueId: identity.masterUniqueId,
    companyName: identity.companyName,
  };
}

/** The active panel this id and secret belong to, else null. Never throws, never says which part was wrong. */
async function ownedActivePanel(
  tenantId: string,
  panelId: string | undefined,
  panelSecret: string | undefined,
): Promise<OfficePanel | null> {
  if (!panelId || !panelSecret) return null;
  try {
    const panel = await authenticatePanel(panelId, panelSecret);
    return panel.tenantId === tenantId && panel.status === 'active' ? panel : null;
  } catch {
    return null;
  }
}

/**
 * A panel unpairing itself (`panel:leave`): its row is marked removed, reason "left", so a PC that
 * pairs again finds a removed row instead of leaving an active, offline one behind.
 */
export async function leavePanel(panelId: string): Promise<void> {
  const existing = await panelRepo.findPanelById(panelId);
  if (!existing || existing.status === 'revoked') return;

  const panel = await db().transaction(async (trx) => {
    const row = await panelRepo.updatePanelStatus(panelId, 'revoked', trx);
    if (!row) throw new NotFoundError('Panel');
    await activityLog.recordActivity(
      {
        tenantId: row.tenantId,
        entityType: 'office_panel',
        entityId: row.id,
        action: 'left',
        actorType: 'system',
        actorId: null,
        details: { name: row.name, reason: 'left' },
      },
      systemActor(row.tenantId),
      trx,
    );
    return row;
  });

  forgetPanelConnection(panelId);
  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  log.info(`Office panel "${panel.name}" (${panelId}) left of its own accord`);
}

/**
 * Check a panel's id and secret.
 *
 * The three refusals carry distinct message keys, which the socket hub turns
 * into distinct codes: a revoked pairing (`panelRevoked`) is the one an Office
 * acts on by forgetting its credentials, while a row this Master does not have
 * (`panelNotPaired`, say on a Master restored from an older backup) or a
 * secret mid-rotation must not wipe a pairing that may still be good.
 */
export async function authenticatePanel(panelId: string, panelSecret: string): Promise<OfficePanel> {
  // Checked before the query: the column is a uuid, and Postgres answers a
  // malformed one with an error rather than no row.
  if (typeof panelId !== 'string' || !UUID_PATTERN.test(panelId)) {
    throw new UnauthorizedError('error.unauthorized.panelNotPaired');
  }
  const panel = await panelRepo.findPanelById(panelId);
  if (panel?.status === 'revoked') throw new UnauthorizedError('error.unauthorized.panelRevoked');
  if (!panel || panel.status !== 'active') throw new UnauthorizedError('error.unauthorized.panelNotPaired');

  const secret = await panelRepo.findPanelSecretHash(panelId);
  if (!secret || !(await bcrypt.compare(panelSecret, secret.hash))) {
    throw new UnauthorizedError('error.unauthorized.panelCredentialsInvalid');
  }

  // A panel paired before 1.3 has no proof key yet, and this is the one moment
  // the Master holds its plaintext secret to derive it from. Skipped once set,
  // so the per-request panel HTTP path pays no write.
  if (!secret.hasProofKey) {
    await panelRepo.fillPanelProofKey(panelId, masterProofKey(panelSecret));
  }

  return panel;
}

/**
 * The key a Master proves itself with (`shared/src/protocol/discovery.ts`):
 * HMAC-SHA256 keyed by the panel secret over `MASTER_PROOF_CONTEXT`, hex.
 */
export function masterProofKey(panelSecret: string): string {
  return createHmac('sha256', panelSecret).update(MASTER_PROOF_CONTEXT).digest('hex');
}

/** A nonce is hex, long enough to be unguessable and short enough to be cheap. */
const NONCE_PATTERN = /^[0-9a-f]{32,128}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prove to a panel that found this Master at a new address that it is the
 * Master the panel paired with, before the panel sends its secret here.
 *
 * A 404 for a panel this Master does not know, has revoked, or has no proof
 * key for yet: in each case the panel must not adopt this address. `host` and
 * `port` are where the request arrived on this machine; the proof covers them.
 */
export async function proveMaster(
  panelId: string,
  nonce: string,
  host: string | null,
  port: number | undefined,
): Promise<MasterProofResponse> {
  if (!NONCE_PATTERN.test(nonce)) throw new ValidationError('validation.panel.fieldInvalid');

  if (!UUID_PATTERN.test(panelId) || !host || !port) throw new NotFoundError('Panel');
  const row = await panelRepo.findPanelProofKey(panelId);
  if (!row || row.status !== 'active' || !row.key) throw new NotFoundError('Panel');

  return {
    proof: createHmac('sha256', Buffer.from(row.key, 'hex'))
      .update(masterProofMessage(nonce, host, port))
      .digest('hex'),
  };
}

export async function revokePanel(panelId: string, actor?: ActorContext): Promise<OfficePanel> {
  await assertPanelBelongsTo(panelId, actor);

  const panel = await db().transaction(async (trx) => {
    const row = await panelRepo.updatePanelStatus(panelId, 'revoked', trx);
    if (!row) throw new ValidationError('error.notFound', { what: 'Panel' });

    await recordPanelActivity(row, actor, { status: 'revoked' }, trx, 'revoked');
    return row;
  });

  forgetPanelConnection(panelId);

  // Publish before closing the socket: hub.ts's onChange listener emits
  // `panel:revoked` synchronously on the panel's live socket, so emitting it
  // after the socket is gone sends the cooperative notice to nobody and
  // the panel sits on "disconnected" forever instead of dropping to the
  // pairing screen. Close the live socket rather than only asking it to
  // leave: the cooperative push only works on a well-behaved client, and
  // until the socket is actually closed a revoked panel keeps issuing
  // fully-authorized commands over the connection it already has, no matter
  // what the admin screen shows.
  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  disconnectPanel(panelId);

  return panel;
}

export async function renamePanel(
  panelId: string,
  name: string,
  actor?: ActorContext,
): Promise<OfficePanel> {
  return updatePanel(panelId, { name }, actor);
}

/**
 * Rename a panel, retag it, or move it onto another role — in one call, because
 * the administration screen edits them on one form and a half-applied save is
 * worse than a refused one.
 *
 * A field left out is left alone. That is what makes `notes: null` meaningful:
 * absent means "don't touch", null means "clear it".
 *
 * Every field is checked before any is written, and the writes and their
 * entry share one transaction. Each write used to commit on its own as soon as
 * its field was checked, so a role refused as unknown left the panel already
 * renamed — the half-applied save described above.
 */
export async function updatePanel(
  panelId: string,
  input: OfficePanelUpdateInput,
  actor?: ActorContext,
): Promise<OfficePanel> {
  const existing = await panelRepo.findPanelById(panelId);
  if (!existing) throw new NotFoundError('Panel');
  if (actor && existing.tenantId !== actor.tenantId) throw new NotFoundError('Panel');

  const changed: Record<string, unknown> = {};
  const writes: Array<(trx: TransactionContext) => Promise<OfficePanel | null>> = [];

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new ValidationError('validation.panel.nameEmpty');

    if (trimmed !== existing.name) {
      if (nameIsTaken(trimmed, await panelRepo.liveNames(existing.tenantId, panelId))) {
        throw new ValidationError('validation.panel.nameTaken', { name: trimmed });
      }
      writes.push((trx) => panelRepo.renamePanel(panelId, trimmed, trx));
      changed.name = trimmed;
    }
  }

  if (input.notes !== undefined) {
    const notes = input.notes === null ? null : input.notes.trim() || null;
    if (notes && notes.length > MAX_NOTE_LENGTH) {
      throw new ValidationError('validation.panel.notesTooLong', { max: MAX_NOTE_LENGTH });
    }

    if (notes !== existing.notes) {
      writes.push((trx) => panelRepo.updatePanelNotes(panelId, notes, trx));
      changed.notes = notes === null ? 'cleared' : 'set';
    }
  }

  if (input.roleId !== undefined && input.roleId !== existing.roleId) {
    const roleId = input.roleId;
    // A role from another company would silently widen what this panel may do,
    // so the id is resolved inside the tenant rather than trusted.
    if (roleId !== null) {
      const set = await permissionSetForRole(existing.tenantId, roleId);
      if (!set) throw new NotFoundError('Role');
      // A panel is a machine anyone can sit at; the Server Master role is for
      // two named people on the Master PC.
      if (isServerMasterTier(set.tier)) throw new ValidationError('validation.panel.serverMasterRole');
    }

    writes.push((trx) => panelRepo.assignPanelRole(panelId, roleId, trx));
    changed.roleId = roleId ?? 'default';
  }

  // Nothing actually moved — no audit row, no broadcast. An edit that changes
  // nothing is not an event, and recording it would bury the ones that are.
  if (writes.length === 0) return existing;

  const panel = await db().transaction(async (trx) => {
    let row = existing;
    for (const write of writes) row = (await write(trx)) ?? row;

    await recordPanelActivity(row, actor, changed, trx);
    return row;
  });

  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  return panel;
}

export async function listPanelsWithPresence(
  tenantId: string,
): Promise<OfficePanelWithPresence[]> {
  const panels = await panelRepo.listPanels(tenantId);
  return panels.map(withPresence);
}

/**
 * One panel with everything its administration screen shows.
 *
 * Assembled here rather than by five requests from the browser, because the
 * answers have to agree with each other: a role read a second after the panel
 * row could describe a role the panel no longer has.
 */
export async function getPanelDetail(
  tenantId: string,
  panelId: string,
): Promise<OfficePanelDetail> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== tenantId) throw new NotFoundError('Panel');

  const fallbackRoleId = panel.roleId ?? (await roleIdForTier(tenantId, 'office'));
  const [set, work] = await Promise.all([
    permissionSetForRole(tenantId, fallbackRoleId),
    panelRepo.countWorkFromPanel(tenantId, panelId),
  ]);

  return {
    ...withPresence(panel),
    role: {
      id: set?.roleId ?? null,
      name: set?.roleName ?? '',
      tier: set?.tier ?? 'office',
      permissions: [...(set?.permissions ?? [])],
      isFallback: panel.roleId === null,
    },
    work,
  };
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

export async function markPanelConnected(
  panelId: string,
  lanIp: string | null,
  /** What the panel announced in its handshake; absent from an older Office. */
  protocol?: number,
): Promise<void> {
  // Synchronous up to the first await, so the hub can mark a panel present
  // before it awaits anything and a disconnect that follows clears it.
  cancelLongOfflineNotice(panelId);
  connectedPanelIds.add(panelId);
  panelRuntime.set(panelId, {
    pendingMutations: null,
    cachedImages: null,
    lastSnapshotAt: null,
    signedInUsername: null,
    connectedSince: new Date().toISOString(),
    ...(protocol !== undefined ? { protocol } : {}),
  });
  await panelRepo.touchLastSeen(panelId, lanIp);
}

export async function markPanelDisconnected(panelId: string): Promise<void> {
  forgetPanelConnection(panelId);
  scheduleLongOfflineNotice(panelId, LONG_OFFLINE_MS);
  await panelRepo.touchLastSeen(panelId, null);
}

/**
 * One timer per panel that has dropped, firing once it has been away for
 * `LONG_OFFLINE_MS`. Held in memory: a Master restart loses them, and
 * `scheduleLongOfflineNoticesAtBoot` puts them back from `last_seen_at`.
 */
const longOfflineTimers = new Map<string, NodeJS.Timeout>();

/** After a restart, give panels this long to reconnect before any notice. */
const BOOT_GRACE_MS = 5 * 60 * 1000;

function scheduleLongOfflineNotice(panelId: string, delayMs: number): void {
  cancelLongOfflineNotice(panelId);
  const timer = setTimeout(() => {
    longOfflineTimers.delete(panelId);
    void noticeLongOffline(panelId).catch((error: unknown) =>
      log.warn(`Could not send the long-offline notice for ${panelId}: ${toErrorMessage(error)}`),
    );
  }, delayMs);
  timer.unref?.();
  longOfflineTimers.set(panelId, timer);
}

function cancelLongOfflineNotice(panelId: string): void {
  const timer = longOfflineTimers.get(panelId);
  if (timer) clearTimeout(timer);
  longOfflineTimers.delete(panelId);
}

/** Drop every pending notice; the hub calls this when it stops. */
export function cancelLongOfflineNotices(): void {
  for (const timer of longOfflineTimers.values()) clearTimeout(timer);
  longOfflineTimers.clear();
}

/**
 * Re-arm the notices a restart lost: each active, absent panel is noticed an
 * hour after it was last seen, but never sooner than `BOOT_GRACE_MS` from now,
 * so a Master that was itself switched off does not report every panel at once.
 */
export async function scheduleLongOfflineNoticesAtBoot(now: number = Date.now()): Promise<void> {
  for (const panel of await panelRepo.listActivePanels()) {
    if (connectedPanelIds.has(panel.id) || longOfflineTimers.has(panel.id) || !panel.lastSeenAt) continue;
    const due = Date.parse(panel.lastSeenAt) + LONG_OFFLINE_MS;
    scheduleLongOfflineNotice(panel.id, Math.max(due, now + BOOT_GRACE_MS) - now);
  }
}

async function noticeLongOffline(panelId: string): Promise<void> {
  // Read again: the panel may have come back, been renamed or been revoked.
  if (connectedPanelIds.has(panelId)) return;
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.status !== 'active') return;

  await notify(
    panel.tenantId,
    await findActiveUserIdsWithPermission(panel.tenantId, 'panels.manage'),
    {
      kind: 'panel.offlineLong',
      params: { panel: panel.name },
      link: { kind: 'panel', id: panel.id },
      dedupeKey: `panel.offlineLong:${panel.id}`,
    },
  );
}

export function isPanelConnected(panelId: string): boolean {
  return connectedPanelIds.has(panelId);
}

// --- Administration (docs/UI_REDESIGN.md — the Master's Office Panels screen) --

/**
 * Take delivery of what a panel says about itself.
 *
 * The durable half lands in columns so a switched-off panel still has something
 * to show; the per-connection half stays in memory. `connectedSince` survives
 * the report — it belongs to the connection, and a report is not a reconnection.
 */
export async function recordPanelReport(
  panelId: string,
  incoming: unknown,
): Promise<OfficePanel | null> {
  /*
   * The choke point both callers share — the five-minute `panel:report` and an
   * administrator pressing Refresh — so neither can be the one that forgets.
   * Untyped `unknown` on purpose: the payload arrives as JSON from a machine
   * that may be running an older build, and typing it as the input it is
   * *supposed* to be is what let an unparseable `startedAt` reach Postgres's
   * date serializer and 500 the panel detail screen.
   */
  const report = normalisePanelReport(incoming);

  const panel = await panelRepo.updateDeviceReport(panelId, report);
  if (!panel) return null;

  const previous = panelRuntime.get(panelId);
  panelRuntime.set(panelId, {
    pendingMutations: report.pendingMutations,
    cachedImages: report.cachedImages,
    lastSnapshotAt: report.lastSnapshotAt,
    signedInUsername: report.signedInUsername,
    connectedSince: previous?.connectedSince ?? new Date().toISOString(),
    // Like `connectedSince`, it belongs to the connection, not the report.
    ...(previous?.protocol !== undefined ? { protocol: previous.protocol } : {}),
  });

  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: panel });
  return panel;
}

/**
 * Ask a connected panel to describe itself right now, and store the answer.
 *
 * Used when an administrator opens a panel's screen: the timed report is
 * deliberately slow, and a disk figure twenty minutes stale is the kind of
 * thing somebody makes a decision on.
 */
export async function refreshPanelReport(
  tenantId: string,
  panelId: string,
): Promise<OfficePanelDetail> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== tenantId) throw new NotFoundError('Panel');

  const report = await requestFromPanel<unknown>(panelId, 'panel:describe');
  await recordPanelReport(panelId, report);

  return getPanelDetail(tenantId, panelId);
}

/**
 * Issue this panel a new secret.
 *
 * The order matters and is the opposite of the obvious one: the panel is handed
 * the new secret and must acknowledge storing it **before** the Master replaces
 * the hash. Writing the hash first would invalidate the old secret while the
 * panel still held it, so a dropped acknowledgement would lock out a panel that
 * was working a moment ago — over a network whose whole premise is that it goes
 * down.
 *
 * A panel that is switched off cannot be told at all. That is not an error: the
 * secret is reissued anyway and `delivered: false` says somebody has to walk to
 * that PC, which is exactly the advice the screen gives.
 */
export async function rotatePanelSecret(
  tenantId: string,
  panelId: string,
  actor?: ActorContext,
): Promise<PanelSecretRotation> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== tenantId) throw new NotFoundError('Panel');
  if (panel.status !== 'active') throw new ValidationError('validation.panel.notActive');

  const panelSecret = randomBytes(32).toString('base64url');
  let delivered = false;

  if (isPanelConnected(panelId)) {
    await requestFromPanel<null>(panelId, 'panel:credentials', { panelSecret });
    delivered = true;
  }

  const updated = await panelRepo.updatePanelSecretHash(
    panelId,
    await bcrypt.hash(panelSecret, BCRYPT_ROUNDS),
    masterProofKey(panelSecret),
  );
  if (!updated) throw new NotFoundError('Panel');

  // Detached, deliberately: the panel may already be holding the new secret,
  // and rolling the hash back because the entry failed would lock it out.
  await recordRemotePanelActivity(updated, actor, { secretRotated: true, delivered });
  publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: updated });
  log.info(`Reissued the secret for office panel ${panelId} (delivered: ${delivered})`);

  return {
    panelId,
    panelSecret,
    delivered,
    rotatedAt: updated.secretRotatedAt ?? new Date().toISOString(),
  };
}

/**
 * Ask a panel to keep its files somewhere else on its own disk.
 *
 * Validated here only as far as the Master can: the path belongs to another
 * machine, so whether it exists, is writable, or has room is a question only
 * that panel can answer — and it does, by refusing. What the Master can insist
 * on is that the path is absolute, because a relative one would resolve against
 * whatever directory that panel happened to be launched from.
 */
export async function setPanelStoragePath(
  tenantId: string,
  panelId: string,
  input: PanelStoragePathInput,
  actor?: ActorContext,
): Promise<PanelStoragePathResult> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== tenantId) throw new NotFoundError('Panel');

  const target = typeof input.path === 'string' ? input.path.trim() : '';
  if (!target) throw new ValidationError('validation.panel.storagePathRequired');

  // Both separators, because the Master may be on Linux while the panel is on
  // Windows: `path.isAbsolute` on a POSIX Master calls `D:\OrderBook` relative.
  if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) {
    throw new ValidationError('validation.panel.storagePathRelative');
  }

  const result = await requestFromPanel<PanelStoragePathResult>(panelId, 'panel:setStoragePath', {
    path: target,
    moveExisting: input.moveExisting !== false,
  });

  // Detached, deliberately: the move already happened on the panel's own disk,
  // and nothing on this side could take it back if the entry failed.
  await recordRemotePanelActivity(panel, actor, { storagePath: result.dataDir });
  // The panel re-reports after moving, but the row on file is stale until it
  // does; write the new path now so the screen agrees with what just happened.
  await panelRepo.updateDeviceReport(panelId, {
    ...toReportInput(panel),
    dataDir: result.dataDir,
    diskFreeBytes: result.diskFreeBytes,
  });

  const refreshed = await panelRepo.findPanelById(panelId);
  if (refreshed) {
    publishChange({ entity: 'office_panel', action: 'updated', id: panelId, payload: refreshed });
  }

  return result;
}

/**
 * The recent trail for one panel, both what it did and what was done to it.
 *
 * Gated on `logs.view` at the route rather than `panels.manage`: this is the
 * audit trail, and who may read it is a question the Logs module already
 * answers. An administrator who may manage panels but not read logs sees the
 * rest of the screen without this section.
 */
export async function listPanelActivity(
  tenantId: string,
  panelId: string,
  limit = 50,
): Promise<ActivityLogEntry[]> {
  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== tenantId) throw new NotFoundError('Panel');

  return activityLog.listPanelActivity(tenantId, panelId, Math.min(Math.max(limit, 1), 200));
}

/**
 * Drop a panel's socket without touching its pairing.
 *
 * The panel reconnects on its own within seconds — which is the point. An
 * Office from 1.3 on reconnects after a Master-side disconnect; an older one
 * read that drop as final and waited for a restart. It is
 * the "turn it off and on again" of this system: a panel wedged on a stale
 * session or a half-applied snapshot gets a clean one, and nobody has to walk
 * to that PC. Revoking would be the wrong tool: that ends the pairing.
 */
export function disconnectPanel(panelId: string): boolean {
  const link = panelLink();
  if (!link) return false;

  const dropped = link.disconnect(panelId);
  if (dropped) log.info(`Dropped the socket for office panel ${panelId}`);
  return dropped;
}

/**
 * `disconnectPanel` for an administrator's click. Nothing in the database
 * changes, so the entry is written detached, after the socket is dropped.
 * Only a drop that happened is logged.
 */
export async function disconnectPanelByAdmin(panelId: string, actor: ActorContext): Promise<boolean> {
  const panel = await panelRepo.findPanelById(panelId);
  // A panel id from another company is a 404, not a silent `false`.
  if (!panel || panel.tenantId !== actor.tenantId) throw new NotFoundError('Panel');

  const dropped = disconnectPanel(panelId);
  if (dropped) {
    await activityLog.recordDetachedActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'office_panel',
        entityId: panelId,
        action: 'disconnected',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: panel.name },
      },
      actor,
      db(),
    );
  }
  return dropped;
}

const DEFAULT_PANEL_PREFIX = 'Office Panel';

/**
 * The next unused default name.
 *
 * Highest suffix plus one, not count plus one — see `panelNamesMatching`. A
 * name under the prefix whose tail is not a number ("Office Panel — Reception")
 * is ignored rather than counted, so it cannot pull the sequence backwards.
 */
async function defaultPanelName(tenantId: string): Promise<string> {
  const names = await panelRepo.panelNamesMatching(tenantId, DEFAULT_PANEL_PREFIX);
  return nextPanelName(names);
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether a panel still in use already has this name (case and surrounding spaces ignored). */
export function nameIsTaken(name: string, existing: readonly string[]): boolean {
  return existing.some((other) => sameName(other, name));
}

/**
 * A name nobody in use has. A PC that is reinstalled pairs again under the name its
 * user types, and the old row is still on the list until somebody removes it; two rows
 * called "Reception" cannot be told apart, so the new one becomes "Reception 2".
 */
export function uniquePanelName(name: string, existing: readonly string[]): string {
  if (!nameIsTaken(name, existing)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name} ${suffix}`;
    if (!nameIsTaken(candidate, existing)) return candidate;
  }
}

/**
 * Exported for its test — the repository read is the only thing that needs a
 * database, and the rule worth pinning is this arithmetic.
 */
export function nextPanelName(existing: readonly string[]): string {
  const highest = existing.reduce((max, name) => {
    const suffix = Number(name.slice(DEFAULT_PANEL_PREFIX.length).trim());
    return Number.isInteger(suffix) && suffix > max ? suffix : max;
  }, 0);

  return `${DEFAULT_PANEL_PREFIX} ${highest + 1}`;
}

function withPresence(panel: OfficePanel): OfficePanelWithPresence {
  const isConnected = connectedPanelIds.has(panel.id);
  return { ...panel, isConnected, runtime: isConnected ? (panelRuntime.get(panel.id) ?? null) : null };
}

/**
 * A panel id from another company is a 404, never a silent success.
 *
 * Only checked when an actor is supplied. The routes always supply one; the
 * paths that do not — pairing, and the tests that exercise a service directly —
 * have no session to check against, and inventing a tenant for them would make
 * this a check against itself.
 */
async function assertPanelBelongsTo(panelId: string, actor: ActorContext | undefined): Promise<void> {
  if (!actor) return;

  const panel = await panelRepo.findPanelById(panelId);
  if (!panel || panel.tenantId !== actor.tenantId) throw new NotFoundError('Panel');
}

function forgetPanelConnection(panelId: string): void {
  connectedPanelIds.delete(panelId);
  panelRuntime.delete(panelId);
}

/**
 * Send one request to a panel, turning each way it can fail into its own
 * refusal — "offline", "said no" and "said nothing" are three different things
 * to whoever is standing at the Master, and collapsing them into one message
 * would leave them guessing which.
 */
async function requestFromPanel<T>(
  panelId: string,
  event: 'panel:describe' | 'panel:credentials' | 'panel:setStoragePath',
  payload?: unknown,
): Promise<T> {
  const link = panelLink();
  if (!link || !link.isConnected(panelId)) {
    throw new ValidationError('validation.panel.notConnected');
  }

  try {
    return await link.request<T>(panelId, event, payload);
  } catch (error) {
    if (error instanceof Error && error.message) {
      throw new ValidationError('validation.panel.noAnswer', {}, { reason: error.message });
    }
    throw new ValidationError('validation.panel.noAnswer');
  }
}

/** The stored device row, back in the shape `updateDeviceReport` takes. */
function toReportInput(panel: OfficePanel): OfficePanelReportInput {
  return {
    hostname: panel.device.hostname ?? '',
    platform: panel.device.platform ?? '',
    osVersion: panel.device.osVersion ?? '',
    appVersion: panel.device.appVersion ?? '',
    nodeVersion: panel.device.nodeVersion ?? '',
    dataDir: panel.device.dataDir ?? '',
    imagesDir: panel.device.imagesDir ?? '',
    storageBytes: panel.device.storageBytes,
    diskFreeBytes: panel.device.diskFreeBytes,
    diskTotalBytes: panel.device.diskTotalBytes,
    localPort: panel.device.localPort ?? 0,
    startedAt: panel.device.startedAt ?? new Date().toISOString(),
    pendingMutations: null,
    cachedImages: null,
    lastSnapshotAt: null,
    signedInUsername: null,
  };
}

/**
 * One audit row per administrative change, attributed to whoever made it.
 *
 * `office_panel`/`updated` is an existing catalogue token, so what varies is
 * `details` — which is where "what changed" belongs anyway: the trail is
 * append-only, and a new token per field would be a token per future field.
 *
 * Inside the change's own transaction, so the row and its entry commit
 * together — see `recordRemotePanelActivity` for the two changes that cannot.
 */
async function recordPanelActivity(
  panel: OfficePanel,
  actor: ActorContext | undefined,
  details: Record<string, unknown>,
  trx: TransactionContext,
  action: 'updated' | 'revoked' = 'updated',
): Promise<void> {
  const acting = actor ?? systemActor(panel.tenantId);

  await activityLog.recordActivity(
    {
      tenantId: panel.tenantId,
      entityType: 'office_panel',
      entityId: panel.id,
      action,
      actorType: acting.actorType,
      actorId: acting.actorId,
      details: { name: panel.name, ...details },
    },
    acting,
    trx,
  );
}

/**
 * The same entry, for a change that had already happened on the panel's own
 * machine before the Master wrote anything — a reissued secret the panel has
 * stored, files it has moved. There is no transaction that could take the
 * panel's half back, so the entry is written detached (`activity-log.repository.ts`
 * says when that is right) rather than made able to undo the Master's half.
 */
async function recordRemotePanelActivity(
  panel: OfficePanel,
  actor: ActorContext | undefined,
  details: Record<string, unknown>,
): Promise<void> {
  const acting = actor ?? systemActor(panel.tenantId);

  await activityLog.recordDetachedActivity(
    {
      tenantId: panel.tenantId,
      entityType: 'office_panel',
      entityId: panel.id,
      action: 'updated',
      actorType: acting.actorType,
      actorId: acting.actorId,
      details: { name: panel.name, ...details },
    },
    acting,
    db(),
  );
}
