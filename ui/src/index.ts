/**
 * The shared UI package's public surface.
 *
 * Every component here used to exist twice — once under
 * `master/web/src/ui/` and once under `office/web/src/ui/` — and 26 of the
 * files were byte-identical while four had quietly drifted apart. One of them,
 * `icons.tsx`, even carried a comment telling you to remember to add your new
 * icon to the other panel by hand. Adding a component was a two-file change,
 * and `base.css` was a two-file change of 2,300 lines.
 *
 * Consumed as source, not as a build artifact: Vite does not pre-bundle a
 * symlinked workspace package, so the `.tsx`, `.css` and `.woff2` graph is
 * transpiled like local source. That is required rather than incidental —
 * `assetsInlineLimit: 0` has to own font emission, because the shop network
 * has no internet and the app must never reach for a CDN.
 *
 * Generated ordering, hand-maintained content: add a file, add a line.
 */

export * from './AppShell.js';
export * from './Avatar.js';
export * from './AvatarStack.js';
export * from './BasicHome.js';
export * from './AvatarPicker.js';
export * from './BusyMark.js';
export * from './Button.js';
export * from './Card.js';
export * from './Clock.js';
export * from './Combobox.js';
export * from './ConfirmDialog.js';
export * from './chatModel.js';
export * from './ChatConversation.js';
export * from './ChatGroupSettings.js';
export * from './ChatroomScreen.js';
export * from './ChatShareScreen.js';
export * from './CommandPalette.js';
export * from './CursorPager.js';
export * from './DataDisplay.js';
export * from './DataTable.js';
export * from './EditorScreen.js';
export * from './ErrorBoundary.js';
export * from './FieldGrid.js';
export * from './fitColumns.js';
export * from './FilterBar.js';
export * from './FilterBarSlot.js';
export * from './Form.js';
export * from './GalleryScreen.js';
export * from './ImageCropModal.js';
export * from './MainProductsScreen.js';
export * from './KanbanBoard.js';
export * from './KeyboardProvider.js';
export * from './LeadEntryScreen.js';
export * from './LeadRecordView.js';
export * from './LeadStaleEdit.js';
export * from './Logo.js';
export * from './LogsScreen.js';
export * from './Modal.js';
export * from './NotificationBell.js';
export * from './OptionListEditor.js';
export * from './OrderNote.js';
export * from './OrderRecordView.js';
export * from './OrderNoteScreen.js';
export * from './printPortal.js';
export * from './NoteDocumentPortal.js';
export * from './PrintroomScreen.js';
export * from './printroomModel.js';
export * from './PrintStationRunner.js';
export * from './SendToPrintroomDialog.js';
export * from './PermissionGrid.js';
export * from './PermissionSummary.js';
export * from './PartyFormModal.js';
export * from './ProductDetail.js';
export * from './ProductDrawer.js';
export * from './ProductImages.js';
export * from './ImportDialog.js';
export * from './PartyImportModal.js';
export * from './ReportsScreen.js';
export * from './ProductImportModal.js';
export * from './Popover.js';
export * from './PresenceRail.js';
export * from './ProgressiveImage.js';
export * from './RecordNumber.js';
export * from './ResetSlot.js';
export * from './ScreenHost.js';
export * from './SettingsLayout.js';
export * from './ShortcutSettings.js';
export * from './Splash.js';
export * from './SuggestInput.js';
export * from './States.js';
export * from './StatTile.js';
export * from './SubProductsScreen.js';
export * from './SubNavSlot.js';
export * from './subPages.js';
export * from './catalogueSummary.js';
export * from './Tabs.js';
export * from './TierPill.js';
export * from './Toast.js';
export * from './TopbarSlot.js';
export * from './TopProgress.js';
export * from './abort.js';
export * from './breakpoints.js';
export * from './clipboard.js';
export * from './config.js';
export * from './format.js';
export * from './i18n.js';
export * from './icons.js';
export * from './logoCells.js';
export * from './permissionLabels.js';
export * from './rem.js';
export * from './errorText.js';
export * from './sessionEnded.js';
export * from './theme.js';
export * from './useMediaQuery.js';
export * from './useRecordPresence.js';
export * from './useDebounced.js';
export * from './useEnterToAdvance.js';
export * from './useOverlay.js';
export * from './navIcons.js';
export * from './NoteButtons.js';
export * from './navGlyphs.js';
export * from './CatalogListsScreen.js';
export * from './ListFilters.js';
export * from './ProductShare.js';
export * from './useBoardPresence.js';
