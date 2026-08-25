/**
 * Master Panel UI strings. Mirrors `office/web/src/i18n/strings.ts` — same
 * key set plus the Master's own nav and aggregate-sync vocabulary — until the
 * planned shared `ui/` workspace (docs/UI_REDESIGN.md §7) hoists both onto
 * `shared/src/i18n`.
 *
 * Every user-facing string in shell/UI code goes through t() (design spec
 * §2.6); the pre-existing screens still hold literals by design (§4.4).
 */

type Params = Record<string, string | number>;

const en: Record<string, string> = {
  'app.name': 'OrderBook',
  'app.panel': 'Master Panel',

  // Office gallery keys ride along so the shared GalleryScreen compiles.
  'nav.work': 'Work',
  'nav.catalogue': 'Catalogue',
  'nav.leads': 'Leads',
  'nav.orders': 'Orders',
  'nav.parties': 'Parties',
  'nav.products': 'Products',
  'nav.conflicts': 'Conflicts',

  'nav.master.work': 'Work',
  'nav.master.admin': 'Admin',
  'nav.master.dashboard': 'Dashboard',
  'nav.master.leadsOrders': 'Leads & orders',
  'nav.master.inventory': 'Inventory',
  'nav.master.conflicts': 'Conflicts',
  'nav.master.panels': 'Office panels',
  'nav.master.access': 'Roles & users',
  'nav.master.settings': 'Settings',

  'action.newLead': 'New lead',
  'action.signOut': 'Sign out',
  'action.retryNow': 'Retry now',
  'action.reviewConflicts': 'Review conflicts',
  'action.dismiss': 'Dismiss',
  'action.close': 'Close',

  'search.placeholder': 'Search…',
  'search.noResults': 'Nothing matches “{term}”.',
  'search.failedOffline': "Can't search right now — try again in a moment.",

  'sync.synced': 'Synced',
  'sync.syncing': 'Syncing {count}',
  'sync.offline': '{count} offline',
  'sync.offlinePending': '{count} offline — {pending} pending',
  'sync.conflictReview': '{count} conflicts — review',
  'sync.popoverTitle.synced': 'Everything synced',
  'sync.popoverTitle.syncing': 'Syncing',
  'sync.popoverTitle.offline': 'Panels unreachable',
  'sync.popoverTitle.offlinePending': 'Panels unreachable — changes pending',
  'sync.popoverTitle.conflict': 'Conflicts to review',
  'sync.pendingChanges': 'Changes waiting on panels',
  'sync.panelsOnline': 'Panels online',
  'sync.lowStock': 'Products low on stock',
  'sync.lastSuccessful': 'Last successful sync',
  'sync.pairedServer': 'Paired server',
  'sync.flushNow': 'Sync now',
  'sync.flushing': 'Syncing…',

  'footer.signedInAs': '{name} · {role}',
  'footer.version': 'v0.1.0',
  'footer.designSystem': 'Design system',

  'shell.starting': 'Starting…',

  // --- Leads & orders (LeadsOrdersScreen) -----------------------------------
  'leadsOrders.title': 'Leads & orders',
  'leadsOrders.tab.leads': 'Open leads',
  'leadsOrders.tab.orders': 'Orders',
  'leadsOrders.tab.converted': 'Converted leads',
  'leadsOrders.unit.kg': 'kg',

  'leadsOrders.error.load': 'Could not load',
  'leadsOrders.error.moveLead': 'Could not move the lead',
  'leadsOrders.error.moveOrder': 'Could not move the order',
  'leadsOrders.error.dispatch': 'Could not dispatch the order',
  'leadsOrders.error.convert': 'Could not convert the lead',

  'leadsOrders.orders.column.order': 'Order',
  'leadsOrders.orders.column.party': 'Party',
  'leadsOrders.orders.column.fromLead': 'From lead',
  'leadsOrders.orders.column.products': 'Products',
  'leadsOrders.orders.column.weight': 'Weight',
  'leadsOrders.orders.weightManual': 'Entered by hand, not summed from the lines',
  'leadsOrders.orders.column.amount': 'Amount',
  'leadsOrders.orders.column.stage': 'Stage',
  'leadsOrders.orders.dispatch': 'Dispatch',
  'leadsOrders.orders.dispatched': 'Dispatched {when}',
  'leadsOrders.orders.empty.title': 'No orders yet',
  'leadsOrders.orders.empty.description': 'They appear here once a lead is converted.',

  'leadsOrders.leads.column.lead': 'Lead',
  'leadsOrders.leads.column.party': 'Party',
  'leadsOrders.leads.column.products': 'Products',
  'leadsOrders.leads.column.amount': 'Amount',
  'leadsOrders.leads.column.stage': 'Stage',
  'leadsOrders.leads.column.created': 'Created',
  'leadsOrders.leads.incomplete': 'incomplete',
  'leadsOrders.leads.converted': 'converted',
  'leadsOrders.leads.convertedOrder': 'order {id}',
  'leadsOrders.leads.convert': 'Convert to order',
  'leadsOrders.leads.convertBlocked':
    'Every line needs packaging before this can become an order',
  'leadsOrders.leads.empty.open.title': 'No open leads',
  'leadsOrders.leads.empty.open.description': 'Office Panels raise them.',
  'leadsOrders.leads.empty.converted.title': 'No converted leads yet',

  'inventory.search.placeholder': 'Search product or colour',
  'inventory.filter.all': 'All stock',
  'inventory.filter.lowOnly': 'Low only',
  'inventory.filterNote': 'Stock only leaves the ledger at dispatch — reservations hold it aside',
  'inventory.section.stockLevels': 'Stock levels',
  'inventory.boxesFree': '{count} boxes free',
  'inventory.action.stockIn': 'Stock in',
  'inventory.action.physicalCount': 'Physical count',

  'inventory.table.code': 'Code',
  'inventory.table.product': 'Product',
  'inventory.table.colour': 'Colour',
  'inventory.table.onHand': 'On hand',
  'inventory.table.reserved': 'Reserved',
  'inventory.table.free': 'Free to sell',
  'inventory.table.reorder': 'Reorder at',
  'inventory.table.status': 'Status',
  'inventory.status.low': 'Low',
  'inventory.status.healthy': 'Healthy',
  'inventory.reorderLevelLabel': 'Reorder level for {product} {colour}',

  'inventory.empty.title': 'No stock yet',
  'inventory.empty.description': 'Record stock in, and it will appear here.',

  'inventory.stockIn.title': 'Stock in',
  'inventory.stockIn.description': 'Boxes that arrived from the factory or a purchase.',
  'inventory.stockIn.submit': 'Add stock',
  'inventory.physicalCount.title': 'Physical count',
  'inventory.physicalCount.description':
    'Enter the number of boxes actually on the shelf — not the difference.',
  'inventory.physicalCount.submit': 'Save count',

  'inventory.field.product': 'Product',
  'inventory.field.productPlaceholder': 'Choose a product…',
  'inventory.field.colour': 'Colour',
  'inventory.field.colourPlaceholder': 'e.g. Ivory',
  'inventory.field.boxes': 'Boxes',
  'inventory.field.note': 'Note',
  'inventory.field.notePlaceholder': 'e.g. factory lot A-77, breakage',

  'inventory.movements.title': 'Recent movements',
  'inventory.movements.description':
    'Every row is a signed change, never a total — which is what makes the running figure reconstructible.',
  'inventory.movements.empty.title': 'No movements yet',
  'inventory.movements.empty.description': 'Stock in, dispatch and adjustments will appear here.',
  'inventory.movements.table.when': 'When',
  'inventory.movements.table.product': 'Product',
  'inventory.movements.table.colour': 'Colour',
  'inventory.movements.table.type': 'Type',
  'inventory.movements.table.change': 'Change',
  'inventory.movements.table.reference': 'Reference',
  'inventory.movements.table.note': 'Note',
  'inventory.movementType.inbound': 'Stock in',
  'inventory.movementType.outbound': 'Dispatched',
  'inventory.movementType.adjustment': 'Adjusted',

  'inventory.error.load': 'Could not load inventory',
  'inventory.error.inbound': 'Could not record the incoming stock',
  'inventory.error.adjust': 'Could not save the count',
  'inventory.error.reorder': 'Could not save the reorder level',

  'inventory.drawer.title': '{product} — {colour}',
  'inventory.drawer.ledgerTitle': 'Ledger — signed, append-only',
  'inventory.drawer.ledgerEmpty.title': 'No movements yet',
  'inventory.drawer.ledgerEmpty.description':
    'Stock in, dispatch and adjustments for this colour will appear here.',
  'inventory.drawer.adjust': 'Adjust to physical count',
  'inventory.stockIn.titleForLine': 'Stock in — {product} ({colour})',
  'inventory.physicalCount.titleForLine': 'Physical count — {product} ({colour})',

  // --- Roles & Users (AccessScreen) ----------------------------------------

  'access.title': 'Roles & Users',
  'access.tab.users': 'Users',
  'access.tab.roles': 'Roles',

  'access.recycleBin.show': 'Show deleted roles and people',
  'access.recycleBin.hide': 'Hide deleted roles and people',
  'access.recycleBin.loading': 'Loading…',
  'access.recycleBin.empty': 'Nothing has been deleted.',
  'access.recycleBin.roleMeta': 'role · {tier}',
  'access.recycleBin.userMeta': 'person · {username}',
  'access.recycleBin.restore': 'Restore',
  'access.recycleBin.restoreRoleFailed': 'Could not restore the role',
  'access.recycleBin.restoreUserFailed': 'Could not restore the person',

  'access.users.titleLoading': 'People',
  'access.users.title': '{count} people',
  'access.users.add': 'Add user',
  'access.users.searchPlaceholder': 'Search name or username…',
  'access.users.searchLabel': 'Search people',
  'access.users.filterRoleLabel': 'Filter by role',
  'access.users.filterRoleAll': 'All roles',
  'access.users.filterStatusActive': 'Active',
  'access.users.filterStatusInactive': 'Inactive',
  'access.users.sortLabel': 'Sort by',
  'access.users.sortCreated': 'Creation order',
  'access.users.sortName': 'Name',
  'access.users.sortRole': 'Role',
  'access.users.sortLastSignIn': 'Last sign-in',
  'access.users.empty': 'Nobody here yet.',
  'access.users.emptyFiltered': 'Nobody matches those filters.',
  'access.users.colName': 'Name',
  'access.users.colUsername': 'Username',
  'access.users.colRole': 'Role',
  'access.users.colStatus': 'Status',
  'access.users.colLastSignIn': 'Last sign-in',
  'access.users.roleChangeFailed': 'Could not change the role',
  'access.users.statusActive': 'Active',
  'access.users.statusInactive': 'Inactive',
  'access.users.edit': 'Edit',
  'access.users.resetPassword': 'Reset password',
  'access.users.resetPasswordFailed': 'Could not reset the password',
  'access.users.deactivate': 'Deactivate',
  'access.users.activate': 'Activate',
  'access.users.statusChangeFailed': 'Could not change the status',
  'access.users.delete': 'Delete',
  'access.users.deleteFailed': 'Could not delete',
  'access.users.thisIsYou': 'This is you',
  'access.users.lastAdminReason': 'At least one active administrator must remain',
  'access.users.deactivateConfirmTitle': 'Deactivate {name}?',
  'access.users.deactivateConfirmBody':
    '{name} will not be able to sign in. Their leads, orders and audit history are unchanged. This is not a delete — use Delete to send them to the Recycle Bin.',
  'access.users.deleteConfirmTitle': 'Delete {name}?',
  'access.users.deleteConfirmBody':
    'They go to the Recycle Bin and can be restored. Their records and audit history stay exactly as they are.',
  'access.users.cancel': 'Cancel',

  'access.userForm.displayName': 'Display name',
  'access.userForm.username': 'Username',
  'access.userForm.role': 'Role',
  'access.userForm.helper':
    'A temporary password is generated and shown once. There is no way to see it again.',
  'access.userForm.create': 'Create user',
  'access.userForm.createFailed': 'Could not create the user',
  'access.userForm.cancel': 'Cancel',

  'access.secret.title': 'Temporary password for {username}',
  'access.secret.helper':
    'Copy this now and hand it over. It cannot be shown again — recovery is another reset.',
  'access.secret.copy': 'Copy',
  'access.secret.copied': 'Copied',
  'access.secret.done': 'Done',

  'access.roles.titleLoading': 'Roles',
  'access.roles.title': '{count} roles',
  'access.roles.create': 'Create role',
  'access.roles.empty': 'No roles yet. The Administrator role was created with this company.',
  'access.roles.colRole': 'Role',
  'access.roles.colTier': 'Tier',
  'access.roles.colPermissions': 'Permissions',
  'access.roles.colUsers': 'Users',
  'access.roles.systemBadge': 'system',
  'access.roles.edit': 'Edit',
  'access.roles.delete': 'Delete',
  'access.roles.deleteBlocked': 'Still assigned to somebody — move them first',
  'access.roles.deleteFailed': 'Could not delete',
  'access.roles.deleteConfirmTitle': 'Delete the "{name}" role?',
  'access.roles.deleteConfirmBody':
    'It goes to the Recycle Bin and can be restored, and anybody who still holds it reattaches when it comes back.',
  'access.roles.cancel': 'Cancel',

  'access.roleEditor.newRole': 'New role',
  'access.roleEditor.cancel': 'Cancel',
  'access.roleEditor.save': 'Save',
  'access.roleEditor.saving': 'Saving…',
  'access.roleEditor.saveFailedDefault': 'Could not save the role',
  'access.roleEditor.reloadTheirs': 'Reload theirs',
  'access.roleEditor.overwriteMine': 'Overwrite with mine',
  'access.roleEditor.theirs': 'theirs',
  'access.roleEditor.yours': 'yours',
  'access.roleEditor.nameLabel': 'Name',
  'access.roleEditor.tierLabel': 'Tier',
  'access.roleEditor.tierLocked': 'A system role’s tier is locked',
  'access.roleEditor.discardConfirm': 'Discard your unsaved changes to this role?',
  'access.roleEditor.pendingWarning': 'Changing to {tier} will remove {count} permission{plural}:',
  'access.roleEditor.keepTier': 'Keep {tier}',
  'access.roleEditor.changeTier': 'Change to {tier}',
  'access.roleEditor.diffNone': 'none',
  'access.roleEditor.diffPermissionsCount': '{count} permission{plural}',
  'access.roleEditor.diffNotSet': 'not set',

  'access.userEdit.displayName': 'Display name',
  'access.userEdit.username': 'Username',
  'access.userEdit.save': 'Save',
  'access.userEdit.saveFailed': 'Could not save',
  'access.userEdit.cancel': 'Cancel',

  // --- Sign in ----------------------------------------------------------

  'signIn.subtitle': 'Enter the ID and password generated during setup.',
  'signIn.field.username': 'Username',
  'signIn.field.password': 'Password',
  'signIn.action.signIn': 'Sign in',
  'signIn.action.signingIn': 'Signing in…',
  'signIn.error.default': 'Sign in failed',

  // --- First run ----------------------------------------------------------

  'firstRun.choose.newSite': 'Set up new site',
  'firstRun.choose.restore': 'Restore from backup',
  'firstRun.choose.back': 'Back',

  'firstRun.setup.title': 'Set up this Master Panel',
  'firstRun.setup.description':
    'This PC will store all data for the software. Run this once, on the computer that stays connected to your WiFi router.',
  'firstRun.setup.companyName': 'Company name (optional)',
  'firstRun.setup.companyNamePlaceholder': 'e.g. Shree Ceramics',
  'firstRun.setup.generate': 'Generate connection details',
  'firstRun.setup.generating': 'Generating…',
  'firstRun.error.default': 'Setup failed',

  'firstRun.ready.title': 'Master Panel is ready',
  'firstRun.ready.writeDownWarning':
    'Write these down now. The two passwords are shown only on this screen and cannot be displayed again.',
  'firstRun.ready.signInSection': 'Sign in to this Master Panel',
  'firstRun.ready.usernameLabel': 'Username',
  'firstRun.ready.passwordLabel': 'Password',
  'firstRun.ready.panelsSection': 'Connecting Office Panels',
  'firstRun.ready.panelsHelp':
    'Office Panels normally connect automatically. These details are only needed for manual connection, when automatic search is blocked on your network.',
  'firstRun.ready.addressLabel': 'Master address',
  'firstRun.ready.addressesLabel': 'Master addresses',
  'firstRun.ready.noAddress': 'This PC has no network address yet — port {port}',
  'firstRun.ready.masterIdLabel': 'Master ID',
  'firstRun.ready.pairingPasswordLabel': 'Pairing password',
  'firstRun.ready.continue': 'I have written these down — continue to sign in',

  // --- Office panels --------------------------------------------------------

  'panels.add.title': 'Add Office Panel',
  'panels.add.description':
    'Press this, then start automatic connection on the office PC. This Master only accepts new panels while you are waiting here.',
  'panels.add.action': 'Add Office Panel',
  'panels.add.waitingTitle': 'Waiting for office panel…',
  'panels.add.waitingBody':
    'On the office PC, open the Office Panel and press "Proceed with Auto Connection". It will find this Master automatically.',
  'panels.add.cancel': 'Cancel',
  'panels.add.startFailed': 'Could not start pairing',
  'panels.list.title': 'Connected Office Panels',
  'panels.empty.title': 'No office panels yet',
  'panels.empty.description': 'Panels you pair appear here, online or off.',
  'panels.table.status': 'Status',
  'panels.table.name': 'Name',
  'panels.table.address': 'Address',
  'panels.table.paired': 'Paired',
  'panels.table.lastSeen': 'Last seen',
  'panels.status.connected': 'Connected',
  'panels.status.offline': 'Offline',
  'panels.status.removed': 'Removed',
  'panels.action.rename': 'Rename',
  'panels.action.remove': 'Remove',
  'panels.rename.title': 'Rename "{name}"',
  'panels.rename.label': 'Name for this office panel',
  'panels.rename.save': 'Save',
  'panels.rename.cancel': 'Cancel',
  'panels.rename.failed': 'Could not rename the panel',
  'panels.revoke.title': 'Remove "{name}"?',
  'panels.revoke.body': 'That PC will have to connect again.',
  'panels.revoke.cancel': 'Cancel',
  'panels.revoke.failed': 'Could not remove the panel',

  // --- Sync conflicts ---------------------------------------------------

  'conflicts.includeReviewed': 'Include reviewed',
  'conflicts.description':
    'Raised when two panels edited the same field of the same record while both were offline. The higher timestamp won; the other value is kept here so nothing is lost silently.',
  'conflicts.error.load': 'Could not load conflicts',
  'conflicts.error.resolve': 'Could not resolve the conflict',
  'conflicts.empty.title': 'No conflicts',
  'conflicts.empty.description':
    'Conflicts appear here when two panels edit the same field of the same record while both are offline.',
  'conflicts.kept': 'Kept (device {device})',
  'conflicts.overwritten': 'Overwritten (device {device})',
  'conflicts.reviewedAt': 'Reviewed {when}',
  'conflicts.action.keepWinner': 'Keep what is there',
  'conflicts.action.restoreLoser': 'Put the other value back',
  'conflicts.noPermission': 'Your role does not include {permission}.',
  'conflicts.emptyValue': '(empty)',

  // --- Dashboard ----------------------------------------------------------

  'dashboard.stat.panelsOnline': 'Panels online',
  'dashboard.stat.panelsOnline.noteNone': 'No panels registered yet',
  'dashboard.stat.panelsOnline.noteAll': 'All panels connected',
  'dashboard.stat.panelsOnline.noteSome': '{count} unreachable',
  'dashboard.stat.conflicts': 'Conflicts to review',
  'dashboard.stat.conflicts.noteNone': 'Nothing to review',
  'dashboard.stat.conflicts.noteSome': 'Waiting for review',
  'dashboard.stat.pendingSync': 'Pending sync',
  'dashboard.stat.pendingSync.note': 'Changes waiting on panels',
  'dashboard.stat.lowStock': 'Low stock',
  'dashboard.stat.lowStock.noteNone': 'All products healthy',
  'dashboard.stat.lowStock.noteSome': 'Below reorder level',

  'dashboard.panels.subtitle': '{connected} of {total} online',
  'dashboard.panels.empty.title': 'No office panels yet',
  'dashboard.panels.empty.description': 'Panels you add appear here, online or off.',
  'dashboard.panels.addressUnknown': 'Unknown address',
  'dashboard.panels.deviceLabel': 'device {code}',
  'dashboard.panels.footerNote':
    'A panel that is offline is still taking leads — they arrive here when it reconnects.',

  // --- Settings -------------------------------------------------------------

  'settings.appearance.title': 'Appearance',
  'settings.appearance.subtitle': 'Per-machine — never synced',
  'settings.theme.label': 'Theme',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.density.label': 'Density',
  'settings.density.compact': 'Compact',
  'settings.density.comfortable': 'Comfortable',
  'settings.density.large': 'Large',
  'settings.density.note': 'Root {size} — this screen resizes live',
  'settings.motion.label': 'Motion',
  'settings.motion.turnOff': 'Turn animation off',
  'settings.motion.hint': "Also honours the system's reduced-motion setting",

  'settings.connection.title': 'Connection details',
  'settings.connection.description':
    'Office Panels normally connect automatically. Use these only for manual connection.',
  'settings.connection.company': 'Company',
  'settings.connection.masterAddress': 'Master address',
  'settings.connection.masterAddresses': 'Master addresses',
  'settings.connection.masterId': 'Master ID',
  'settings.connection.setupCompleted': 'Set up on',
  'settings.connection.noAddress': 'No network address detected — port {port}',
  'settings.connection.passwordNote':
    'The pairing password is not stored in readable form and cannot be shown again. Office Panels already connected are unaffected.',

  'settings.storage.title': 'Storage on this PC',
  'settings.storage.database': 'Database',
  'settings.storage.uploads': 'Images and files',
  'settings.storage.total': 'Total used by this software',
  'settings.storage.free': 'Free space on this drive',

  'backup.export.title': 'Export whole data',
  'backup.export.action': 'Export data…',
  'backup.export.passphraseLabel': 'Export passphrase',
  'backup.export.passphraseHint':
    'At least 10 characters. This passphrase is never stored anywhere — if it is lost, this file cannot be opened again.',
  'backup.export.confirm': 'Export',
  'backup.export.working': 'Preparing export…',
  'backup.export.done': 'Export ready — check your downloads',
  'backup.restore.title': 'Restore from backup',
  'backup.restore.action': 'Restore from backup…',
  'backup.restore.chooseFile': 'Choose backup file…',
  'backup.restore.passphraseLabel': 'Backup passphrase',
  'backup.restore.confirmWipe':
    'This installation already has data. Restoring will replace it completely. Type CONFIRM to proceed.',
  'backup.restore.confirmWipeInput': 'Type CONFIRM',
  'backup.restore.confirm': 'Restore',
  'backup.restore.working': 'Restoring…',
  'backup.restore.done': 'Restore complete',
  'backup.restore.newPairingPassword':
    'New pairing password (shown once): {password}. Every Office Panel must re-pair using it.',
  'backup.restore.previewSource': 'Source',
  'backup.restore.previewScope': 'Scope',
  'backup.restore.previewCreated': 'Created',
  'backup.restore.previewAppVersion': 'App version',
  'backup.restore.cancel': 'Cancel',
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
