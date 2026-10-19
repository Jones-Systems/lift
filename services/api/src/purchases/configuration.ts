import type { AppleProduct, AppleSandboxConfiguration, AppleDeliveryRequest } from './types.js';

export const accountUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const appleTransactionId = /^[0-9]{1,64}$/;
const productId = /^[A-Za-z0-9_.-]{1,200}$/;
const types = new Set(['Auto-Renewable Subscription', 'Non-Consumable', 'Non-Renewing Subscription']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateAppleConfiguration(value: unknown): Readonly<Required<AppleSandboxConfiguration>> {
  if (!record(value) || Object.keys(value).some(k => !['bundleId', 'products', 'environment'].includes(k))
    || typeof value.bundleId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId)
    || value.bundleId.length > 255 || (value.environment !== undefined && value.environment !== 'Sandbox')
    || !Array.isArray(value.products) || value.products.length < 1 || value.products.length > 100)
    throw new Error('Apple purchases require an explicit bundle, product allowlist and Sandbox environment');
  const products: AppleProduct[] = [];
  const ids = new Set<string>();
  for (const item of value.products) {
    if (!record(item) || Object.keys(item).some(k => !['productId', 'type', 'entitlement'].includes(k))
      || typeof item.productId !== 'string' || !productId.test(item.productId) || ids.has(item.productId)
      || typeof item.type !== 'string' || !types.has(item.type) || item.entitlement !== 'form_plus')
      throw new Error('Invalid Apple product allowlist');
    ids.add(item.productId);
    products.push(Object.freeze({ productId: item.productId, type: item.type as AppleProduct['type'], entitlement: item.entitlement }));
  }
  return Object.freeze({ bundleId: value.bundleId, products: Object.freeze(products), environment: 'Sandbox' });
}

export function parseAppleDeliveryRequest(value: unknown): AppleDeliveryRequest | null {
  if (!record(value) || Object.keys(value).length !== 4
    || Object.keys(value).some(k => !['transactionId', 'productId', 'jwsRepresentation', 'idempotencyKey'].includes(k))
    || typeof value.transactionId !== 'string' || !appleTransactionId.test(value.transactionId)
    || typeof value.productId !== 'string' || !productId.test(value.productId)
    || typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.idempotencyKey)
    || typeof value.jwsRepresentation !== 'string' || value.jwsRepresentation.length > 60_000
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.jwsRepresentation)) return null;
  return { transactionId: value.transactionId, productId: value.productId,
    jwsRepresentation: value.jwsRepresentation, idempotencyKey: value.idempotencyKey };
}
