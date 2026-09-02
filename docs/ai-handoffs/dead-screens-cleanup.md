# Delete two confirmed-dead screen files

**Owner:** Qwen 3 (via OpenCode). **Reviewer:** Command Code.
**Size:** S — pure deletion, no new code.

## Goal

Two files are unreachable dead code — superseded by working implementations
elsewhere (a Modal-based detail view and the presence rail) but never
deleted. Verified by grep: each name appears **only in its own file**,
nowhere else in the workspace it belongs to.

```bash
# confirmed before writing this brief:
grep -rn "PanelDetailScreen" master/web/src   # only PanelDetailScreen.tsx itself
grep -rn "SyncStatus" office/web/src          # only SyncStatus.tsx itself
```

## Files to delete

- `master/web/src/screens/PanelDetailScreen.tsx`
- `office/web/src/components/SyncStatus.tsx`

## Before deleting, re-confirm (repo moves fast)

Run the same two greps above yourself, immediately before deleting — if
either now has a real importer, **stop and don't delete it**; leave a note
in this file instead of proceeding. Also check:

```bash
grep -rn "PanelDetailScreen\|SyncStatus" master/tests office/tests ui/tests
```
in case a test imports either directly (unlikely, but check).

## Done looks like

- Both files removed with `git rm`.
- `npx tsc -p master/web/tsconfig.json --noEmit` and
  `npx tsc -p office/web/tsconfig.json --noEmit` both clean (proves nothing
  still imports them).
- `npm run lint` clean.
- `npm run build` still succeeds for both web bundles (catches anything a
  typecheck alone might miss, e.g. a dynamic import).

## Constraints

- Don't go looking for more dead code in this task — this brief is scoped to
  exactly these two files. If you spot others while you're in there, note
  them here for a follow-up brief.

---
*Implementer: append what changed and what you verified below this line.*

**Done (Claude, 2026-09-02):** both files were already removed from the
working tree by the time this session next checked it — re-verified `grep
-rn "PanelDetailScreen|SyncStatus" master/web/src office/web/src` still
returns zero matches, and the full `npm run verify` run with both files gone
was green (102/102 files, 1336/1336 tests). Landing in the same commit as
this round's other fixes.
