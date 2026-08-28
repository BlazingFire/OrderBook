/**
 * The activity log — append-only and hash-chained (`/api/logs`).
 *
 * Two things set this apart from every other list in the panel.
 *
 * An entry is a token, not a sentence: the row carries `entityType`, `action`
 * and a `details` bag, and the shared `activity.*` catalogue is what turns that
 * triple into prose. Rendering goes through `renderActivity` rather than
 * concatenating here, so the day a locale switch lands the same stored row
 * reads as Hindi — an English sentence assembled in this file would be frozen
 * as English forever.
 *
 * And the feed is keyset-paged in both directions. The log grows while it is
 * being read, so there is no stable "page 3" to number: Newer/Older walk from
 * whichever entry the current page ends on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityActorType,
  ActivityLogEntry,
  ActivityLogFacets,
  ActivityLogQuery,
  ChainVerification,
  CursorPage,
} from '@orderbook/shared';
import { createTranslator, renderActivity } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  ButtonLink,
  ConflictBanner,
  DataTable,
  DateField,
  EmptyState,
  ErrorState,
  Input,
  KeyValueList,
  Modal,
  NewerOlderPager,
  Section,
  Select,
  SkeletonTable,
  StatusPill,
  formatDateTime,
  rem,
  t,
  useFilterBar,
  type DataTableColumn,
} from '@orderbook/ui';

interface Props {
  /** The signed-in user's resolved permissions, as the shell already holds them. */
  permissions: string[];
}

/**
 * The panel has no locale selector yet, so the catalogue is asked for the one
 * locale it can offer today. When one arrives this argument is the change —
 * not the rendering of every row.
 */
const translator = createTranslator('en');

interface Filters {
  q: string;
  /** `actorType|actorId` as one select value; `''` means anyone. */
  actor: string;
  entityType: string;
  action: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { q: '', actor: '', entityType: '', action: '', from: '', to: '' };

function actorKey(type: ActivityActorType, id: string | null): string {
  return `${type}|${id ?? ''}`;
}

function toQuery(filters: Filters): ActivityLogQuery {
  const [actorType, actorId] = filters.actor ? filters.actor.split('|') : [];
  return {
    q: filters.q.trim() || undefined,
    actorType: (actorType as ActivityActorType | undefined) || undefined,
    actorId: actorId || undefined,
    entityType: filters.entityType || undefined,
    action: filters.action || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  };
}

function describe(entry: ActivityLogEntry): string {
  return renderActivity(translator, {
    entityType: entry.entityType,
    action: entry.action,
    actorName: entry.actor.name,
    details: entry.details,
  });
}

function actorLabel(entry: ActivityLogEntry): string {
  return entry.actor.name ?? t(`logs.actorType.${entry.actor.type}`);
}

export function LogsScreen({ permissions }: Props) {
  const canView = permissions.includes('logs.view');
  const canVerify = permissions.includes('logs.verifyChain');
  const canExport = permissions.includes('logs.export');

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [facets, setFacets] = useState<ActivityLogFacets | null>(null);
  const [facetsFailed, setFacetsFailed] = useState(false);

  // `null` is the head of the feed — the page you get with no cursor at all.
  const [cursor, setCursor] = useState<{ value: string; direction: 'older' | 'newer' } | null>(
    null,
  );
  const [page, setPage] = useState<CursorPage<ActivityLogEntry> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [openEntry, setOpenEntry] = useState<ActivityLogEntry | null>(null);

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const query = useMemo(() => toQuery(filters), [filters]);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const result = await api.logs({
          ...query,
          cursor: cursor?.value,
          direction: cursor?.direction,
        });
        if (cancelled) return;
        setPage(result);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // Clearing the page matters: a failed fetch that left the last good
        // page on screen would read as "these are the current entries".
        setPage(null);
        setError(caught instanceof Error ? caught.message : t('logs.error.title'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canView, query, cursor, reloadNonce]);

  // Facets are scoped to the date range, so the actor/type/action choices only
  // ever offer values that can actually match.
  useEffect(() => {
    if (!canView) return;
    let cancelled = false;

    void api
      .logFacets({ from: query.from, to: query.to })
      .then((result) => {
        if (cancelled) return;
        setFacets(result);
        setFacetsFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFacets(null);
        setFacetsFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [canView, query.from, query.to]);

  // Any filter change invalidates the cursor — it points at a row that the new
  // filter may not even select.
  const setFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setCursor(null);
  }, []);

  async function runVerify(): Promise<void> {
    setVerifyOpen(true);
    setVerifying(true);
    setVerification(null);
    setVerifyError(null);
    try {
      setVerification(await api.verifyLogChain());
    } catch (caught) {
      setVerifyError(caught instanceof Error ? caught.message : t('logs.verify.failed'));
    } finally {
      setVerifying(false);
    }
  }

  function closeVerify(): void {
    setVerifyOpen(false);
    // Verifying is itself an audited act, so the run just finished is now the
    // newest entry — go back to the head rather than leave it invisible.
    if (verification) {
      setCursor(null);
      setReloadNonce((value) => value + 1);
    }
  }

  const filtered = Object.values(filters).some((value) => value !== '');

  useFilterBar(
    canView ? (
      <>
        <div className="ob-search">
          <Input
            value={filters.q}
            placeholder={t('logs.filter.searchPlaceholder')}
            aria-label={t('logs.filter.searchPlaceholder')}
            onChange={(event) => setFilter({ q: event.target.value })}
          />
        </div>
        <Select
          value={filters.actor}
          aria-label={t('logs.filter.actorLabel')}
          onChange={(event) => setFilter({ actor: event.target.value })}
        >
          <option value="">{t('logs.filter.actorAll')}</option>
          {/* Keyed by position, not by identity: `system` and `office_panel`
              actors can both arrive with a null id, and two such rows would
              otherwise collide on one React key. */}
          {(facets?.actors ?? []).map((actor, index) => (
            <option
              key={`${index}-${actorKey(actor.type, actor.id)}`}
              value={actorKey(actor.type, actor.id)}
            >
              {actor.name ?? t(`logs.actorType.${actor.type}`)}
            </option>
          ))}
        </Select>
        <Select
          value={filters.entityType}
          aria-label={t('logs.filter.entityLabel')}
          onChange={(event) => setFilter({ entityType: event.target.value })}
        >
          <option value="">{t('logs.filter.entityAll')}</option>
          {(facets?.entityTypes ?? []).map((entityType) => (
            <option key={entityType} value={entityType}>
              {entityType}
            </option>
          ))}
        </Select>
        <Select
          value={filters.action}
          aria-label={t('logs.filter.actionLabel')}
          onChange={(event) => setFilter({ action: event.target.value })}
        >
          <option value="">{t('logs.filter.actionAll')}</option>
          {(facets?.actions ?? []).map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </Select>
        <DateField
          value={filters.from}
          max={filters.to || undefined}
          aria-label={t('logs.filter.fromLabel')}
          onChange={(event) => setFilter({ from: event.target.value })}
        />
        <DateField
          value={filters.to}
          min={filters.from || undefined}
          aria-label={t('logs.filter.toLabel')}
          onChange={(event) => setFilter({ to: event.target.value })}
        />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(NO_FILTERS);
              setCursor(null);
            }}
          >
            {t('logs.filter.clear')}
          </Button>
        )}
        {facetsFailed && (
          <span className="ob-small" style={{ color: 'var(--state-conflict)' }}>
            {t('logs.filter.facetsUnavailable')}
          </span>
        )}
      </>
    ) : null,
  );

  if (!canView) {
    return (
      <EmptyState
        title={t('logs.noPermission.title')}
        description={t('logs.noPermission.description', { permission: 'logs.view' })}
      />
    );
  }

  /** One audit entry, in full — including the hash somebody re-checks by hand. */
  function renderEntryDetail(entry: ActivityLogEntry) {
    return (
      <div className="ob-detail">
        <KeyValueList
          items={[
            {
              label: t('logs.drawer.token'),
              value: (
                <span className="ob-mono">
                  {entry.entityType}.{entry.action}
                </span>
              ),
            },
            {
              label: t('logs.drawer.record'),
              value: <span className="ob-mono">{entry.entityId}</span>,
            },
            { label: t('logs.drawer.who'), value: actorLabel(entry) },
            { label: t('logs.drawer.when'), value: formatDateTime(entry.createdAt) },
            {
              label: t('logs.drawer.sequence'),
              value: entry.chained ? (
                <span className="ob-mono">{entry.sequence}</span>
              ) : (
                <StatusPill tone="offline">{t('logs.chain.preChain')}</StatusPill>
              ),
            },
            {
              label: t('logs.drawer.entryId'),
              value: <span className="ob-mono">{entry.id}</span>,
            },
            // Shown in full, never abbreviated: this is the value somebody
            // re-checks by hand against an export when they distrust the
            // screen that computed the verdict.
            {
              label: t('logs.drawer.hash'),
              value: entry.hash ? (
                <span className="ob-mono" style={{ wordBreak: 'break-all' }}>
                  {entry.hash}
                </span>
              ) : (
                <span style={{ color: 'var(--fg-tertiary)' }}>{t('logs.chain.preChainHint')}</span>
              ),
            },
          ]}
        />

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('logs.drawer.details')}</div>
          {Object.keys(entry.details).length === 0 ? (
            <p className="ob-small" style={{ margin: 0 }}>
              {t('logs.drawer.noDetails')}
            </p>
          ) : (
            <pre
              className="ob-data"
              style={{
                margin: 0,
                padding: 'var(--s-12)',
                background: 'var(--bg-sunken)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-md)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          )}
        </section>
      </div>
    );
  }

  const columns: DataTableColumn<ActivityLogEntry>[] = [
    {
      key: 'when',
      header: t('logs.table.when'),
      width: rem(160),
      render: (entry) => <span className="ob-small">{formatDateTime(entry.createdAt)}</span>,
    },
    {
      key: 'what',
      header: t('logs.table.what'),
      render: (entry) => {
        const sentence = describe(entry);
        return (
          <span
            title={sentence}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sentence}
          </span>
        );
      },
    },
    {
      key: 'who',
      header: t('logs.table.who'),
      width: rem(150),
      render: (entry) => {
        const who = actorLabel(entry);
        return (
          <span
            title={who}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {who}
          </span>
        );
      },
    },
    {
      key: 'record',
      header: t('logs.table.record'),
      priority: 2,
      width: rem(210),
      render: (entry) => (
        <span
          className="ob-mono"
          title={`${entry.entityType} ${entry.entityId}`}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--fg-secondary)',
          }}
        >
          {entry.entityType} {entry.entityId}
        </span>
      ),
    },
    {
      key: 'sequence',
      header: t('logs.table.sequence'),
      priority: 3,
      width: rem(110),
      align: 'right',
      render: (entry) =>
        entry.chained ? (
          <span className="ob-mono">{entry.sequence}</span>
        ) : (
          <span title={t('logs.chain.preChainHint')}>
            <StatusPill tone="offline">{t('logs.chain.preChain')}</StatusPill>
          </span>
        ),
    },
  ];

  const entries = page?.items ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Section
        title={t('logs.section.title')}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            {canVerify && (
              <Button
                variant="secondary"
                size="sm"
                busy={verifying}
                onClick={() => void runVerify()}
              >
                {t('logs.action.verify')}
              </Button>
            )}
            {canExport && (
              <ButtonLink href={api.logsExportUrl(query)} variant="secondary" size="sm">
                {t('logs.action.export')}
              </ButtonLink>
            )}
          </div>
        }
      >
        <p className="ob-small" style={{ margin: 0 }}>
          {t('logs.section.description')}
        </p>

        {loading ? (
          <SkeletonTable columns={columns} />
        ) : error ? (
          <ErrorState
            title={t('logs.error.title')}
            description={error}
            actionLabel={t('logs.error.retry')}
            onAction={() => setReloadNonce((value) => value + 1)}
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={entries}
              rowKey={(entry) => entry.id}
              onRowOpen={setOpenEntry}
              openOn="click"
              selectedId={openEntry?.id}
              empty={
                <EmptyState
                  title={filtered ? t('logs.emptyFiltered.title') : t('logs.empty.title')}
                  description={
                    filtered ? t('logs.emptyFiltered.description') : t('logs.empty.description')
                  }
                />
              }
            />
            <NewerOlderPager
              hasNewer={Boolean(page?.prevCursor)}
              hasOlder={Boolean(page?.nextCursor)}
              onNewer={() => {
                if (page?.prevCursor) setCursor({ value: page.prevCursor, direction: 'newer' });
              }}
              onOlder={() => {
                if (page?.nextCursor) setCursor({ value: page.nextCursor, direction: 'older' });
              }}
            />
          </>
        )}
      </Section>

      <Modal
        open={openEntry !== null}
        onClose={() => setOpenEntry(null)}
        size="lg"
        title={openEntry ? describe(openEntry) : ''}
        subtitle={openEntry ? formatDateTime(openEntry.createdAt) : undefined}
        footer={
          <Button variant="primary" onClick={() => setOpenEntry(null)}>
            {t('action.done')}
          </Button>
        }
      >
        {openEntry && renderEntryDetail(openEntry)}
      </Modal>

      <Modal
        open={verifyOpen}
        onClose={closeVerify}
        title={t('logs.verify.title')}
        footer={
          <Button variant="secondary" onClick={closeVerify}>
            {t('logs.verify.close')}
          </Button>
        }
      >
        {verifying ? (
          <p className="ob-small" style={{ margin: 0 }}>
            {t('logs.verify.running')}
          </p>
        ) : verifyError ? (
          <ConflictBanner>{verifyError}</ConflictBanner>
        ) : verification ? (
          <VerificationVerdict result={verification} />
        ) : null}
      </Modal>
    </div>
  );
}

/**
 * A verdict is worth nothing without its scope, so the range, the count and
 * the pre-chain skips are shown next to it — "intact" over four entries is not
 * the same claim as "intact" over forty thousand. A break names where it is:
 * the sequence is the only handle anybody has on the entry that failed.
 */
function VerificationVerdict({ result }: { result: ChainVerification }) {
  if (result.fromSequence === null || result.toSequence === null) {
    return (
      <p className="ob-small" style={{ margin: 0 }}>
        {t('logs.verify.rangeEmpty')}
      </p>
    );
  }

  return (
    <>
      {result.ok ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <StatusPill tone="ok">{t('logs.verify.ok')}</StatusPill>
        </div>
      ) : (
        <ConflictBanner>
          {t('logs.verify.broken', { sequence: result.firstBreak?.sequence ?? '—' })}
        </ConflictBanner>
      )}

      <KeyValueList
        items={[
          {
            label: t('logs.verify.range'),
            value: (
              <span className="ob-mono">
                {t('logs.verify.rangeValue', { from: result.fromSequence, to: result.toSequence })}
              </span>
            ),
          },
          {
            label: t('logs.verify.checked'),
            value: <span className="ob-data">{result.checkedCount}</span>,
          },
          {
            label: t('logs.verify.skipped'),
            value: <span className="ob-data">{result.skippedPreChainCount}</span>,
          },
          ...(result.firstBreak
            ? [
                {
                  label: t('logs.verify.breakAt'),
                  value: (
                    <span>
                      {t(`logs.verify.break.${result.firstBreak.kind}`)}{' '}
                      <span className="ob-small" style={{ color: 'var(--fg-secondary)' }}>
                        {t('logs.verify.breakDetail', {
                          id: result.firstBreak.id,
                          when: formatDateTime(result.firstBreak.createdAt),
                        })}
                      </span>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      {result.truncated && (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-secondary)' }}>
          {t('logs.verify.truncated')}
        </p>
      )}
    </>
  );
}
