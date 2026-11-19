import type { AppleEntitlementGrant } from '../types.js';

export type StripeGrant = Omit<AppleEntitlementGrant, 'source' | 'environment'> & { source: 'stripe'; environment: 'test' | 'live' };
export type PurchaseAccessProposal = Readonly<{
  kind: 'proposal'; rule: 'either_channel_active'; selecting: false;
  grants: readonly (AppleEntitlementGrant | StripeGrant)[]; active: readonly string[];
  channels: Readonly<{ apple: boolean; stripe: boolean }>; dualChannel: boolean;
}>;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Unregistered proposal for Platform's projection. Owner rule (Nov 17): access is granted if either channel is
 * active. It is non-selecting: neither channel's grant replaces the other's, and dual-channel activity is reported,
 * not resolved. Output is independent of input order (code-point ordering by source, then grant ID).
 */
export function proposePurchaseAccessMerge(apple: Readonly<{ grants: readonly AppleEntitlementGrant[] }>,
  stripe: Readonly<{ grants: readonly StripeGrant[] }>): PurchaseAccessProposal {
  const grants = [...apple.grants, ...stripe.grants].sort((a, b) => order(a.source, b.source) || order(a.id, b.id));
  const channels = Object.freeze({ apple: apple.grants.some(g => g.active), stripe: stripe.grants.some(g => g.active) });
  return Object.freeze({ kind: 'proposal', rule: 'either_channel_active', selecting: false, grants: Object.freeze(grants),
    active: Object.freeze([...new Set(grants.filter(g => g.active).map(g => g.entitlement))].sort(order)),
    channels, dualChannel: channels.apple && channels.stripe });
}
