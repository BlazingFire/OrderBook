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
  'nav.master.fields': 'Fields',
  'nav.master.reports': 'Reports',
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
  'startup.waiting.title': 'Waiting for this PC’s server',
  'startup.waiting.body':
    'The panel is still starting up. On a first run it spends a little while building its database — this screen clears itself as soon as it is ready.',
  'startup.waiting.slow':
    'Still no answer. Check the server window that opened alongside this one for an error, and make sure nothing else is using its port.',
  'startup.waiting.step': '{step}… this screen clears itself as soon as the panel is ready.',
  'startup.failed.title': 'This PC’s server could not start',
  'startup.failed.unknown':
    'The server stopped while starting up and did not say why. The server window that opened alongside this one will have the details.',

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

  // --- Office Panels: the screen's own sections ---------------------------

  'panels.section.all': 'All panels',
  'panels.section.pairing': 'Add a panel',
  'panels.section.activity': 'Panel activity',
  'panels.list.hint': 'Double-click a panel to open and manage it.',
  'panels.table.machine': 'PC',
  'panels.table.storage': 'Storage',
  'panels.summary.total': 'Paired',
  'panels.summary.connected': 'Connected now',
  'panels.summary.offline': 'Offline',
  'panels.summary.pending': 'Changes waiting',
  'panels.activity.title': 'Everything the panels have done',
  'panels.activity.empty.title': 'Nothing recorded yet',
  'panels.activity.empty.description': 'Work raised at a panel, and changes made to one, appear here.',
  'panels.activity.error': 'Could not read the activity trail',
  'panels.activity.denied': 'Your role does not include {permission}, so the trail is hidden.',
  'panels.activity.column.when': 'When',
  'panels.activity.column.what': 'What happened',
  'panels.activity.column.who': 'Who',

  // --- Office Panels: one panel's own screen ------------------------------

  'panel.back': 'All panels',
  'panel.tab.overview': 'Overview',
  'panel.tab.credentials': 'ID & password',
  'panel.tab.storage': 'Storage',
  'panel.tab.access': 'What it may do',
  'panel.tab.activity': 'Activity',

  'panel.load.failed': 'Could not open that panel',
  'panel.save.failed': 'Could not save that change',
  'panel.action.refresh': 'Refresh from the panel',
  'panel.action.refreshed': 'Updated from {name}',
  'panel.refresh.offline': 'That panel is offline, so these figures are the last it sent.',

  'panel.status.connected': 'Connected',
  'panel.status.offline': 'Offline',
  'panel.status.removed': 'Removed',
  'panel.status.connectedSince': 'Connected since {when}',
  'panel.status.lastSeen': 'Last seen {when}',
  'panel.status.neverSeen': 'Has never connected',

  'panel.overview.identity': 'This panel',
  'panel.overview.machine': 'The PC it runs on',
  'panel.overview.link': 'Connection',
  'panel.overview.work': 'What it has raised',
  'panel.overview.reportedAt': 'Details as of {when}',
  'panel.overview.neverReported':
    'This panel has not described itself yet. It does so the moment it next connects.',

  'panel.field.name': 'Name',
  'panel.field.notes': 'Note',
  'panel.field.notesHint': 'Where this PC is, or who uses it. Only the Master shows this.',
  'panel.field.deviceCode': 'Device code',
  'panel.field.deviceCodeHint': 'Stamped into every record this panel raises offline.',
  'panel.field.panelId': 'Panel ID',
  'panel.field.paired': 'Paired',
  'panel.field.hostname': 'PC name',
  'panel.field.platform': 'System',
  'panel.field.appVersion': 'OrderBook version',
  'panel.field.nodeVersion': 'Node version',
  'panel.field.startedAt': 'Running since',
  'panel.field.address': 'Address on the network',
  'panel.field.localPort': 'Opens in a browser at',
  'panel.field.pendingMutations': 'Changes waiting to reach here',
  'panel.field.snapshotAt': 'Copy of the data dated',
  'panel.field.signedInUser': 'Signed in on that PC',
  'panel.field.nobody': 'Nobody',
  'panel.field.leads': 'Leads raised',
  'panel.field.orders': 'Orders raised',
  'panel.field.lastAction': 'Last action',
  'panel.field.unknown': 'Not reported yet',

  'panel.credentials.title': 'How this panel signs in',
  'panel.credentials.description':
    'A panel proves itself to the Master with its ID and a secret. The ID never changes; the secret can be reissued at any time.',
  'panel.credentials.secretLabel': 'Secret',
  'panel.credentials.secretStored': 'Stored as a hash — it cannot be read back, only replaced.',
  'panel.credentials.rotatedAt': 'Last reissued {when}',
  'panel.credentials.neverRotated': 'Unchanged since this panel was paired.',
  'panel.credentials.rotate': 'Reissue the secret',
  'panel.credentials.rotate.title': 'Reissue the secret for {name}?',
  'panel.credentials.rotate.connected':
    'That panel is connected, so it will be handed the new secret and carry on working. Nobody has to touch that PC.',
  'panel.credentials.rotate.offline':
    'That panel is offline and cannot be told. It will be locked out until somebody pairs that PC again by hand.',
  'panel.credentials.rotate.confirm': 'Reissue it',
  'panel.credentials.rotate.failed': 'Could not reissue the secret',
  'panel.credentials.new.title': 'The new secret for {name}',
  'panel.credentials.new.once':
    'This is shown once and is not stored anywhere. Write it down before closing.',
  'panel.credentials.new.delivered':
    'The panel has already taken it and is still connected — there is nothing further to do.',
  'panel.credentials.new.undelivered':
    'The panel was offline. Enter this on that PC’s Manual Connection screen to bring it back.',
  'panel.credentials.new.close': 'I have written it down',
  'panel.credentials.pairing.title': 'Pairing password',
  'panel.credentials.pairing.description':
    'The one an operator types on a panel’s Manual Connection screen belongs to this Master, not to any one panel. It is on the Settings screen.',

  'panel.storage.title': 'Where this panel keeps its files',
  'panel.storage.description':
    'An Office Panel holds no database. What lives here is its queue of unsent work, its copy of the data, and the photos it has viewed.',
  'panel.storage.path': 'Folder on that PC',
  'panel.storage.images': 'Photo cache',
  'panel.storage.used': 'Used by this panel',
  'panel.storage.free': 'Free on that drive',
  'panel.storage.total': 'Drive size',
  'panel.storage.cachedImages': 'Photos cached',
  'panel.storage.change': 'Move to another folder',
  'panel.storage.change.title': 'Move {name}’s files',
  'panel.storage.change.description':
    'The panel checks the folder on its own PC and refuses if it cannot write there or the drive is too small.',
  'panel.storage.change.label': 'New folder on that PC',
  'panel.storage.change.hint': 'The full path, e.g. D:\\OrderBook\\panel-data',
  'panel.storage.change.move': 'Copy what is already there',
  'panel.storage.change.moveHint':
    'Leave this on. Turning it off starts the panel empty and abandons any work it has not sent yet.',
  'panel.storage.change.confirm': 'Move the files',
  'panel.storage.change.failed': 'That panel could not move its files',
  'panel.storage.change.done': 'Moved {count} files to {path}',
  'panel.storage.change.oldFolder':
    'The old folder at {path} was left in place. Delete it from that PC once you are satisfied.',
  'panel.storage.offline':
    'The folder can only be moved while that panel is connected — it is the panel that does the moving.',

  'panel.access.title': 'What this panel may do on its own',
  'panel.access.description':
    'When nobody is signed in at that desk, the panel still acts — accepting a lead, syncing what it holds. This is the role it acts under then. A person signed in on the panel always acts under their own role instead.',
  'panel.access.role': 'Role for the unattended panel',
  'panel.access.fallback': 'Office (the default)',
  'panel.access.fallbackHint': 'No role chosen, so the seeded Office role stands in.',
  'panel.access.permissions': 'That role may',
  'panel.access.permissionCount': '{count} permissions',
  'panel.access.tier': 'Tier',
  'panel.access.save': 'Save the role',

  'panel.danger.title': 'Connection',
  'panel.danger.disconnect': 'Drop the connection',
  'panel.danger.disconnectHint':
    'Ends the panel’s current link. It reconnects on its own within seconds — a way to clear a stuck session without going to that PC.',
  'panel.danger.disconnected': 'Dropped {name}’s connection',
  'panel.danger.disconnectFailed': 'Could not drop that connection',
  'panel.danger.remove': 'Remove this panel',
  'panel.danger.removeHint':
    'Ends the pairing for good. That PC drops to its connection screen and has to be paired again.',

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

  // --- Activity log (LogsScreen) -------------------------------------------

  // Kept with this screen's own keys rather than in the nav block above, so the
  // whole Logs vocabulary moves as one when strings are hoisted to shared.
  'nav.master.logs': 'Activity log',

  'logs.filter.searchPlaceholder': 'Search records and details',
  'logs.filter.actorLabel': 'Filter by who',
  'logs.filter.actorAll': 'Anyone',
  'logs.filter.entityLabel': 'Filter by record type',
  'logs.filter.entityAll': 'All record types',
  'logs.filter.actionLabel': 'Filter by action',
  'logs.filter.actionAll': 'All actions',
  'logs.filter.fromLabel': 'From date',
  'logs.filter.toLabel': 'To date',
  'logs.filter.clear': 'Clear filters',
  'logs.filter.facetsUnavailable': 'Could not load the filter choices',

  'logs.actorType.user': 'A person',
  'logs.actorType.office_panel': 'An office panel',
  'logs.actorType.system': 'The system',

  'logs.section.title': 'Activity log',
  'logs.section.description':
    'Append-only and hash-chained: every entry seals the one before it, so a row cannot be altered or removed without the chain saying so.',
  'logs.action.verify': 'Verify chain',
  'logs.action.export': 'Export CSV',

  'logs.table.when': 'When',
  'logs.table.what': 'What happened',
  'logs.table.who': 'Who',
  'logs.table.record': 'Record',
  'logs.table.sequence': 'Seq.',

  'logs.chain.preChain': 'pre-chain',
  'logs.chain.preChainHint': 'Recorded before hash chaining — unverifiable, not broken',

  'logs.empty.title': 'Nothing recorded yet',
  'logs.empty.description': 'Every change made in this panel or an office panel appears here.',
  'logs.emptyFiltered.title': 'No entries match those filters',
  'logs.emptyFiltered.description': 'Widen the date range, or clear the filters.',
  'logs.error.title': 'Could not load the activity log',
  'logs.error.retry': 'Try again',
  'logs.noPermission.title': 'You cannot see the activity log',
  'logs.noPermission.description': 'Your role does not include {permission}.',

  'logs.verify.title': 'Audit chain verification',
  'logs.verify.running': 'Recomputing every hash in the range…',
  'logs.verify.failed': 'Could not verify the chain',
  'logs.verify.ok': 'Intact — every hash in the range recomputes to what is stored.',
  'logs.verify.broken': 'Tampering detected. The chain first breaks at sequence {sequence}.',
  'logs.verify.break.hash_mismatch': "The entry's own hash does not match its contents.",
  'logs.verify.break.prev_hash_mismatch':
    'The entry does not seal the one before it — an entry was replaced or inserted.',
  'logs.verify.break.sequence_gap': 'An entry is missing from the sequence.',
  'logs.verify.breakAt': 'First break',
  'logs.verify.breakDetail': 'entry {id}, recorded {when}',
  'logs.verify.range': 'Range checked',
  'logs.verify.rangeValue': 'sequence {from} to {to}',
  'logs.verify.rangeEmpty': 'Nothing to check — the log is empty.',
  'logs.verify.checked': 'Entries checked',
  'logs.verify.skipped': 'Skipped as pre-chain',
  'logs.verify.truncated':
    'Only the most recent stretch was checked — the range was capped to keep the scan bounded.',
  'logs.verify.close': 'Close',

  'logs.drawer.token': 'Token',
  'logs.drawer.record': 'Record',
  'logs.drawer.who': 'Who',
  'logs.drawer.when': 'When',
  'logs.drawer.sequence': 'Sequence',
  'logs.drawer.hash': 'Hash',
  'logs.drawer.entryId': 'Entry',
  'logs.drawer.details': 'Recorded details',
  'logs.drawer.noDetails': 'This entry carries no extra detail.',

  // --- Reports (ReportsScreen) ----------------------------------------------

  'reports.title': 'Reports',
  'reports.tab.dispatches': 'Dispatches',
  'reports.tab.leadOutcomes': 'Lead outcomes',
  'reports.tab.topParties': 'Top parties',

  'reports.noPermission.title': 'Reports are not part of your role',
  'reports.noPermission.description': 'Ask an administrator to add {permission}.',

  'reports.range.period': 'Period',
  'reports.period.thisMonth': 'This month',
  'reports.period.last3Months': 'Last 3 months',
  'reports.period.last6Months': 'Last 6 months',
  'reports.period.last12Months': 'Last 12 months',
  'reports.period.custom': 'Custom range',
  'reports.range.fromMonth': 'From month',
  'reports.range.toMonth': 'To month',
  'reports.range.toMonthHint': 'Leave empty to run up to this month',
  'reports.range.caption': '{from} to {to} · {zone}',

  'reports.export': 'Export CSV',
  'reports.ratesHidden': 'Money is left out — your role does not include {permission}.',
  'reports.error.load': 'Could not load the report',

  'reports.empty.title': 'No activity in this range',
  'reports.dispatches.empty.description':
    'Nothing was dispatched in these months. Try a wider range.',
  'reports.leadOutcomes.empty.description':
    'No leads were raised in these months. Try a wider range.',
  'reports.topParties.empty.description': 'No party ordered in these months. Try a wider range.',

  'reports.column.month': 'Month',
  'reports.column.orders': 'Orders',
  'reports.column.boxes': 'Boxes',
  'reports.column.value': 'Value',
  'reports.column.colour': 'Colour',
  'reports.column.converted': 'Converted',
  'reports.column.lost': 'Lost',
  'reports.column.quiet': 'Went quiet',
  'reports.column.open': 'Still open',
  'reports.column.party': 'Party',
  'reports.column.code': 'Code',
  'reports.column.city': 'City',
  'reports.column.parties': 'Parties',

  'reports.stat.orders': 'Orders dispatched',
  'reports.stat.boxes': 'Boxes dispatched',
  'reports.stat.value': 'Value dispatched',

  'reports.dispatches.byMonth': 'By month',
  'reports.dispatches.byColour': 'By colour',
  'reports.dispatches.colours.empty.title': 'No colours to break down',
  'reports.dispatches.colours.empty.description':
    'Dispatched boxes carry a colour — none of the lines in this range did.',

  'reports.leadOutcomes.byMonth': 'By month',
  'reports.leadOutcomes.quietNote':
    'A lead counts as gone quiet after {days} days with no movement.',

  'reports.topParties.parties': 'Parties',
  'reports.topParties.orderedByValue': 'Top {limit} by order value.',
  'reports.topParties.orderedByCount':
    'Top {limit} by number of orders — your role does not include rates.',
  'reports.topParties.cities': 'Cities',
  'reports.topParties.cities.empty.title': 'No cities to group by',
  'reports.topParties.cities.empty.description': 'None of these parties has a city recorded.',

  // --- Documents (DocumentsScreen) ------------------------------------------

  // Kept with this screen's own keys rather than in the nav block above, so the
  // whole Documents vocabulary moves as one when strings are hoisted to shared.
  'nav.master.documents': 'Documents',

  'documents.title': 'Documents',
  'documents.tab.templates': 'Templates',
  'documents.tab.exports': 'Export history',
  'documents.cancel': 'Cancel',
  'documents.loadMore': 'Load more',
  'documents.noAccess.title': 'Documents are not open to you',
  'documents.noAccess.description': 'Your role does not include {permission}.',

  'documents.type.quotation': 'Quotation',
  'documents.type.orderConfirmation': 'Order confirmation',
  'documents.type.dispatchNote': 'Dispatch note',
  'documents.orientation.portrait': 'Portrait',
  'documents.orientation.landscape': 'Landscape',

  'documents.templates.sectionTitle': 'Templates',
  'documents.templates.create': 'New template',
  'documents.templates.colName': 'Template',
  'documents.templates.colType': 'Document',
  'documents.templates.colPaper': 'Paper',
  'documents.templates.colRates': 'Rates',
  'documents.templates.colUpdated': 'Updated',
  'documents.templates.defaultBadge': 'default',
  'documents.templates.ratesShown': 'Shown',
  'documents.templates.ratesHidden': 'Hidden',
  'documents.templates.delete': 'Delete',
  'documents.templates.deleted': 'Deleted “{name}”',
  'documents.templates.deleteFailed': 'Could not delete the template',
  'documents.templates.deleteConfirmTitle': 'Delete the “{name}” template?',
  'documents.templates.deleteConfirmBody':
    'It goes to the Recycle Bin and can be restored. Documents already rendered from it are untouched — they keep the name they were sent under.',
  'documents.templates.loadFailed': 'Could not load templates',
  'documents.templates.empty.title': 'No templates yet',
  'documents.templates.empty.description':
    'A template decides what a quotation, order confirmation or dispatch note looks like.',

  'documents.editor.newTitle': 'New template',
  'documents.editor.save': 'Save',
  'documents.editor.saved': 'Saved “{name}”',
  'documents.editor.saveFailed': 'Could not save the template',
  'documents.editor.reloadTheirs': 'Reload theirs',
  'documents.editor.overwriteMine': 'Overwrite with mine',
  'documents.editor.theirs': 'theirs',
  'documents.editor.yours': 'yours',
  'documents.editor.name': 'Name',
  'documents.editor.documentType': 'Document',
  'documents.editor.paperSize': 'Paper size',
  'documents.editor.orientation': 'Orientation',
  'documents.editor.accentColour': 'Accent colour',
  'documents.editor.accentHint': 'Hex like #2F6FEB. Blank uses the app accent.',
  'documents.editor.default': 'Default template',
  'documents.editor.defaultLabel': 'Use this one unless another is chosen',
  'documents.editor.defaultHint': 'One default per document type.',

  'documents.editor.group.margins': 'Margins (mm)',
  'documents.editor.margin.top': 'Top',
  'documents.editor.margin.right': 'Right',
  'documents.editor.margin.bottom': 'Bottom',
  'documents.editor.margin.left': 'Left',

  'documents.editor.group.content': 'What the document says',
  'documents.editor.group.branding': 'Company marks',
  'documents.editor.group.pageFurniture': 'Around the page',
  'documents.editor.showRates': 'Rates and amounts',
  'documents.editor.showColourChips': 'Colour swatches beside each line',
  'documents.editor.showPartyBlock': 'Party name and address block',
  'documents.editor.showLogo': 'Logo',
  'documents.editor.showWatermark': 'Watermark',
  'documents.editor.showSignature': 'Signature block',
  'documents.editor.showTerms': 'Terms',
  'documents.editor.showPageNumbers': 'Page numbers',

  'documents.editor.watermarkText': 'Watermark text',
  'documents.editor.termsText': 'Terms',
  'documents.editor.termsHint': 'Up to 500 characters.',
  'documents.editor.footerText': 'Footer text',

  'documents.preview.title': 'Preview',
  'documents.preview.description':
    'Renders what is on this form, saved or not, against a real record — nothing is stored.',
  'documents.preview.subject': 'Preview against',
  'documents.preview.action': 'Preview',
  'documents.preview.failed': 'Could not build the preview',
  'documents.preview.popupBlocked':
    'Your browser blocked the preview tab. Allow pop-ups for OrderBook, then preview again.',
  'documents.preview.loadingSubjects': 'Finding a record to preview against…',
  'documents.preview.noSubjects': 'Nothing to preview this template against yet.',
  'documents.preview.subjectsFailed': 'Could not load anything to preview against',

  'documents.exports.sectionTitle': 'Export history',
  'documents.exports.description':
    'Every document that was rendered, kept as the record of what was sent. Exports are never deleted.',
  'documents.exports.colWhen': 'When',
  'documents.exports.colDocument': 'File',
  'documents.exports.colType': 'Document',
  'documents.exports.colSubject': 'For',
  'documents.exports.colTemplate': 'Template',
  'documents.exports.colRates': 'Rates',
  'documents.exports.colPages': 'Pages',
  'documents.exports.colSize': 'Size',
  'documents.exports.colRenderedBy': 'Rendered by',
  'documents.exports.withRates': 'Included',
  'documents.exports.withoutRates': 'Omitted',
  'documents.exports.renderedByPanel': 'Office panel',
  'documents.exports.download': 'Download',
  'documents.exports.loadFailed': 'Could not load the export history',
  'documents.exports.empty.title': 'Nothing rendered yet',
  'documents.exports.empty.description':
    'Documents rendered from a lead or an order appear here with the file that was sent.',

  // --- Fields (FieldsScreen) ------------------------------------------------
  // `fieldSet.*` mirrors `shared/src/i18n/en.ts` exactly: the catalogue names
  // these tokens itself, so a fifth managed set minted server-side arrives here
  // as a token this file has to answer.

  'fieldSet.lead.sourcePlatform': 'Lead source',
  'fieldSet.stock.colour': 'Colour',
  'fieldSet.product.productType': 'Product type',
  'fieldSet.line.packaging': 'Packaging',

  'fields.title': 'Fields',
  'fields.tab.values': 'Option lists',
  'fields.tab.definitions': 'Custom fields',
  'fields.tab.stages': 'Pipeline stages',

  'fields.noAccess.title': 'Fields are not part of your role',
  'fields.noAccess.description': 'Ask an administrator for {permission}.',
  'fields.readOnly': 'You can read these lists but not change them — that needs {permission}.',

  'fields.error.load': 'Could not load the fields',
  'fields.error.save': 'Could not save',
  'fields.error.delete': 'Could not remove it',
  'fields.error.reorder': 'Could not save the new order',
  'fields.error.title': 'Could not load',

  'fields.conflict.reload': 'Reload theirs',
  'fields.conflict.overwrite': 'Overwrite with mine',
  'fields.conflict.theirs': 'theirs',
  'fields.conflict.yours': 'yours',
  'fields.conflict.notSet': 'not set',

  'fields.action.cancel': 'Cancel',
  'fields.action.save': 'Save',
  'fields.action.create': 'Create',
  'fields.action.edit': 'Edit',
  'fields.action.remove': 'Remove',
  'fields.action.moveUp': 'Move up',
  'fields.action.moveDown': 'Move down',
  'fields.col.order': 'Order',
  'fields.status.active': 'In pickers',
  'fields.status.inactive': 'Hidden',

  'fields.usedBy.label': 'Used by {sources}',
  'fields.usedBy.leads': 'leads',
  'fields.usedBy.orders': 'orders',
  'fields.usedBy.inventory': 'inventory',
  'fields.usedBy.products': 'products',

  'fields.values.add': 'Add value',
  'fields.values.col.colour': 'Colour',
  'fields.values.col.value': 'Value',
  'fields.values.col.label': 'Label',
  'fields.values.col.status': 'Status',
  'fields.values.col.usage': 'On records',
  'fields.values.empty.title': 'Nothing in this list yet',
  'fields.values.empty.description':
    'Add a value and it becomes a choice everywhere this list is used.',
  'fields.values.error.description':
    'The list could not be read, so nothing is shown — this is not an empty list.',

  'fields.values.unlisted.title': 'Already on records, not in the list',
  'fields.values.unlisted.description':
    'These strings sit on live records but have no entry here, so nothing offers them for a new record. Add one to put it back in the pickers.',
  'fields.values.unlisted.item': '{value} · {count}',

  'fields.values.new.title': 'New {set} value',
  'fields.values.edit.title': 'Edit {label}',
  'fields.values.field.value': 'Value',
  'fields.values.field.valueHint':
    'What gets written onto the record. Cannot be changed afterwards.',
  'fields.values.field.valueLocked':
    'The value is what records already hold — only the label can change.',
  'fields.values.field.label': 'Label',
  'fields.values.field.labelHint': 'What people read. Safe to rename at any time.',
  'fields.values.field.hex': 'Colour',
  'fields.values.field.hexHint': 'Six hex digits, e.g. #c8a165. Leave empty for no swatch.',
  'fields.values.field.hexInvalid': 'Use six hex digits after a #, e.g. #c8a165.',
  'fields.values.field.active': 'Offer this in pickers',
  'fields.values.field.activeHint':
    'Turning this off hides it from new records. Records already holding it keep showing it.',

  'fields.values.delete.title': 'Remove “{label}”?',
  'fields.values.delete.body':
    'It goes to the Recycle Bin and can be restored. Every record already holding “{value}” keeps that exact string — what changes is only that new records are no longer offered it.',

  'fields.definitions.add': 'Add custom field',
  'fields.definitions.col.key': 'Key',
  'fields.definitions.col.label': 'Label',
  'fields.definitions.col.type': 'Type',
  'fields.definitions.col.required': 'Required',
  'fields.definitions.col.options': 'Choices',
  'fields.definitions.empty.title': 'No custom fields on {entity} yet',
  'fields.definitions.empty.description':
    'Add one to collect something this product has no column for.',
  'fields.definitions.error.description':
    'The definitions could not be read, so nothing is shown — this is not an empty set.',
  'fields.definitions.requiredYes': 'Required',
  'fields.definitions.requiredNo': '—',

  'fields.definitions.new.title': 'New {entity} field',
  'fields.definitions.edit.title': 'Edit {label}',
  'fields.definitions.field.key': 'Key',
  'fields.definitions.field.keyHint':
    'What the answer is stored under on the record. Cannot be changed afterwards.',
  'fields.definitions.field.keyLocked':
    'The key is where stored answers live — only the label can change.',
  'fields.definitions.field.label': 'Label',
  'fields.definitions.field.type': 'Type',
  'fields.definitions.field.typeLocked': 'The type is fixed once answers can exist.',
  'fields.definitions.field.required': 'Required',
  'fields.definitions.field.requiredHint':
    'A missing answer flags the record incomplete. It never blocks a save.',
  'fields.definitions.field.options': 'Choices',
  'fields.definitions.field.optionsHint': 'One per line. A choice field needs at least one.',
  'fields.definitions.field.active': 'Show this field on records',

  'fields.definitions.delete.title': 'Remove “{label}”?',
  'fields.definitions.delete.body':
    'It goes to the Recycle Bin. Answers already stored under “{key}” stay on their records untouched, and adding the field back recovers them.',

  'fields.type.text': 'Text',
  'fields.type.number': 'Number',
  'fields.type.date': 'Date',
  'fields.type.select': 'Choice',
  'fields.type.boolean': 'Yes / no',

  'fields.entity.lead': 'Leads',
  'fields.entity.order': 'Orders',
  'fields.entity.party': 'Parties',
  'fields.entity.product': 'Products',

  'fields.stages.description':
    'Stages are the Kanban columns. Archiving one stops new records landing in it; everything already there keeps rendering.',
  'fields.stages.col.colour': 'Colour',
  'fields.stages.col.name': 'Stage',
  'fields.stages.col.flags': 'Behaviour',
  'fields.stages.flag.default': 'Default',
  'fields.stages.flag.terminal': 'Finished',
  'fields.stages.flag.archived': 'Archived',
  'fields.stages.action.makeDefault': 'Make default',
  'fields.stages.action.archive': 'Archive',
  'fields.stages.action.restore': 'Bring back',
  'fields.stages.empty.title': 'No stages in this pipeline',
  'fields.stages.empty.pipelines': 'No pipelines on this company',
  'fields.stages.empty.description': 'Lead and order pipelines are created with the company.',
  'fields.stages.error.description':
    'The pipelines could not be read, so nothing is shown — this is not an empty board.',

  'fields.stages.edit.title': 'Edit {name}',
  'fields.stages.field.name': 'Name',
  'fields.stages.field.colour': 'Colour',
  'fields.stages.field.terminal': 'Records here are finished',
  'fields.stages.field.terminalHint': 'Won, lost or dispatched — nothing further is expected.',

  'fields.stages.refusal.default':
    'The default stage cannot be archived — new records need somewhere to land. Make another stage the default first.',
  'fields.stages.refusal.occupied':
    '“{stage}” still holds {leads} leads and {orders} orders. Move them out and it can be archived.',
  'fields.stages.refusal.moveTo': 'The default stage, “{target}”, is where they would normally go.',

  // --- Recycle bin (RecycleBinScreen) ---------------------------------------

  // Kept with this screen's own keys rather than in the nav block above, so the
  // whole Recycle bin vocabulary moves as one when strings are hoisted to shared.
  'nav.master.recycleBin': 'Recycle bin',

  'recycleBin.title': 'Recycle bin',
  'recycleBin.scope.own': 'Your deletions',
  'recycleBin.scope.own.hint': 'Showing what you deleted yourself.',
  'recycleBin.scope.everyone': 'Everyone’s deletions',
  'recycleBin.scope.everyone.hint': 'Showing what anyone in the company deleted.',

  'recycleBin.search.placeholder': 'Search deleted records…',
  'recycleBin.filter.type': 'Record type',
  'recycleBin.filter.allTypes': 'All types',
  'recycleBin.filter.typeWithCount': '{type} ({count})',
  'recycleBin.filter.deletedBy': 'Deleted by',
  'recycleBin.filter.anyone': 'Deleted by anyone',

  'recycleBin.entity.lead': 'Lead',
  'recycleBin.entity.order': 'Order',
  'recycleBin.entity.party': 'Party',
  'recycleBin.entity.product': 'Product',
  'recycleBin.entity.role': 'Role',
  'recycleBin.entity.user': 'Person',
  'recycleBin.entity.option_list_item': 'Option value',
  'recycleBin.entity.custom_field_definition': 'Custom field',
  'recycleBin.entity.document_template': 'Document template',

  'recycleBin.column.type': 'Type',
  'recycleBin.column.label': 'Record',
  'recycleBin.column.detail': 'Detail',
  'recycleBin.column.deletedAt': 'Deleted',
  'recycleBin.column.deletedBy': 'Deleted by',
  'recycleBin.deletedBy.panel': 'Office panel',

  'recycleBin.action.restore': 'Restore',
  'recycleBin.action.loadMore': 'Load older',

  'recycleBin.empty.title': 'Nothing deleted',
  'recycleBin.empty.description': 'Deleted records wait here until someone puts them back.',
  'recycleBin.empty.filtered.title': 'No deleted record matches these filters',

  'recycleBin.error.title': 'Could not load the recycle bin',
  'recycleBin.error.load': 'Could not load the recycle bin',
  'recycleBin.error.restore': 'Could not restore that record',
  'recycleBin.error.restoreParent': 'Could not restore the records this one needs',

  'recycleBin.denied.title': 'You cannot see the recycle bin',
  'recycleBin.denied.description': 'Your role does not include {permission}.',

  'recycleBin.toast.restored': '{label} restored',
  'recycleBin.toast.restoredAs': '{label} restored as {name}',

  'recycleBin.refusal.title': 'Cannot restore {label} yet',
  'recycleBin.refusal.nameLabel': 'New name',
  'recycleBin.refusal.nameHint': 'A record still in use has the original one. Edit this if you prefer another.',
  'recycleBin.refusal.restoreAs': 'Restore under this name',
  'recycleBin.refusal.parentsTitle': 'Still deleted',
  'recycleBin.refusal.parentLine': '{type} · {label}',
  'recycleBin.refusal.restoreParents': 'Restore those first, then this',
  'recycleBin.refusal.parentsNotYours':
    'Someone allowed to restore those records has to put them back before this one can come back.',
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
