import { createHash } from 'node:crypto';
import { accountUuid } from '../configuration.js';
import { stripeApiVersion, stripeCatalog, stripeConfiguration, type Plan, type StripeConfiguration } from './configuration.js';
export type StripeRequest = Readonly<{ method: 'GET' | 'POST'; path: string; apiVersion: string; apiKeyEnv: string;
  idempotencyKey?: string; form?: Readonly<Record<string, string>> }>;
export interface StripeHttpClient { request(request: StripeRequest): Promise<unknown> }
function key(accountId: string, operation: string, requestKey: string): string {
  if (!accountUuid.test(accountId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestKey)) throw new Error('stripe_request_invalid');
  return createHash('sha256').update(JSON.stringify(['stripe-web-v1', accountId, operation, requestKey])).digest('hex');
}
export function buildCheckoutRequest(config: StripeConfiguration, accountId: string, plan: Plan, requestKey: string): StripeRequest {
  const c = stripeConfiguration(config)!;
  if (!Object.hasOwn(stripeCatalog, plan)) throw new Error('stripe_plan_invalid');
  return Object.freeze({ method: 'POST', path: '/v1/checkout/sessions', apiVersion: stripeApiVersion, apiKeyEnv: c.apiKeyEnv,
    idempotencyKey: key(accountId, 'checkout', requestKey), form: Object.freeze({ mode: 'subscription', currency: 'usd',
      client_reference_id: accountId, 'subscription_data[metadata][form_account_id]': accountId,
      'line_items[0][price]': c.prices[plan], 'line_items[0][quantity]': '1', success_url: c.successUrl, cancel_url: c.cancelUrl }) });
}
export function buildPortalRequest(config: StripeConfiguration, accountId: string, customerId: string, requestKey: string): StripeRequest {
  const c = stripeConfiguration(config)!;
  if (!/^cus_[A-Za-z0-9]{1,200}$/.test(customerId)) throw new Error('stripe_customer_invalid');
  return Object.freeze({ method: 'POST', path: '/v1/billing_portal/sessions', apiVersion: stripeApiVersion, apiKeyEnv: c.apiKeyEnv,
    idempotencyKey: key(accountId, 'portal', requestKey), form: Object.freeze({ customer: customerId, return_url: c.returnUrl, configuration: c.portalConfiguration }) });
}
