/**
 * Two invariants about the two front ends that nothing else can see.
 *
 * `vitest.config.ts` collects `{shared,master,office,electron}/tests/**` and
 * `ui/tests/**`. Neither `master/web` nor `office/web` matches, and neither
 * holds a test file of its own — so the whole application shell of both panels
 * is invisible to the gate. Both of the blocking defects the owner hit in
 * manual QA lived there, and `tsc` was clean on both:
 *
 *  · The Office's New Lead screen was unreachable. `activeId` had no branch for
 *    `addLead`, so the sidebar-membership check fell through to the first nav
 *    item and the tab switch landed on the Dashboard. Pressing "+ New Lead"
 *    appeared to do nothing.
 *  · The Master had no Parties screen. `api.createParty` had existed with
 *    **zero callers** since the repo was restructured, so the panel that owns
 *    the database could not add a customer.
 *
 * **Sibling file:** `screen-reachability.test.ts` already holds the
 * nav ↔ `ScreenSpec` ↔ `Tab` agreement, and caught the stale "Office only"
 * reason for `parties` the moment the Master gained the screen. It does not
 * catch the New Lead bug, because all three of its lists agreed — the defect
 * was in how `activeId` *chose* between them. That is what the first group
 * below adds; the second group is about the api clients, which neither file
 * covered.
 *
 * Both are source-level facts, so these are source-level assertions — the style
 * `no-duplicate-ui.test.ts` and `i18n-call-sites.test.ts` already use. No React
 * render, no jsdom, no new framework.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every panel source but the client itself, with `api\n  .foo()` folded back
 * onto one line. Prettier breaks a long promise chain right after `api`, so a
 * naive `api.foo` search reports a called member as dead — which would have the
 * test's own exception list fill up with things that are not exceptions.
 */
function callSites(panel: 'master' | 'office', apiFile: string): string {
  return sources(path.join(ROOT, panel, 'web/src'))
    .filter((file) => file !== apiFile)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/\bapi\s*\.\s*/g, 'api.');
}

function appSource(panel: 'master' | 'office'): string {
  return readFileSync(path.join(ROOT, panel, 'web/src/App.tsx'), 'utf8');
}

/** The members of `type Tab = | 'a' | 'b' …`, comments and all, from App.tsx. */
function tabUnion(source: string): string[] {
  const start = source.indexOf('type Tab =');
  expect(start, 'App.tsx declares a Tab union').toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf(';', start));
  return [...body.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1] ?? '');
}

/**
 * Screens with no sidebar entry, stated on purpose.
 *
 * `addLead` is legitimately nav-less — it is reached from the "+ New Lead"
 * button and the command palette, and giving it a sidebar row would be wrong.
 * The point of the list is that being nav-less has to be *written down once*
 * rather than discovered by somebody pressing a button that does nothing.
 */
const NAV_LESS: Record<'master' | 'office', string[]> = {
  master: [],
  office: ['addLead'],
};

describe('every Tab in a panel can actually be shown', () => {
  it('office: every Tab is reachable through idToTab or is a stated nav-less screen', () => {
    const source = appSource('office');

    // The Office maps sidebar ids back onto tabs; a tab absent from the map
    // fails the sidebar-membership check in `activeId` and silently falls back
    // to the first nav item. That is exactly how New Lead broke.
    const start = source.indexOf('const idToTab: Record<string, Tab> = {');
    expect(start, 'App.tsx declares idToTab').toBeGreaterThan(-1);
    const map = source.slice(start, source.indexOf('};', start));
    const mapped = new Set([...map.matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1] ?? ''));

    const unreachable = tabUnion(source).filter(
      (tab) => !mapped.has(tab) && !NAV_LESS.office.includes(tab),
    );
    expect(unreachable, 'Office Tab members with no idToTab entry').toEqual([]);
  });

  it('office: a nav-less screen is handled inside activeId, not by fallthrough', () => {
    const source = appSource('office');

    // Scoped to the `activeId` expression itself, not the whole file. A search
    // over the file passes on the broken code: `resetActiveScreen` a few lines
    // above also tests `tab === 'addLead'`, so the assertion was satisfied by a
    // line that has nothing to do with which screen is shown.
    const start = source.indexOf('const activeId =');
    expect(start, 'App.tsx computes activeId').toBeGreaterThan(-1);
    const expression = source.slice(start, source.indexOf(';', start));

    for (const tab of NAV_LESS.office) {
      expect(expression, `activeId's own expression names the nav-less tab '${tab}'`).toMatch(
        new RegExp(`'${tab}'`),
      );
    }
  });
});

/**
 * Exported api-client members that nothing calls.
 *
 * Every entry below is either a screen somebody still has to build or code
 * somebody should delete — both are decisions to take on purpose rather than
 * discover when an owner reports that a feature does not exist. Each line
 * carries its reason, because an exception list without reasons is a mute
 * button.
 */
const ALLOWED_UNCALLED: Record<'master' | 'office', Record<string, string>> = {
  master: {
    // --- Panel administration: `PanelsScreen`'s detail dialog offers rename and
    // --- revoke (plus the pairing window); these actions have no control yet.
    updatePanel: 'no PanelsScreen control edits a panel beyond its name',
    refreshPanel: 'no PanelsScreen control asks a panel to re-report itself',
    rotatePanelSecret: 'no PanelsScreen control rotates a panel secret',
    setPanelStoragePath: 'no PanelsScreen control moves a panel’s storage',
    disconnectPanel: 'no PanelsScreen control disconnects a panel',
    panelActivity: 'the panel detail dialog shows no activity list',
    partyAccessFor:
      'PartyAccessScreen edits a party out of the assignment list it loaded; nothing reads one party alone',

    // --- No Master catalogue surface. Decision recorded in HANDOFF.md:
    // --- products stay Office-owned; parties came to the Master (PartiesScreen).
    createProduct: 'products are catalogued on the Office Panel — no Master products screen',
    deleteProduct: 'as createProduct',

    // --- Single-record fetches superseded by the list the screen already holds.
    // --- Kept because a detail screen that deep-links to one record will want
    // --- exactly these, and the routes are part of the shipped API contract.
    dashboard:
      'the summary arrives on the socket (`dashboard:changed`, sent on connect and after each change), never by GET',
    panel: 'PanelsScreen renders the panel out of the list it already loaded',
    lead: 'LeadsOrdersScreen acts on the rows of the page it loaded and opens no single lead',
    order: 'as lead',
    role: 'AccessScreen edits a role out of the loaded list',

    // --- Built ahead of the screens that will use them.
    addLeadRemark: 'the Master has no lead detail, so nowhere to add a remark yet',
    reportRangeQuery: 'a helper the report calls use inside api.ts; no screen needs it directly',
    connectorProfiles:
      'the Integrations screen builds a connector from scratch and offers no profiles',
    deleteConnector: 'no connector delete action on the Integrations screen yet',
  },
  office: {
    // --- Administration lives on the Master. These exist because both clients
    // --- were generated from one API surface, not because the panel needs them.
    recycleBin: 'the Recycle Bin is a Master screen',
    recycleBinCounts: 'as recycleBin',
    restoreFromBin: 'as recycleBin',
    deleteParty: 'as recycleBin — deletes are taken on the Master',
    deleteProduct: 'as recycleBin',
    deleteLead: 'as recycleBin',
    deleteOrder: 'as recycleBin',
    // --- Superseded by the merged view the panel's SSE stream maintains.
    snapshot: 'the panel reads its view from the change stream, not by polling',
    conflicts: 'ConflictsScreen reads view.conflicts from the same stream',

    // The option-list value calls are reached through `optionListTransport.ts`
    // (Products → Brands, Settings → Leads' sources); the rest stay Master-only.
    fieldsCatalogue: 'Fields is a Master screen',
    fieldDefinitions: 'as fieldsCatalogue',
    createFieldDefinition: 'as fieldsCatalogue',
    updateFieldDefinition: 'as fieldsCatalogue',
    deleteFieldDefinition: 'as fieldsCatalogue',
    reorderFieldDefinitions: 'as fieldsCatalogue',
    fieldStages: 'as fieldsCatalogue',
    updateFieldStage: 'as fieldsCatalogue',
    reorderFieldStages: 'as fieldsCatalogue',
    archiveFieldStage: 'as fieldsCatalogue',
    restoreFieldStage: 'as fieldsCatalogue',
    logs: 'the Activity log is a Master screen',
    logFacets: 'as logs',
    verifyLogChain: 'as logs',
    logsExportUrl: 'as logs',
    reportRangeQuery: 'Reports is a Master screen',
    dispatchReport: 'as reportRangeQuery',
    leadOutcomeReport: 'as reportRangeQuery',
    topPartiesReport: 'as reportRangeQuery',
    reportExportUrl: 'as reportRangeQuery',
    partyAccessFor:
      'PartyAccessScreen edits a party out of the assignment list it loaded; nothing reads one party alone',
    upsertVariant:
      'no screen edits a party’s own product records — PartyDetail and New lead only read view.partyVariants',

    // --- Built ahead of the screens that will use them.
    refreshDashboard: 'the dashboard refreshes off the snapshot stream',
  },
};

describe('no api-client member is dead code by accident', () => {
  it.each(['master', 'office'] as const)('%s: every exported api member has a caller', (panel) => {
    const apiFile = path.join(ROOT, panel, 'web/src/api.ts');
    const text = readFileSync(apiFile, 'utf8');
    const body = text.slice(text.indexOf('export const api = {'));
    const names = [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):\s/gm)].map((m) => m[1] ?? '');
    expect(names.length, 'the api object was parsed').toBeGreaterThan(20);

    const elsewhere = callSites(panel, apiFile);

    const uncalled = names.filter((name) => !new RegExp(`\\bapi\\.${name}\\b`).test(elsewhere));
    const unexplained = uncalled.filter((name) => !(name in ALLOWED_UNCALLED[panel]));

    expect(
      unexplained,
      `${panel}/web/src/api.ts exports these with no caller. Either build the screen that ` +
        `needs them, delete them, or add them to ALLOWED_UNCALLED with a reason.`,
    ).toEqual([]);
  });

  it.each(['master', 'office'] as const)('%s: the exception list has no stale entries', (panel) => {
    const apiFile = path.join(ROOT, panel, 'web/src/api.ts');
    const text = readFileSync(apiFile, 'utf8');
    const body = text.slice(text.indexOf('export const api = {'));
    const names = new Set(
      [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):\s/gm)].map((m) => m[1] ?? ''),
    );

    const elsewhere = callSites(panel, apiFile);

    // An exception that is now called, or that names a member the client no
    // longer exports, is a line nobody will ever read again — and the list is
    // only worth having while every line in it is still true.
    const stale = Object.keys(ALLOWED_UNCALLED[panel]).filter(
      (name) => !names.has(name) || new RegExp(`\\bapi\\.${name}\\b`).test(elsewhere),
    );

    expect(stale, `${panel}: remove these from ALLOWED_UNCALLED`).toEqual([]);
  });
});
