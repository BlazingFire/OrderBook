/**
 * Ready-made connectors, as data.
 *
 * The point of this file is that it is boring: a new system to integrate with
 * is an entry here (or a JSON paste at runtime, which is the same shape), never
 * a module with its own request code. Every profile below reaches the same
 * `runConnector`, so a bug fixed once is fixed for all of them.
 *
 * The base URLs are placeholders — the shop's own host and port go in when
 * somebody creates the connection. A profile is a shape, not an address.
 */

import type { ConnectorProfile } from '@orderbook/shared';

export const CONNECTOR_PROFILES: readonly ConnectorProfile[] = Object.freeze([
  {
    slug: 'hermes',
    label: 'Hermes',
    baseUrl: 'http://127.0.0.1:8080',
    authKind: 'header',
    authHeader: 'X-Api-Key',
    resources: [
      {
        entity: 'party',
        path: '/api/customers',
        method: 'GET',
        itemsPointer: '/data',
        remoteIdPointer: '/id',
        updatedAtPointer: '/modified_at',
        pageParam: 'page',
        pageSizeParam: 'per_page',
        pageSize: 100,
        fieldMaps: [
          { localField: 'name', remotePointer: '/name', transform: 'trim', isRequired: true },
          { localField: 'phone', remotePointer: '/mobile', transform: 'digits' },
          { localField: 'email', remotePointer: '/email', transform: 'lower' },
          { localField: 'city', remotePointer: '/address/city', transform: 'trim' },
          { localField: 'state', remotePointer: '/address/state', transform: 'trim' },
          { localField: 'pincode', remotePointer: '/address/pin', transform: 'digits' },
          { localField: 'gstNumber', remotePointer: '/gstin', transform: 'upper' },
        ],
      },
      {
        entity: 'product',
        path: '/api/items',
        method: 'GET',
        itemsPointer: '/data',
        remoteIdPointer: '/id',
        updatedAtPointer: '/modified_at',
        pageParam: 'page',
        pageSizeParam: 'per_page',
        pageSize: 100,
        fieldMaps: [
          // `code` and `weightKg` are lifted onto the product's own variant by
          // the run service; a remote item is one code, so it lands as a
          // single-variant product.
          { localField: 'code', remotePointer: '/sku', transform: 'upper', isRequired: true },
          { localField: 'name', remotePointer: '/name', transform: 'trim', isRequired: true },
          {
            localField: 'categoryName',
            remotePointer: '/category',
            transform: 'trim',
            isRequired: true,
          },
          { localField: 'size', remotePointer: '/size', transform: 'trim' },
          { localField: 'weightKg', remotePointer: '/weight' },
          // The remote quotes rupees; this product stores paise. Getting that
          // wrong is a hundredfold price error, so it is a named transform.
          { localField: 'rate', remotePointer: '/price', transform: 'rupees_to_paise' },
          { localField: 'hsnCode', remotePointer: '/hsn', transform: 'digits' },
        ],
      },
    ],
  },
]);
