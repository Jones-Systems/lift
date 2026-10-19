import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Auth, BetterAuthOptions } from 'better-auth';
import type { Sqlite } from '../storage.js';
import type { Registration } from '../schemas.js';
import { DomainError } from '../errors.js';
import { assertPrincipalActive } from '../lifecycle/guards.js';
import { isPhoneEmail } from '../phone/index.js';
import { credentialMailFor, eligibleCredential } from './mail.js';

const email = z.email().max(254), password = z.string().min(12).max(128), currentPassword = z.string().min(1).max(128);
const otp = z.string().regex(/^[0-9]{8}$/), empty = z.object({}).strict();
const signin = z.object({ email, password, callbackURL: z.string().max(300).optional(), rememberMe: z.boolean().optional() }).strict();
const schemas: Record<string, z.ZodType> = {
  '/sign-in/email': signin, '/sign-up/email': signin.extend({ name: z.string().trim().min(1).max(100) }),
  '/sign-out': empty, '/revoke-sessions': empty, '/revoke-other-sessions': empty,
  '/revoke-session': z.object({ token: z.string().min(1).max(4096) }).strict(),
  '/change-password': z.object({ currentPassword, newPassword: password, revokeOtherSessions: z.boolean().optional() }).strict(),
  '/email-otp/request-password-reset': z.object({ email }).strict(),
  '/email-otp/reset-password': z.object({ email, otp, password }).strict(),
  '/email-otp/request-email-change': z.object({ newEmail: email, currentPassword }).strict(),
  '/email-otp/change-email': z.object({ newEmail: email, otp }).strict(),
};
const phonePaths = new Set(['/phone-number/challenge', '/phone-number/resend', '/phone-number/verify']);
export function supportedAuthRoute(method: string, path: string, providers: readonly string[]): boolean {
  if (method === 'GET' && path === '/get-session') return true;
  if (method === 'POST' && (schemas[path] || phonePaths.has(path))) return true;
  if (method === 'POST' && path === '/sign-in/social') return providers.length > 0;
  const callback = /^\/callback\/([^/]+)$/.exec(path);
  return (method === 'GET' || method === 'POST') && !!callback && providers.includes(callback[1]!);
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
export async function credentialAuthProxy(request: Request, deps: { db: Sqlite; auth: Auth<BetterAuthOptions>; registration: Registration; providers: readonly string[] }): Promise<Response> {
  const path = new URL(request.url).pathname.slice('/api/auth'.length);
  if (!supportedAuthRoute(request.method, path, deps.providers)) return json({ error: { code: 'not_found', message: 'not_found' } }, 404);
  const resetRequest = path === '/email-otp/request-password-reset';
  const started = performance.now(); let result: Response | undefined;
  try {
    if (path.startsWith('/email-otp/') && credentialMailFor(deps.db).status() === 'unconfigured')
      return result = json({ error: { code: 'password_recovery_unavailable' } }, 501);
    let input: Record<string, unknown> | undefined;
    if (schemas[path] || path === '/sign-in/social') {
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required');
      let raw: unknown; try { raw = await request.json(); } catch { throw new DomainError(400, 'invalid_json'); }
      const parsed = (schemas[path] ?? z.object({ provider: z.enum(['apple', 'google']), callbackURL: z.string().max(300).optional(), errorCallbackURL: z.string().max(300).optional(), newUserCallbackURL: z.string().max(300).optional(), disableRedirect: z.boolean().optional(), idToken: z.object({ token: z.string().max(16384), nonce: z.string().max(1024).optional(), accessToken: z.string().max(16384).optional(), refreshToken: z.string().max(16384).optional(), expiresAt: z.number().optional(), user: z.object({ name: z.object({ firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional() }).strict().optional(), email: email.optional() }).strict().optional() }).strict().optional(), scopes: z.array(z.string().max(100)).max(20).optional(), requestSignUp: z.boolean().optional(), loginHint: z.string().max(254).optional(), additionalParams: z.record(z.string().max(100), z.string().max(2048)).optional(), additionalData: z.record(z.string().max(100), z.unknown()).optional() }).strict()).safeParse(raw);
      if (!parsed.success) throw new DomainError(422, 'invalid_request');
      input = parsed.data as Record<string, unknown>;
      if (path === '/sign-in/social' && !deps.providers.includes(input.provider as string)) return result = json({ error: { code: 'not_found' } }, 404);
    }
    if (path === '/sign-up/email' && (isPhoneEmail(input!.email as string) || deps.registration.mode === 'closed' || !deps.registration.emails.some(x => x.toLowerCase() === (input!.email as string).toLowerCase()))) throw new DomainError(403, 'registration_unavailable');
    if (path === '/sign-in/email') {
      const user = deps.db.prepare('SELECT id FROM "user" WHERE email=? COLLATE NOCASE').get(input!.email) as { id: string } | undefined;
      if (user) assertPrincipalActive(deps.db, user.id);
    }
    if (path === '/email-otp/reset-password' && !eligibleCredential(deps.db, input!.email as string)) return result = json({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
    const anonymous = resetRequest || path === '/email-otp/reset-password';
    const before = anonymous ? null : await deps.auth.api.getSession({ headers: request.headers });
    if (before) assertPrincipalActive(deps.db, before.user.id);
    if (path === '/change-password') input = { ...input, revokeOtherSessions: true };
    if (path === '/email-otp/request-email-change' || path === '/email-otp/change-email') {
      if (!before) return result = json({ code: 'UNAUTHORIZED' }, 401);
      if (!eligibleCredential(deps.db, before.user.email)) return result = json({ code: 'CREDENTIAL_ACCOUNT_NOT_FOUND' }, 400);
      if (isPhoneEmail(input!.newEmail as string) || (input!.newEmail as string).toLowerCase() === before.user.email.toLowerCase()) throw new DomainError(422, 'invalid_request');
      if (path.endsWith('/request-email-change')) {
        const budgetKey = `form:email-change-password:${before.user.id}`, now = Date.now();
        const permitted = deps.db.transaction(() => {
          const budget = deps.db.prepare('SELECT count,lastRequest FROM rateLimit WHERE key=?').get(budgetKey) as { count: number; lastRequest: number } | undefined;
          if (budget && now - budget.lastRequest < 900000 && budget.count >= 3) return false;
          deps.db.prepare('INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=?,lastRequest=?').run(budgetKey, budgetKey, now, budget && now - budget.lastRequest < 900000 ? budget.count + 1 : 1, budget && now - budget.lastRequest < 900000 ? budget.lastRequest : now);
          return true;
        }).immediate();
        if (!permitted) return result = json({ code: 'TOO_MANY_REQUESTS' }, 429);
        try { await deps.auth.api.verifyPassword({ headers: request.headers, body: { password: input!.currentPassword as string } }); }
        catch { return result = json({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, 400); }
        input = { newEmail: input!.newEmail };
      }
    }
    result = await deps.auth.handler(input === undefined ? request : new Request(request, { body: JSON.stringify(input) }));
    if (before) assertPrincipalActive(deps.db, before.user.id);
    if (resetRequest && result.status !== 429) result = json({ success: true });
    return result;
  } finally {
    if (resetRequest && result?.status !== 429) {
      let remaining = 700 - (performance.now() - started);
      while (remaining > 0) { await delay(Math.ceil(remaining)); remaining = 700 - (performance.now() - started); }
    }
  }
}
