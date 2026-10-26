# Arc UI components — applicability for OrderBook

Source catalogue: https://uiarc.dev (188 components + 113 blocks; 120 components
and 22 blocks free/MIT). Rule: free items are rebuilt natively in
`ui/src/` (no motion/lucide/radix deps — offline-only, no new runtime deps).
Pro items are never reconstructed; the verdict names the free substitute.

Existing kit inventory: 115 `.tsx` files in `ui/src` (see task record
2026-10-26). This file lists what is applicable, what is built, and what is
deliberately not.

## Built and applied (both panels via the kit)

| Arc item | Kit file | Applied where | Tests |
|---|---|---|---|
| Button | `Button.tsx` + CSS | Everywhere (100+ call sites), press scale + `loading` alias | form-controls, shell suites |
| ActionButton | `ActionButtons.tsx` | Notice board mark-all / mark-read (pending → Saved) | arc-actions |
| ActionSwap | `ActionButtons.tsx` | Kit + tests (no product surface needs a cycling toggle yet) | arc-actions |
| HoldToConfirm | `ActionButtons.tsx` | Kit + tests (deletes keep dialogs — context needs reading) | arc-actions |
| CopyButton | `ActionButtons.tsx` | Record number, phone, party code, IdField (replaced 3 ad-hoc) | arc-actions, kit-i18n |
| ButtonGroup | `ActionButtons.tsx` | Note screen actions (Preview/Send/Save…) | order-note-screen |
| SearchField | `SearchField.tsx` | Leads, Orders, Parties (Master) + Products, Main products, Logs, Printroom, Reports, Chat rooms (both panels) | catalogue, notice suites |
| ExpandingSearch | `SearchField.tsx` | Kit + tests (no crowded header needs it yet) | arc-fields |
| InlineEdit | `InlineEdit.tsx` | Kit + tests (no rename endpoint on todo/party yet) | arc-fields |
| UserMenu | `UserMenu.tsx` | Both footers (replaced static chip + topbar account buttons) | shell suites, nav-icons, topbar-fit |
| SwipeActions | `SwipeActions.tsx` | Chat rows, print job rows, notice rows (all keep More menu) | arc-fields, chatroom, printroom |
| Reactions | `Reactions.tsx` | Notice board (client-side acknowledgment) | arc-fields |
| Password field | `Form.tsx` PasswordInput | All 14 password boxes (guard test bans raw inputs) | password-input |

## Applicable free items — build next, in this order

1. **AnimatedCounter** (`StatTile` values, dashboard/report totals) — tabular-nums
   roll on change. Small, high-visibility.
2. **CommentThread** (conflict discussion, notice comments) — replies +
   Reactions + InlineEdit already in kit; compose, don't rebuild chat.
3. **ChatThread** — adopt incrementally into `ChatConversation` (grouped
   messages, read receipts, typing already exist; add reactions row).
4. **Breadcrumb** (`TopbarTitle` parent chip → real breadcrumb with links).
5. **PageHeader** (folding header + tab counts for record screens) — extend
   `TopbarTitle`, don't add a parallel header.
6. **FilterToolbar** (list filter bars) — `FilterBar` + SearchField + chips
   already compose it; formalize as one component.
7. **DropdownMenu / ContextMenu** (row `⋯` menus, `RecordMenu`) — our Popover
   covers positioning; add menu semantics (roving tabindex, typeahead).
8. **Dialog/Drawer/BottomSheet** audit — Modal/ConfirmDialog/drawer CSS exist;
   align on one set of motion tokens (already done for sidebar).
9. **Tabs** (note Filling/Dispatch, catalogue tabs already Segmented) — keep.
10. **EmptyState** — exists in `States.tsx`; add the morphing-illustration
    variant only if Basic Home needs it (currently fine as-is).
11. **Timeline** — exists in `DataDisplay.tsx`; keep.
12. **Stepper** (restore wizard, first-run setup) — SettingsLayout covers flows;
    adopt for multi-step restores when touched.
13. **AnnouncementBar** (offline/hour-offline/update banners) — we have
    Conflict/Offline banners; unify rotation + dismiss.
14. **Progress** (job polls, restore/import/export) — TopProgress + bars exist;
    unify behind one component when next touched.
15. **ThemeSwitch** — UserMenu already has inline light/dark + motion switch;
    extract as standalone only if Settings needs it separately.
16. **SignaturePad** (Dispatch supervisor/loaded-by/checked-by) — replaces typed
    names with ink + PNG on the job. Needs backend field — separate brief.
17. **FileDropzone** (photo import, chat attachments, backup restore) —
    MultiPicker + ImportDialog cover flows; adopt when restyling those.
18. **MentionInput** (chat composer @people) — composer has custom @-picker;
    adopt when composer is restyled.
19. **OTPInput** (pairing/master-key six-digit codes) — pairing + recovery
    flows use plain inputs; adopt when those screens are restyled.
20. **CommandPalette** — exists; keep.
21. **NotificationCenter** — bell + drawer exist; keep, add animated disclosure
    when drawer is restyled.
22. **ChangelogFeed** (Updates screen release notes) — adopt when Updates is
    restyled.
23. **CardStack** (notice deck review) — adopt if board gets a review mode.
24. **ImageCompare** (photo before/after in restore review) — adopt with
    restore review; needs backend diff — separate brief.

## Deliberately not applicable

- **MoneyInput / BillingToggle / PlanComparison / Pricing blocks** — no money
  in the product (removed 2026-09-21).
- **AI blocks** (composer, side panel, run/research/answer, model picker,
  arena, studio, memory, tasks, approvals, routines, orchestrator, eval,
  knowledge, MCP) — no AI in the product.
- **Charts beyond current** (funnel/radar/race/realtime/sankey/sunburst/
  treemap/streamgraph/slope/waffle/ridgeline/horizon/brush) — Dashboard and
  Reports use committed-data tables + StatTiles; no chart lib beyond motion.
- **Kanban showpiece / DataGrid / PresenceStack / Dock / Liquid tabs /
  MegaMenu / ControlCenter / Product grids / CoverFlow / Voice / Recorder /
  AI illustrations** — Pro or out of scope; free alternatives or existing kit
  (KanbanBoard, AvatarStack) used instead. Never reconstructed.
- **Cart/Checkout/Payments/Calendar/DateReel/TimeDial/Revenue blocks** — no
  commerce, no scheduling product surface.
- **Login/Signup blocks** — sign-in + pairing + Server Master flows are
  custom and audited; not replaced.
- **EmojiPicker** (Pro) — kit icons only, so nothing renders as tofu without
  colour fonts.

## Rules for every adoption

- Native kit code only: `--motion` tokens, `t()` strings, kit icons, no new
  npm deps, no CDN, no `http` imports in `ui/src`.
- Reduced-motion branch + `data-motion="off"` kill switch on everything
  animated; transform/opacity only.
- One component per job; a brief per surface; targeted suites + shell suites
  green before merge. No bump/push/release until the verify gate passes.
