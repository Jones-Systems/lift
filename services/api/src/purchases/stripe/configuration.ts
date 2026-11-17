export const stripeApiVersion = '2025-02-24.acacia';
export const stripeCatalog = Object.freeze({
  weekly: Object.freeze({ productId: 'form.plus.week', amount: 700, interval: 'week' }),
  monthly: Object.freeze({ productId: 'form.plus.month', amount: 2000, interval: 'month' }),
  yearly: Object.freeze({ productId: 'form.plus.year', amount: 15000, interval: 'year' }),
});
export type Plan = keyof typeof stripeCatalog;
export type StripeConfiguration = Readonly<{
  enabled: true; livemode: boolean; prices: Readonly<Record<Plan, string>>;
  apiKeyEnv: string; webhookSecretEnvs: readonly string[];
  successUrl: string; cancelUrl: string; returnUrl: string; portalConfiguration: string;
}>;
export function stripeConfiguration(value?: StripeConfiguration): StripeConfiguration | null {
  if (value === undefined) return null;
  const env = /^[A-Z][A-Z0-9_]{0,127}$/;
  if (Object.keys(value).sort().join(',') !== 'apiKeyEnv,cancelUrl,enabled,livemode,portalConfiguration,prices,returnUrl,successUrl,webhookSecretEnvs'
    || value.enabled !== true || typeof value.livemode !== 'boolean' || !env.test(value.apiKeyEnv)
    || !Array.isArray(value.webhookSecretEnvs) || value.webhookSecretEnvs.length < 1 || value.webhookSecretEnvs.length > 3
    || value.webhookSecretEnvs.some(k => !env.test(k)) || !/^bpc_[A-Za-z0-9]{1,200}$/.test(value.portalConfiguration)
    || Object.keys(value.prices).sort().join(',') !== 'monthly,weekly,yearly'
    || Object.values(value.prices).some(p => !/^price_[A-Za-z0-9]{1,200}$/.test(p))
    || new Set(Object.values(value.prices)).size !== 3) throw new Error('stripe_configuration_invalid');
  for (const text of [value.successUrl, value.cancelUrl, value.returnUrl]) {
    const url = new URL(text);
    if (text.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('stripe_url_invalid');
  }
  return Object.freeze({ ...value, prices: Object.freeze({ ...value.prices }), webhookSecretEnvs: Object.freeze([...value.webhookSecretEnvs]) });
}
