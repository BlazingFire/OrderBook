/**
 * An Office panel's Documents screen.
 *
 * The screen lives in `@orderbook/ui`; this is the adapter that tells it how a
 * panel fetches. Every document call is proxied to the Master over the panel's
 * socket, which is why this screen is **online only** — a template saved into
 * an outbox would queue behind work the Master has not seen, and a render that
 * queued would produce a document dated whenever the link came back.
 *
 * Two reads do not go to the Master at all. Custom field definitions and the
 * preview's candidate records are already in the snapshot this panel holds, so
 * asking for them again would be a round trip for something on the shelf.
 */

import { useMemo, useRef } from 'react';
import type { CustomFieldDefinition } from '@orderbook/shared';

import { ApiError, api, type LocalView } from '../api';
import { DocumentsScreen as SharedDocumentsScreen, type DocumentsTransport } from '@orderbook/ui';

interface Props {
  revision: number;
  permissions: string[];
  /** The merged snapshot, or null before the first one has arrived. */
  view: LocalView | null;
}

export function DocumentsScreen({ revision, permissions, view }: Props) {
  /*
   * The snapshot behind a ref, so the transport is built once.
   *
   * Rebuilding it whenever the view changes would give the shared screen a new
   * transport identity on every sync, and its loaders depend on that identity —
   * so a panel that syncs every few seconds would refetch its template list
   * every few seconds. The ref keeps the reads current without the churn.
   */
  const viewRef = useRef(view);
  viewRef.current = view;

  const transport: DocumentsTransport = useMemo(
    () => ({
      templates: (options) => api.documentTemplates(options ?? {}),
      createTemplate: (input) => api.createDocumentTemplate(input),
      updateTemplate: (id, input) => api.updateDocumentTemplate(id, input),
      deleteTemplate: (id, expectedVersion) => api.deleteDocumentTemplate(id, expectedVersion),
      preview: (input) => api.previewDocument(input as never),
      exports: (options) => api.documentExports(options ?? {}),
      exportUrl: (id) => api.documentExportUrl(String(id)),

      // Off the snapshot, not the wire.
      customFields: async () =>
        (viewRef.current as { customFields?: CustomFieldDefinition[] } | null)?.customFields ?? [],

      subjects: async () => {
        const current = viewRef.current;
        if (!current) throw new Error('no snapshot yet');

        return [
          ...(current.orders ?? []).map((order) => ({
            kind: 'order' as const,
            id: order.id,
            label: `${order.id} · ${order.partyName}`,
          })),
          ...(current.leads ?? []).map((lead) => ({
            kind: 'lead' as const,
            id: lead.id,
            label: `${lead.id} · ${lead.partyName}`,
          })),
        ];
      },

      /*
       * This panel's `ApiError` carries `isConflict` but reads the rest off
       * `details`, where the server put them — the Master's client happens to
       * expose two getters for the same values, and the shared screen must not
       * depend on either shape.
       */
      conflictOf: (error) => {
        if (!(error instanceof ApiError) || !error.isConflict) return null;

        const storedVersion = error.details.storedVersion;
        if (typeof storedVersion !== 'number') return null;

        return {
          message: error.message,
          storedVersion,
          diff: (error.details.diff ?? {}) as Record<
            string,
            { stored: unknown; incoming: unknown }
          >,
        };
      },
    }),
    [],
  );

  return (
    <SharedDocumentsScreen revision={revision} permissions={permissions} transport={transport} />
  );
}
