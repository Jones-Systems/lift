import { z } from 'zod';

export function normalizePhone(value: string): string {
  const normalized = value.trim().replace(/[ ()-]/g, '');
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) throw new Error('Expected an international E.164 phone number');
  return normalized;
}

const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[a-fA-F0-9]{32}$`));
export const phoneConfiguration = z.object({
  allowCloudRequests: z.literal(true), accountSid: sid('AC'), serviceSid: sid('VA'),
  apiKeySid: sid('SK'), apiKeySecret: z.string().min(16).max(8192),
  allowedPhones: z.array(z.string().transform(normalizePhone)).min(1).max(20),
}).strict();
export type PhoneConfiguration = z.input<typeof phoneConfiguration>;
export type ProviderResult = { sid: string; status: 'pending' | 'approved' | 'canceled' | 'max_attempts_reached' | 'deleted' | 'failed' | 'expired'; phone: string };
export interface ManagedPhoneProvider {
  start(phone: string): Promise<ProviderResult>;
  check(phone: string, verificationSid: string, code: string): Promise<ProviderResult>;
}
export class ProviderRejected extends Error {}
export class ProviderUnknown extends Error {}

export class TwilioVerify implements ManagedPhoneProvider {
  private readonly config: z.output<typeof phoneConfiguration>;
  constructor(config: PhoneConfiguration, private readonly fetcher: typeof fetch = fetch) {
    this.config = phoneConfiguration.parse(config);
  }
  start(phone: string): Promise<ProviderResult> {
    return this.request('Verifications', new URLSearchParams({ To: normalizePhone(phone), Channel: 'sms' }), phone);
  }
  check(phone: string, verificationSid: string, code: string): Promise<ProviderResult> {
    sid('VE').parse(verificationSid);
    if (!/^[0-9]{4,10}$/.test(code)) throw new ProviderRejected('invalid_code');
    return this.request('VerificationCheck', new URLSearchParams({ VerificationSid: verificationSid, Code: code }), phone, verificationSid);
  }
  private async request(resource: string, body: URLSearchParams, phone: string, expectedSid?: string): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(`https://verify.twilio.com/v2/Services/${this.config.serviceSid}/${resource}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.apiKeySid}:${this.config.apiKeySecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Only documented request rejection classes are safe to classify as no approval.
        if ([400, 401, 403, 404, 429].includes(response.status)) throw new ProviderRejected('provider_rejected');
        throw new ProviderUnknown('provider_outcome_unknown');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderUnknown('provider_outcome_unknown');
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 16_384) throw new ProviderUnknown('provider_outcome_unknown');
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const result = z.object({ sid: sid('VE'), service_sid: sid('VA'), account_sid: sid('AC'), to: z.string(),
        status: z.enum(['pending', 'approved', 'canceled', 'max_attempts_reached', 'deleted', 'failed', 'expired']) })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (result.service_sid !== this.config.serviceSid || result.account_sid !== this.config.accountSid ||
          result.to !== normalizePhone(phone) || (expectedSid && result.sid !== expectedSid))
        throw new ProviderUnknown('provider_identity_mismatch');
      return { sid: result.sid, phone: result.to, status: result.status };
    } catch (error) {
      if (error instanceof ProviderRejected || error instanceof ProviderUnknown) throw error;
      throw new ProviderUnknown('provider_outcome_unknown');
    } finally { clearTimeout(timeout); }
  }
}
