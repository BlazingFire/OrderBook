# Debounce Inventory and Recycle Bin search inputs

**Owner:** Qwen 3 (via OpenCode). **Reviewer:** Command Code.
**Size:** S — should be a ~10-line diff across two files.

## Goal

Both `InventoryScreen.tsx` and `RecycleBinScreen.tsx` fire a full network
request on **every keystroke** in their search box — there's no debounce, so
fast typing produces a burst of overlapping requests for characters the user
has already typed past. The shared `useDebounced` hook already exists in
`ui/src/` for exactly this (`ui/src/useDebounced.ts`, exported from
`ui/src/index.ts`) — it was built specifically to replace two hand-rolled
`setTimeout` pairs that had the same bug (timer cleared on next keystroke but
not on unmount). Neither of these two screens uses it yet.

## Files to touch

- `master/web/src/screens/InventoryScreen.tsx`
- `master/web/src/screens/RecycleBinScreen.tsx`

## Exact change, per file

1. Import `useDebounced` from `@orderbook/ui` (it's already re-exported from
   the package barrel, so this is just adding it to the existing import list
   from that package).
2. Keep the existing `const [search, setSearch] = useState('')` — the input's
   `value`/`onChange` stay wired to `search` so typing feels instant.
3. Add `const debouncedSearch = useDebounced(search);` right after it.
4. In the `useEffect` that fetches data, use `debouncedSearch` instead of
   `search` — and put `debouncedSearch` (not `search`) in the dependency
   array.

**InventoryScreen.tsx** — around line 76/95/103:
```ts
const [search, setSearch] = useState('');
const debouncedSearch = useDebounced(search);
// ...
api.stock({ search: debouncedSearch || undefined, lowOnly }),
// ...
}, [debouncedSearch, lowOnly]);
```

**RecycleBinScreen.tsx** — around line 116/145/179:
```ts
const [search, setSearch] = useState('');
const debouncedSearch = useDebounced(search);
// ...
search: debouncedSearch.trim() || undefined,
// ...
}, [canView, type, debouncedSearch, deletedBy, revision, refresh]);
```
Note line 395's `filtered` check (`Boolean(type || search.trim() || ...)`)
should keep reading the **raw** `search`, not the debounced one — that flag
drives whether a "clear filters" affordance shows, and should react to what
the user typed immediately, not lag behind it. Only the network-triggering
effect should use the debounced value.

## Done looks like

- `npx tsc -p master/web/tsconfig.json --noEmit` clean.
- `npm run lint` clean (no unused-import warnings, etc.).
- Manually confirm in the running app (`npm run dev:master`): typing quickly
  in either search box no longer fires a request per keystroke (watch the
  Network tab — should settle ~150ms after the last keystroke), and the
  "clear filters" UI in Recycle Bin still reacts to the raw typed text.
- No test suite covers this directly; don't add one for a 2-line debounce
  wiring — not worth the ceremony.

## Constraints

- Don't touch `useDebounced.ts` itself — it's already correct and shared.
- Don't add debounce to any other screen in this task; if you notice more,
  note them in this file for a follow-up brief rather than expanding scope.

---
*Implementer: append what changed and what you verified below this line.*
