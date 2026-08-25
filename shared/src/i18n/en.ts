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
  'permission.storage.manage': 'Export, restore and migrate storage',
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

  // --- fieldSet.* — one per FIELD_LIST_KEYS entry, the Fields screen's set labels ---
  'fieldSet.lead.sourcePlatform': 'Lead source',
  'fieldSet.stock.colour': 'Colour',
  'fieldSet.product.productType': 'Product type',
  'fieldSet.line.packaging': 'Packaging',

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
  'error.conflict.notSetUp': 'This Master Panel has not been set up yet',
  'error.conflict.productCodeTaken': 'Product code "{productCode}" is already in use',
  'error.conflict.nameTaken.role': 'A role named "{value}" already exists',
  'error.conflict.nameTaken.username': 'The username "{value}" is already taken',
  'error.conflict.staleVersion': 'Somebody else saved this first. Reload to see their changes.',
  'error.internal.panelNoTenant': 'Panel has no tenant',
  'error.internal.sessionNoTenant': 'Session has no tenant',
  'error.internal.backupHashChainInvalid':
    'The restored audit trail did not verify against its own hashes — restore refused',
  'error.validation.backupWrongPassphrase': 'Incorrect passphrase',
  'error.validation.backupCorruptFile': 'This backup file is corrupt or incomplete',
  'error.validation.backupFormatTooNew':
    'This backup was made by a newer version of OrderBook (app {fileAppVersion}) than this installation can import. Update this installation first.',
  'error.conflict.dataDirectoryPopulated':
    'This installation already has data. Confirm you want to wipe it before restoring.',
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
  'validation.backup.passphraseTooShort': 'The export passphrase must be at least {min} characters long',
  'validation.backup.passphraseRequired': 'Enter the export passphrase',
  'validation.backup.scopeRequired': 'Choose whether to export the whole database or selected companies',
  'validation.backup.fileRequired': 'Choose a backup file',
  'validation.backup.tenantsRequired': 'Choose at least one company to export',
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
  'validation.stage.archived': 'That stage is archived and cannot accept new records',
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

  // --- Logs (docs/backend-modules/04-API-CONTRACT.md §2) ---
  'validation.logs.date.invalid': 'Enter a valid date range',
  'validation.logs.direction.invalid': 'That is not a valid paging direction',
  'validation.logs.verify.limitExceeded': 'That verification range is too large',
  'validation.logs.verify.fromSequenceInvalid': 'That is not a valid chain position',

  // --- Reports (docs/backend-modules/04-API-CONTRACT.md §3) ---
  'validation.reports.range.invalid': 'Enter a valid month range',
  'validation.reports.range.fromMonthRequired': 'Choose a starting month for a custom range',
  'validation.reports.range.toBeforeFrom': 'The end month cannot be before the start month',
  'validation.reports.range.tooWide': 'That range spans more than {maxMonths} months',
  'validation.reports.kind.unknown': 'That is not a report this product generates',

  // --- PDF Designer (docs/backend-modules/04-API-CONTRACT.md §6) ---
  'validation.documents.name.required': 'A template name is required',
  'validation.documents.documentType.unknown': 'That is not a document this product produces',
  'validation.documents.paperSize.unknown': 'Choose a paper size this product supports',
  'validation.documents.orientation.unknown': 'Choose portrait or landscape',
  'validation.documents.margins.invalid': 'Margins must be between {min}mm and {max}mm',
  'validation.documents.margins.exceedsPage': 'Those margins leave no room for the document',
  'validation.documents.accentColour.invalid': 'Enter a colour as #RRGGBB',
  'validation.documents.watermarkText.required': 'Enter the watermark text, or turn the watermark off',
  'validation.documents.locale.unknown': 'That is not a language this product speaks',
  'validation.documents.layout.duplicateKind': 'A document cannot have two {kind} sections',
  'validation.documents.layout.missingLines': 'A document needs a line-items section',
  'validation.documents.layout.headerNotFirst': 'The header must come first',
  'validation.documents.layout.signatureNotLast': 'The signature must come last',
  'validation.documents.layout.termsTooLong': 'Terms cannot be longer than {max} characters',
  'validation.documents.layout.blockKindUnknown': 'That is not a section a document can contain',
  'validation.documents.subjectKind.unknown': 'A document is rendered for a lead or an order',
  'validation.documents.templateType.mismatch':
    'That template produces a {documentType}, which does not apply to this record',
  'validation.documents.asset.unsupportedType': 'Upload a PNG or a JPEG',
  'validation.documents.asset.tooLarge': 'That image is larger than {maxBytes} bytes',
  'validation.documents.asset.kindUnknown': 'That is not a kind of image a document uses',
  'validation.documents.asset.malformed': 'That image could not be read',
  'error.conflict.nameTaken.documentTemplate': 'A template named "{value}" already exists',
  'error.conflict.subjectDeleted': 'That record is in the recycle bin — restore it first',
  'error.documents.renderFailed': 'The document could not be produced',
  'error.documents.fontMissing': 'A document font is missing from this installation: {file}',

  // --- Product images (7-IMAGE-PIPELINE.md) ---
  'validation.image.fileRequired': 'Choose an image file',
  'validation.image.tooLarge': 'That file is too large',
  'validation.image.unreadable': 'That file could not be read as an image — {reason}',
  'validation.image.crop.invalid': 'The crop was not applied correctly — try again',
  'validation.image.crop.tooSmall': 'The crop area is too small',
  'validation.image.crop.outOfBounds': 'The crop area falls outside the image',
  'validation.image.rotation.invalid': 'The rotation was not applied correctly — try again',
  'validation.image.reorder.notPermutation': 'That is not a complete reorder of this product’s images',
  'error.notFound.image': 'Image not found',

  'validation.fields.listKeyRequired': 'Choose which list this is',
  'validation.fields.entityInvalid': 'Choose a valid record type',
  'validation.fields.valueRequired': 'Enter a value',
  'validation.fields.valueImmutable':
    'The value cannot be changed once created — rename the label instead',
  'validation.fields.hexInvalid': 'Enter a colour as #RRGGBB',
  'validation.fields.reorderMismatch': 'That is not the complete, current list — reload and try again',
  'validation.fields.fieldTypeInvalid': 'Choose a valid field type',
  'validation.fields.keyRequired': 'Enter a key',
  'validation.fields.keyImmutable': 'The key cannot be changed once created',
  'validation.fields.optionsRequired': 'A select field needs at least one option',
  'error.conflict.optionValueTaken': '"{value}" already exists in this list',
  'error.conflict.definitionKeyTaken': 'A custom field with the key "{key}" already exists',
  'error.conflict.stageOccupied': 'This stage still holds live records — move them first',
  'error.conflict.stageIsDefault': 'This is the pipeline’s default stage and cannot be archived',

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
  'activity.option_list_item.created': '{actor} added the option {name}',
  'activity.option_list_item.updated': '{actor} updated the option {name}',
  'activity.option_list_item.deleted': '{actor} removed the option {name}',
  'activity.option_list_item.restored': '{actor} restored the option {name}',
  'activity.option_list_item.reordered': '{actor} reordered {list}',
  'activity.custom_field_definition.created': '{actor} added the custom field {name}',
  'activity.custom_field_definition.updated': '{actor} updated the custom field {name}',
  'activity.custom_field_definition.deleted': '{actor} removed the custom field {name}',
  'activity.custom_field_definition.restored': '{actor} restored the custom field {name}',
  'activity.custom_field_definition.reordered': '{actor} reordered the custom fields for {entity}',
  'activity.product_image.created': '{actor} added a photo to {name}',
  'activity.product_image.updated': '{actor} updated a photo on {name}',
  'activity.product_image.deleted': '{actor} removed a photo from {name}',
  'activity.pipeline_stage.updated': '{actor} updated the stage {name}',
  'activity.pipeline_stage.reordered': '{actor} reordered the stages in {pipeline}',
  'activity.pipeline_stage.archived': '{actor} archived the stage {name}',
  'activity.pipeline_stage.restored': '{actor} restored the stage {name}',
  'activity.pipeline_stage.default_changed': '{actor} set {name} as the default stage',
  'activity.activity_log.verified': '{actor} verified the audit chain',
  'activity.activity_log.exported': '{actor} exported the activity log',
  'activity.report.exported': '{actor} exported the {report} report',
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
