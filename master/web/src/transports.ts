/**
 * What the shared record views in `ui/` are allowed to reach on this panel.
 *
 * Plain references to the api client, in one module-level object each, so a
 * screen never builds a transport inline. (The views hold the object in a ref
 * regardless — see `ui/tests/no-transport-dep.test.ts` — but a stable one means
 * nothing downstream has to care.)
 */

import type {
  CatalogueTransport,
  LeadEntryTransport,
  LeadRecordTransport,
  OrderRecordTransport,
} from '@orderbook/ui';

import { api } from './api';
import { partyFormTransport } from './partyFormTransport';

export const leadRecordTransport: LeadRecordTransport = {
  addLeadRemark: (id, message) => api.addLeadRemark(id, message),
  setLeadStage: (id, stageId) => api.setLeadStage(id, stageId),
  convertLead: (id, input) => api.convertLead(id, input),
};

export const orderRecordTransport: OrderRecordTransport = {
  updateOrder: (id, input) => api.updateOrder(id, input),
  setOrderStage: (id, stageId) => api.setOrderStage(id, stageId),
  dispatchOrder: (id, note) => api.dispatchOrder(id, note),
};

export const leadEntryTransport: LeadEntryTransport = {
  ...partyFormTransport,
  pick: (kind, query) => api.pick(kind, query),
  createLead: (input) => api.createLead(input),
  updateLead: (id, input) => api.updateLead(id, input),
};

export const catalogueTransport: CatalogueTransport = {
  listProducts: (query, signal) => api.listProducts(query, signal),
  categories: (query) => api.categories(query),
  createCategory: (input) => api.createCategory(input),
  updateCategory: (id, input) => api.updateCategory(id, input),
  deleteCategory: (id) => api.deleteCategory(id),
  createProduct: (input) => api.createProduct(input),
  updateProduct: (id, input) => api.updateProduct(id, input),
  uploadProductImage: (productId, file, crop) => api.uploadProductImage(productId, file, crop),
  updateProductImage: (productId, imageId, input) =>
    api.updateProductImage(productId, imageId, input),
  reorderProductImages: (productId, ids) => api.reorderProductImages(productId, ids),
  deleteProductImage: (productId, imageId) => api.deleteProductImage(productId, imageId),
  productImportTemplate: (format) => api.productImportTemplate(format),
  exportProducts: (format, level) => api.exportProducts(format, level),
  importProducts: (file, options) => api.importProducts(file, options),
};
