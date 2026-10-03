/**
 * Every in-process cache and queue that holds tenant data, emptied in one call
 * after the database behind them was replaced: a developer reset, a v1
 * restore, a v2 archive restore.
 *
 * Each of these survives a schema drop, and a stale entry is a role nobody
 * granted, a setting nobody set, a tenant id that no longer exists (the public
 * API's tenant cache, HANDOFF known defect 5), or a push answered against data
 * that is gone. A module that adds such a cache adds its reset here, so all
 * three callers clear it.
 *
 * Sessions are not here: a restore and a reset end them before they start
 * (`resetAuthState`), and a v1 restore keeps them on purpose.
 */

import { resetRateLimits } from '../http/middleware/api-key-rate-limit.js';
import { resetApiKeyFailures } from '../http/middleware/require-api-key.js';
import { resetPublicApiTenantCache } from '../http/routes/public-api.routes.js';
import { resetChangeRing } from '../realtime/change-ring.js';
import { invalidateFieldCache } from '../repositories/custom-field.repository.js';
import { invalidatePipelineCache } from '../repositories/pipeline.repository.js';
import { invalidateRoleCache } from '../repositories/role.repository.js';
import { maintenanceError } from './backup-job.js';
import { cancelLongOfflineNotices } from './panel.service.js';
import { resetPresence } from './presence.service.js';
import { rejectQueuedPushes } from './push-gate.js';
import { invalidateSettingsCache } from './settings.service.js';

export function resetProcessCaches(): void {
  invalidateSettingsCache();
  invalidateRoleCache();
  invalidatePipelineCache();
  invalidateFieldCache();
  resetPublicApiTenantCache();
  resetRateLimits();
  resetApiKeyFailures();
  // A new boot id as well as an empty ring: a panel's cursor names records
  // this database may never have held, so it must take a snapshot.
  resetChangeRing();
  // Refused, never left waiting: the panel retries each push against the new data.
  rejectQueuedPushes(maintenanceError());
  // Who has which record open, and the "offline for an hour" timers, are about
  // the records and panels of the data that was replaced.
  resetPresence();
  cancelLongOfflineNotices();
  // Notifications have no in-process cache: the bell reads the table each time.
}
