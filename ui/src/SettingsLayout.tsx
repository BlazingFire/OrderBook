/**
 * The Settings screen's shared skeleton: a tabbed page, a titled section, a
 * label/control row, the appearance controls, and the Developer tab.
 *
 * Both panels used to build Settings as their own flat stack of cards, and
 * both carried a private copy of the theme/scale/density/motion controls —
 * under two different key sets, so a wording fix landed on one panel and not
 * the other. Everything that is the same on both panels now lives here; a
 * panel's screen only decides which tabs it has and what data feeds them.
 *
 * `DeveloperPanel` is deliberately dumb about transport: it takes a status and
 * a list of tools and never imports an `api`, which is what lets it be tested
 * in jsdom and shared by two panels whose routes differ.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DeveloperStatus, DeveloperUnlock, SettingControl } from '@orderbook/shared';

import { Button, IconButton } from './Button.js';
import { Card } from './Card.js';
import { Input, Slider, Switch } from './Form.js';
import { Modal } from './Modal.js';
import { rem } from './rem.js';
import { Segmented, Tabs } from './Tabs.js';
import { useToast } from './Toast.js';
import { t } from './i18n.js';
import {
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  applyMotion,
  applyScale,
  applyTheme,
  loadScale,
  loadTheme,
  motionDisabled,
  type Theme,
} from './theme.js';

export interface SettingsTab {
  id: string;
  label: string;
  render: () => ReactNode;
}

export function SettingsPage({
  tabs,
  activeId,
  onChange,
  title,
  subtitle,
}: {
  tabs: SettingsTab[];
  activeId: string;
  onChange: (id: string) => void;
  title: string;
  subtitle?: string;
}) {
  // Falls back to the first tab rather than rendering nothing: a stored id
  // can outlive the tab it named (a permission withdrawn, a tab renamed).
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div>
        <h2 className="ob-title" style={{ margin: 0 }}>
          {title}
        </h2>
        {subtitle && (
          <p className="ob-small" style={{ margin: 'var(--s-4) 0 0', color: 'var(--fg-tertiary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      <Tabs tabs={tabs} activeId={active?.id ?? activeId} onChange={onChange} />
      <div
        role="tabpanel"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-16)',
          maxWidth: rem(760),
        }}
      >
        {active?.render()}
      </div>
    </div>
  );
}

/*
 * The App can ask for a tab before the screen exists — the shell's Help menu
 * sends `settings.developer` while the operator is on Orders — so the request
 * is parked here until a `useSettingsTab` mounts and takes it.
 */
let pendingTab: string | null = null;
const tabListeners = new Set<(id: string) => void>();

export function requestSettingsTab(id: string): void {
  pendingTab = id;
  for (const listener of tabListeners) listener(id);
}

/**
 * The active Settings tab, remembered per machine and validated against the
 * tabs this panel actually has.
 */
export function useSettingsTab(
  storageKey: string,
  tabIds: readonly string[],
  fallback: string,
): [string, (id: string) => void] {
  const [active, setActiveState] = useState<string>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored !== null && tabIds.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });

  const ids = tabIds.join(',');

  useEffect(() => {
    const accept = (id: string) => {
      if (!ids.split(',').includes(id)) return;
      pendingTab = null;
      setActiveState(id);
    };
    if (pendingTab !== null) accept(pendingTab);
    tabListeners.add(accept);
    return () => {
      tabListeners.delete(accept);
    };
  }, [ids]);

  const setActive = (id: string) => {
    setActiveState(id);
    try {
      window.localStorage.setItem(storageKey, id);
    } catch {
      // Private browsing: the choice lasts until the page is closed.
    }
  };

  return [active, setActive];
}

export function SettingsSection({
  title,
  description,
  tone = 'default',
  action,
  children,
}: {
  title: string;
  description?: string;
  tone?: 'default' | 'danger';
  /** A control that applies to the whole section, right-aligned in its header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className={tone === 'danger' ? 'ob-card--danger' : undefined}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-12)',
          marginBottom: description ? 'var(--s-4)' : 'var(--s-12)',
        }}
      >
        <div className="ob-eyebrow">{title}</div>
        {action}
      </div>
      {description && (
        <p className="ob-small" style={{ margin: '0 0 var(--s-12)' }}>
          {description}
        </p>
      )}
      {children}
    </Card>
  );
}

export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(10rem, 12rem) 1fr',
        gap: 'var(--s-12)',
        alignItems: 'start',
      }}
    >
      <label className="ob-body" htmlFor={htmlFor} style={{ paddingTop: 'var(--s-4)' }}>
        {label}
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', minWidth: 0 }}>
        {children}
        {hint && (
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A bounded number, saved on a button rather than on change.
 *
 * A `Switch` may save on change — there is one other value and it is visible.
 * A number must not: saving each keystroke writes `1` while somebody is on
 * their way to typing `12`, and for `security.sessionHours` that is a value
 * that signs people out four times as often, written and audited.
 *
 * Here rather than in the Master's Settings screen because the Office's
 * Settings → Leads edits the follow-up default through the same row.
 */
export function NumberSetting({
  control,
  value,
  label,
  saving,
  onSave,
}: {
  control: Extract<SettingControl, { kind: 'number' }>;
  value: number | null;
  label: string;
  saving: boolean;
  onSave: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  // Re-seeded when the stored value changes under us — a save elsewhere, or
  // this row's own write coming back.
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
  }, [value]);

  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const valid =
    parsed === null
      ? control.nullable === true
      : Number.isFinite(parsed) && parsed >= control.min && parsed <= control.max;
  const changed = parsed !== value;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
      <Input
        type="number"
        min={control.min}
        max={control.max}
        step={control.step}
        value={draft}
        aria-label={label}
        aria-invalid={!valid || undefined}
        placeholder={control.nullable ? t('setting.number.none') : undefined}
        style={{ width: rem(110) }}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="ob-small">{t(control.unitToken)}</span>
      <Button
        variant="secondary"
        size="sm"
        busy={saving}
        disabled={!valid || !changed || saving}
        onClick={() => void onSave(parsed)}
      >
        {t('common.save')}
      </Button>
    </div>
  );
}

/** Steps are fractional; summing them drifts (0.1 + 0.2), so land on the grid. */
function roundScale(value: number): number {
  return Math.round(value / SCALE_STEP) * SCALE_STEP;
}

function currentRootSize(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--root-size').trim();
}

/** Theme, scale and motion — per machine, never synced (§10). */
export function AppearanceSettings() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [scale, setScale] = useState<number>(loadScale);
  // The slider moves a draft; the page only resizes on release. Resizing the
  // UI mid-drag also resizes the slider under the pointer, which is the jitter.
  const [draft, setDraft] = useState<number | null>(null);
  const [motionOn, setMotionOn] = useState<boolean>(() => !motionDisabled());

  function pickTheme(next: Theme): void {
    applyTheme(next);
    setTheme(next);
  }
  function pickScale(next: number): void {
    applyScale(next);
    setScale(next);
    setDraft(null);
  }
  // The switch reads "Turn animation off", so checked means motion is off.
  function toggleMotion(motionOff: boolean): void {
    applyMotion(!motionOff);
    setMotionOn(!motionOff);
  }

  /*
   * Scale and motion together — **not** theme.
   *
   * Scale already had a per-control reset; density and motion had none, so
   * putting a machine back to its shipped defaults after experimenting meant
   * three separate corrections. Theme is left alone deliberately: resetting
   * somebody's light/dark preference as a side effect of an appearance reset
   * they did not ask for would be surprising, and light/dark is a preference
   * rather than a setting that drifts.
   *
   * The per-scale reset stays: somebody who only moved the slider wants only
   * the slider back.
   */
  const atDefaults = scale === SCALE_DEFAULT && motionOn;

  function resetAppearance(): void {
    pickScale(SCALE_DEFAULT);
    // `toggleMotion` takes "motion is off", so false restores motion.
    toggleMotion(false);
  }

  return (
    <SettingsSection
      title={t('settings.appearance.title')}
      description={t('settings.appearance.subtitle')}
      action={
        <Button variant="secondary" size="sm" disabled={atDefaults} onClick={resetAppearance}>
          {t('settings.appearance.resetAll')}
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <SettingRow label={t('settings.theme.label')}>
          <Segmented
            options={[
              { value: 'light' as const, label: t('settings.theme.light') },
              { value: 'dark' as const, label: t('settings.theme.dark') },
            ]}
            value={theme}
            onChange={pickTheme}
          />
        </SettingRow>

        <SettingRow
          label={t('settings.scale.label')}
          hint={t('settings.scale.note', { size: currentRootSize() })}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            {/* One step either side of the slider, for a mouse that cannot land
                on a 4% notch and a person who wants "a bit bigger" without
                aiming. Clamped the way the slider itself clamps. */}
            <IconButton
              icon="minus"
              label={t('settings.scale.smaller')}
              disabled={scale <= SCALE_MIN}
              onClick={() => pickScale(Math.max(SCALE_MIN, roundScale(scale - SCALE_STEP)))}
            />
            <Slider
              value={draft ?? scale}
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              label={t('settings.scale.label')}
              onChange={setDraft}
              onCommit={pickScale}
            />
            <IconButton
              icon="plus"
              label={t('settings.scale.larger')}
              disabled={scale >= SCALE_MAX}
              onClick={() => pickScale(Math.min(SCALE_MAX, roundScale(scale + SCALE_STEP)))}
            />
            <span className="ob-mono ob-small" style={{ minWidth: '3.5rem', textAlign: 'right' }}>
              {Math.round(((draft ?? scale) / SCALE_DEFAULT) * 100)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => pickScale(SCALE_DEFAULT)}
              disabled={scale === SCALE_DEFAULT}
            >
              {t('settings.scale.reset')}
            </Button>
          </div>
        </SettingRow>

        <SettingRow label={t('settings.motion.label')} hint={t('settings.motion.hint')}>
          <Switch checked={!motionOn} onChange={toggleMotion} label={t('settings.motion.turnOff')} />
        </SettingRow>
      </div>
    </SettingsSection>
  );
}

// --- Developer tab ----------------------------------------------------------

/** The three calls a panel's `api.developer` must offer for the tab to unlock. */
export interface DeveloperTransport {
  status: (token: string | null) => Promise<DeveloperStatus>;
  unlock: (password: string) => Promise<DeveloperUnlock>;
  lock: (token: string) => Promise<unknown>;
}

/**
 * The unlock token and what the server says about it.
 *
 * Held in React state by the screen — never localStorage — so it lives
 * exactly as long as the page does. The screen stays mounted while Settings
 * is hidden (`ScreenHost` keeps visited screens), so switching tabs does not
 * lock; reloading does, which is the right way round.
 */
export function useDeveloperSession(transport: DeveloperTransport): {
  token: string | null;
  status: DeveloperStatus | null;
  busy: boolean;
  error: string | null;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
} {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<DeveloperStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `api.developer` is a stable object, but a caller may pass an inline one;
  // reading it through a ref keeps the effect keyed on the token alone.
  const latest = useRef(transport);
  latest.current = transport;

  useEffect(() => {
    let cancelled = false;
    void latest.current
      .status(token)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function unlock(password: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const granted = await latest.current.unlock(password);
      setToken(granted.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('developer.unlockFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function lock(): Promise<void> {
    if (!token) return;
    setBusy(true);
    try {
      // A lock that fails on the wire still locks here: the token is dropped
      // either way, and the server's copy expires on its own.
      await latest.current.lock(token).catch(() => undefined);
    } finally {
      setToken(null);
      setBusy(false);
    }
  }

  return { token, status, busy, error, unlock, lock };
}

export interface DeveloperTool {
  id: string;
  title: string;
  description: string;
  danger?: boolean;
  /** The word the person must type, exactly, before `run` is allowed. */
  confirmWord?: string;
  confirmTitle?: string;
  confirmHint?: string;
  /** What the action erases, one bullet each. */
  confirmDetails?: string[];
  /** Button label. */
  action: string;
  /** Toast shown once `run` resolves. */
  done?: string;
  /**
   * Shown instead of the button when the tool cannot run here — a browser
   * tab has no shell to uninstall from. Honest rather than a dead button.
   */
  unavailable?: string;
  /** Extra controls above the button — an option the action takes. */
  controls?: ReactNode;
  run: () => Promise<void>;
  /** Shown after a successful run — the credentials a seed produced, say. */
  result?: ReactNode;
}

export function DeveloperPanel({
  status,
  busy,
  error,
  onUnlock,
  onLock,
  tools,
}: {
  status: DeveloperStatus | null;
  busy: boolean;
  error: string | null;
  onUnlock: (password: string) => Promise<void>;
  onLock: () => Promise<void>;
  tools: DeveloperTool[];
}) {
  const remaining = useCountdown(status?.unlocked ? status.expiresAt : null);
  const unlocked = Boolean(status?.unlocked) && remaining > 0;

  if (!unlocked) {
    return <LockedSection busy={busy} error={error} onUnlock={onUnlock} />;
  }

  return (
    <>
      <div className="ob-banner" role="status">
        <span style={{ flex: 1 }}>
          {t('developer.unlocked.title')}
          {' · '}
          {t('developer.unlocked.locksIn', { time: formatCountdown(remaining) })}
        </span>
        <Button size="sm" busy={busy} onClick={() => void onLock()}>
          {t('developer.lock')}
        </Button>
      </div>
      {tools.map((tool) => (
        <ToolSection key={tool.id} tool={tool} />
      ))}
    </>
  );
}

function LockedSection({
  busy,
  error,
  onUnlock,
}: {
  busy: boolean;
  error: string | null;
  onUnlock: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');

  return (
    <SettingsSection
      title={t('developer.locked.title')}
      description={t('developer.locked.description')}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length === 0) return;
          void onUnlock(password).then(() => setPassword(''));
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
      >
        <SettingRow
          label={t('developer.locked.passwordLabel')}
          htmlFor="developer-password"
          hint={t('developer.locked.hint')}
        >
          <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center' }}>
            <Input
              id="developer-password"
              type="password"
              autoComplete="off"
              value={password}
              invalid={error !== null}
              onChange={(event) => setPassword(event.target.value)}
              style={{ maxWidth: rem(280) }}
            />
            <Button type="submit" variant="primary" busy={busy} disabled={password.length === 0}>
              {t('developer.unlock')}
            </Button>
          </div>
          {error && (
            <div className="ob-field-error" role="alert">
              {error}
            </div>
          )}
        </SettingRow>
      </form>
    </SettingsSection>
  );
}

function ToolSection({ tool }: { tool: DeveloperTool }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      await tool.run();
      setConfirming(false);
      setTyped('');
      if (tool.done) toast.push(tool.done, { tone: 'ok' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }

  const matches = tool.confirmWord !== undefined && typed === tool.confirmWord;

  return (
    <SettingsSection
      title={tool.title}
      description={tool.description}
      tone={tool.danger ? 'danger' : 'default'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        {tool.controls}
        {tool.unavailable ? (
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {tool.unavailable}
          </span>
        ) : (
          <div>
            <Button
              variant={tool.danger ? 'danger' : 'secondary'}
              busy={running && !tool.confirmWord}
              onClick={() => (tool.confirmWord ? setConfirming(true) : void run())}
            >
              {tool.action}
            </Button>
          </div>
        )}
        {error && (
          <div className="ob-field-error" role="alert">
            {error}
          </div>
        )}
        {tool.result}
      </div>

      {tool.confirmWord && (
        <Modal
          open={confirming}
          onClose={() => {
            setConfirming(false);
            setTyped('');
          }}
          title={tool.confirmTitle ?? tool.title}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('action.cancel')}
              </Button>
              <Button
                variant="danger"
                busy={running}
                disabled={!matches}
                onClick={() => void run()}
              >
                {tool.action}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            {tool.confirmDetails && tool.confirmDetails.length > 0 && (
              <ul className="ob-small" style={{ margin: 0, paddingLeft: 'var(--s-16)' }}>
                {tool.confirmDetails.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {tool.confirmHint && (
              <p className="ob-small" style={{ margin: 0 }}>
                {tool.confirmHint}
              </p>
            )}
            <label className="ob-label" htmlFor={`developer-confirm-${tool.id}`}>
              {t('developer.confirm.typeWord', { word: tool.confirmWord })}
            </label>
            <Input
              id={`developer-confirm-${tool.id}`}
              value={typed}
              autoComplete="off"
              autoFocus
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        </Modal>
      )}
    </SettingsSection>
  );
}

/** Seconds until `expiresAt`, ticking once a second; 0 when there is no deadline. */
function useCountdown(expiresAt: string | null): number {
  const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
  const [remaining, setRemaining] = useState(() => secondsUntil(deadline));

  useEffect(() => {
    setRemaining(secondsUntil(deadline));
    if (!Number.isFinite(deadline)) return;
    const timer = setInterval(() => setRemaining(secondsUntil(deadline)), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  return remaining;
}

function secondsUntil(deadline: number): number {
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

// --- Uninstall --------------------------------------------------------------

/**
 * The "remove this program from this computer" tool, identical on both panels.
 *
 * It lives here rather than twice in the two Settings screens because the only
 * thing that differs between them is which panel the shell happens to be, and
 * the shell already knows that — the page never says. What the page does own is
 * the one question the shell cannot answer for it: whether the company's data
 * goes with the program.
 *
 * `bridge` is `null` in a browser tab, where there is nothing to uninstall: a
 * page served over the LAN is looking at somebody else's PC, and a button that
 * silently did nothing there would be worse than a sentence saying why it is
 * absent.
 *
 * The typed confirmation appears only when the data is going too. Removing the
 * program is recoverable — reinstall it and the database is still there — and
 * the shell asks natively either way; erasing the records is neither.
 */
export function useUninstallTool(bridge: UninstallBridge | null): DeveloperTool {
  const [deleteData, setDeleteData] = useState(false);
  const toast = useToast();

  const supported = typeof bridge?.uninstall === 'function';

  return {
    id: 'uninstall',
    danger: true,
    title: t('developer.tool.uninstall.title'),
    description: t('developer.tool.uninstall.description'),
    action: t('developer.tool.uninstall.action'),
    unavailable: supported ? undefined : t('developer.tool.uninstall.browserOnly'),
    controls: supported ? (
      <Switch
        checked={deleteData}
        onChange={setDeleteData}
        label={t('developer.tool.uninstall.deleteData')}
      />
    ) : undefined,
    confirmWord: deleteData ? t('developer.tool.uninstall.confirmWord') : undefined,
    confirmTitle: t('developer.tool.uninstall.confirmTitle'),
    confirmHint: t('developer.tool.uninstall.confirmHint'),
    confirmDetails: [
      t('developer.tool.uninstall.detail.program'),
      t('developer.tool.uninstall.detail.data'),
    ],
    run: async () => {
      // `false` is the shell saying it refused — the native dialog was
      // cancelled, the script is missing from this build, or the platform has
      // no uninstaller. A `true` never reaches a toast: the app is already
      // quitting, which is the only feedback that matters.
      const started = await bridge?.uninstall?.({ keepData: !deleteData });
      if (started === false) toast.push(t('developer.tool.uninstall.refused'), { tone: 'info' });
    },
  };
}

/** Just the method this tool calls, so the kit needs no dependency on the shell's full bridge. */
export interface UninstallBridge {
  uninstall?(options: { keepData: boolean }): Promise<boolean>;
}
