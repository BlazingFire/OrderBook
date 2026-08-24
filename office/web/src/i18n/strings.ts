/**
 * UI strings. Every user-facing string in shell/UI code goes through t()
 * (§2.6) — one keyed template with named placeholders, never concatenation.
 *
 * Deliberately local to office/web for now: a shared i18n module is being
 * built on the backend side of the house; when it lands, this dictionary can
 * move onto it without touching any call sites.
 */

type Params = Record<string, string | number>;

const en: Record<string, string> = {
  'app.name': 'OrderBook',
  'app.panel': 'Office Panel',

  'nav.work': 'Work',
  'nav.catalogue': 'Catalogue',
  'nav.leads': 'Leads',
  'nav.orders': 'Orders',
  'nav.parties': 'Parties',
  'nav.products': 'Products',
  'nav.conflicts': 'Conflicts',

  'action.newLead': 'New lead',
  'action.signOut': 'Sign out',
  'action.retryNow': 'Retry now',
  'action.reviewConflicts': 'Review conflicts',
  'action.dismiss': 'Dismiss',
  'action.close': 'Close',

  'search.placeholder': 'Search…',
  'search.noResults': 'Nothing matches “{term}”.',
  'search.failedOffline': "Can't search while the Master is unreachable — try again once it's back.",

  'sync.synced': 'Synced',
  'sync.syncing': 'Syncing {count}',
  'sync.offline': 'Offline',
  'sync.offlinePending': 'Offline — {count} pending',
  'sync.conflictReview': '{count} fields resolved — review',
  'sync.popoverTitle.synced': 'Synced',
  'sync.popoverTitle.syncing': 'Syncing',
  'sync.popoverTitle.offline': 'Offline',
  'sync.popoverTitle.offlinePending': 'Offline — pending changes',
  'sync.popoverTitle.conflict': 'Conflicts to review',
  'sync.pendingChanges': 'Pending changes',
  'sync.refusedChanges': 'Refused changes',
  'sync.lastSuccessful': 'Last successful sync',
  'sync.pairedServer': 'Paired server',
  'sync.flushNow': 'Sync now',
  'sync.flushing': 'Syncing…',

  'footer.company': 'Company',
  'footer.signedInAs': '{name} · {role}',
  'footer.offlineSignIn': 'signed in offline',
  'footer.version': 'v0.1.0',
  'footer.designSystem': 'Design system',

  'shell.starting': 'Starting…',
  'shell.noModules':
    "Your role does not include access to any of this panel's screens. Ask an administrator if you think that is wrong.",
  'shell.waitingFirstSync':
    'Waiting for the first sync with the Master Panel. Once it has happened, this panel keeps working whether or not the Master is reachable.',
};

export function t(key: string, params?: Params): string {
  let text = en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
