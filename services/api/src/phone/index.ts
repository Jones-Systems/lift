import { phoneNumber } from 'better-auth/plugins/phone-number';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { z } from 'zod';
import type { BetterAuthPlugin } from 'better-auth';
import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import { PhoneChallenges, phoneEmail } from './challenges.js';
import { phoneConfiguration, TwilioVerify, type PhoneConfiguration } from './provider.js';

export { phoneMigrationSql } from './migration.js';
export { isPhoneEmail } from './challenges.js';
export { normalizePhone, phoneConfiguration } from './provider.js';
export type { PhoneConfiguration } from './provider.js';

const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const binding = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const challengeRequest = z.object({ phoneNumber: phone, binding }).strict();
const boundRequest = challengeRequest.extend({ challengeId: z.uuid() }).strict();
const checkRequest = boundRequest.extend({ code: z.string().regex(/^[0-9]{4,10}$/) }).strict();
const errorStatuses = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'UNPROCESSABLE_ENTITY', 429: 'TOO_MANY_REQUESTS', 501: 'NOT_IMPLEMENTED' } as const;

async function publicError<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DomainError) throw new APIError(errorStatuses[error.status as keyof typeof errorStatuses] ?? 'INTERNAL_SERVER_ERROR',
      { code: error.code, message: error.message });
    throw new APIError('INTERNAL_SERVER_ERROR', { code: 'phone_login_failed', message: 'Phone login could not be completed.' });
  }
}

export function createPhoneAuth(db: Sqlite, config: PhoneConfiguration | undefined, receiptSecret: string,
  seams: { fetcher?: typeof fetch; now?: () => number } = {}) {
  const parsed = config ? phoneConfiguration.parse(config) : undefined;
  const challenges = new PhoneChallenges(db, parsed ? new TwilioVerify(parsed, seams.fetcher) : undefined,
    parsed?.allowedPhones ?? [], receiptSecret, seams.now);
  const maintained = phoneNumber({
    requireVerification: true, expiresIn: 600, allowedAttempts: 3,
    phoneNumberValidator: number => phone.safeParse(number).success,
    // This route is deliberately absent. Provider-generated codes have no local fallback.
    sendOTP: () => { throw new APIError('NOT_FOUND', { code: 'not_found', message: 'not_found' }); },
    verifyOTP: async ({ phoneNumber: number, code }, context) => publicError(async () => {
      const input = checkRequest.parse(context?.body);
      if (input.phoneNumber !== number || input.code !== code) throw new DomainError(422, 'invalid_request');
      return challenges.verify(input, context?.headers?.get('idempotency-key') ?? context?.request?.headers.get('idempotency-key') ?? '');
    }),
    signUpOnVerification: { getTempEmail: phoneEmail, getTempName: () => 'Form member' },
    callbackOnVerification: async ({ user }, context) => publicError(async () => {
      challenges.recordSubject(checkRequest.parse(context?.body), user);
    }),
  });
  const guard = createAuthMiddleware(async context => {
    if (context.path === '/update-user') throw new APIError('FORBIDDEN', { code: 'phone_linking_unavailable', message: 'Phone account changes are unavailable.' });
    const parsedBody = checkRequest.safeParse(context.body);
    if (!parsedBody.success) throw new APIError('BAD_REQUEST', { code: 'invalid_request', message: 'Check the submitted fields.' });
  });
  const plugin = {
    ...maintained,
    hooks: { before: [...maintained.hooks.before, {
      matcher: context => context.path === '/phone-number/verify' ||
        (context.path === '/update-user' && context.body !== undefined && 'phoneNumber' in context.body), handler: guard,
    }] },
    endpoints: {
      // Retain Better Auth's identity/session implementation; exclude its password and linking surfaces.
      verifyPhoneNumber: maintained.endpoints.verifyPhoneNumber,
      startPhoneChallenge: createAuthEndpoint('/phone-number/challenge', { method: 'POST', body: challengeRequest },
        async context => publicError(async () => context.json(await challenges.start(context.body,
          context.headers?.get('idempotency-key') ?? context.request?.headers.get('idempotency-key') ?? '')))),
      resendPhoneChallenge: createAuthEndpoint('/phone-number/resend', { method: 'POST', body: boundRequest },
        async context => publicError(async () => context.json(await challenges.resend(context.body,
          context.headers?.get('idempotency-key') ?? context.request?.headers.get('idempotency-key') ?? '')))),
    },
  } satisfies BetterAuthPlugin;
  return { plugin, capability: () => challenges.capability(), canCreateUser: challenges.canCreateUser.bind(challenges) };
}
