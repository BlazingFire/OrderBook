/**
 * Keys and connections, on one screen with two tabs.
 *
 * The two halves are the two directions of requirement 13: a key lets another
 * program on the shop LAN read and correct this company's data, and a
 * connection copies another system's catalogue into it. Both are things one
 * person sets up once and then wants to be able to see at a glance, which is
 * why they share a screen rather than each having a sidebar entry.
 *
 * A freshly issued token is shown once, in the same one-time dialog a reset
 * password uses, because it is the same rule: this product never stores a
 * credential it can hand back, and "recovery is a reset".
 *
 * The field-map editor is a large editor and takes the content area with its
 * own sub-nav entry, exactly as the role editor does — twenty rows of
 * `local field ← remote pointer` is not a modal.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  ApiKey,
  Connector,
  ConnectorEntity,
  ConnectorFieldMapInput,
  ConnectorResourceInput,
  ConnectorRun,
  ConnectorTestResult,
} from '@orderbook/shared';
import { CONNECTOR_FLAGGABLE_FIELDS, CONNECTOR_TRANSFORMS, PERMISSIONS } from '@orderbook/shared';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  FieldGrid,
  FieldGroup,
  Input,
  Modal,
  Segmented,
  Select,
  capabilityLabel,
  copyText,
  t,
  useSubNav,
  useFormBaseline,
  useGuardedBack,
  useToast,
  useTopbarActions,
  PasswordInput,
  useUnsavedWork,
  SaveTextButton,
} from '@orderbook/ui';

import { api } from '../api';

export type Tab = 'keys' | 'connectors';

export function IntegrationsScreen({
  canManage,
  tab,
  onTabChange,
}: {
  canManage: boolean;
  /** Which tab is showing — chosen here or from the sidebar's sub-pages. */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ key: ApiKey; token: string } | null>(null);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [mapping, setMapping] = useState<Connector | null>(null);
  const toast = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextKeys, nextConnectors] = await Promise.all([api.apiKeys(), api.connectors()]);
      setKeys(nextKeys);
      setConnectors(nextConnectors);
    } catch (error) {
      toast.push(error instanceof Error ? error.message : t('integrations.loadFailed'), {
        tone: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useTopbarActions(
    mapping ? null : (
      <Segmented
        options={[
          { value: 'keys' as const, label: t('integrations.tab.keys') },
          { value: 'connectors' as const, label: t('integrations.tab.connectors') },
        ]}
        value={tab}
        onChange={onTabChange}
      />
    ),
  );

  useSubNav(
    'integrations',
    mapping
      ? {
          parentId: 'integrations',
          items: [
            {
              id: 'integrations.mapping',
              label: t('integrations.mapping.title', { name: mapping.label }),
              icon: 'filter',
            },
          ],
          activeId: 'integrations.mapping',
        }
      : null,
  );

  if (mapping) {
    return (
      <MappingEditor
        connector={mapping}
        onClose={() => setMapping(null)}
        onSaved={(next) => {
          setMapping(next);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="ob-pane">
      {issued && <IssuedTokenDialog issued={issued} onClose={() => setIssued(null)} />}

      {issuing && (
        <IssueKeyDialog
          onClose={() => setIssuing(false)}
          onIssued={(result) => {
            setIssuing(false);
            setIssued(result);
            void reload();
          }}
        />
      )}

      {editing && (
        <ConnectorDialog
          connector={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {tab === 'keys' ? (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            <div className="ob-eyebrow" style={{ flex: 1 }}>
              {t('integrations.keys.title')}
            </div>
            {canManage && (
              <Button variant="primary" onClick={() => setIssuing(true)}>
                {t('integrations.keys.issue')}
              </Button>
            )}
          </div>
          <p className="ob-small">{t('integrations.keys.help')}</p>

          {!loading && keys.length === 0 ? (
            <EmptyState title={t('integrations.keys.empty')} />
          ) : (
            <DataTable
              rows={keys}
              rowKey={(key) => key.id}
              columns={[
                { key: 'label', header: t('integrations.keys.label'), render: (key) => key.label },
                {
                  key: 'prefix',
                  header: t('integrations.keys.prefix'),
                  render: (key) => <span className="ob-mono">{key.tokenPrefix}</span>,
                },
                {
                  key: 'owner',
                  header: t('integrations.keys.owner'),
                  render: (key) => key.ownerName ?? '—',
                },
                {
                  key: 'scopes',
                  header: t('integrations.keys.scopes'),
                  render: (key) => String(key.scopes.length),
                },
                {
                  key: 'state',
                  header: t('integrations.keys.state'),
                  render: (key) =>
                    key.revokedAt
                      ? t('integrations.keys.revoked')
                      : key.lastUsedAt
                        ? t('integrations.keys.lastUsed', {
                            when: new Date(key.lastUsedAt).toLocaleString(),
                          })
                        : t('integrations.keys.unused'),
                },
                {
                  key: 'actions',
                  header: '',
                  render: (key) =>
                    canManage && !key.revokedAt ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void api
                            .revokeApiKey(key.id)
                            .then(() => reload())
                            .catch((error: unknown) =>
                              toast.push(
                                error instanceof Error
                                  ? error.message
                                  : t('integrations.loadFailed'),
                                { tone: 'error' },
                              ),
                            );
                        }}
                      >
                        {t('integrations.keys.revoke')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <ConnectorsTab
          connectors={connectors}
          loading={loading}
          canManage={canManage}
          onNew={() => setEditing({ id: '' } as Connector)}
          onEdit={setEditing}
          onMap={setMapping}
          onChanged={reload}
        />
      )}
    </div>
  );
}

// --- Keys ------------------------------------------------------------------

function IssueKeyDialog({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (issued: { key: ApiKey; token: string }) => void;
}) {
  const [label, setLabel] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // "Save all and update": named, never saved. An API key ends in a token that is
  // shown once, to somebody watching; issuing one behind an update's back would
  // lose it.
  useUnsavedWork(
    'new-api-key',
    label.trim() ? { label: t('updates.saveAll.apiKey', { name: label.trim() }) } : null,
  );

  useEffect(() => {
    void api
      .users()
      .then((list) =>
        setUsers(list.map((user) => ({ id: user.id, displayName: user.displayName }))),
      )
      .catch(() => setUsers([]));
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      onIssued(await api.issueApiKey({ label, ownerUserId, scopes }));
    } catch (error) {
      toast.push(error instanceof Error ? error.message : t('integrations.loadFailed'), {
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('integrations.keys.issue')}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t('integrations.keys.issue')}
          </Button>
        </>
      }
    >
      <FieldGroup title={t('integrations.keys.title')}>
        <Field label={t('integrations.keys.label')} required span={2}>
          {(id) => (
            <Input
              id={id}
              value={label}
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('integrations.keys.owner')} required>
          {(id) => (
            <Select
              id={id}
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
            >
              <option value="">{t('integrations.keys.ownerChoose')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </FieldGroup>

      <FieldGroup title={t('integrations.keys.scopes')}>
        <Field label={t('integrations.keys.scopesHelp')} span={3}>
          {() => (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
                gap: 'var(--s-4)',
                maxHeight: '18rem',
                overflowY: 'auto',
              }}
            >
              {PERMISSIONS.map((permission) => (
                <label
                  key={permission}
                  className="ob-small"
                  style={{ display: 'flex', gap: 'var(--s-4)' }}
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(permission)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, permission]
                          : current.filter((scope) => scope !== permission),
                      )
                    }
                  />
                  {capabilityLabel(permission)}
                </label>
              ))}
            </div>
          )}
        </Field>
      </FieldGroup>
    </Modal>
  );
}

/**
 * The token, once.
 *
 * The same shape as a reset password's dialog, deliberately: a person who has
 * seen one recognises the other, and both are saying the identical thing —
 * write this down now, because nothing here can show it to you again.
 */
function IssuedTokenDialog({
  issued,
  onClose,
}: {
  issued: { key: ApiKey; token: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('integrations.keys.issuedTitle', { name: issued.key.label })}
      footer={
        <>
          <SaveTextButton
            title={t('saveText.title.apiToken', { name: issued.key.label })}
            slug="api-token"
            sections={[
              {
                values: [
                  { label: t('saveText.label.tokenName'), value: issued.key.label },
                  { label: t('saveText.label.token'), value: issued.token },
                ],
              },
            ]}
          />
          <Button variant="secondary" onClick={() => void copyText(issued.token).then(setCopied)}>
            {copied ? t('access.secret.copied') : t('access.secret.copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('access.secret.done')}
          </Button>
        </>
      }
    >
      <p className="ob-body">{t('integrations.keys.issuedHelp')}</p>
      <code
        className="ob-mono"
        style={{
          display: 'block',
          wordBreak: 'break-all',
          padding: 'var(--s-8) var(--s-12)',
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--r-md)',
        }}
      >
        {issued.token}
      </code>
    </Modal>
  );
}

// --- Connections -----------------------------------------------------------

function ConnectorsTab({
  connectors,
  loading,
  canManage,
  onNew,
  onEdit,
  onMap,
  onChanged,
}: {
  connectors: Connector[];
  loading: boolean;
  canManage: boolean;
  onNew: () => void;
  onEdit: (connector: Connector) => void;
  onMap: (connector: Connector) => void;
  onChanged: () => Promise<void>;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConnectorRun[] | null>(null);
  const toast = useToast();

  async function run(connector: Connector, mode: 'dry_run' | 'import'): Promise<void> {
    setRunning(connector.id);
    try {
      const result = await api.runConnector(connector.id, mode);
      toast.push(
        t('integrations.connectors.ranSummary', {
          created: result.created,
          updated: result.updated,
          failed: result.failed,
        }),
        { tone: result.failed > 0 ? 'error' : 'ok' },
      );
      setRuns(await api.connectorRuns(connector.id));
      await onChanged();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : t('integrations.loadFailed'), {
        tone: 'error',
      });
    } finally {
      setRunning(null);
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
        <div className="ob-eyebrow" style={{ flex: 1 }}>
          {t('integrations.connectors.title')}
        </div>
        {canManage && (
          <Button variant="primary" onClick={onNew}>
            {t('integrations.connectors.new')}
          </Button>
        )}
      </div>
      <p className="ob-small">{t('integrations.connectors.help')}</p>

      {!loading && connectors.length === 0 ? (
        <EmptyState title={t('integrations.connectors.empty')} />
      ) : (
        <DataTable
          rows={connectors}
          rowKey={(connector) => connector.id}
          columns={[
            {
              key: 'label',
              header: t('integrations.connectors.label'),
              render: (connector) => connector.label,
            },
            {
              key: 'baseUrl',
              header: t('integrations.connectors.baseUrl'),
              render: (connector) => <span className="ob-mono">{connector.baseUrl}</span>,
            },
            {
              key: 'schedule',
              header: t('integrations.connectors.schedule'),
              render: (connector) =>
                connector.scheduleKind === 'periodic'
                  ? t('integrations.connectors.everyMinutes', {
                      minutes: connector.intervalMin ?? 0,
                    })
                  : t(`integrations.connectors.schedule.${connector.scheduleKind}`),
            },
            {
              key: 'status',
              header: t('integrations.connectors.lastRun'),
              render: (connector) =>
                connector.lastRunAt
                  ? `${new Date(connector.lastRunAt).toLocaleString()} · ${connector.lastStatus ?? ''}`
                  : t('integrations.connectors.never'),
            },
            {
              key: 'actions',
              header: '',
              render: (connector) =>
                canManage ? (
                  <div style={{ display: 'flex', gap: 'var(--s-4)' }}>
                    <Button variant="secondary" onClick={() => onMap(connector)}>
                      {t('integrations.connectors.mapping')}
                    </Button>
                    <Button
                      variant="secondary"
                      busy={running === connector.id}
                      onClick={() => void run(connector, 'dry_run')}
                    >
                      {t('integrations.connectors.dryRun')}
                    </Button>
                    <Button
                      variant="secondary"
                      busy={running === connector.id}
                      onClick={() => void run(connector, 'import')}
                    >
                      {t('integrations.connectors.import')}
                    </Button>
                    <Button variant="secondary" onClick={() => onEdit(connector)}>
                      {t('common.edit')}
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      )}

      {runs && runs.length > 0 && (
        <div style={{ marginTop: 'var(--s-12)' }}>
          <div className="ob-eyebrow">{t('integrations.connectors.runs')}</div>
          <DataTable
            rows={runs}
            rowKey={(run_) => String(run_.id)}
            columns={[
              {
                key: 'when',
                header: t('integrations.connectors.runStarted'),
                render: (run_) => new Date(run_.startedAt).toLocaleString(),
              },
              {
                key: 'mode',
                header: t('integrations.connectors.runMode'),
                render: (run_) => run_.mode,
              },
              {
                key: 'status',
                header: t('integrations.connectors.runStatus'),
                render: (run_) => run_.status,
              },
              {
                key: 'counts',
                header: t('integrations.connectors.runCounts'),
                render: (run_) =>
                  t('integrations.connectors.ranSummary', {
                    created: run_.created,
                    updated: run_.updated,
                    failed: run_.failed,
                  }),
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function ConnectorDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: Connector | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = {
    slug: connector?.slug ?? '',
    label: connector?.label ?? '',
    baseUrl: connector?.baseUrl ?? '',
    authKind: connector?.authKind ?? ('none' as Connector['authKind']),
    authHeader: connector?.authHeader ?? '',
    authUsername: connector?.authUsername ?? '',
    credential: '',
    scheduleKind: connector?.scheduleKind ?? ('manual' as Connector['scheduleKind']),
    intervalMin: String(connector?.intervalMin ?? 15),
    runAsUserId: connector?.runAsUserId ?? '',
    isEnabled: connector?.isEnabled ?? false,
  };
  const [draft, setDraft] = useState(initial);
  const baseline = useFormBaseline(initial);
  const [users, setUsers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void api
      .users()
      .then((list) =>
        setUsers(list.map((user) => ({ id: user.id, displayName: user.displayName }))),
      )
      .catch(() => setUsers([]));
  }, []);

  const set = (field: keyof typeof draft, value: string | boolean): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  /** True when the connector was saved; a failure is shown as a toast and answers false. */
  async function save(): Promise<boolean> {
    setBusy(true);
    try {
      const input = {
        slug: draft.slug.trim(),
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        authKind: draft.authKind,
        authHeader: draft.authHeader || null,
        authUsername: draft.authUsername || null,
        scheduleKind: draft.scheduleKind,
        intervalMin: Number(draft.intervalMin) || null,
        runAsUserId: draft.runAsUserId || null,
        isEnabled: draft.isEnabled,
        // Absent leaves whatever is stored. Sending an empty string every time
        // would wipe the credential on every rename.
        ...(draft.credential ? { credential: draft.credential } : {}),
      };

      if (connector) await api.updateConnector(connector.id, input);
      else await api.createConnector(input);

      onSaved();
      return true;
    } catch (error) {
      toast.push(error instanceof Error ? error.message : t('integrations.loadFailed'), {
        tone: 'error',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a connector being added or changed is saved when it
  // has a name and an address, and named when it has not.
  useUnsavedWork(
    'connector',
    baseline.dirty(draft)
      ? {
          label: t('updates.saveAll.connector', { name: draft.label.trim() || draft.slug.trim() || '…' }),
          save: async () => (draft.label.trim() && draft.slug.trim() && draft.baseUrl.trim() ? save() : false),
        }
      : null,
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={connector ? t('integrations.connectors.edit') : t('integrations.connectors.new')}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FieldGrid>
        <FieldGroup title={t('integrations.connectors.title')}>
          <Field label={t('integrations.connectors.label')} required>
            {(id) => (
              <Input id={id} value={draft.label} onChange={(e) => set('label', e.target.value)} />
            )}
          </Field>
          <Field label={t('integrations.connectors.slug')} required>
            {(id) => (
              <Input id={id} value={draft.slug} onChange={(e) => set('slug', e.target.value)} />
            )}
          </Field>
          <Field label={t('integrations.connectors.baseUrl')} required span={2}>
            {(id) => (
              <Input
                id={id}
                value={draft.baseUrl}
                onChange={(e) => set('baseUrl', e.target.value)}
              />
            )}
          </Field>
        </FieldGroup>

        <FieldGroup title={t('integrations.connectors.auth')}>
          <Field label={t('integrations.connectors.authKind')}>
            {(id) => (
              <Select
                id={id}
                value={draft.authKind}
                onChange={(e) => set('authKind', e.target.value)}
              >
                <option value="none">{t('integrations.connectors.auth.none')}</option>
                <option value="header">{t('integrations.connectors.auth.header')}</option>
                <option value="bearer">{t('integrations.connectors.auth.bearer')}</option>
                <option value="basic">{t('integrations.connectors.auth.basic')}</option>
              </Select>
            )}
          </Field>
          {draft.authKind === 'header' && (
            <Field label={t('integrations.connectors.authHeader')}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.authHeader}
                  onChange={(e) => set('authHeader', e.target.value)}
                />
              )}
            </Field>
          )}
          {draft.authKind === 'basic' && (
            <Field label={t('integrations.connectors.authUsername')}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.authUsername}
                  onChange={(e) => set('authUsername', e.target.value)}
                />
              )}
            </Field>
          )}
          {draft.authKind !== 'none' && (
            <Field
              label={t('integrations.connectors.credential')}
              hint={
                connector?.credentialConfigured
                  ? t('integrations.connectors.credentialStored')
                  : undefined
              }
            >
              {(id) => (
                <PasswordInput
                  id={id}
                  value={draft.credential}
                  onChange={(e) => set('credential', e.target.value)}
                />
              )}
            </Field>
          )}
        </FieldGroup>

        <FieldGroup title={t('integrations.connectors.running')}>
          <Field label={t('integrations.connectors.runAs')} required>
            {(id) => (
              <Select
                id={id}
                value={draft.runAsUserId}
                onChange={(e) => set('runAsUserId', e.target.value)}
              >
                <option value="">{t('integrations.keys.ownerChoose')}</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('integrations.connectors.schedule')}>
            {(id) => (
              <Select
                id={id}
                value={draft.scheduleKind}
                onChange={(e) => set('scheduleKind', e.target.value)}
              >
                <option value="manual">{t('integrations.connectors.schedule.manual')}</option>
                <option value="periodic">{t('integrations.connectors.schedule.periodic')}</option>
              </Select>
            )}
          </Field>
          {draft.scheduleKind === 'periodic' && (
            <Field label={t('integrations.connectors.intervalMin')}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.intervalMin}
                  inputMode="numeric"
                  onChange={(e) => set('intervalMin', e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label={t('integrations.connectors.enabled')}>
            {(id) => (
              <input
                id={id}
                type="checkbox"
                checked={draft.isEnabled}
                onChange={(e) => set('isEnabled', e.target.checked)}
              />
            )}
          </Field>
        </FieldGroup>
      </FieldGrid>
    </Modal>
  );
}

// --- The mapping editor ----------------------------------------------------

/** The local fields a connector may write, per entity. */
const LOCAL_FIELDS: Record<ConnectorEntity, string[]> = {
  party: [
    'name',
    'phone',
    'altPhone',
    'email',
    'addressLine1',
    'city',
    'state',
    'pincode',
    'gstNumber',
    'notes',
  ],
  product: ['code', 'name', 'categoryName', 'alias', 'size', 'weightKg', 'multiColour'],
};

/**
 * Twenty rows of `local field ← remote pointer`, with a picker fed by a real
 * response.
 *
 * "Test the connection" and "discover the schema" are one action here, because
 * they are one question: the test fetches a page and hands back the flattened
 * pointers of its first row, which is exactly the list this editor needs.
 */
function MappingEditor({
  connector,
  onClose,
  onSaved,
}: {
  connector: Connector;
  onClose: () => void;
  onSaved: (next: Connector) => void;
}) {
  const [entity, setEntity] = useState<ConnectorEntity>(
    connector.resources[0]?.entity ?? 'product',
  );
  const [resources, setResources] = useState<
    Array<ConnectorResourceInput & { fieldMaps: ConnectorFieldMapInput[] }>
  >(
    connector.resources.map((resource) => ({
      entity: resource.entity,
      path: resource.path,
      method: resource.method,
      itemsPointer: resource.itemsPointer,
      remoteIdPointer: resource.remoteIdPointer,
      updatedAtPointer: resource.updatedAtPointer,
      pageParam: resource.pageParam,
      pageSizeParam: resource.pageSizeParam,
      pageSize: resource.pageSize,
      fieldMaps: resource.fieldMaps.map((map) => ({
        localField: map.localField,
        remotePointer: map.remotePointer,
        transform: map.transform,
        onConflict: map.onConflict,
        isRequired: map.isRequired,
      })),
    })),
  );
  const [probe, setProbe] = useState<ConnectorTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const baseline = useFormBaseline(resources);

  const current = resources.find((resource) => resource.entity === entity);

  function updateCurrent(
    change: Partial<ConnectorResourceInput & { fieldMaps: ConnectorFieldMapInput[] }>,
  ): void {
    setResources((all) => {
      const existing = all.find((resource) => resource.entity === entity);
      if (!existing) {
        return [
          ...all,
          {
            entity,
            path: '',
            remoteIdPointer: '',
            itemsPointer: '',
            fieldMaps: [],
            ...change,
          },
        ];
      }
      return all.map((resource) =>
        resource.entity === entity ? { ...resource, ...change } : resource,
      );
    });
  }

  async function save(): Promise<boolean> {
    setBusy(true);
    try {
      onSaved(await api.setConnectorMapping(connector.id, resources));
      baseline.mark(resources);
      toast.push(t('integrations.mapping.saved'), { tone: 'ok' });
      return true;
    } catch (error) {
      toast.push(error instanceof Error ? error.message : t('integrations.loadFailed'), {
        tone: 'error',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a changed field mapping is saved if the Master accepts it.
  const dirty = baseline.dirty(resources);
  useUnsavedWork(
    'connector-mapping',
    dirty ? { label: t('updates.saveAll.mapping', { name: connector.label }), save } : null,
  );
  // Close (and Escape, which clicks it: R8) asks before a changed mapping is thrown away.
  const { back: close } = useGuardedBack(onClose, dirty);

  return (
    <div className="ob-pane">
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <div className="ob-eyebrow" style={{ flex: 1 }}>
            {t('integrations.mapping.title', { name: connector.label })}
          </div>
          <Segmented
            options={[
              { value: 'product' as const, label: t('integrations.mapping.products') },
              { value: 'party' as const, label: t('integrations.mapping.parties') },
            ]}
            value={entity}
            onChange={setEntity}
          />
          <Button
            variant="secondary"
            onClick={() => {
              void api
                .testConnector(connector.id, entity)
                .then(setProbe)
                .catch((error: unknown) =>
                  toast.push(
                    error instanceof Error ? error.message : t('integrations.loadFailed'),
                    { tone: 'error' },
                  ),
                );
            }}
          >
            {t('integrations.mapping.test')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
          <Button variant="secondary" data-esc-back onClick={close}>
            {t('common.close')}
          </Button>
        </div>

        <p className="ob-small">{t('integrations.mapping.help')}</p>

        {probe && (
          <p className="ob-small">
            {probe.ok
              ? t('integrations.mapping.probeOk', { count: probe.itemCount })
              : (probe.error ?? t('integrations.mapping.probeFailed'))}
          </p>
        )}

        <FieldGrid>
          <FieldGroup title={t('integrations.mapping.request')}>
            <Field label={t('integrations.mapping.path')} required>
              {(id) => (
                <Input
                  id={id}
                  value={current?.path ?? ''}
                  onChange={(event) => updateCurrent({ path: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('integrations.mapping.itemsPointer')}>
              {(id) => (
                <Input
                  id={id}
                  value={current?.itemsPointer ?? ''}
                  onChange={(event) => updateCurrent({ itemsPointer: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('integrations.mapping.remoteIdPointer')} required>
              {(id) => (
                <Input
                  id={id}
                  value={current?.remoteIdPointer ?? ''}
                  onChange={(event) => updateCurrent({ remoteIdPointer: event.target.value })}
                />
              )}
            </Field>
          </FieldGroup>
        </FieldGrid>

        <div className="ob-eyebrow" style={{ marginTop: 'var(--s-12)' }}>
          {t('integrations.mapping.fields')}
        </div>

        <table className="ob-table">
          <thead>
            <tr>
              <th>{t('integrations.mapping.localField')}</th>
              <th>{t('integrations.mapping.remotePointer')}</th>
              <th>{t('integrations.mapping.transform')}</th>
              <th>{t('integrations.mapping.onConflict')}</th>
              <th>{t('integrations.mapping.required')}</th>
            </tr>
          </thead>
          <tbody>
            {LOCAL_FIELDS[entity].map((localField) => {
              const map = current?.fieldMaps.find(
                (candidate) => candidate.localField === localField,
              );
              const flaggable = CONNECTOR_FLAGGABLE_FIELDS[entity].includes(localField);

              const change = (patch: Partial<ConnectorFieldMapInput>): void => {
                const others = (current?.fieldMaps ?? []).filter(
                  (candidate) => candidate.localField !== localField,
                );
                const next = { localField, remotePointer: '', ...map, ...patch };
                updateCurrent({
                  fieldMaps: next.remotePointer ? [...others, next] : others,
                });
              };

              return (
                <tr key={localField}>
                  <td>{localField}</td>
                  <td>
                    <Input
                      list="connector-pointers"
                      value={map?.remotePointer ?? ''}
                      onChange={(event) => change({ remotePointer: event.target.value })}
                    />
                  </td>
                  <td>
                    <Select
                      value={map?.transform ?? ''}
                      onChange={(event) =>
                        change({
                          transform: event.target.value
                            ? (event.target.value as ConnectorFieldMapInput['transform'])
                            : null,
                        })
                      }
                    >
                      <option value="">{t('integrations.mapping.transformNone')}</option>
                      {CONNECTOR_TRANSFORMS.map((transform) => (
                        <option key={transform} value={transform}>
                          {t(`integrations.mapping.transform.${transform}`)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      value={map?.onConflict ?? 'remote_wins'}
                      onChange={(event) =>
                        change({
                          onConflict: event.target.value as ConnectorFieldMapInput['onConflict'],
                        })
                      }
                    >
                      <option value="remote_wins">{t('integrations.mapping.remoteWins')}</option>
                      <option value="local_wins">{t('integrations.mapping.localWins')}</option>
                      {/* Only where the conflict restorer can put the old value
                          back — anywhere else this raises a row nobody can
                          resolve. */}
                      {flaggable && <option value="flag">{t('integrations.mapping.flag')}</option>}
                    </Select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={map?.isRequired ?? false}
                      onChange={(event) => change({ isRequired: event.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Fed by the connection test, so the picker offers what the remote
            actually returned rather than what somebody remembers. */}
        <datalist id="connector-pointers">
          {(probe?.samplePointers ?? []).map((pointer) => (
            <option key={pointer} value={pointer} />
          ))}
        </datalist>
      </Card>
    </div>
  );
}
