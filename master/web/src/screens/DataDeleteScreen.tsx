/**
 * Delete data, in the Master's Admin group (`shared/src/domain/data-reset.ts`).
 *
 * **Start fresh** deletes every new order, final order and party — every
 * user's, every panel's and this Master's — and keeps products, users, roles,
 * settings and panels. **Delete all chat messages** empties every chat and keeps
 * the groups; **Clear print room history** deletes printed and cancelled jobs and
 * keeps the waiting ones. Each says what goes and what stays, and its dialog asks
 * for the person's password and the typed word before the Master does it.
 * **Find and delete one record** searches parties, new orders and final orders
 * and deletes just the one picked (to the Recycle Bin). **Delete related data**
 * is the company switch `parties.deleteRelatedData`: on, a party's delete dialog
 * lists its orders and sends them to the Recycle Bin with it.
 *
 * Offered only to an administrator or a Server Master holding
 * `settings.manage`; the Master checks both again on every request.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  FRESH_START_CONFIRMATION,
  recordNumber,
  type FreshStartInput,
  type FreshStartSummary,
  type SettingView,
} from '@orderbook/shared';

import { api } from '../api';
import { PartyDeleteDialog, type PartyToDelete } from '../components/PartyDeleteDialog';
import {
  Button,
  Card,
  ConfirmDialog,
  ConflictBanner,
  EmptyState,
  ErrorState,
  FieldError,
  FormField,
  Input,
  Modal,
  PasswordInput,
  Section,
  StatusPill,
  Switch,
  apiErrorText,
  rem,
  t,
  useDebounced,
  useToast,
} from '@orderbook/ui';

interface Props {
  /** Moves when an order, party, product, user or setting changes anywhere. */
  revision: number;
  /** The signed-in person's keys: the search offers only the deletes they may make. */
  permissions: readonly string[];
}

/** Which bulk delete's dialog is open. */
type BulkTool = 'fresh' | 'chat' | 'print';

export function DataDeleteScreen({ revision, permissions }: Props) {
  const toast = useToast();
  const [summary, setSummary] = useState<FreshStartSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [related, setRelated] = useState<boolean | null>(null);
  const [relatedBusy, setRelatedBusy] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [tool, setTool] = useState<BulkTool | null>(null);
  // Bumped after a delete here, so the search reads again.
  const [searchNonce, setSearchNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const [counts, settings] = await Promise.all([api.freshStartSummary(), api.settings()]);
      setSummary(counts);
      setRelated(readRelated(settings));
      setLoadError(null);
    } catch (caught) {
      setLoadError(apiErrorText(caught, 'dataDelete.loadFailed'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function toggleRelated(next: boolean): Promise<void> {
    setRelatedBusy(true);
    setRelatedError(null);
    try {
      setRelated(readRelated(await api.saveSetting('parties.deleteRelatedData', next)));
    } catch (caught) {
      setRelatedError(apiErrorText(caught, 'dataDelete.related.saveFailed'));
    } finally {
      setRelatedBusy(false);
    }
  }

  if (loadError && !summary) {
    return <ErrorState title={loadError} onAction={() => void load()} />;
  }

  const noOrdersOrParties =
    summary !== null && summary.pendingOrders + summary.finalOrders + summary.parties === 0;

  function finished(message: string): void {
    setTool(null);
    toast.push(message, { tone: 'ok' });
    setSearchNonce((count) => count + 1);
    void load();
  }

  const removesOrders = summary ? (
    <CountList
      heading={t('dataDelete.fresh.removes')}
      lines={[
        t('dataDelete.count.pendingOrders', { count: summary.pendingOrders }),
        t('dataDelete.count.finalOrders', { count: summary.finalOrders }),
        t('dataDelete.count.parties', { count: summary.parties }),
      ]}
    />
  ) : null;

  return (
    <div className="ob-measure-wide" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <p className="ob-small" style={{ margin: 0 }}>
        {t('dataDelete.subtitle')}
      </p>

      <Card>
        <Section title={t('dataDelete.fresh.title')}>
          <p className="ob-body" style={{ margin: 0 }}>
            {t('dataDelete.fresh.body')}
          </p>
          {summary && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
                {removesOrders}
                <CountList
                  heading={t('dataDelete.fresh.keeps')}
                  lines={[
                    t('dataDelete.count.products', { count: summary.products }),
                    t('dataDelete.count.users', { count: summary.users }),
                    t('dataDelete.keeps.rest'),
                  ]}
                />
              </div>
              <span className="ob-small">{t('dataDelete.binNote')}</span>
            </div>
          )}
          <ToolButton
            label={t('dataDelete.fresh.button')}
            nothing={noOrdersOrParties ? t('dataDelete.fresh.nothing') : null}
            disabled={summary === null}
            onClick={() => setTool('fresh')}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('dataDelete.chat.title')}>
          <p className="ob-body" style={{ margin: 0 }}>
            {t('dataDelete.chat.body')}
          </p>
          {summary && (
            <CountList
              heading={t('dataDelete.fresh.removes')}
              lines={[t('dataDelete.chat.count', { count: summary.chatMessages })]}
            />
          )}
          <ToolButton
            label={t('dataDelete.chat.button')}
            nothing={summary?.chatMessages === 0 ? t('dataDelete.chat.nothing') : null}
            disabled={summary === null}
            onClick={() => setTool('chat')}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('dataDelete.print.title')}>
          <p className="ob-body" style={{ margin: 0 }}>
            {t('dataDelete.print.body')}
          </p>
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
              <CountList
                heading={t('dataDelete.fresh.removes')}
                lines={[t('dataDelete.print.count', { count: summary.printHistory })]}
              />
              <CountList
                heading={t('dataDelete.fresh.keeps')}
                lines={[t('dataDelete.print.waiting', { count: summary.printWaiting })]}
              />
            </div>
          )}
          <ToolButton
            label={t('dataDelete.print.button')}
            nothing={summary?.printHistory === 0 ? t('dataDelete.print.nothing') : null}
            disabled={summary === null}
            onClick={() => setTool('print')}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('dataDelete.find.title')}>
          <p className="ob-body" style={{ margin: 0 }}>
            {t('dataDelete.find.body')}
          </p>
          <FindAndDelete
            permissions={permissions}
            nonce={searchNonce + revision}
            onDeleted={(name) => {
              toast.push(t('dataDelete.find.deleted', { name }), { tone: 'ok' });
              setSearchNonce((count) => count + 1);
              void load();
            }}
          />
        </Section>
      </Card>

      <Card>
        <Section title={t('dataDelete.related.title')}>
          <p className="ob-body" style={{ margin: 0 }}>
            {t('dataDelete.related.body')}
          </p>
          <Switch
            checked={related === true}
            disabled={related === null || relatedBusy}
            onChange={(next) => void toggleRelated(next)}
            label={t('dataDelete.related.switch')}
          />
          {related !== null && (
            <span className="ob-small">
              {related ? t('dataDelete.related.on') : t('dataDelete.related.off')}
            </span>
          )}
          {relatedError && <FieldError>{relatedError}</FieldError>}
        </Section>
      </Card>

      {summary && (
        <>
          <BulkDeleteDialog
            open={tool === 'fresh'}
            title={t('dataDelete.fresh.modalTitle')}
            warning={t('dataDelete.fresh.warning')}
            confirmLabel={t('dataDelete.fresh.confirm')}
            onClose={() => setTool(null)}
            run={async (input) => {
              const result = await api.freshStart(input);
              return t('dataDelete.fresh.done', { ...result.removed });
            }}
            onDone={finished}
          >
            {removesOrders}
            <p className="ob-small" style={{ margin: 0 }}>
              {t('dataDelete.fresh.panelsNote')}
            </p>
          </BulkDeleteDialog>
          <BulkDeleteDialog
            open={tool === 'chat'}
            title={t('dataDelete.chat.modalTitle')}
            warning={t('dataDelete.bulk.warning')}
            confirmLabel={t('dataDelete.chat.confirm')}
            onClose={() => setTool(null)}
            run={async (input) => {
              const result = await api.clearChat(input);
              return t('dataDelete.chat.done', { ...result.removed });
            }}
            onDone={finished}
          >
            <CountList
              heading={t('dataDelete.fresh.removes')}
              lines={[t('dataDelete.chat.count', { count: summary.chatMessages })]}
            />
          </BulkDeleteDialog>
          <BulkDeleteDialog
            open={tool === 'print'}
            title={t('dataDelete.print.modalTitle')}
            warning={t('dataDelete.bulk.warning')}
            confirmLabel={t('dataDelete.print.confirm')}
            onClose={() => setTool(null)}
            run={async (input) => {
              const result = await api.clearPrintHistory(input);
              return t('dataDelete.print.done', { ...result.removed });
            }}
            onDone={finished}
          >
            <CountList
              heading={t('dataDelete.fresh.removes')}
              lines={[t('dataDelete.print.count', { count: summary.printHistory })]}
            />
          </BulkDeleteDialog>
        </>
      )}
    </div>
  );
}

function readRelated(settings: SettingView[]): boolean {
  const setting = settings.find((row) => row.key === 'parties.deleteRelatedData');
  return setting !== undefined && 'value' in setting && setting.value === true;
}

function CountList({ heading, lines }: { heading: string; lines: string[] }) {
  return (
    <div>
      <h3 className="ob-label" style={{ margin: '0 0 var(--s-4)' }}>
        {heading}
      </h3>
      <ul className="ob-body" style={{ margin: 0, paddingLeft: 'var(--s-16)' }}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function ToolButton({
  label,
  nothing,
  disabled,
  onClick,
}: {
  label: string;
  /** Why there is nothing to do, or null when there is. */
  nothing: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)', marginTop: 'var(--s-8)' }}>
      <Button variant="danger" disabled={disabled || nothing !== null} onClick={onClick}>
        {label}
      </Button>
      {nothing && <span className="ob-small">{nothing}</span>}
    </div>
  );
}

/** A bulk delete's last step: what goes, the password and the typed word. */
function BulkDeleteDialog({
  open,
  title,
  warning,
  confirmLabel,
  children,
  onClose,
  run,
  onDone,
}: {
  open: boolean;
  title: string;
  warning: string;
  confirmLabel: string;
  children: ReactNode;
  onClose: () => void;
  /** Does the delete; answers the toast's words. */
  run: (input: FreshStartInput) => Promise<string>;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts empty: a typed password never waits in a closed dialog.
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setWord('');
    setError(null);
  }, [open]);

  const ready = password.length > 0 && word === FRESH_START_CONFIRMATION && !busy;

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const message = await run({ confirmPassword: password, confirmText: word });
      setPassword('');
      onDone(message);
    } catch (caught) {
      setError(apiErrorText(caught, 'dataDelete.fresh.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="sm"
      title={title}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" busy={busy} disabled={!ready} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        // Enter in either field confirms, as a form with a submit button would; the
        // visible buttons live in the footer, outside the form.
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <ConflictBanner>{warning}</ConflictBanner>
        {children}
        <FormField label={t('dataDelete.fresh.password')}>
          {(id) => (
            <PasswordInput
              id={id}
              value={password}
              autoComplete="current-password"
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('dataDelete.fresh.typeToConfirm', { word: FRESH_START_CONFIRMATION })}>
          {(id) => (
            <Input
              id={id}
              value={word}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setWord(event.target.value)}
            />
          )}
        </FormField>
        {error && <FieldError>{error}</FieldError>}
      </form>
    </Modal>
  );
}

/** One search hit the person may delete. */
interface Hit {
  kind: 'party' | 'lead' | 'order';
  id: string;
  name: string;
  detail: string;
}

const HIT_LIMIT = 10;

/**
 * Search parties, new orders and final orders, then delete the one picked —
 * a party through the same dialog as the Parties screen (so Delete related data
 * applies), an order with a plain confirm. Each kind is searched only when the
 * person may both see and delete it.
 */
function FindAndDelete({
  permissions,
  nonce,
  onDeleted,
}: {
  permissions: readonly string[];
  nonce: number;
  onDeleted: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query).trim();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [party, setParty] = useState<PartyToDelete | null>(null);
  const [order, setOrder] = useState<Hit | null>(null);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const mayParties = permissions.includes('parties.view') && permissions.includes('parties.delete');
  const mayLeads = permissions.includes('leads.view') && permissions.includes('leads.delete');
  const mayOrders = permissions.includes('orders.view') && permissions.includes('orders.delete');

  useEffect(() => {
    if (debounced.length < 2) {
      setHits(null);
      setFailed(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      mayParties ? api.parties(debounced, HIT_LIMIT) : null,
      mayLeads ? api.leads({ search: debounced, limit: HIT_LIMIT }) : null,
      mayOrders ? api.orders({ search: debounced, limit: HIT_LIMIT }) : null,
    ])
      .then(([parties, leads, orders]) => {
        if (cancelled) return;
        setFailed(null);
        setHits([
          ...(parties?.items ?? []).map(
            (row): Hit => ({ kind: 'party', id: row.id, name: row.name, detail: row.partyCode ?? '' }),
          ),
          ...(leads?.items ?? []).map(
            (row): Hit => ({ kind: 'lead', id: row.id, name: recordNumber(row), detail: row.partyName ?? '' }),
          ),
          ...(orders?.items ?? []).map(
            (row): Hit => ({ kind: 'order', id: row.id, name: recordNumber(row), detail: row.partyName ?? '' }),
          ),
        ]);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setFailed(apiErrorText(caught, 'dataDelete.find.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, nonce, mayParties, mayLeads, mayOrders]);

  async function removeOrder(target: Hit): Promise<void> {
    setOrderBusy(true);
    setOrderError(null);
    try {
      if (target.kind === 'lead') await api.deleteLead(target.id);
      else await api.deleteOrder(target.id);
      setOrder(null);
      onDeleted(target.name);
    } catch (caught) {
      setOrderError(apiErrorText(caught, 'leadsOrders.delete.failed'));
    } finally {
      setOrderBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <div className="ob-search" style={{ maxWidth: rem(420) }}>
        <Input
          type="search"
          value={query}
          placeholder={t('dataDelete.find.placeholder')}
          aria-label={t('dataDelete.find.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {debounced.length === 1 && <span className="ob-small">{t('dataDelete.find.hint')}</span>}
      {failed && <FieldError>{failed}</FieldError>}
      {hits !== null && hits.length === 0 && !failed && (
        <EmptyState title={t('dataDelete.find.none', { query: debounced })} />
      )}
      {hits !== null && hits.length > 0 && (
        <ul
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
        >
          {hits.map((hit) => (
            <li
              key={`${hit.kind}:${hit.id}`}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)', padding: 'var(--s-4) 0' }}
            >
              <StatusPill tone={hit.kind === 'party' ? 'accent' : 'default'}>
                {t(`dataDelete.find.kind.${hit.kind}`)}
              </StatusPill>
              <span className="ob-body" style={{ flex: 1, minWidth: 0 }}>
                <strong>{hit.name}</strong>
                {hit.detail && <span className="ob-small"> · {hit.detail}</span>}
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  if (hit.kind === 'party') {
                    setParty({ id: hit.id, name: hit.name });
                  } else {
                    setOrderError(null);
                    setOrder(hit);
                  }
                }}
              >
                {t('dataDelete.find.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <PartyDeleteDialog
        party={party}
        onClose={() => setParty(null)}
        onDeleted={(deleted) => {
          setParty(null);
          onDeleted(deleted.name);
        }}
      />
      <ConfirmDialog
        open={order !== null}
        tone="danger"
        busy={orderBusy}
        title={t('dataDelete.find.confirmTitle', { name: order?.name ?? '' })}
        body={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <p className="ob-body ob-confirm-body">{t('dataDelete.find.confirmBody')}</p>
            {orderError && <FieldError>{orderError}</FieldError>}
          </div>
        }
        confirmLabel={t('dataDelete.find.delete')}
        onCancel={() => setOrder(null)}
        onConfirm={() => {
          if (order) void removeOrder(order);
        }}
      />
    </div>
  );
}
