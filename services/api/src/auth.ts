import { assertPrincipalActive } from './lifecycle/guards.js';
import { betterAuth, type BetterAuthOptions, type Auth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { bindCredentialMail, type CredentialMailPort } from './credentials/mail.js';
import { bearer } from 'better-auth/plugins/bearer';
import type { Registration } from './schemas.js';
import type { Sqlite } from './storage.js';
import { createPhoneAuth, isPhoneEmail, type PhoneConfiguration } from './phone/index.js';

export type SocialProviders = Pick<NonNullable<BetterAuthOptions['socialProviders']>, 'google' | 'apple'>;
export function createAuth(db: Sqlite, config: {
  baseURL: string; secret: string; trustedOrigins: string[]; registration: Registration; socialProviders?: SocialProviders; phone?: PhoneConfiguration; credentialMail?: CredentialMailPort;
}): Auth<BetterAuthOptions> {
  const phoneAuth = createPhoneAuth(db, config.phone, config.secret);
  const credentialMail = bindCredentialMail(db, config.credentialMail);
  const options: BetterAuthOptions = {
    appName: 'Form', baseURL: config.baseURL, basePath: '/api/auth', secret: config.secret, database: db,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true, disableSignUp: config.registration.mode === 'closed',
      revokeSessionsOnPasswordReset: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: true,
    },
    user: { changeEmail: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    socialProviders: config.socialProviders ?? {},
    plugins: [bearer({ requireSignature: true }), phoneAuth.plugin, emailOTP({ otpLength: 8, expiresIn: 600, allowedAttempts: 3, storeOTP: 'hashed', disableSignUp: true,
      changeEmail: { enabled: true, verifyCurrentEmail: false },
      sendVerificationOTP: async input => { if (input.type === 'forget-password' || input.type === 'change-email') credentialMail.dispatch({ ...input, type: input.type }); },
    })],
    advanced: { ipAddress: { ipAddressHeaders: ['x-form-peer-ip'] }, database: { generateId: 'uuid' } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
      customRules: { '/email-otp/request-password-reset': { window: 900, max: 3 }, '/email-otp/reset-password': { window: 900, max: 10 },
        '/email-otp/request-email-change': { window: 900, max: 3 }, '/email-otp/change-email': { window: 900, max: 10 }, '/change-password': { window: 900, max: 5 }, '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 10 } } },
    databaseHooks: {
      session: {
        create: { before: async session => { assertPrincipalActive(db, session.userId); },
          after: async session => {
            try { assertPrincipalActive(db, session.userId); } catch (error) { db.prepare('DELETE FROM session WHERE id=?').run(session.id); throw error; }
          } },
        update: { before: async (session, context) => {
          const userId = session.userId ?? context?.context.session?.user.id;
          if (typeof userId === 'string') assertPrincipalActive(db, userId);
        } },
      },
      account: { create: { before: async account => { assertPrincipalActive(db, account.userId); } },
        update: { before: async (account, context) => {
          const userId = account.userId ?? context?.context.session?.user.id;
          if (typeof userId === 'string') assertPrincipalActive(db, userId);
        } } },
      user: { update: { before: async (user, context) => {
        const userId = user.id ?? context?.context.session?.user.id;
        if (typeof userId === 'string') assertPrincipalActive(db, userId);
      } }, create: { before: async (user, context) => phoneAuth.canCreateUser(user, context) ||
        (!isPhoneEmail(user.email) && (user as Record<string, unknown>).phoneNumber == null &&
          (user as Record<string, unknown>).phoneNumberVerified !== true && config.registration.mode === 'allowlist' &&
          config.registration.emails.some(email => email.toLowerCase() === user.email.toLowerCase())) } },
    },
    telemetry: { enabled: false },
  };
  return betterAuth(options);
}
