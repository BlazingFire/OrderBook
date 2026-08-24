/**
 * The English catalogue — THE source of truth. Every `MessageKey` in the
 * product is a key of this object (`keys.ts`), so a key that exists only in
 * `hi.ts` or only in a throw site is a compile error, not a runtime gap.
 *
 * Rules, each enforced by `shared/tests/i18n-coverage.test.ts`:
 *  - Flat, dotted keys — not nested objects — so `keyof typeof` is a usable
 *    union and the whole catalogue stays greppable.
 *  - `as const` is load-bearing: without it every value widens to `string` and
 *    `Placeholders<S>` has nothing to read.
 *  - Named `{placeholders}`, never positional and never string concatenation —
 *    a translator may need to reorder a sentence.
 *  - No pre-formatted numbers, no thousands separators, no currency symbol.
 *    Numbers arrive as params and are formatted by the caller.
 *  - A count is two sibling keys, `.one` and `.other`, never a number glued to
 *    a sentence.
 *
 * `error.*` and `validation.*` values were copied character-for-character from
 * the throw sites they replace, including punctuation, so that
 * `AppError.message` (derived from this catalogue) keeps existing English
 * assertions in `master/tests/*.integration.test.ts` byte-identical.
 */

export const EN_MESSAGES = {
  // --- permission.* — one per CAPABILITIES entry, plus one per module×action key ---
  'permission.lead.convert': 'Convert a lead to an order',
  'permission.orders.dispatch': 'Dispatch an order',
  'permission.record.reassignOwner': 'Reassign the owner of a record',
  'permission.field.saleRate.view': 'View sale rate',
  'permission.field.saleRate.edit': 'Edit sale rate',
  'permission.stock.adjust': 'Adjust stock by physical count',
  'permission.users.manage': 'Manage users',
  'permission.roles.assign': 'Assign roles to users',
  'permission.panels.manage': 'Manage office panels',
  'permission.settings.manage': 'Manage settings',
  'permission.fields.manage': 'Manage pipelines, stages and custom fields',
  'permission.sync.resolveConflicts': 'Resolve sync conflicts',

  'permission.leads.view': 'View leads',
  'permission.leads.create': 'Create leads',
  'permission.leads.edit': 'Edit leads',
  'permission.leads.delete': 'Delete leads',
  'permission.leads.export': 'Export leads',
  'permission.leads.bulk': 'Bulk-edit leads',
  'permission.orders.view': 'View orders',
  'permission.orders.edit': 'Edit orders',
  'permission.orders.delete': 'Delete orders',
  'permission.orders.export': 'Export orders',
  'permission.orders.bulk': 'Bulk-edit orders',
  'permission.parties.view': 'View parties',
  'permission.parties.create': 'Create parties',
  'permission.parties.edit': 'Edit parties',
  'permission.parties.delete': 'Delete parties',
  'permission.parties.export': 'Export parties',
  'permission.parties.bulk': 'Bulk-edit parties',
  'permission.products.view': 'View products',
  'permission.products.create': 'Create products',
  'permission.products.edit': 'Edit products',
  'permission.products.delete': 'Delete products',
  'permission.products.export': 'Export products',
  'permission.products.bulk': 'Bulk-edit products',
  'permission.inventory.view': 'View inventory',
  'permission.inventory.edit': 'Edit inventory',
  'permission.inventory.export': 'Export inventory',
  'permission.reports.view': 'View reports',
  'permission.reports.export': 'Export reports',
  'permission.roles.view': 'View roles',
  'permission.roles.create': 'Create roles',
  'permission.roles.edit': 'Edit roles',
  'permission.roles.delete': 'Delete roles',

  // Module actions minted by this batch — new modules, module x action grid.
  'permission.logs.view': 'View activity logs',
  'permission.logs.export': 'Export activity logs',
  'permission.documents.view': 'View documents',
  'permission.documents.create': 'Create documents',
  'permission.documents.edit': 'Edit documents',
  'permission.documents.delete': 'Delete documents',
  'permission.logs.verifyChain': 'Verify the audit chain',
  'permission.recycleBin.view': 'View the recycle bin',
  'permission.recycleBin.viewAll': 'View everybody’s deleted items',
  'permission.fields.view': 'View pipelines, stages and custom fields',
  'permission.documents.render': 'Render a document',

  // --- module.* — one per MODULES entry ---
  'module.leads': 'Leads',
  'module.orders': 'Orders',
  'module.parties': 'Parties',
  'module.products': 'Products',
  'module.inventory': 'Inventory',
  'module.reports': 'Reports',
  'module.roles': 'Roles',
  'module.logs': 'Logs',
  'module.documents': 'Documents',

  // --- action.* — the grid's column headers ---
  'action.view': 'View',
  'action.create': 'Create',
  'action.edit': 'Edit',
  'action.delete': 'Delete',
  'action.export': 'Export',
  'action.bulk': 'Bulk',

  // --- capabilityGroup.* ---
  'capabilityGroup.workflow': 'Workflow',
  'capabilityGroup.pricing': 'Pricing',
  'capabilityGroup.stock': 'Stock',
  'capabilityGroup.admin': 'Administration',

  // --- roleTemplate.* ---
  'roleTemplate.sales': 'Sales',
  'roleTemplate.dispatch': 'Dispatch',

  // --- error.* — one per AppError subclass and per stable code ---
  'error.notFound': '{what} not found',
  'error.forbidden.missingPermission': 'Missing permission: {permission}',
  'error.unauthorized': 'Not signed in',
  'error.unauthorized.signInFailed': 'Sign-in failed',
  'error.unauthorized.accountDeactivated': 'This account has been deactivated',
  'error.unauthorized.noRole': 'This account has no role. Ask an administrator to assign one.',
  'error.unauthorized.currentPasswordIncorrect': 'Your current password is not correct',
  'error.unauthorized.tooManyAttempts': 'Too many failed attempts. Try again in a minute.',
  'error.unauthorized.pairingNotAccepting':
    'The Master Panel is not accepting new panels right now. Open "Add Office Panel" on the Master and try again.',
  'error.unauthorized.incorrectPairingPassword': 'Incorrect pairing password',
  'error.unauthorized.differentMaster': 'This is a different Master Panel than the one you entered',
  'error.unauthorized.panelNotPaired': 'This panel is not paired',
  'error.unauthorized.panelCredentialsInvalid': 'Panel credentials are not valid',
  'error.tenantViolation': '{what} does not belong to this company',
  'error.conflict.alreadySetUp': 'This Master Panel has already been set up',
  'error.conflict.productCodeTaken': 'Product code "{productCode}" is already in use',
  'error.conflict.nameTaken.role': 'A role named "{value}" already exists',
  'error.conflict.nameTaken.username': 'The username "{value}" is already taken',
  'error.conflict.staleVersion': 'Somebody else saved this first. Reload to see their changes.',
  'error.internal.panelNoTenant': 'Panel has no tenant',
  'error.internal.sessionNoTenant': 'Session has no tenant',
  'error.unavailable': 'The Master Panel is unreachable. Try again when the link is back.',
  'error.unknown': 'Something went wrong',

  // Coarse, param-free fallbacks for `errorMessageKey(code)` — tier 2 of the
  // client's three-tier render ladder, reached only when a throw site named no
  // finer token of its own.
  'error.generic.notFound': 'Not found',
  'error.generic.conflict': 'Somebody else made a conflicting change',
  'error.generic.validation': 'That is not valid',
  'error.generic.forbidden': 'You do not have permission to do that',
  'error.generic.internal': 'Something went wrong on the server',
  'error.generic.masterCommandFailed': 'The Master Panel could not complete that action',
  'error.generic.invalidRequest': 'That request was not valid',
  'error.generic.notSynced': 'This panel has not synced with the Master yet',
  'error.generic.queueFailed': 'Could not queue that action for later',
  'error.generic.scanFailed': 'Could not scan for a Master Panel',
  'error.generic.pairingFailed': 'Pairing failed',
  'error.generic.invalidCredentials': 'Incorrect username or password',
  'error.generic.lockedOut': 'Too many failed attempts. Try again later',
  'error.generic.unknownHere': 'That is not available on this panel',

  // --- validation.* — field-level messages, one per distinct throw site ---
  'validation.user.username.required': 'Enter a username',
  'validation.user.displayName.required': 'Enter a display name',
  'validation.user.role.mustExist': 'Choose a role that exists',
  'validation.conflict.alreadyReviewed': 'That conflict was already reviewed',
  'validation.conflict.cannotRestoreField':
    'Cannot restore "{field}" automatically — edit the record directly',
  'validation.conflict.cannotRestoreEntity': 'Cannot restore a {entity} value automatically',
  'validation.conflict.actionRequired':
    'Choose whether to keep the current value or restore the other',
  'validation.order.dispatchedLocked': 'This order has been dispatched and can no longer be edited',
  'validation.order.weightNegative': 'Weight cannot be negative',
  'validation.order.alreadyDispatched': 'This order was already dispatched',
  'validation.order.stockAlreadyMoved': 'Stock has already moved for this order',
  'validation.remark.textRequired': 'A remark needs some text',
  'validation.stock.boxesArrivedRequired': 'Enter how many boxes arrived',
  'validation.stock.countedBoxesRequired': 'Enter the counted number of boxes',
  'validation.stock.reorderLevelNegative': 'A reorder level cannot be negative',
  'validation.stock.colourRequired': 'Choose which colour this stock is for',
  'validation.stock.productRequired': 'Select a product',
  'validation.stock.colourSelectRequired': 'Select a colour',
  'validation.lead.partyRequired': 'Select a party for this lead',
  'validation.lead.itemsRequired': 'Add at least one product to this lead',
  'validation.lead.partyMissing': 'The selected party no longer exists',
  'validation.lead.convertedLocked': 'This lead has become an order and can no longer be edited',
  'validation.lead.productMissing': 'One of the selected products no longer exists',
  'validation.lead.quantityRequired': 'Add a quantity for {productName}',
  'validation.lead.sourceInvalid': '"{value}" is not a configured lead source',
  'validation.lead.alreadyConverted': 'This lead has already been converted to an order',
  'validation.lead.noItemsToConvert':
    'A lead needs at least one product before it can become an order',
  'validation.lead.quantityMissingOnConvert':
    'Every line needs a quantity before converting — check {items}',
  'validation.lead.packagingMissing': 'Choose packaging for {items} before converting',
  'validation.panel.setupIncomplete': 'This Master Panel has not finished its first-run setup',
  'validation.panel.nameEmpty': 'Panel name cannot be empty',
  'validation.panel.nameRequired': 'Panel name is required',
  'validation.password.tooShort': 'Choose a password of at least 8 characters',
  'validation.password.bothRequired': 'Enter your current and new password',
  'validation.party.nameRequired': 'Party name is required',
  'validation.product.nameRequired': 'Product name is required',
  'validation.product.codeRequired': 'Product code is required',
  'validation.role.nameRequired': 'Give the role a name',
  'validation.role.tierInvalid': 'Choose a valid tier',
  'validation.permissions.unknown.one': 'Unknown permission: {keys}',
  'validation.permissions.unknown.other': 'Unknown permissions: {keys}',
  'validation.permissions.aboveTier':
    'The {tier} tier cannot hold: {keys}. Raise the tier or remove them.',
  'validation.role.systemUndeletable': '"{roleName}" is a system role and cannot be deleted',
  'validation.role.systemTierLocked':
    '"{roleName}" is a system role and its tier cannot be changed',
  'validation.role.lastAdminRequired':
    'At least one active administrator must remain. Give someone else an admin role first.',
  'validation.role.irrevocableCapabilityLost':
    'This would leave nobody able to {capabilities}. Grant it to an admin-tier role first.',
  'validation.role.stillAssigned':
    '"{roleName}" is still assigned to at least one person. Move them to another role first.',
  'validation.expectedVersion.required':
    'This change did not say which version it was based on, so it cannot be saved safely.',
  'validation.stage.differentPipeline': 'That stage belongs to a different pipeline',
  'validation.stage.leadConverted':
    'This lead has already become an order — move the order instead',
  'validation.stage.required': 'Choose a stage',
  'validation.signIn.credentialsRequired': 'Enter your ID and password',
  'validation.pairing.invalidRequest': 'Invalid pairing request',
  'validation.permissions.aboveTier.title': 'Above tier',
  'validation.cursor.malformed': 'This link to a page of results is no longer valid',
  'error.conflict.parentDeleted': 'One or more related records are still in the Recycle Bin',
  'error.conflict.restoreCollision': 'A live record already uses this {field}',
  'error.conflict.blockedByLiveReferences': 'Other records still reference this and must be dealt with first',
  'validation.recycleBin.unknownEntityType': 'That is not a Recycle Bin entity type',
  'validation.recycleBin.idRequired': 'That record has no id',

  // --- activity.* — activity.<entityType>.<action>, rendered by the Logs screen ---
  'activity.stock.inbound': '{actor} recorded {quantity} boxes in for {product}',
  'activity.stock.adjusted': '{actor} adjusted the counted stock for {product}',
  'activity.user.created': '{actor} created the account for {name}',
  'activity.user.updated': '{actor} updated {name}',
  'activity.user.deactivated': '{actor} deactivated {name}',
  'activity.user.deleted': '{actor} deleted the account for {name}',
  'activity.user.restored': '{actor} restored the account for {name}',
  'activity.user.password_reset': '{actor} reset the password for {name}',
  'activity.user.password_changed': '{actor} changed their password',
  'activity.user.sign_in': '{actor} signed in',
  'activity.user.sign_in_failed': 'A sign-in attempt failed for {name}',
  'activity.party.created': '{actor} added the party {name}',
  'activity.party.updated': '{actor} updated the party {name}',
  'activity.product.created': '{actor} added the product {name}',
  'activity.product.updated': '{actor} updated the product {name}',
  'activity.role.created': '{actor} created the role {name}',
  'activity.role.updated': '{actor} updated the role {name}',
  'activity.role.deleted': '{actor} deleted the role {name}',
  'activity.role.restored': '{actor} restored the role {name}',
  'activity.order.created': '{actor} created this order',
  'activity.order.dispatched': '{actor} dispatched this order',
  'activity.office_panel.created': '{actor} paired the office panel {name}',
  'activity.office_panel.updated': '{actor} updated the office panel {name}',
  'activity.lead.created': '{actor} created this lead',
  'activity.lead.updated': '{actor} updated this lead',
  'activity.lead.stage_changed': '{actor} moved this lead to {to}',
  'activity.lead.deleted': '{actor} deleted this lead',
  'activity.lead.restored': '{actor} restored this lead',
  'activity.order.updated': '{actor} updated this order',
  'activity.order.deleted': '{actor} deleted this order',
  'activity.order.restored': '{actor} restored this order',
  'activity.party.deleted': '{actor} deleted the party {name}',
  'activity.party.restored': '{actor} restored the party {name}',
  'activity.product.deleted': '{actor} deleted the product {name}',
  'activity.product.restored': '{actor} restored the product {name}',
  'activity.option_list_item.deleted': '{actor} removed the option {name}',
  'activity.option_list_item.restored': '{actor} restored the option {name}',
  'activity.custom_field_definition.deleted': '{actor} removed the custom field {name}',
  'activity.custom_field_definition.restored': '{actor} restored the custom field {name}',
  'activity.document_template.created': '{actor} created the document template {name}',
  'activity.document_template.updated': '{actor} updated the document template {name}',
  'activity.document_template.deleted': '{actor} deleted the document template {name}',
  'activity.document_template.restored': '{actor} restored the document template {name}',
  'activity.document_export.rendered': '{actor} rendered {documentType} for {subject}',

  // --- common.* ---
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.search': 'Search',
  'common.restore': 'Restore',
  'common.export': 'Export',
  'common.older': 'Older',
  'common.newer': 'Newer',

  // --- count.* — sibling .one/.other pairs, never a number glued to a sentence ---
  'count.leads.one': '{count} lead',
  'count.leads.other': '{count} leads',
  'count.rows.one': '{count} row',
  'count.rows.other': '{count} rows',
} as const;
