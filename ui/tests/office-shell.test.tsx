/**
 * The Office Panel's shell, booted whole in jsdom (`panel-harness.ts` says
 * how). Each group below is a defect somebody could only have found by
 * clicking, which is why none of them was caught before:
 *
 *  · the footer's "Design system" link opened the gallery for one frame — the
 *    `hashchange` it caused was read as "no route" and closed it again;
 *  · Alt+N reached screens the sidebar does not offer the signed-in person;
 *  · "See what was refused" on the refusal toast landed a salesperson on the
 *    Dashboard, because the screen that lists refusals was not theirs to open
 *    — and, pressed from the gallery, left them on the gallery;
 *  · the screen somebody was on outlived their session, so whoever signed in
 *    next at that window started on it, whether it was theirs to open or not;
 *  · a saved lead was still on the New lead form the next time it opened, one
 *    Save away from being queued twice;
 *  · the packaging "required" marker stayed up with the company switch off;
 *  · Reset asked through the browser's own `window.confirm`;
 *  · the order weight override was re-sent on every blur, edited or not, and
 *    a typed "1.2.3" crossed the wire as `null` and cleared it;
 *  · a panel whose own server could not be reached said "Request cancelled"
 *    on the splash, in English, rather than that it could not reach it.
 */

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import { publishSessionEnded } from '../src/sessionEnded.js';
import {
  FakeEventSource,
  installBrowserStubs,
  json,
  loadApi,
  loadApp,
  pressAltDigit,
  pressAltDigitUntil,
  routeFetch,
  topbarTitle,
  wait,
  type Call,
} from './panel-harness.js';

const CONNECTION = {
  hasNetworkLink: true,
  interfaces: [],
  isPaired: true,
  panelName: 'Counter',
  state: 'connected',
  masterHost: '10.0.0.1',
  masterPort: 4100,
  companyName: 'Acme Ceramics',
  lastError: null,
  lastSyncedAt: null,
  masterVersion: null,
};

const PARTY = {
  id: 'party-1',
  partyCode: 'P-001',
  name: 'Sharma Traders',
  city: 'Morbi',
  phone: '98250 00000',
};

const CATEGORY = { id: 'cat-1', name: 'ONE PIECE TOILET' };

const PRODUCT = {
  id: 'prod-1',
  name: 'Aqua Closet',
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
  alias: null,
  size: null,
  multiColour: false,
  variants: [{ id: 'var-1', label: 'White', code: 'AQ-W', weightKg: 30, isActive: true }],
};

const ORDER_PIPELINE = {
  id: 'pipe-orders',
  kind: 'order',
  name: 'Orders',
  stages: [{ id: 'stage-new', name: 'Confirmed', sequence: 1, isDefault: true, isTerminal: false }],
};

const ORDER = {
  id: 'ORD-1',
  partyId: PARTY.id,
  partyName: PARTY.name,
  leadId: null,
  stageId: 'stage-new',
  stageName: 'Confirmed',
  items: [],
  reservations: [],
  timeline: [],
  totalWeightKg: 120,
  totalWeightKgOverride: 150,
  weightSource: 'manual',
  linesWithoutWeight: 0,
  dispatchedAt: null,
  sync: { hlc: 'h1' },
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parties: [PARTY],
    products: [PRODUCT],
    categories: [CATEGORY],
    partyVariants: [],
    leads: [],
    orders: [],
    stock: [],
    pipelines: [],
    optionLists: [],
    customFields: [],
    conflicts: [],
    dashboard: { asOf: '2026-09-24T00:00:00.000Z' },
    permissions: [],
    serverHlc: '0',
    serverTime: '2026-09-24T00:00:00.000Z',
    pendingCount: 0,
    ...overrides,
  };
}

interface Boot {
  permissions: string[];
  view?: Record<string, unknown>;
  /** What `POST /api/sync/flush` refuses. */
  refusals?: Array<{ mutationId: string; entityId: string; error: string }>;
  /** Asked first; `undefined` falls through to the answers below. */
  route?: (call: Call) => Response | Promise<Response> | undefined;
}

/** The signed-in person `/api/session` and a sign-in both answer with. */
function panelSession(permissions: string[]) {
  return {
    userId: 'user-1',
    username: 'asha',
    displayName: 'Asha',
    roleId: null,
    roleName: 'Sales',
    roleTier: 'office',
    permissions,
    offline: false,
    signedInAt: '2026-09-24T00:00:00.000Z',
  };
}

async function boot({ permissions, view = {}, refusals = [], route }: Boot): Promise<Call[]> {
  let held: typeof refusals = [];
  const calls = routeFetch((call) => {
    const answer = route?.(call);
    if (answer) return answer;
    const { method, url } = call;
    const path = url.split('?')[0] ?? url;
    if (path === '/api/connection') return json(CONNECTION);
    if (path === '/api/session') {
      return json({ session: panelSession(permissions), defaultLocale: 'en' });
    }
    if (path === '/api/sync') return json({ ...CONNECTION, pendingCount: 0, rejections: held });
    if (path === '/api/sync/flush' && method === 'POST') {
      held = refusals;
      return json({
        pushed: 1,
        applied: 0,
        merged: 0,
        rejected: refusals.length,
        rejections: refusals,
        remaining: 0,
      });
    }
    if (path === '/api/sync/rejections/acknowledge' && method === 'POST') {
      held = [];
      return json({ rejections: [] });
    }
    if (path === '/api/pick/party') return json({ items: [PARTY], truncated: false });
    if (path === '/api/pick/category') return json({ items: [CATEGORY], truncated: false });
    if (path === '/api/pick/product') return json({ items: [PRODUCT], truncated: false });
    if (path === '/api/leads' && method === 'POST') {
      return json({ queued: true, id: 'L-TMP-1', mutationId: 'mut-1', pendingCount: 1 });
    }
    if (path.startsWith('/api/orders/') && method === 'PUT') {
      return json({ queued: true, id: ORDER.id, mutationId: 'mut-2', pendingCount: 1 });
    }
    return undefined;
  });

  const App = await loadApp('office');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByRole('link', { name: t('footer.designSystem') });
  await sendSnapshot(snapshot(view));
  return calls;
}

/**
 * The Master's view, down the panel's event stream — once there is one.
 *
 * The panel opens the stream in an effect, and React can put the shell on
 * screen before it has run that effect: the footer is there, the stream is
 * not. A snapshot sent then reached nobody, and every screen went on waiting
 * for a first sync that never came — on a loaded machine that was a New lead
 * form, an order row or a pending count that never appeared, in whichever
 * test lost the race.
 */
async function sendSnapshot(view: ReturnType<typeof snapshot>): Promise<void> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  await act(async () => {
    FakeEventSource.instances.at(-1)!.emit('snapshot', view);
  });
}

beforeEach(() => {
  installBrowserStubs();
});

/** The topbar's own New lead button — the Leads board has one of its own. */
function newLeadButton(): HTMLElement {
  return within(document.querySelector<HTMLElement>('.ob-topbar')!).getByRole('button', {
    name: t('action.newLead'),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The panel's own lead form, as far as a draft card with one quantity typed. */
async function draftOneProduct(): Promise<void> {
  // The first test to open the New lead screen also pays for compiling it,
  // which under a full run takes longer than `findBy`'s one-second default.
  const partyBox = await screen.findByLabelText(
    t('lead.add.party.search'),
    {},
    { timeout: 10_000 },
  );
  fireEvent.focus(partyBox);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(PARTY.name) }));

  const search = screen.getByLabelText(t('lead.add.products.searchLabel'));
  fireEvent.focus(search);
  fireEvent.mouseDown(await screen.findByRole('button', { name: CATEGORY.name }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(PRODUCT.name) }));

  fireEvent.change(await screen.findByLabelText(`${t('lead.add.draft.col.quantity')} — White`), {
    target: { value: '5' },
  });
}

describe('the splash', () => {
  it("says this panel's server could not be reached when the request never got there", async () => {
    routeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const App = await loadApp('office');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByText(t('splash.error.unreachable'))).toBeTruthy();
  });
});

describe('a request that ends without an answer', () => {
  it('is "aborted" when its own caller cancelled it', async () => {
    // What `CatalogScreen` drops quietly when a newer search replaces a load.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const api = await loadApi('office');
    const controller = new AbortController();

    const pending = api.pick('party', { term: 'sha', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'aborted',
      message: t('error.requestCancelled'),
    });
  });

  it('is a failure, not a cancel, when it never reached the server', async () => {
    routeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const api = await loadApi('office');

    await expect(api.pick('party', { term: 'sha' })).rejects.toMatchObject({
      code: 'internal_error',
      message: t('error.requestFailed'),
    });
  });
});

describe('the design-system gallery', () => {
  it('stays open after the link it was opened from changes the hash', async () => {
    await boot({ permissions: ['leads.view'] });

    // What a click on the footer link does in a browser: the handler, then the
    // hash, then `hashchange`.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: t('footer.designSystem') }));
      window.location.hash = '#/gallery';
      await wait(0);
    });

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });

  it('opens when the panel is loaded at #/gallery', async () => {
    window.history.replaceState(null, '', '/#/gallery');
    await boot({ permissions: ['leads.view'] });

    expect(topbarTitle()).toBe(t('footer.designSystem'));
  });
});

describe('Alt+N', () => {
  it('does not open a screen the sidebar does not offer', async () => {
    // No `leads.view`, so no Leads item — Alt+2 is the Leads shortcut.
    await boot({ permissions: ['orders.view'] });
    await pressAltDigitUntil(3, t('orders.filter.allStages'));

    await act(async () => pressAltDigit(2));

    expect(topbarTitle()).toBe(t('orders.filter.allStages'));
    expect(document.querySelector('.ob-topbar')?.textContent).not.toContain(t('action.newLead'));
  });

  it('still opens a screen the sidebar does offer', async () => {
    await boot({ permissions: ['orders.view'] });

    await pressAltDigitUntil(3, t('orders.filter.allStages'));
  });
});

describe('the refusal toast', () => {
  /** Sync now, from the footer's popover, as somebody holding one queued write. */
  async function syncAndReview({
    fromGallery = false,
    route,
  }: { fromGallery?: boolean; route?: Boot['route'] } = {}): Promise<void> {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { pendingCount: 1 },
      refusals: [{ mutationId: 'mut-9', entityId: 'L-TMP-9', error: 'Party is view-only for you' }],
      route,
    });
    if (fromGallery) {
      await act(async () => {
        fireEvent.click(screen.getByRole('link', { name: t('footer.designSystem') }));
        window.location.hash = '#/gallery';
        await wait(0);
      });
      expect(topbarTitle()).toBe(t('footer.designSystem'));
    }

    fireEvent.click(
      screen.getAllByRole('button', { name: new RegExp(t('sync.syncing', { count: 1 })) })[0]!,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('sync.flushNow') }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('action.reviewRefusals') }));
    });
  }

  it('takes somebody without sync.resolveConflicts to their refusals', async () => {
    await syncAndReview();

    expect(topbarTitle()).toBe(t('nav.conflicts'));
    expect(screen.getByText('Party is view-only for you')).toBeTruthy();
  });

  it('keeps the page open while the last refusal is dismissed, and drops it after', async () => {
    await syncAndReview();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('sync.rejections.dismiss') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.conflicts'));

    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.dashboard')));
    });
    expect(screen.queryByTitle(t('nav.conflicts'))).toBeNull();
  });

  it('leaves the design-system gallery for the refusals, as it was pressed from there', async () => {
    // The footer is on every screen, so Sync now — and the toast it raises —
    // can be pressed with the gallery open.
    await syncAndReview({ fromGallery: true });

    expect(topbarTitle()).toBe(t('nav.conflicts'));
    expect(screen.getByText('Party is view-only for you')).toBeTruthy();
    // And a reload does not put the gallery back.
    expect(window.location.hash).toBe('');
  });

  it('does not open for whoever signs in after the session ended on it', async () => {
    await syncAndReview({
      route: ({ method, url }) =>
        url === '/api/auth/sign-in' && method === 'POST'
          ? json({ session: panelSession(['leads.view']) })
          : undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('sync.rejections.dismiss') }));
      await wait(0);
    });
    expect(topbarTitle()).toBe(t('nav.conflicts'));

    // The Master stopped honouring the session — a password changed, say.
    await act(async () => {
      publishSessionEnded('signIn.notice.sessionEnded');
    });
    fireEvent.change(await screen.findByLabelText(t('signin.username')), {
      target: { value: 'ravi' },
    });
    fireEvent.change(screen.getByLabelText(t('signin.password')), { target: { value: 'secret' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(t('signin.password')).closest('form')!);
      await wait(0);
    });
    // Nothing of the last person's view is drawn for this one: the screens
    // wait for this session's own first snapshot.
    expect(screen.getByText(t('shell.waitingFirstSync'))).toBeTruthy();
    await sendSnapshot(snapshot());

    expect(topbarTitle()).toBe(t('nav.dashboard'));
    expect(screen.queryByTitle(t('nav.conflicts'))).toBeNull();
  });
});

describe('the New lead form', () => {
  it('starts blank again after a lead is saved', async () => {
    const calls = await boot({ permissions: ['leads.view', 'leads.create'] });

    fireEvent.click(newLeadButton());
    await draftOneProduct();
    fireEvent.change(screen.getByPlaceholderText(t('lead.add.products.packagingPlaceholder')), {
      target: { value: 'Carton' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: t('lead.add.draft.saveProduct') })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('lead.add.save') }));
      await wait(0);
    });

    expect(
      calls.filter((call) => call.url === '/api/leads' && call.method === 'POST'),
    ).toHaveLength(1);
    expect(topbarTitle()).toBe(t('lead.board.tab.list'));

    await act(async () => {
      fireEvent.click(newLeadButton());
    });

    // Blank: the party is a search box again and nothing has been added.
    expect(screen.getByLabelText(t('lead.add.party.search'))).toBeTruthy();
    expect(screen.getByText(t('lead.add.panel.emptyNone'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('lead.add.save') })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('marks packaging required only while the company requires it', async () => {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { features: { packagingRequiredOnConvert: false } },
    });

    fireEvent.click(newLeadButton());
    await draftOneProduct();

    const packaging = screen.getByPlaceholderText(t('lead.add.products.packagingPlaceholder'));
    const label = packaging.closest('label')!;
    expect(within(label).queryByText(t('lead.add.step.required'))).toBeNull();
  });

  it('still marks packaging required when the company requires it', async () => {
    await boot({
      permissions: ['leads.view', 'leads.create'],
      view: { features: { packagingRequiredOnConvert: true } },
    });

    fireEvent.click(newLeadButton());
    await draftOneProduct();

    const packaging = screen.getByPlaceholderText(t('lead.add.products.packagingPlaceholder'));
    const label = packaging.closest('label')!;
    expect(within(label).getByText(t('lead.add.step.required'))).toBeTruthy();
  });

  it('asks before a reset throws a half-typed lead away, in the themed dialog', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    await boot({ permissions: ['leads.view', 'leads.create'] });

    fireEvent.click(newLeadButton());
    fireEvent.change(await screen.findByLabelText(t('lead.add.details.notes')), {
      target: { value: 'Wants delivery before Diwali' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('screen.reset') }));
    });

    expect(nativeConfirm).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('lead.add.discardConfirm'))).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: t('lead.add.discard') }));
      await wait(0);
    });

    expect((screen.getByLabelText(t('lead.add.details.notes')) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });
});

describe('the order weight override', () => {
  /*
   * A write here is queued and answered at once, and no snapshot follows it —
   * an offline panel, or the round trip before the Master echoes the change.
   * The order on screen goes on saying 150 however many writes are queued,
   * which is the state the override has to be right in.
   */
  async function openOrder(route?: Boot['route']): Promise<Call[]> {
    const calls = await boot({
      permissions: ['orders.view'],
      view: { orders: [ORDER], pipelines: [ORDER_PIPELINE] },
      route,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(t('nav.orders')));
    });
    await act(async () => {
      fireEvent.click(await screen.findByText(ORDER.id));
    });
    return calls;
  }

  const overrideWrites = (calls: Call[]) =>
    calls.filter((call) => call.method === 'PUT' && call.url === `/api/orders/${ORDER.id}`);

  it('is not sent when the field is left as it was', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.focus(field);
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls)).toEqual([]);
  });

  it('is sent once when it was changed', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
    ]);
  });

  it('is not sent, and says so, when the text is not a number', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '1.2.3' } });
      fireEvent.blur(field);
      await wait(0);
    });

    // Sent, NaN would have crossed the wire as `null` and cleared the override.
    expect(overrideWrites(calls)).toEqual([]);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // Said in words too: closing the order drops what was typed.
    expect(screen.getByText(t('orders.detail.weightOverrideInvalid'))).toBeTruthy();
  });

  it('is sent again when it is put back before the first write is answered', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.change(field, { target: { value: '150' } });
      fireEvent.blur(field);
      await wait(0);
    });

    // Dropping the second left 175 queued under a field that says 150.
    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 150 },
    ]);
  });

  it('sends an edit typed while the save before it was still on its way', async () => {
    let answer: (response: Response) => void = () => undefined;
    const calls = await openOrder(({ method, url }) =>
      method === 'PUT' && url === `/api/orders/${ORDER.id}`
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '180' } });
      await wait(0);
    });
    await act(async () => {
      answer(json({ queued: true, id: ORDER.id, mutationId: 'mut-2', pendingCount: 1 }));
      await wait(0);
    });
    await act(async () => {
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 180 },
    ]);
  });

  it('is put back even while the save it undoes is still on its way', async () => {
    const calls = await openOrder(({ method, url }) =>
      method === 'PUT' && url === `/api/orders/${ORDER.id}`
        ? new Promise<Response>(() => undefined)
        : undefined,
    );
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '150' } });
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 150 },
    ]);
  });

  it('is tried again on the next blur after a save that failed', async () => {
    let failed = false;
    const calls = await openOrder(({ method, url }) => {
      if (method !== 'PUT' || url !== `/api/orders/${ORDER.id}` || failed) return undefined;
      failed = true;
      return json({ error: 'queue_failed', message: 'Could not queue that' }, 500);
    });
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '175' } });
      fireEvent.blur(field);
      await wait(0);
    });
    await act(async () => {
      fireEvent.focus(field);
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: 175 },
      { totalWeightKgOverride: 175 },
    ]);
  });

  it('is cleared when the field is emptied', async () => {
    const calls = await openOrder();
    const field = await screen.findByLabelText(t('orders.detail.weightOverrideLabel'));

    await act(async () => {
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.blur(field);
      await wait(0);
    });

    expect(overrideWrites(calls).map((call) => call.body)).toEqual([
      { totalWeightKgOverride: null },
    ]);
  });
});
