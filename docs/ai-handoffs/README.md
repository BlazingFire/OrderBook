# AI handoff briefs

One file per task, written by whichever agent scoped the work for whichever
agent implements it. Follow `docs/AI_COLLABORATION.md` §5:

1. **The brief** (written by the planner): the goal in one paragraph, the exact
   files to touch, what "done" looks like (which tests to run, what output is
   expected), and any constraints (offline-only, don't touch migrations, etc.).
2. **One named owner** for implementation, one for review.
3. **The implementer appends to the same file** — what changed, what was
   verified (`npm run verify` output or the relevant subset), what's left. The
   next agent reads this file, not a chat transcript.
4. Once a brief is *fully* done, fold anything durable into `HANDOFF.md` and
   delete it — this directory is a working queue, not a permanent record. A
   brief that is **partly** done keeps its file, with the landed half recorded
   at the bottom and the open half named explicitly.

Name files `<short-task-slug>.md`. Keep exactly one open brief per task so two
agents don't pick up the same work.

---

## Queue, as of 2026-09-17

The 2026-09-14 queue held **19 open or partial briefs**. Fourteen are now
complete and deleted; five remain, four of them partial. Every remaining file
carries a dated "Landed" section naming what shipped and what did not — read
that first, not the brief's original body, which describes the pre-fix world.

### Open, in the order they are worth doing

1. **`office-product-image-flow.md`** — §2 is the substantive gap left in the
   product: **there is no way to look at a product photo.** `ProductDetail.tsx`
   contains no reference to `product.images`, so the `large` and `master`
   variants encoded on every upload are never requested by anything. For a
   ceramics catalogue that is the primary use of a photo. §3 (the image UI is
   entirely hardcoded English) and §4 (offline upload errors) go with it.

2. **`office-product-form-gates-and-slimming.md`** — the permission defects are
   done; what remains is the owner's actual complaint, *"too much field in New
   Product modal"*: the field-count reorganisation, which the brief deliberately
   holds as its own commit so a permission fix is not buried in a layout diff.
   Plus the auto-generated product code and client-side numeric bounds.

3. **`party-access-truncation-and-routing.md`** — §3 and §4. §3 is the owner's
   report ("no option for assign party"): there is no route from a party record
   to the screen that says who can see it. §4 is a list of smaller confirmed
   defects in the same area, including a label that is computed from what the
   *viewer* can see rather than from the party's actual grant state.

4. **`session-loss-and-password-change.md`** — all three numbered gaps are done.
   What remains is the tail of §2: `invalidateSessionsForUser` records no reason
   (so `signIn.notice.passwordChanged` exists and is unused), **Reset password**
   has no self-exclusion warning, and whether a password change should push to
   the user's other live sessions is undecided.

### Blocked on the owner, not on an implementer

5. **`recycle-bin-delete-actions-and-purge.md`** — **part 1 is done** (leads,
   orders, parties and products can all be deleted from the Master now, so the
   bin is reachable for all nine entity types). **Part 2 is a product decision
   and must not be started until the owner picks an option**: nothing ever
   leaves the Recycle Bin, so tombstoned rows, sealed passwords for deleted
   users, and image files all accumulate forever. The three coherent options and
   the four questions any of them has to answer are in the file.

### Deleted this round, because they are finished

`fix-office-new-lead-unreachable`, `add-master-party-screen`,
`web-reachability-and-dead-api-tests`, `close-money-field-gate-gaps`,
`office-write-refusal-visibility`, `signin-attempts-and-lockout-feedback`,
`self-service-password-change`, `fix-broken-popover-menu-css`,
`office-panel-report-hardening`, `fields-and-ai-domain-cleanup`,
`debounce-list-search`, `reset-appearance-action`,
`testing-plan-reconciliation`, `design-audit-high-priority`.

What they landed is in the git history and summarised in `HANDOFF.md` under
"Recent sessions".

---

## One standing caveat

Every brief here was written against the tree at some past moment, and several
have described a world the code had already moved past. **Check a claim against
the source before acting on it.** Two of this round's briefs were partly moot on
arrival: `fields-and-ai-domain-cleanup` was mostly about an AI assistant that no
longer exists, and `reset-appearance-action` assumed two separate Settings
screens that had since been merged into one shared component.
