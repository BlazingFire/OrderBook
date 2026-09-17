/**
 * The keys whose sentence differs between the two panels.
 *
 * Each is stored twice in the catalogue, once as `master.<key>` and once as
 * `office.<key>`; a call site asks for the bare key and `ui/src/i18n.ts`
 * resolves it against the panel it is running in. "Offline" is the reason the
 * mechanism exists: on the Master it means *panels* are unreachable, on an
 * Office Panel that *it* is.
 *
 * It lives in `shared/` rather than beside the resolver in `ui/src/i18n.ts`
 * because the call-site guard (`master/tests/i18n-call-sites.test.ts`) needs
 * the same list — it cannot tell a panel-scoped key from a missing one without
 * it — and had grown its own copy. A second copy is how a key gets added to
 * the resolver and not to the guard, and then renders as a raw key on screen
 * with a green test suite.
 */
export const PANEL_SCOPED_KEYS: readonly string[] = [
  'app.panel',
  'backup.export.title',
  'backup.restore.confirmWipe',
  'settings.storage.title',
  'settings.subtitle',
  'sync.conflictReview',
  'sync.offline',
  'sync.offlinePending',
  'sync.pendingChanges',
  'sync.popoverTitle.offline',
  'sync.popoverTitle.offlinePending',
  'sync.popoverTitle.synced',
];
