/**
 * What it takes to boot a whole panel — `office/web/src/App.tsx` or
 * `master/web/src/App.tsx` — inside jsdom, for the shell tests beside this file.
 *
 * Neither web app has a test directory of its own, and the defects these tests
 * pin live in the shell itself: which screen a key press, a toast action or a
 * footer link actually lands on. Only a real render can see that, so the app is
 * booted whole and only its edges are replaced:
 *
 *  · `fetch` is answered by a route table the test supplies, so every screen
 *    runs its real `api.ts` code rather than a mock of it;
 *  · the browser APIs jsdom lacks (`matchMedia`, `document.fonts`,
 *    `EventSource`) get the smallest stand-in that works;
 *  · motion is switched off, which is also how the real splash skips its
 *    minimum hold;
 *  · `configureUi` is called with the panel's name, as its `main.tsx` does,
 *    so a panel-scoped message key reads as that panel's.
 *
 * The app is imported through a *variable* path on purpose. A literal import
 * would pull both web apps into `ui/tests/tsconfig.json`'s program, which is
 * stricter than theirs (`noUncheckedIndexedAccess`), and the test would start
 * failing the type check for reasons that belong to their own `tsc -b`. Vitest
 * resolves the path at run time either way.
 */

import type { ComponentType } from 'react';
import { configure, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';

import { configureUi } from '../src/config.js';

/** One `new EventSource(url)` the app opened, and a way to push frames down it. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  /** Every stream ever opened, closed ones included — `instances` forgets them. */
  static opened = 0;

  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
    FakeEventSource.opened += 1;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    FakeEventSource.instances = FakeEventSource.instances.filter((source) => source !== this);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Installs a `fetch` that answers from `route` and records every call.
 *
 * A route that returns `undefined` is answered with a request that never
 * settles: a screen the test did not set up for stays on its skeleton rather
 * than rendering an error somebody then has to read past.
 */
export function routeFetch(
  route: (call: Call) => Response | Promise<Response> | undefined,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: String(input),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      const answer = route(call);
      // The entry form's save-time "which products are live" read: a screen the test did not set
      // up for gets "cannot tell", as from an older Master, instead of a request that never settles.
      if (!answer && call.url === '/api/pick/live-products') return json({ live: null });
      return answer ?? new Promise<Response>(() => undefined);
    }),
  );
  return calls;
}

export function installBrowserStubs(): void {
  // A whole panel renders behind every `findBy`; the default second is tight
  // for that on a loaded machine, and a timeout here is never the finding.
  configure({ asyncUtilTimeout: 5000 });

  window.localStorage.clear();
  // Each test is its own sign-in: a remembered pop-up decision (V6) must not carry into the next one.
  window.sessionStorage.clear();
  window.localStorage.setItem('ob.motion', 'off');
  window.history.replaceState(null, '', '/');

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  // `KeyboardProvider` and the overlay hooks ask whether a dialog is actually
  // on screen; jsdom has no `checkVisibility`, so answer it from the styles.
  if (!('checkVisibility' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value(this: Element): boolean {
        if (!this.isConnected) return false;
        if (window.getComputedStyle(this).display === 'none') return false;
        const parent = this.parentElement;
        return parent ? parent.checkVisibility() : true;
      },
    });
  }

  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });

  // `DataTable` fits its columns to the width it is given; jsdom lays nothing
  // out, so there is nothing to observe.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );

  FakeEventSource.instances = [];
  FakeEventSource.opened = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('__APP_VERSION__', 'test');
}

/** The panel's `App`, loaded the way the header explains and configured as its `main.tsx` does. */
export async function loadApp(panel: 'master' | 'office'): Promise<ComponentType> {
  configureUi({ panel, defaultTheme: 'light', themeStorageKey: 'ob.theme' });
  const path = `../../${panel}/web/src/App.tsx`;
  const module = (await import(/* @vite-ignore */ path)) as { App: ComponentType };
  return module.App;
}

/** The one call the shell tests make on a panel's `api.ts` directly. */
export interface PanelApi {
  pick: (kind: 'party', query: { term: string; signal?: AbortSignal }) => Promise<unknown>;
}

/** The panel's `api` object, loaded through a variable path for the reason in the header. */
export async function loadApi(panel: 'master' | 'office'): Promise<PanelApi> {
  const path = `../../${panel}/web/src/api.ts`;
  const module = (await import(/* @vite-ignore */ path)) as { api: PanelApi };
  return module.api;
}

/** Alt+N, the way `KeyboardProvider` reads it: by `code`, with Alt held. */
export function pressAltDigit(digit: number): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: String(digit),
      code: `Digit${digit}`,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** The title the topbar is showing — the shell's own statement of where you are. */
export function topbarTitle(): string {
  return document.querySelector('.ob-topbar h1')?.textContent ?? '';
}

/**
 * Alt+N, pressed until the panel answers it with the screen titled `title`.
 *
 * The keyboard provider binds its listener in an effect, which React may not
 * have run yet when the shell is first on screen. A chord pressed before then
 * did nothing — and a test that expected a refusal read that as the refusal.
 * Pressing again is harmless: a screen already open stays open. A refusal test
 * opens a screen with this first, to know the panel is listening.
 */
export async function pressAltDigitUntil(digit: number, title: string): Promise<void> {
  await waitFor(() => {
    pressAltDigit(digit);
    expect(topbarTitle()).toBe(title);
  });
}

/** Lets debounced pickers, timers and queued microtasks run. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
