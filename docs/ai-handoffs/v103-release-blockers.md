# v1.0.3 (d52bdef) — four blockers before any installer is built

**Owner:** Command Code (it wrote the commit; it fixes it). **Reviewer:** Claude.
**Size:** M. **Nothing about 1.0.3 ships until these four land.**

> **Owner's decision, 2026-09-03: fix forward, do not revert.** `d52bdef` stays
> on `main`. The **draft GitHub release `v1.0.3` (created 2026-09-02) is held —
> do not publish it, and do not build or distribute installers** until all four
> blockers below are fixed and verified.
>
> **Sequencing: do `guardrails-for-autonomous-commits.md` FIRST.** The owner
> asked for the seven guardrail tests before this work, so each test can be
> written against the unfixed code, watched to fail, and then watched to pass as
> the fix lands. Blockers 1, 2 and 3 each have a named test in that brief; write
> the test, see it red, then fix.

`d52bdef` bumped every workspace to **1.0.3** and is `HEAD` on **both `dev` and
`main`**. It was written by an autonomous agent, self-documented by the same
agent, and merged with no review. A 46-agent adversarial audit across seven
dimensions found **four blockers**, all confirmed and all surviving
refutation-and-shipped-product verification. Verdict on the commit message: three
dimensions rated it *inaccurate*, three *overstated*, **none accurate**.

`npm run verify` is green (102 files, 1339 tests) — which is the point. Every
finding below is invisible to it.

---

## Blocker 1 — two ordinary budget refusals permanently disable AI for the whole installation

**File:** `master/src/services/ai.service.ts:70-91`, `:321-358`

`checkCanStartRun` increments the counter as its **last** act (`:86`), and the
only decrement is in the `.finally()` attached to `generate(...)` at `:352-358`.
Between the increment and that attachment sit **four throwing paths**:

```
:321  await checkCanStartRun(actor.tenantId);   ← activeRunCount++
:326  await getSetting(…, 'ai.dailyTokenBudget')          ← DB read, can throw
:328  await aiRunRepo.tokensSpentToday(…)                 ← DB read, can throw
:329  throw new ValidationError('validation.ai.budgetSpent')   ← ORDINARY OUTCOME
:332  await aiRunRepo.insertRun({…})                      ← DB write, can throw
:352  void generate(…).finally(() => releaseRunSlot())    ← the only release
```

`:329` is the one that makes this a blocker rather than an edge case. **It is not
an error path** — it is the normal, designed response to a user exceeding the
daily token budget. Every such refusal leaks a slot, permanently.

**Failure:** `ai.maxConcurrentRuns` defaults to **2**. A user hits the token
budget twice — or any two of those four paths throw once each — and
`activeRunCount` is stuck at 2 forever. Every subsequent AI request anywhere in
the company is refused with `error.ai.tooManyConcurrent`. The counter is
process-global and module-level, so it survives every request and only a Master
restart clears it. There is no diagnostic and no surface that shows the count. A
shop with no IT staff sees "the assistant stopped working" with nothing to
connect it to.

**Fix:** acquire the slot in a `try`, release it in a `finally` that covers every
path up to the point `generate`'s own `.finally` takes ownership. Simplest
correct shape: move the increment to immediately before `void generate(...)`, so
the counter is only ever held by a run that actually started — the validation
above it does not need a slot.

**Test (ten lines, the highest-value test in this brief):** call `startRun` down
the `budgetSpent` path and assert the next `startRun` is not refused.

---

## Blocker 2 — an Office panel on a different version than its Master crashes entirely

**Files:** `shared/src/domain/ai.ts:141-153`, `ui/src/AssistantScreen.tsx:144, :251`,
`office/src/http/app.ts:792-802`, `office/web/src/api.ts:503`

The commit added four **required** fields to `AiHardware` — `availableMemoryGb`,
`platform`, `hasUnifiedMemory`, `recommendedModels`. That type crosses a machine
boundary, and nothing on that boundary validates or version-gates:

- `office/src/http/app.ts:792-802` forwards `masterConnection.command('ai:status')`
  straight into `res.json(...)` — raw passthrough, no shape check.
- `office/web/src/api.ts:503` is `request<AiStatus>(…)` — a bare cast.
- `office/src/realtime/master-connection.ts` records `masterVersion` in four
  places and reports it in a fifth, but **never compares it to anything**. There
  is no version handshake between panels.
- `ui/src/AssistantScreen.tsx:144` gates on `status?.hardware &&` — truthiness —
  and `:251` then reads `hardware.recommendedModels.length`.

**Failure:** a 1.0.2 Master returns `{tier, totalMemoryGb, cpus}`. That object is
truthy, so `HardwareInfo` renders and `.recommendedModels.length` throws on
`undefined`. `ui/src/ErrorBoundary.tsx` is mounted app-wide
(`office/web/src/main.tsx:21`), so the throw does **not** degrade the Assistant
tab — **it replaces the entire Office panel with the crash screen.**

This product is rolled out by copying installers between PCs by hand
(`docs/TESTING_PLAN.md:17, :24`), so a Master and a panel on different versions
is the *normal* state of a shop mid-update, not an edge case.

`ui/src/ErrorBoundary.tsx:7-10` memorialises this exact bug class in prose:
*"That is exactly what a footer avatar reading `.id` off an absent field did, and
on a shop floor it is indistinguishable from the software being broken beyond
use."* The commit added a second instance.

**Fix:** make the four new fields **optional** in `AiHardware` and guard the read
at `AssistantScreen.tsx:251` (`hardware.recommendedModels?.length ?? 0`). A
widened wire type that older senders cannot satisfy has to be optional — that is
the same rule the repo already applies to `partyGrants`, `bootId`, `seq` and
`serverVersion` in `SyncSnapshot`, each with a comment saying why.

---

## Blocker 3 — "RAM management" raises V8's ceiling on big machines and lowers it on small ones

**File:** `electron/shell.ts:123-128`

```ts
const ramCapMb = config.panel === 'office' ? total * 0.4 : total * 0.6;
const maxOldSpaceMb = Math.round(ramCapMb * 0.7);   // → 42% of total RAM for the Master
```

No `Math.max`, no `Math.min`. Node's default old-space ceiling is ~4096 MB, so:

| Machine | New heap ceiling | Was | Effect |
|---|---|---|---|
| 4 GB shop PC | ~1720 MB | ~2048 MB | **lowered — new OOM risk** |
| 8 GB shop PC | ~3440 MB | ~4144 MB | **lowered — new OOM risk** |
| 16 GB | ~6.7 GB | ~4 GB | raised — no longer a cap |
| 64 GB | ~26 GB | ~4 GB | meaningless |

So a feature the commit message calls **"crash prevention"** introduces a fresh
V8 OOM risk on exactly the small, unlike-the-developer's machine this product is
installed on — and removes the cap on the machines that did not need one.

Compounding it, the monitor that was meant to warn **cannot**:
`master/src/lib/memory-monitor.ts:45` and `:48` are `global.gc?.()`, and
`--expose-gc` is never passed anywhere (`electron/shell.ts:134` sets only
`--max-old-space-size`). `global.gc` is always `undefined`; the call is a silent
no-op in dev **and** in the packaged app. Three places claim otherwise: the
file's own doc comment, `master/src/index.ts:276` ("GC hints are triggered
automatically"), and the commit message.

Also confirmed: outside the Electron shell (i.e. every dev run and every CI run)
`NODE_OPTIONS` is unset, so `memory-monitor.ts:40` falls back to
`os.totalmem() * 0.75` and compares **one process's V8 heap** against it — on a
16 GB box, a 12 GB ceiling against a ~4 GB heap cap. **The monitor is
mathematically incapable of ever firing in the only environment anyone tests in.**
The comment at `:38-39` confuses V8 heap limits with system memory.

**Fix:** clamp — `Math.max(2048, Math.min(4096, Math.round(ramCapMb * 0.7)))`,
or whatever bounds the team wants, but bounded in both directions. And **delete
`global.gc?.()`** rather than adding `--expose-gc`: the two calls do nothing, and
the lazy correct fix is not writing the line. Same for the `memory` object added
to the health endpoint (`master/src/http/health.ts:67`) — grep finds **zero
consumers** across both web apps, `electron` and `ui`, so it costs a second
`process.memoryUsage()` per request and buys nothing.

---

## Blocker 4 — the new screen refetches on every sync delta, a bug this repo already fixed and documented

**File:** `ui/src/AiSupportScreen.tsx:56-58`

```ts
useEffect(() => {
  void transport.status().then(setStatus).catch(() => setStatus(null));
}, [transport]);
```

The call site is an object literal built inside a render function —
`master/web/src/App.tsx:762-764`, `transport={{ status: api.aiStatus }}`, inside
`render: () => (...)`, which `ui/src/ScreenHost.tsx:72` invokes on every one of
its own renders. `master/web/src/App.tsx:156-160` holds live sync state, so the
Master's App re-renders on change-ring traffic; each re-render mints a new
literal, changes the dep, and refires the fetch — one `providerFor(tenantId)`
settings lookup on the machine that owns the database, per sync delta, for as
long as the tab is open.

**200 lines above it, in a file this same commit edits,
`ui/src/AssistantScreen.tsx:61-72` carries the postmortem for this exact bug** and
the fix: `const transportRef = useRef(transport)`.

**Fix:** copy the `transportRef` pattern from two hundred lines up.

---

## Should follow, but must not ship as-is either

- **Two of the six recommended models do not exist** (`master/src/ai/hardware.ts:73-78`,
  `:82-88`) — their `ollama` commands will fail. The model table also breaks its
  own stated 40%-headroom rule at every tier, and the setup card hardcodes an 8B
  pull the table itself marks as too large.
- **Every install instruction assumes internet access** on a product that is
  offline-only on a LAN, including a `curl` at `shared/src/i18n/en.ts:2445`.
  **The lazy fix is deletion** — drop the install commands and the two invented
  models rather than curating a model catalogue inside an offline app.
- **`Ctrl+F` / `⌘F` steals browser find and fires while the caret is in an input
  or textarea** (`ui/src/KeyboardProvider.tsx:211`). One condition to fix; take it
  with the blockers since you are in the file. Same for `Ctrl+Z`, which collides
  with the Electron Edit menu's own undo accelerator and is a trap for anyone
  typing a lead.
- **Four of the six new commands have no handler anywhere** — `edit.undo`,
  `edit.duplicate`, `nav.prev`, `nav.next` appear in the palette and the shortcut
  sheet and do nothing when selected. `nav.prev`/`nav.next` additionally bind a
  chord `matchesChord` can never match (the arrow keys are not in the code table).
  `view.toggleSidebar` writes `document.documentElement.dataset.sidebarCollapsed`,
  which **no CSS reads** — both panels drive collapse from React state.
  Either delete them until something answers, or wire them.
- **The Hindi catalogue is unreachable** — nothing anywhere writes the locale key
  that selects it (`ui/src/i18n.ts:47`). Worth knowing before anyone spends
  effort on the 37 new `ai.support.*` Hindi entries, **all of which are verbatim
  English** anyway.
- **The stagger animation escapes both reduced-motion kill switches**
  (`animation-delay` is not clamped by either), replays on every tab switch
  because `Activity` hides panes with `display:none`, and is capped at 5 items so
  card 200 fires simultaneously with card 1.

## Constraints

- **One feature per commit from here.** This commit is four unrelated features in
  32 files with one line of new test, which is why nothing held it whole.
- The `HANDOFF.md` entry for this commit is wrong in several ways — it heads its
  list "Files modified (20 files)" over 23 bullets for a 32-file diff, omits all
  seven `package.json` bumps that are the commit's own headline, invents a `⌘+,`
  shortcut that does not exist, asserts a reduced-motion guarantee that is false,
  and describes the nav gate as "when AI is enabled" when the code checks a
  permission. **Correct it as part of this work** — it is the file the next agent
  will trust.
- Its "Verified" line records "140 shared tests, 23 keyboard tests, three
  tsconfigs". `docs/AI_COLLABORATION.md` states the real bar is `npm run verify`,
  three sections above where that line was written. Use the real bar.

---
*Implementer: append what changed and what you verified below this line.*
