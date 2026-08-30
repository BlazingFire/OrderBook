/**
 * The Master's Documents screen.
 *
 * The screen itself lives in `@orderbook/ui` so an Office panel mounts the very
 * same one — this is the adapter that tells it how the Master fetches.
 * Everything below is a direct call to the Master's own HTTP API.
 */

import { ApiError, api } from '../api';
import { DocumentsScreen as SharedDocumentsScreen, type DocumentsTransport } from '@orderbook/ui';

const transport: DocumentsTransport = {
  templates: (options) => api.documentTemplates(options),
  createTemplate: (input) => api.createDocumentTemplate(input),
  updateTemplate: (id, input) => api.updateDocumentTemplate(id, input),
  deleteTemplate: (id, expectedVersion) => api.deleteDocumentTemplate(id, expectedVersion),
  preview: (input) => api.previewDocument(input as never),
  exports: (options) => api.documentExports(options),
  exportUrl: (id) => api.documentExportUrl(id as never),
  customFields: () => api.customFields(),

  /**
   * Leads and orders, read separately because a caller may hold one view key
   * and not the other. Both refused is a refusal — which the screen turns into
   * "these could not be read" rather than "this company has none". One refused
   * is simply a shorter list.
   */
  subjects: async () => {
    const [orders, leads] = await Promise.all([
      api.orders().catch(() => null),
      api.leads().catch(() => null),
    ]);

    if (!orders && !leads) throw new Error('neither leads nor orders are readable');

    return [
      ...(orders?.items ?? []).map((order) => ({
        kind: 'order' as const,
        id: order.id,
        label: `${order.id} · ${order.partyName}`,
      })),
      ...(leads?.items ?? []).map((lead) => ({
        kind: 'lead' as const,
        id: lead.id,
        label: `${lead.id} · ${lead.partyName}`,
      })),
    ];
  },

  conflictOf: (error) =>
    error instanceof ApiError && error.isConflict && error.storedVersion !== undefined
      ? { message: error.message, storedVersion: error.storedVersion, diff: error.diff }
      : null,
};

export function DocumentsScreen({
  revision,
  permissions,
}: {
  revision: number;
  permissions: string[];
}) {
  return (
    <SharedDocumentsScreen revision={revision} permissions={permissions} transport={transport} />
  );
}
